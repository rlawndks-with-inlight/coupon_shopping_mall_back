'use strict';
// 1회성(멱등): 언어팩을 켠 브랜드(setting_obj.is_use_lang = 1)의 레코드 중
// lang_obj 가 비어 있는 것들을 번역 대기열(lang_processes)에 넣는다.
//
// [왜 필요한가]
// brandSettingLang 은 **is_use_lang 이 0 → 1 로 바뀌는 순간에만** 전량을 대기열에 넣는다.
// 그래서 이미 켜 둔 상태에서 나중에 다른 경로로 들어온 데이터(일괄 등록·마이그레이션·
// 대기열이 격리(is_confirm=2)로 버린 건)는 번역본이 영영 생기지 않는다.
// 실제로 카테고리는 상당수가 lang_obj 가 비어 있어 '카테고리는 다국어가 안 먹는다'로 보였다.
//
// 이 스크립트는 번역을 직접 하지 않는다 — 대기열에 넣기만 하고,
// 실제 번역은 기존 스케줄러(langProcess)가 건수·요청수 예산을 지키며 천천히 소비한다.
// 무료 gtx 엔드포인트라 한 번에 몰아치면 차단 위험이 있어서 이렇게 나눈다.
//
// 실행: 백엔드 루트에서  node scripts/lang-backfill.js
//       미리보기(대기열에 넣지 않고 건수만):  node scripts/lang-backfill.js --dry
//       테이블 한정:  node scripts/lang-backfill.js --only=product_categories,product_category_groups
//       ShopGo 만:    node scripts/lang-backfill.js --shopgo
//       브랜드 지정:  node scripts/lang-backfill.js --brand=98,101
//
// --only 를 두는 이유: 상품은 건수가 카테고리보다 두 자릿수 크다(대형몰 3곳이 대부분).
// 카테고리만 먼저 채우고 상품은 따로 판단하는 식으로 나눠 돌릴 수 있어야 한다.
import 'dotenv/config';
import { readPool, writePool } from '../config/db-pool.js';
import { lang_obj_columns } from '../utils.js/schedules/lang-process.js';

const DRY = process.argv.includes('--dry');

// 브랜드 범위 한정.
//
// ⚠ 이걸 안 두고 '언어팩 켠 브랜드 전량'을 돌렸다가 구글 무료 gtx 엔드포인트에서 IP 차단을 당했다.
//   실측하면 언어팩 켠 36곳 전체는 464,639자인데, 그중 462,416자(99.5%)가
//   해외직구 B2B 3곳(티제이몰·다오니·아워샵)의 상품이다.
//   정작 필요한 ShopGo(본사 98 + 산하) 범위는 1,816자 — 무료 한도의 0.4% 다.
//   범위를 좁히면 몇 초면 끝나는 일이었다. 기본값을 '전체'로 두지 않는 편이 안전하다.
//
//   --shopgo        ShopGo 본사(98)와 그 산하 가맹점만
//   --brand=1,2,3   브랜드 id 직접 지정
const SHOPGO_MASTER_ID = parseInt(process.env.SHOPGO_MASTER_ID ?? '98') || 98;
const SHOPGO_ONLY = process.argv.includes('--shopgo');
const BRAND_IDS = (() => {
    const arg = process.argv.find((a) => a.startsWith('--brand='));
    if (!arg) return null;
    const ids = arg.slice('--brand='.length).split(',')
        .map((s) => parseInt(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length === 0) {
        console.error('--brand= 뒤에 브랜드 id 를 쉼표로 넣어야 합니다. 예: --brand=98,101');
        process.exit(1);
    }
    return ids;
})();

const ONLY = (() => {
    const arg = process.argv.find((a) => a.startsWith('--only='));
    if (!arg) return null;
    const list = arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = list.filter((t) => !lang_obj_columns[t]);
    if (unknown.length > 0) {
        console.error(`알 수 없는 테이블: ${unknown.join()}\n사용 가능: ${Object.keys(lang_obj_columns).join()}`);
        process.exit(1);
    }
    return list;
})();

// 테이블별 '브랜드에 속한 행' 을 뽑는 SQL.
// product_options / product_option_groups 는 brand_id 컬럼이 없어 부모로 조인해야 한다
// (lang-process.js 의 brandSettingLang 과 같은 규칙).
// '아직 번역이 없는 행' 조건.
//
// 처음엔 lang_obj 가 NULL/빈문자/'{}' 인 것만 봤다. 그런데 번역 호출이 전부 실패한 행은
// 원문만 담긴 {"category_name":{"ko":"주방용품"}} 형태로 저장된다 — 비어 있지 않으므로
// 이 조건을 통과해 '이미 번역됨'으로 취급됐고, 다시 대기열에 들어가지 못했다.
// 대상 언어 키(en/ja/cn/es)가 하나도 없으면 번역이 없는 것으로 본다.
// 세 번째 보완: 판정이 '행 단위' 라 **번역 대상 컬럼이 나중에 늘어나면 영영 안 채워진다**.
//   실제로 products 에 product_description 을 추가했더니, 상품명이 이미 번역된 18건이
//   전부 '번역됨' 으로 걸러져 상세설명만 원문으로 남았다(백필을 돌려도 0건 적재).
//   → 컬럼마다 'lang_obj 안에 그 컬럼 키가 있는지' 를 따로 본다.
//     원문이 비어 있는 컬럼은 번역할 것이 없으므로 대상에서 뺀다.
// 네 번째 보완(2026-08-27): 판정을 SQL 에서 JS 로 옮겼다.
//   앞의 조건들은 전부 '컬럼 열쇠가 lang_obj 안에 있는가' 만 봤다. 그런데 번역은 **언어별로**
//   실패한다 — HTML 본문이 일본어만 되고 영어·중국어·스페인어는 빠지는 일이 실제로 있었다.
//   그러면 popup_content 열쇠는 있으므로 '번역됨'으로 걸러져, 고쳐 놓고 백필을 돌려도 0건이었다.
//   어느 언어가 채워졌는지는 LIKE 로 볼 수 없다. lang_obj 를 읽어와 JS 에서 본다.
//
// ⚠ 대신 브랜드 범위의 행을 전부 읽는다. --shopgo · --brand= 로 좁혀 쓰는 도구라 괜찮지만,
//   상품이 수만 건인 대형몰을 지정하면 메모리를 많이 쓴다(그 경우 --only= 로 나눠 돌릴 것).
const 목표언어 = ['en', 'ja', 'cn', 'es'];
const 번역이빠졌나 = (item, cols = []) => {
    let lang = {};
    try { lang = JSON.parse(item?.lang_obj ?? '{}') ?? {}; } catch (e) { return true; }
    for (const col of cols) {
        // 원문이 비어 있는 컬럼은 번역할 것이 없다.
        if (!String(item?.[col] ?? '').trim()) continue;
        const slot = lang?.[col] ?? {};
        // 한 언어라도 비었으면 다시 담는다. settingLangs 가 빠진 언어를 채워 준다.
        if (목표언어.some((L) => !String(slot?.[L] ?? '').trim())) return true;
    }
    return false;
};

const selectFor = (table, cols) => {
    // lang_obj 도 함께 읽는다 — '어느 언어가 채워졌는지' 는 SQL 의 LIKE 로 볼 수 없어
    // 아래 번역이빠졌나() 가 JS 에서 판정한다.
    const c = [...cols.map((x) => `${table}.${x}`), `${table}.lang_obj`].join();
    if (table === 'posts') {
        return `SELECT posts.id, ${c} FROM posts
                  LEFT JOIN post_categories ON posts.category_id = post_categories.id
                 WHERE post_categories.brand_id = ?`;
    }
    if (table === 'product_option_groups') {
        return `SELECT product_option_groups.id, ${c} FROM product_option_groups
                  LEFT JOIN products ON product_option_groups.product_id = products.id
                 WHERE products.brand_id = ?`;
    }
    if (table === 'product_options') {
        return `SELECT product_options.id, ${c} FROM product_options
                  LEFT JOIN product_option_groups ON product_options.group_id = product_option_groups.id
                  LEFT JOIN products ON product_option_groups.product_id = products.id
                 WHERE products.brand_id = ?`;
    }
    if (table === 'product_characters') {
        // 특성도 brand_id 컬럼이 없다 — 부모(products)로 조인해 브랜드를 판정한다.
        return `SELECT product_characters.id, ${c} FROM product_characters
                  LEFT JOIN products ON product_characters.product_id = products.id
                 WHERE products.brand_id = ?`;
    }
    if (table === 'benefit_notice_tabs') {
        // brand_id 컬럼이 없다 — 부모(benefit_notices)로 조인한다.
        return `SELECT benefit_notice_tabs.id, ${c} FROM benefit_notice_tabs
                  LEFT JOIN benefit_notices ON benefit_notice_tabs.notice_id = benefit_notices.id
                 WHERE benefit_notices.brand_id = ?`;
    }
    if (table === 'product_order_form_fields') {
        // brand_id 컬럼이 없다 — 상품(products)으로 조인한다.
        return `SELECT product_order_form_fields.id, ${c} FROM product_order_form_fields
                  LEFT JOIN products ON product_order_form_fields.product_id = products.id
                 WHERE products.brand_id = ?`;
    }
    if (table === 'order_form_fields') {
        // brand_id 컬럼이 없다 — 부모(order_form_templates)로 조인한다.
        return `SELECT order_form_fields.id, ${c} FROM order_form_fields
                  LEFT JOIN order_form_templates ON order_form_fields.template_id = order_form_templates.id
                 WHERE order_form_templates.brand_id = ?`;
    }
    // ⚠ 여기로 떨어지는 테이블은 brand_id 컬럼이 **반드시** 있어야 한다.
    //   없으면 MySQL 이 Unknown column 으로 던지고, 이 스크립트는 그 순간 통째로 멈춘다
    //   (한 테이블만 건너뛰는 게 아니라 백필 전체가 실패한다 — 실제로 그렇게 멈춰 있었다).
    //   lang_obj_columns 에 테이블을 추가할 때 brand_id 가 없다면 위에 분기를 하나 더 둘 것.
    //   같은 규칙이 utils.js/schedules/lang-process.js 의 brandSettingLang 에도 있다.
    return `SELECT id, ${c} FROM ${table}
             WHERE brand_id = ?`;
};

const run = async () => {
    // is_use_lang 은 setting_obj 안에 **문자열 "1"** 로 저장되는 경우가 많다.
    // JSON_EXTRACT(...) = 1 로 비교하면 문자열 "1" 이 걸리지 않아 전부 놓친다 —
    // JS 쪽에서 String() 으로 비교한다.
    let brands = await readPool.query(`SELECT id, name, parent_id, setting_obj FROM brands WHERE is_delete = 0`);
    brands = brands[0].filter((b) => {
        try { if (String(JSON.parse(b?.setting_obj ?? '{}')?.is_use_lang) !== '1') return false; }
        catch (e) { return false; }
        if (BRAND_IDS) return BRAND_IDS.includes(Number(b.id));
        if (SHOPGO_ONLY) return Number(b.id) === SHOPGO_MASTER_ID || Number(b.parent_id) === SHOPGO_MASTER_ID;
        return true;
    });
    if (brands.length === 0) {
        console.log('대상 브랜드가 없습니다(언어팩이 켜져 있고 지정 범위에 드는 브랜드 기준). 할 일 없음.');
        process.exit(0);
    }
    const scope = BRAND_IDS ? `브랜드 ${BRAND_IDS.join()}` : (SHOPGO_ONLY ? `ShopGo(${SHOPGO_MASTER_ID} 및 산하)` : '전체 ⚠');
    if (!BRAND_IDS && !SHOPGO_ONLY) {
        console.log('⚠ 범위를 지정하지 않아 언어팩 켠 브랜드 전부를 대상으로 합니다.');
        console.log('  대형몰이 섞여 있으면 번역 요청이 폭주해 차단당할 수 있습니다 — --shopgo 또는 --brand= 를 권장합니다.\n');
    }
    let tables = ONLY ?? Object.keys(lang_obj_columns);

    // lang_obj 컬럼이 아직 없는 표는 뺀다.
    //
    // 번역 대상 목록에 표를 새로 넣으려면 마이그레이션(ALTER TABLE ... ADD lang_obj)이 선행돼야 하는데,
    // 코드가 먼저 배포되는 순간이 생긴다(마이그레이션은 사람이 손으로 돌린다).
    // 그때 이 스크립트는 한 표를 건너뛰는 게 아니라 **Unknown column 으로 통째로 멈춘다** —
    // 조인 분기가 빠져 있어 실제로 그렇게 멈춰 있었다. 같은 사고를 컬럼 쪽에서도 막는다.
    {
        const [cols] = await readPool.query(
            `SELECT TABLE_NAME t FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'lang_obj'`);
        const 있는표 = new Set(cols.map((r) => r.t));
        const 없는것 = tables.filter((t) => !있는표.has(t));
        if (없는것.length) {
            console.log(`⚠ lang_obj 컬럼이 없어 건너뜁니다: ${없는것.join()}`);
            console.log('  migrations/ 의 해당 SQL 을 먼저 실행하세요.\n');
            tables = tables.filter((t) => 있는표.has(t));
        }
    }
    console.log(`대상 브랜드 ${brands.length}곳 (범위: ${scope}) / 대상 테이블: ${tables.join()}`);

    let grand = 0;
    const by_table = {};
    for (const brand of brands) {
        let rows_to_insert = [];
        for (const table of tables) {
            const cols = lang_obj_columns[table];
            let items = await readPool.query(selectFor(table, cols), [brand.id]);
            items = items[0];
            for (const item of items) {
                // 원문이 하나도 없는 행은 번역할 것이 없다 — 대기열만 늘어난다.
                const has_text = cols.some((c) => String(item?.[c] ?? '').trim().length > 0);
                if (!has_text) continue;
                // 이미 다섯 언어가 다 찬 행은 건드리지 않는다.
                if (!번역이빠졌나(item, cols)) continue;
                // 대기열에는 원문만 싣는다. lang_obj 까지 넣으면 큐 행이 몇 배로 커지고,
                // 스케줄러는 어차피 columns 만 읽는다.
                const 원문 = { id: item.id };
                for (const col of cols) 원문[col] = item[col];
                rows_to_insert.push([table, item.id, brand.id, JSON.stringify(원문)]);
            }
        }
        // 이미 대기 중(is_confirm=0)인 건 다시 넣지 않는다 — 멱등하게 만든다.
        if (rows_to_insert.length > 0) {
            let pending = await readPool.query(
                `SELECT table_name, item_id FROM lang_processes WHERE brand_id = ? AND is_confirm = 0`, [brand.id]);
            const pending_set = new Set(pending[0].map((r) => `${r.table_name}:${r.item_id}`));
            rows_to_insert = rows_to_insert.filter((r) => !pending_set.has(`${r[0]}:${r[1]}`));
        }
        for (const r of rows_to_insert) by_table[r[0]] = (by_table[r[0]] ?? 0) + 1;
        console.log(`  브랜드 ${brand.id} (${brand.name}) : ${rows_to_insert.length}건`);
        grand += rows_to_insert.length;
        if (DRY || rows_to_insert.length === 0) continue;
        for (let i = 0; i < rows_to_insert.length; i += 1000) {
            await writePool.query(
                `INSERT INTO lang_processes (table_name, item_id, brand_id, obj) VALUES ?`,
                [rows_to_insert.slice(i, i + 1000)]);
        }
    }
    console.log('\n테이블별:', JSON.stringify(by_table));
    console.log(DRY ? `[미리보기] 대기열에 넣을 총 ${grand}건 (실제로 넣지 않음)`
                    : `\n대기열 적재 완료: 총 ${grand}건. 스케줄러(langProcess)가 1분마다 소비합니다.`);
    process.exit(0);
};

run().catch((e) => { console.error('실패:', e?.message || e); process.exit(1); });
