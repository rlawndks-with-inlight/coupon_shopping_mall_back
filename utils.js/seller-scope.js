'use strict';
import { readPool } from "../config/db-pool.js";
import logger from "./winston/index.js";

// 셀러 노출 범위(가격대·브랜드·카테고리·성별)는 users 의 seller_* 컬럼이다.
//
// 예전엔 로그인 토큰(decode_user)에 실린 값을 그대로 썼다. 토큰은 로그인할 때 찍히고
// 세션이 미끄러져도 옛 payload 를 다시 서명하므로, 관리자가 셀러의 범위를 바꿔도
// 그 셀러가 로그아웃하기 전까지 반영되지 않았다. 범위가 필요한 자리에서 DB 를 직접 읽는다.
export const loadSellerScope = async (user_id) => {
    if (!(Number(user_id) > 0)) return {};
    const [[row]] = await readPool.query(
        `SELECT seller_brand, seller_category, seller_property, seller_range_u, seller_range_o
           FROM users WHERE id=?`, [Number(user_id)]);
    return row ?? {};
};

// seller_brand·seller_category 는 문자열로 저장돼 있고 모양이 제각각이다:
//   '6788' · '6887, 6976' · '"6875"' (따옴표째 저장된 행이 있다 — 예전 폼이 JSON 문자열을 넣었다).
// 따옴표를 그대로 parseInt 하면 NaN 이 돼 그 id 가 조용히 빠졌다(→ '"6875"' 셀러는 필터 없이 전체 노출).
export const parseIdList = (v) => String(v ?? '')
    .replace(/["\[\]]/g, '')
    .split(',')
    .map((s) => parseInt(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

// 이 브랜드가 카테고리 정규화(브랜드=속성)를 마쳤는지.
export const isBrandPropertyMigrated = async (brand_id) => {
    try {
        const [[b]] = await readPool.query(`SELECT is_category_migrated FROM brands WHERE id=?`, [Number(brand_id) || 0]);
        return Number(b?.is_category_migrated) === 1;
    } catch (e) {
        return false; // 컬럼이 없는 환경 = 정규화 전
    }
};

// seller_brand 의 번호를 '브랜드 속성 번호' 로 맞춘다.
// 정규화 전에 저장된 값은 옛 카테고리 번호다 — 정규화가 남긴 대응표(_mig_cat_to_prop)로 바꾼다.
// 대응표에 없는 번호는 이미 속성 번호로 저장된 것으로 본다.
export const toBrandPropertyIds = async (brand_id, seller_brand) => {
    const ids = parseIdList(seller_brand);
    if (ids.length === 0) return [];
    try {
        const [rows] = await readPool.query(
            `SELECT category_id, property_id FROM _mig_cat_to_prop
              WHERE brand_id=? AND category_id IN (${ids.map(() => '?').join(',')})`,
            [Number(brand_id) || 0, ...ids]);
        const byCategory = new Map(rows.map((r) => [Number(r.category_id), Number(r.property_id)]));
        return [...new Set(ids.map((id) => byCategory.get(id) ?? id))];
    } catch (e) {
        logger.error('셀러 브랜드 대응표 조회 실패(속성 번호로 간주): ' + (e?.sqlMessage || e?.message || e));
        return ids;
    }
};

// 셀러 '노출 브랜드' 조건.
//
// 카테고리 정규화(2026-08-07)를 마친 브랜드(is_category_migrated=1)는 브랜드가 카테고리가 아니라
// 상품 속성('브랜드' 속성 그룹)이다. 상품 폼도 더는 category_id1 을 보내지 않아서,
// category_id1 로 거르면 정규화 이후 새로 등록한 상품이 브랜드 제한 셀러에게 전혀 안 보였다.
// → 속성 연결(products_and_properties)로 거른다. 옛 카테고리 번호로 저장된 셀러도
//   toBrandPropertyIds 가 바꿔 읽으므로 다시 저장하지 않아도 그대로 동작한다.
// 정규화를 안 한 브랜드는 예전처럼 category_id1 로 거른다.
export const sellerBrandCondition = async (brand_id, seller_brand, table = 'products') => {
    const ids = parseIdList(seller_brand);
    if (ids.length === 0) return { sql: '', params: [] };
    if (!(await isBrandPropertyMigrated(brand_id))) {
        return { sql: ` AND ${table}.category_id1 IN (${ids.map(() => '?').join(',')}) `, params: ids };
    }
    const propertyIds = await toBrandPropertyIds(brand_id, seller_brand);
    return {
        sql: ` AND ${table}.id IN (SELECT product_id FROM products_and_properties WHERE property_id IN (${propertyIds.map(() => '?').join(',')})) `,
        params: propertyIds,
    };
};
