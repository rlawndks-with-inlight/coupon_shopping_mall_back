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
//
// --only 를 두는 이유: 상품은 건수가 카테고리보다 두 자릿수 크다(대형몰 3곳이 대부분).
// 카테고리만 먼저 채우고 상품은 따로 판단하는 식으로 나눠 돌릴 수 있어야 한다.
import 'dotenv/config';
import { readPool, writePool } from '../config/db-pool.js';
import { lang_obj_columns } from '../utils.js/schedules/lang-process.js';

const DRY = process.argv.includes('--dry');
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
const selectFor = (table, cols) => {
    const c = cols.map((x) => `${table}.${x}`).join();
    if (table === 'posts') {
        return `SELECT posts.id, ${c} FROM posts
                  LEFT JOIN post_categories ON posts.category_id = post_categories.id
                 WHERE post_categories.brand_id = ?
                   AND (posts.lang_obj IS NULL OR posts.lang_obj = '' OR posts.lang_obj = '{}')`;
    }
    if (table === 'product_option_groups') {
        return `SELECT product_option_groups.id, ${c} FROM product_option_groups
                  LEFT JOIN products ON product_option_groups.product_id = products.id
                 WHERE products.brand_id = ?
                   AND (product_option_groups.lang_obj IS NULL OR product_option_groups.lang_obj = '' OR product_option_groups.lang_obj = '{}')`;
    }
    if (table === 'product_options') {
        return `SELECT product_options.id, ${c} FROM product_options
                  LEFT JOIN product_option_groups ON product_options.group_id = product_option_groups.id
                  LEFT JOIN products ON product_option_groups.product_id = products.id
                 WHERE products.brand_id = ?
                   AND (product_options.lang_obj IS NULL OR product_options.lang_obj = '' OR product_options.lang_obj = '{}')`;
    }
    return `SELECT id, ${cols.join()} FROM ${table}
             WHERE brand_id = ?
               AND (lang_obj IS NULL OR lang_obj = '' OR lang_obj = '{}')`;
};

const run = async () => {
    // is_use_lang 은 setting_obj 안에 **문자열 "1"** 로 저장되는 경우가 많다.
    // JSON_EXTRACT(...) = 1 로 비교하면 문자열 "1" 이 걸리지 않아 전부 놓친다 —
    // JS 쪽에서 String() 으로 비교한다.
    let brands = await readPool.query(`SELECT id, name, setting_obj FROM brands WHERE is_delete = 0`);
    brands = brands[0].filter((b) => {
        try { return String(JSON.parse(b?.setting_obj ?? '{}')?.is_use_lang) === '1'; }
        catch (e) { return false; }
    });
    if (brands.length === 0) {
        console.log('언어팩을 켠 브랜드가 없습니다. 할 일 없음.');
        process.exit(0);
    }
    console.log(`언어팩 켠 브랜드 ${brands.length}곳`);

    let grand = 0;
    for (const brand of brands) {
        let rows_to_insert = [];
        for (const table of Object.keys(lang_obj_columns)) {
            const cols = lang_obj_columns[table];
            let items = await readPool.query(selectFor(table, cols), [brand.id]);
            items = items[0];
            for (const item of items) {
                // 원문이 하나도 없는 행은 번역할 것이 없다 — 대기열만 늘어난다.
                const has_text = cols.some((c) => String(item?.[c] ?? '').trim().length > 0);
                if (!has_text) continue;
                rows_to_insert.push([table, item.id, brand.id, JSON.stringify(item)]);
            }
        }
        // 이미 대기 중(is_confirm=0)인 건 다시 넣지 않는다 — 멱등하게 만든다.
        if (rows_to_insert.length > 0) {
            let pending = await readPool.query(
                `SELECT table_name, item_id FROM lang_processes WHERE brand_id = ? AND is_confirm = 0`, [brand.id]);
            const pending_set = new Set(pending[0].map((r) => `${r.table_name}:${r.item_id}`));
            rows_to_insert = rows_to_insert.filter((r) => !pending_set.has(`${r[0]}:${r[1]}`));
        }
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
