import { readPool, writePool } from "../../config/db-pool.js";
import { deleteQuery, updateQuery } from "../query-util.js";
import { LANG_STATS, settingLangs, usingOfficialTranslateApi } from "../util.js";
import logger from "../winston/index.js";

const table_name = 'lang_processes';

export const lang_obj_columns = {
    post_categories: [
        'post_category_title',
    ],
    posts: [
        'post_title',
        'post_content',
    ],
    product_category_groups: [
        'category_group_name',
    ],
    product_categories: [
        'category_name',
        'category_description',
    ],
    products: [
        'product_name',
        'product_comment',
        'product_spec',
        // 상세설명이 빠져 있었다. 그런데 고객 화면(프레임2 상품상세 등)은
        // formatLang(product, 'product_description', ...) 을 부르고 있어서,
        // 있지도 않은 번역을 찾다가 늘 원문으로 폴백했다 — 다른 건 다 번역됐는데
        // 상세설명만 한국어로 남는 이유가 이것이다.
        // HTML 이므로 HTML_LANG_COLUMNS 에도 함께 등록해 태그를 보존한다.
        'product_description',
    ],
    product_options: [
        'option_name',
    ],
    product_option_groups: [
        'group_name'
    ],
    // 특성은 번역 대상에 아예 없었다 — 고객 상품상세에 노출되는데도 늘 한국어였다.
    // 옵션과 같은 계층이라 브랜드 판정도 같은 방식(부모 products 조인)으로 한다.
    // ⚠ migrations/2026-08-10_product_characters_lang_obj.sql 실행이 선행돼야 한다.
    product_characters: [
        'character_name',
        'character_value',
    ],
    // 상품상세 '혜택 안내'. 본사가 한국어로 한 번 쓰면 나머지 4개 언어는 여기서 채워진다.
    benefit_notices: [
        'label',
        'summary',
    ],
    // 탭 본문은 Quill 이 만든 HTML 이라 HTML_LANG_COLUMNS 에도 등록돼 있다(태그 보존).
    benefit_notice_tabs: [
        'tab_title',
        'tab_content',
    ],
    // 주문서 추가 입력항목의 라벨·도움말. 고객 주문서에 그대로 보이므로 번역 대상이다.
    // (선택지 option_list 는 줄바꿈으로 묶인 목록이라 번역기에 통째로 넣으면 줄이 어긋난다 — 뺐다)
    order_form_fields: [
        'label',
        'placeholder',
    ],
    // 상품에 실제로 걸린 입력항목. 손님 화면에 그대로 보이므로 번역 대상이다.
    // ⚠ 위 order_form_fields 는 마스터가 만드는 '템플릿'이라 손님에게 안 보인다.
    //   이걸 빠뜨리면 상품에 붙인 '행사일' 이 외국어 화면에서 한국어로 남는다.
    product_order_form_fields: [
        'label',
        'placeholder',
    ],
}

// 이전 틱이 아직 돌고 있는지. 스케줄러가 1분마다 부르는데 한 틱이 1분을 넘길 수 있다.
let isRunning = false;

// 번역 대기열 소비자.
//
// 예전 구현은 미처리 전량을 한 틱에 직렬 처리했다. 대형몰이 언어팩을 켜면
// brandSettingLang 이 수천 건을 한꺼번에 적재하는데, 그걸 그대로 돌면
// 요청이 폭주하고(무료 gtx 엔드포인트라 차단 위험) 한 건이 실패하면
// 루프가 통째로 죽어 나머지가 처리되지 않았다.
// 재시도 상한도 없어서, 영원히 실패하는 행이 매분 다시 시도됐다.
//
// 그래서 (1) 건수·요청수 두 가지로 예산을 두고 (2) 실패는 그 행만 격리하고
// (3) 겹쳐 도는 것을 막는다.
export const langProcess = async (opts = {}) => {
    if (isRunning) {
        logger.info('[lang] 이전 처리가 아직 진행 중이라 이번 틱은 건너뜀');
        return;
    }
    // 한 틱 예산. 공식 API 키가 있으면 분당 한도가 넉넉하므로 크게 잡는다
    //  — 무료 gtx 는 조금만 몰아쳐도 IP 가 막히니 예전 값(20건/60요청)을 그대로 유지한다.
    const official = usingOfficialTranslateApi();
    const maxItems = parseInt(opts.maxItems ?? process.env.LANG_BATCH_ITEMS ?? (official ? '200' : '20')) || 20;
    const maxCalls = parseInt(opts.maxCalls ?? process.env.LANG_BATCH_CALLS ?? (official ? '600' : '60')) || 60;
    const maxTries = parseInt(process.env.LANG_MAX_TRIES ?? '3') || 3;
    // 차단(429)을 맞은 뒤 쉬는 시간. 무료 gtx 엔드포인트는 한 IP 가 몰아치면 막는데,
    // 막힌 채로 계속 두드리면 차단이 길어질 뿐이다. 기본 30분.
    const cooldownMs = (parseInt(process.env.LANG_COOLDOWN_MIN ?? '30') || 30) * 60 * 1000;
    if (LANG_STATS.rate_limited_at > 0 && Date.now() - LANG_STATS.rate_limited_at < cooldownMs) {
        const left = Math.ceil((cooldownMs - (Date.now() - LANG_STATS.rate_limited_at)) / 60000);
        logger.info(`[lang] 요청 차단 후 대기 중 — ${left}분 뒤 재시도`);
        return;
    }

    isRunning = true;
    const startCalls = LANG_STATS.calls;
    const startChars = LANG_STATS.chars;
    let done = 0, failed = 0, skipped = 0;
    try {
        let process_items = await readPool.query(
            `SELECT * FROM ${table_name} WHERE is_confirm=0 AND COALESCE(try_count,0) < ? ORDER BY id ASC LIMIT ?`,
            [maxTries, maxItems]
        );
        process_items = process_items[0];
        if (process_items.length == 0) return;

        // 브랜드 설정을 한 번에 읽어 캐시한다(항목마다 조회하지 않는다).
        let brand_ids = [...new Set(process_items.map((itm) => itm?.brand_id).filter((v) => v > 0))];
        let brand_obj = {};
        if (brand_ids.length > 0) {
            let brands = await readPool.query(
                `SELECT * FROM brands WHERE id IN (${brand_ids.map(() => '?').join()})`, brand_ids);
            brands = brands[0];
            for (var i = 0; i < brands.length; i++) {
                brands[i].setting_obj = JSON.parse(brands[i]?.setting_obj ?? '{}');
                brand_obj[brands[i]?.id] = brands[i];
            }
        }

        // 더 시도할 가치가 없는 행은 is_confirm=2 로 격리한다(삭제하지 않는다 — 원인 추적용).
        const quarantine = async (row, reason) => {
            skipped++;
            logger.info(`[lang] 격리 id=${row?.id} table=${row?.table_name} item=${row?.item_id} :: ${reason}`);
            await writePool.query(`UPDATE ${table_name} SET is_confirm=2 WHERE id=?`, [row?.id]);
        };

        for (const row of process_items) {
            // 요청 예산 소진 — 남은 건은 다음 틱으로 넘긴다.
            if (LANG_STATS.calls - startCalls >= maxCalls) {
                logger.info(`[lang] 요청 예산(${maxCalls}) 소진, 남은 건은 다음 틱으로`);
                break;
            }
            const columns = lang_obj_columns[row?.table_name];
            if (!columns) { await quarantine(row, '번역 대상 컬럼 정의 없음'); continue; }
            const brand = brand_obj[row?.brand_id];
            if (!brand) { await quarantine(row, '브랜드를 찾을 수 없음'); continue; }
            if (brand?.setting_obj?.is_use_lang != 1) { await quarantine(row, '브랜드 언어팩 꺼짐'); continue; }

            try {
                const obj = JSON.parse(row?.obj ?? '{}');
                const langs = await settingLangs(columns, obj, brand, row?.table_name, row?.item_id, true);
                if (!langs?.lang_obj) { await quarantine(row, '번역 결과 없음'); continue; }

                // 번역이 실제로 하나라도 채워졌는지 확인한다.
                //
                // [증상] 구글이 429 로 막은 동안 로그는 `성공=4 실패=0` 인데 번역은 하나도 안 됐다.
                // [원인] settingLangs 는 원문을 먼저 ko 슬롯에 넣는다 — {"category_name":{"ko":"주방용품"}}.
                //        모든 언어 호출이 실패해도 이 객체는 비어 있지 않아 truthy 다. 그래서 여기서
                //        성공으로 보고 lang_obj 를 덮어쓴 뒤 대기열 행을 **삭제**했다.
                //        번역본은 영영 안 생기는데, 백필 스크립트는 'lang_obj 가 비지 않았다'고 보아
                //        다시 넣지도 않는다 — 그 항목은 조용히 영구 누락된다.
                // [수정] ko 이외 언어가 하나도 없으면 실패로 처리해 행을 남긴다(try_count 증가).
                //        차단이 풀리면 다음 틱에 다시 시도된다.
                const filled = Object.values(JSON.parse(langs.lang_obj))
                    .some((slot) => Object.keys(slot ?? {}).some((k) => k !== 'ko'));
                if (!filled) {
                    failed++;
                    const reason = langs?.rate_limited ? '요청 차단(429)' : '번역 결과가 원문뿐';
                    await writePool.query(
                        `UPDATE ${table_name} SET try_count=COALESCE(try_count,0)+1, last_error=? WHERE id=?`,
                        [reason, row?.id]);
                    // 차단이면 이번 틱은 여기서 끝낸다 — 남은 건까지 두드리면 차단만 길어진다.
                    if (langs?.rate_limited) {
                        logger.error('[lang] 요청이 차단되어 이번 틱을 중단합니다');
                        break;
                    }
                    continue;
                }

                await updateQuery(row?.table_name, { lang_obj: langs.lang_obj }, row?.item_id);
                await writePool.query(`DELETE FROM ${table_name} WHERE id=?`, [row?.id]);
                done++;
            } catch (err) {
                // 이 행만 실패로 기록한다. 루프는 계속 돈다.
                failed++;
                const msg = String(err?.message || err).slice(0, 240);
                logger.error(`[lang] 처리 실패 id=${row?.id} table=${row?.table_name} item=${row?.item_id} :: ${msg}`);
                await writePool.query(
                    `UPDATE ${table_name} SET try_count=COALESCE(try_count,0)+1, last_error=? WHERE id=?`,
                    [msg, row?.id]
                );
            }
        }
        logger.info(`[lang] 처리 완료 성공=${done} 실패=${failed} 격리=${skipped}`
            + ` 요청수=${LANG_STATS.calls - startCalls} 문자수=${LANG_STATS.chars - startChars}`
            + ` 엔진=${official ? '공식API' : '무료gtx'}`);
    } catch (err) {
        const msg = String(err?.message || err);
        // 마이그레이션을 안 돌린 채 배포하면 여기로 떨어진다. 원인을 바로 알 수 있게 따로 안내한다.
        if (msg.includes('Unknown column') && msg.includes('try_count')) {
            logger.error('[lang] migrations/2026-08-07_lang_queue_retry.sql 을 먼저 실행해야 한다 (lang_processes.try_count 컬럼 없음)');
        } else {
            logger.error(`[lang] langProcess 오류 :: ${msg}`);
        }
    } finally {
        isRunning = false;
    }
}

export const brandSettingLang = async (new_brand_data_ = {}) => {
    let new_brand_data = new_brand_data_;
    new_brand_data.setting_obj = JSON.parse(new_brand_data?.setting_obj ?? '{}');

    let ago_brand = await readPool.query(`SELECT * FROM brands WHERE id=?`, [new_brand_data?.id]);
    ago_brand = ago_brand[0][0];
    ago_brand.setting_obj = JSON.parse(ago_brand?.setting_obj ?? '{}');
    if (new_brand_data?.setting_obj?.is_use_lang == 1) {
        new_brand_data.shop_obj = JSON.parse(new_brand_data?.shop_obj ?? '[]');
        for (var i = 0; i < new_brand_data.shop_obj.length; i++) {
            if (!new_brand_data.shop_obj[i]?.lang_obj) {
                new_brand_data.shop_obj[i].lang_obj = {};
            }
            if (new_brand_data.shop_obj[i]?.title) {
                let title_lang_obj = await settingLangs(
                    ['title'],
                    { title: new_brand_data.shop_obj[i]?.title },
                    new_brand_data,
                    'brands',
                    new_brand_data?.id,
                    true,
                )

                title_lang_obj.lang_obj = JSON.parse(title_lang_obj?.lang_obj ?? '{}');
                new_brand_data.shop_obj[i].lang_obj = {
                    ...new_brand_data.shop_obj[i].lang_obj,
                    ...title_lang_obj.lang_obj,
                }
            }
            for (var j = 0; j < (new_brand_data.shop_obj[i]?.list ?? []).length; j++) {
                if (new_brand_data.shop_obj[i]?.list[j]?.category_name) {
                    let category_name_obj = await settingLangs(
                        ['category_name'],
                        { category_name: new_brand_data.shop_obj[i]?.list[j]?.category_name },
                        new_brand_data,
                        'brands',
                        new_brand_data?.id,
                        true,
                    )
                    category_name_obj.lang_obj = JSON.parse(category_name_obj?.lang_obj ?? '{}');

                    new_brand_data.shop_obj[i].list[j].lang_obj = {
                        ...category_name_obj.lang_obj,
                    }
                }
            }
        }
        new_brand_data.shop_obj = JSON.stringify(new_brand_data.shop_obj);
    }
    if (ago_brand?.setting_obj?.is_use_lang != 1 && new_brand_data?.setting_obj?.is_use_lang == 1) {
        let insert_lang_process_list = [];
        for (var i = 0; i < Object.keys(lang_obj_columns).length; i++) {
            let table = Object.keys(lang_obj_columns)[i];
            if (table == 'posts') {
                let posts = await readPool.query(`SELECT posts.id, posts.post_title, posts.post_content FROM posts LEFT JOIN post_categories ON posts.category_id=post_categories.id WHERE post_categories.brand_id=?`, [new_brand_data?.id]);
                posts = posts[0];
                for (var j = 0; j < posts.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        posts[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(posts[j])
                    ])
                }
            } else if (table == 'product_option_groups') {
                // product_option_groups 에는 brand_id 컬럼이 없어 부모(products)로 조인해 브랜드 필터
                let items = await readPool.query(`SELECT product_option_groups.id, ${lang_obj_columns[table].map(c => `product_option_groups.${c}`).join()} FROM product_option_groups LEFT JOIN products ON product_option_groups.product_id=products.id WHERE products.brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            } else if (table == 'product_options') {
                // product_options 에는 brand_id 컬럼이 없어 그룹→상품 으로 조인해 브랜드 필터
                let items = await readPool.query(`SELECT product_options.id, ${lang_obj_columns[table].map(c => `product_options.${c}`).join()} FROM product_options LEFT JOIN product_option_groups ON product_options.group_id=product_option_groups.id LEFT JOIN products ON product_option_groups.product_id=products.id WHERE products.brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            } else if (table == 'product_characters') {
                // product_characters 에도 brand_id 컬럼이 없어 부모(products)로 조인해 브랜드 필터
                let items = await readPool.query(`SELECT product_characters.id, ${lang_obj_columns[table].map(c => `product_characters.${c}`).join()} FROM product_characters LEFT JOIN products ON product_characters.product_id=products.id WHERE products.brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            } else if (table == 'benefit_notice_tabs') {
                // benefit_notice_tabs 에도 brand_id 컬럼이 없다 — 부모(benefit_notices)로 조인한다.
                // 이 분기가 없으면 else 로 떨어져 `WHERE brand_id=?` 를 붙이고,
                // MySQL 이 Unknown column 으로 던져 **언어팩 켜기 자체가 실패**한다
                // (그 브랜드의 다른 테이블 번역까지 통째로 안 걸린다).
                let items = await readPool.query(`SELECT benefit_notice_tabs.id, ${lang_obj_columns[table].map(c => `benefit_notice_tabs.${c}`).join()} FROM benefit_notice_tabs LEFT JOIN benefit_notices ON benefit_notice_tabs.notice_id=benefit_notices.id WHERE benefit_notices.brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            } else if (table == 'product_order_form_fields') {
                // 이 테이블에도 brand_id 가 없다 — 상품(products)으로 조인한다.
                // 분기가 없으면 else 로 떨어져 Unknown column 으로 언어팩 켜기가 통째로 실패한다.
                let items = await readPool.query(`SELECT product_order_form_fields.id, ${lang_obj_columns[table].map(c => `product_order_form_fields.${c}`).join()} FROM product_order_form_fields LEFT JOIN products ON product_order_form_fields.product_id=products.id WHERE products.brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            } else if (table == 'order_form_fields') {
                // order_form_fields 에도 brand_id 가 없다 — 부모(order_form_templates)로 조인한다.
                // 이 분기가 없으면 else 로 떨어져 Unknown column 으로 언어팩 켜기가 통째로 실패한다.
                let items = await readPool.query(`SELECT order_form_fields.id, ${lang_obj_columns[table].map(c => `order_form_fields.${c}`).join()} FROM order_form_fields LEFT JOIN order_form_templates ON order_form_fields.template_id=order_form_templates.id WHERE order_form_templates.brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {
                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            } else {
                let items = await readPool.query(`SELECT id,${lang_obj_columns[table].join()} FROM ${table} WHERE brand_id=?`, [new_brand_data?.id]);
                items = items[0];
                for (var j = 0; j < items.length; j++) {

                    insert_lang_process_list.push([
                        table,
                        items[j]?.id,
                        new_brand_data?.id,
                        JSON.stringify(items[j])
                    ])
                }
            }
        }
        for (var i = 0; i < insert_lang_process_list.length / 1000; i++) {
            let result = await writePool.query(`INSERT INTO lang_processes (table_name, item_id, brand_id, obj) VALUES ?`, [insert_lang_process_list.slice((i * 1000), (i + 1) * 1000)]);
        }
    }

    delete new_brand_data.id;
    return new_brand_data;
}