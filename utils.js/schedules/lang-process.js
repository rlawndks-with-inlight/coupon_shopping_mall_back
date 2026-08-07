import { readPool, writePool } from "../../config/db-pool.js";
import { deleteQuery, updateQuery } from "../query-util.js";
import { LANG_STATS, settingLangs } from "../util.js";
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
    ],
    product_options: [
        'option_name',
    ],
    product_option_groups: [
        'group_name'
    ]
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
    const maxItems = parseInt(opts.maxItems ?? process.env.LANG_BATCH_ITEMS ?? '20') || 20;
    const maxCalls = parseInt(opts.maxCalls ?? process.env.LANG_BATCH_CALLS ?? '60') || 60;
    const maxTries = parseInt(process.env.LANG_MAX_TRIES ?? '3') || 3;

    isRunning = true;
    const startCalls = LANG_STATS.calls;
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
        logger.info(`[lang] 처리 완료 성공=${done} 실패=${failed} 격리=${skipped} 요청수=${LANG_STATS.calls - startCalls}`);
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