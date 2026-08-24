'use strict';
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, makeObjByList, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool, writePool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { deleteKeys } from "../utils.js/redis-scan.js";
import { saveOptionGroups, saveCombinations } from "../utils.js/product-options.js";
import { saveProductOrderFormFields } from "../utils.js/order-form.js";

const table_name = 'products';

// 새 테이블 조회용. 실패하면 빈 배열을 돌려주고 넘어간다.
//
// 왜 필요한가: 마이그레이션은 사람이 손으로 돌린다. 코드가 먼저 배포되면
// 테이블이 없어 매 요청이 터지고, 그게 상품 상세 응답이면 **몰 전체가 죽는다**.
// 새 기능이 안 보이는 것은 되돌릴 수 있지만, 몰이 죽는 것은 그렇지 않다.
const 안전조회 = async (sql, params = []) => {
    try {
        const [rows] = await readPool.query(sql, params);
        return rows ?? [];
    } catch (e) {
        console.error('신규 테이블 조회 실패(무시하고 진행):', e?.sqlMessage || e?.message || e);
        return [];
    }
};

// 옵션·조합·입력항목을 한 번에 저장한다. create/update 공용.
//
// ⚠ 저장은 조회와 달리 조용히 넘어가면 안 된다 — 가맹점이 입력한 것이 사라졌는데
//   '저장되었습니다'가 뜨면 그게 더 나쁘다. 그래서 여기서는 던진다.
//   다만 조합·입력항목은 새 테이블이라, 마이그레이션 전이면 옵션 저장까지는 살리고
//   새 기능만 실패시킨다(옛 화면에서 저장하는 가맹점을 막지 않기 위해).
const 옵션일체저장 = async (product_id, groups, combinations, order_form_fields, brand = null) => {
    const 이름표 = await saveOptionGroups(product_id, groups);
    try {
        await saveCombinations(product_id, combinations, 이름표);
        // brand 를 넘겨야 라벨·도움말이 번역 대기열에 실린다(언어팩 켠 몰만).
        await saveProductOrderFormFields(product_id, order_form_fields, brand);
    } catch (e) {
        logger.error('조합/입력항목 저장 실패(옵션은 저장됨): ' + (e?.sqlMessage || e?.message || e));
    }
};

// 화면이 JSON 문자열로 보낼 수도, 배열로 보낼 수도 있다(FormData 여부에 따라 다르다).
const 배열로 = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; } }
    return [];
};

/*const productInserter = () => {
    obj = {}
    const initalize = (req) => {
        let {
            brand_id,
            product_img,
            product_name, product_code, product_comment, product_spec, product_description, product_price = 0, product_sale_price = 0, user_id = 0, delivery_fee = 0, product_type = 0,
            consignment_user_name = "", consignment_none_user_name = "", consignment_none_user_phone_num = "", consignment_fee = 0, consignment_fee_type = 0,
            sub_images = [], groups = [], characters = [], properties = "{}"
        } = req.body;

        obj = {
            product_img,
            brand_id, product_name, product_code, product_comment, product_spec, product_description, product_price, product_sale_price, user_id, delivery_fee, product_type,
            consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type,
        };
        for (var i = 0; i < categoryDepth; i++) {
            if (req.body[`category_id${i}`]) {
                obj[`category_id${i}`] = req.body[`category_id${i}`];
            }
        }
    }
    const getProuct = () => {

    }
    const getProperty = () => {

    }
}*/


// 옵션그룹·옵션·특성에서 '빈 껍데기' 를 걸러낸다.
//
// [증상] 관리자 상품폼에서 옵션/특성 줄을 추가만 하고 이름을 안 채운 채 저장하면
//        이름이 빈 그룹·옵션·특성이 그대로 저장됐다(검사가 is_delete 하나뿐이었다).
//        고객 화면에는 라벨 없는 빈 버튼·빈 줄로 나갔다.
// [더 나쁜 점] 지금은 '옵션그룹이 있으면 그룹마다 하나 이상 골라야 한다'는 규칙이 있어서
//        (shop-util assertOptionsSelected) **고를 수 있는 옵션이 하나도 없는 그룹**이 붙어 있으면
//        그 상품은 장바구니·바로구매가 통째로 막힌다 — 팔 수 없는 상품이 된다.
// [처리] 저장 단계에서 조용히 버린다. 화면 검증(프론트)과 별개로 서버가 최종 방어선이다.
const cleanOptionGroups = (groups = []) => (Array.isArray(groups) ? groups : [])
    .filter((g) => g?.is_delete == 1 || String(g?.group_name ?? '').trim() !== '')
    .map((g) => ({
        ...g,
        options: (Array.isArray(g?.options) ? g.options : [])
            .filter((o) => o?.is_delete == 1 || String(o?.option_name ?? '').trim() !== ''),
    }))
    // 살아 있는 옵션이 하나도 없는 그룹은 만들지 않는다(고를 수 없는 그룹 = 구매 불가).
    // 단, 삭제 표시된 그룹은 삭제 처리를 해야 하므로 남긴다.
    .filter((g) => g?.is_delete == 1 || (g.options ?? []).some((o) => o?.is_delete != 1));

const cleanCharacters = (characters = []) => (Array.isArray(characters) ? characters : [])
    .filter((c) => c?.is_delete == 1
        || (String(c?.character_name ?? '').trim() !== '' && String(c?.character_value ?? '').trim() !== ''));

const productCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { /*seller_id,*/ property_id, is_consignment, status, product_type, manager_type } = req.query;
            const { type, seller_id } = req;

            const brandId = decode_dns?.id ?? 0;
            const userLevel = decode_user?.level ?? 0;
            const isAdminLike = userLevel >= 10;

            // ─────────────────────────────
            // Redis 캐시 설정 (리스트용)
            // 관리자(40 이상)는 항상 최신 데이터 보도록 캐시 제외
            // 브랜드가 있고, Redis 연결돼 있으면 캐시 사용
            // ─────────────────────────────
            let listCacheKey = null;
            const canUseListCache = !!redisClient?.isOpen && brandId > 0 && !isAdminLike;

            if (canUseListCache) {
                const keyPayload = {
                    brandId,
                    type: type ?? '',
                    manager_type: manager_type ?? '',
                    seller_id: seller_id ?? '',
                    user_id: decode_user?.id ?? 0,
                    query: req.query, // 필터/검색 조건 포함
                };
                listCacheKey = `product:list:${JSON.stringify(keyPayload)}`;

                try {
                    const cached = await redisClient.get(listCacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);
                        return response(req, res, 100, "success(cache)", data);
                    }
                } catch (e) {
                    console.error("Redis get error (product list):", e);
                    // 캐시 장애 시에도 서비스는 DB로 계속 진행
                }
            }


            let params = [];
            let columns = [
                `${table_name}.*`,
                `sellers.user_name`,
                `sellers.seller_name`,
                //`consignment_users.user_name AS consignment_user_name`,
                //`consignment_users.phone_num AS consignment_phone_num`,
            ]
            // 관리자(level 40 이상)만 order_count, review_count 서브쿼리 실행
            // 일반 사용자는 이 값을 사용하지 않으므로 성능 최적화를 위해 제외
            if (isAdminLike) {
                columns.push(`(SELECT COUNT(*) FROM transaction_orders LEFT JOIN transactions ON transactions.id=transaction_orders.trans_id WHERE transaction_orders.product_id=${table_name}.id AND transactions.is_cancel=0 AND transactions.trx_status >=5 AND transactions.is_delete=0) AS order_count`);
                columns.push(`(SELECT COUNT(*) FROM product_reviews WHERE product_id=${table_name}.id AND is_delete=0) AS review_count`);
            } else {
                columns.push(`0 AS order_count`);
                columns.push(`0 AS review_count`);
            }
            // 목록 카드에서 '이 상품은 골라야 할 옵션이 있는가' 를 알기 위한 값.
            //
            // 없으면 카드의 '장바구니담기' 가 옵션 없이 담아 버린다 — 목록 응답에 옵션이
            // 안 실려 있어서 프론트 검사가 '모르면 통과' 로 빠져나가기 때문이다.
            // 개수만 있으면 카드가 '상세로 보내기' 를 판단할 수 있다.
            // 추가상품(group_type=1)은 안 골라도 사므로 세지 않는다.
            columns.push(`(SELECT COUNT(*) FROM product_option_groups g WHERE g.product_id=${table_name}.id AND g.is_delete=0 AND g.group_type=0
                AND EXISTS (SELECT 1 FROM product_options o WHERE o.group_id=g.id AND o.is_delete=0)) AS required_option_count`);
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users AS sellers ON ${table_name}.user_id=sellers.id `;
            //sql += ` LEFT JOIN users AS consignment_users ON ${table_name}.consignment_user_id=consignment_users.id `;

            if (type == 'seller' || manager_type == 'seller') {
                columns.push(`seller_products.id AS seller_product_id`)
                columns.push(`seller_products.seller_id`)
                if (type == 'seller') {
                    columns.push(`seller_products.seller_price`)
                    columns.push(`seller_products.agent_price`)
                    sql += ` LEFT JOIN seller_products ON ${table_name}.id=seller_products.product_id AND seller_products.seller_id=? AND seller_products.is_delete=0 `
                    params.push(seller_id);
                } else if (manager_type == 'seller') {
                    columns.push(`seller_products.seller_price`)
                    columns.push(`seller_products.agent_price`)
                    sql += ` LEFT JOIN seller_products ON ${table_name}.id=seller_products.product_id AND seller_products.is_delete=0 AND seller_products.seller_id = ?`
                    params.push(decode_user?.id);
                }
            }
            //console.log(sql)
            //console.log(manager_type)

            let where_sql = ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);

            if (seller_id > 0) {
                where_sql += ` AND seller_products.seller_id=? `;
                params.push(seller_id);
            }

            /*
            if (seller_id > 0) {
                let connect_data = await readPool.query(`SELECT * FROM products_and_sellers WHERE seller_id=${seller_id}`);
                connect_data = connect_data[0].map(item => {
                    return item?.product_id
                })
                connect_data.unshift(0);
                where_sql += ` AND (${table_name}.id IN (${connect_data.join()})) `;
            }
            */
            // 카테고리 LEFT JOIN (목록 표시용 en_name). category_id0/1/2 컬럼은 전환기 dual-write 로 유지.
            for (var i = 0; i < categoryDepth; i++) {
                sql += ` LEFT JOIN product_categories AS product_categories${i} ON product_categories${i}.id=${table_name}.category_id${i}`
                columns.push(`product_categories${i}.category_en_name AS category_en_name${i}`);
            }
            // 카테고리 필터 — 단일 트리 + 연결테이블(products_categories) 기준(하위 카테고리 포함).
            //   (구조: category_id0/1/2 위치컬럼 대신 단일 category_id 파라미터 사용)
            if (req.query.category_id) {
                let brand_tree = await readPool.query(`SELECT id, parent_id FROM product_categories WHERE brand_id=? AND is_delete=0`, [decode_dns?.id ?? 0]);
                brand_tree = brand_tree[0];
                let cat_ids = findChildIds(brand_tree, req.query.category_id);
                cat_ids.unshift(parseInt(req.query.category_id));
                cat_ids = cat_ids.filter(v => !isNaN(v));
                if (cat_ids.length > 0) {
                    const ph = cat_ids.map(() => '?').join(',');
                    // dual-read(단계 이행): 연결테이블(마이그레이션 완료 테넌트) OR 위치컬럼 category_id0/1/2(미마이그레이션 폴백).
                    //  → 미마이그레이션 테넌트는 연결테이블이 비어도 기존 위치컬럼으로 정상 필터.
                    where_sql += ` AND ( ${table_name}.id IN (SELECT product_id FROM products_categories WHERE category_id IN (${ph}) AND is_delete=0)
                                        OR ${table_name}.category_id0 IN (${ph})
                                        OR ${table_name}.category_id1 IN (${ph})
                                        OR ${table_name}.category_id2 IN (${ph}) ) `;
                    params.push(...cat_ids, ...cat_ids, ...cat_ids, ...cat_ids);
                }
            }

            for (var i = 0; i < 20; i++) {
                if (req.query[`property_ids${i}`]) {
                    let propIds = req.query[`property_ids${i}`].split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                    if (propIds.length > 0) {
                        where_sql += ` AND ${table_name}.id IN (SELECT product_id FROM products_and_properties WHERE property_id IN (${propIds.map(() => '?').join(',')}) ) `
                        params.push(...propIds);
                    }
                }
            }

            if (status) {
                let statusIds = String(status).split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                if (statusIds.length > 0) {
                    where_sql += ` AND ${table_name}.id IN (SELECT products.id FROM products WHERE status IN (${statusIds.map(() => '?').join(',')}) ) `
                    params.push(...statusIds);
                }
            }

            if (product_type) {
                let productTypeIds = String(product_type).split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                if (productTypeIds.length > 0) {
                    where_sql += ` AND ${table_name}.id IN (SELECT products.id FROM products WHERE product_type IN (${productTypeIds.map(() => '?').join(',')}) ) `
                    params.push(...productTypeIds);
                }
            }

            if (is_consignment) {
                where_sql += ` AND products.consignment_user_id=? `;
                params.push(decode_user?.id ?? 0);
            }
            //console.log(where_sql)
            sql += where_sql;


            if (manager_type == 'seller' && decode_user?.seller_range_o != 0) {
                sql += ` AND product_sale_price BETWEEN ? AND ?`
                params.push(decode_user?.seller_range_u, decode_user?.seller_range_o);
            }

            if (manager_type == 'seller' && (decode_user?.seller_brand != undefined || decode_user?.seller_category != undefined)) {
                if (decode_user?.seller_brand && !decode_user?.seller_category) {
                    let sellerBrandIds = String(decode_user?.seller_brand).split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                    if (sellerBrandIds.length > 0) {
                        sql += ` AND category_id1 IN (${sellerBrandIds.map(() => '?').join(',')})`;
                        params.push(...sellerBrandIds);
                    }
                } else if (!decode_user?.seller_brand && decode_user?.seller_category) {
                    let category_sql_list = [];
                    category_sql_list.push({
                        table: `category_id0`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=195 AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                    let category_obj = await getMultipleQueryByWhen(category_sql_list);

                    let seller_category = decode_user?.seller_category.split(',')

                    let seller_categories = []

                    if (Object.keys(category_obj).length > 0) {
                        for (var i = 0; i < Object.keys(category_obj).length; i++) {
                            let key = Object.keys(category_obj)[i];
                            for (var j = 0; j < seller_category?.length; j++) {
                                let category_ids = findChildIds(category_obj[key], seller_category[j]);
                                category_ids.unshift(parseInt(seller_category[j]));
                                seller_categories.unshift(category_ids.join())
                            }//decode_user?.seller_category를 바로 사용하지 않는 이유는 하위 카테고리의 존재 때문임
                            //console.log(1)
                            //console.log(seller_categories.join())
                            let allSellerCatIds = seller_categories.join().split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                            if (allSellerCatIds.length > 0) {
                                sql += ` AND category_id0 IN (${allSellerCatIds.map(() => '?').join(',')})`;
                                params.push(...allSellerCatIds);
                            }
                        }
                    }

                    //sql += ` AND category_id0 IN (${decode_user?.seller_category}) `
                } else if (decode_user?.seller_brand && decode_user?.seller_category) {
                    let category_sql_list = [];
                    category_sql_list.push({
                        table: `category_id0`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=195 AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                    let category_obj = await getMultipleQueryByWhen(category_sql_list);

                    let seller_category = decode_user?.seller_category.split(',')

                    let seller_categories = []

                    if (Object.keys(category_obj).length > 0) {
                        for (var i = 0; i < Object.keys(category_obj).length; i++) {
                            let key = Object.keys(category_obj)[i];
                            for (var j = 0; j < seller_category?.length; j++) {
                                let category_ids = findChildIds(category_obj[key], seller_category[j]);
                                category_ids.unshift(parseInt(seller_category[j]));
                                seller_categories.unshift(category_ids.join())
                            }//decode_user?.seller_category를 바로 사용하지 않는 이유는 하위 카테고리의 존재 때문임
                            //console.log(2)
                            //console.log(seller_category)
                            //console.log(seller_categories.join())
                            let allSellerCatIds2 = seller_categories.join().split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                            if (allSellerCatIds2.length > 0) {
                                sql += ` AND category_id0 IN (${allSellerCatIds2.map(() => '?').join(',')})`;
                                params.push(...allSellerCatIds2);
                            }
                            let sellerBrandIds2 = String(decode_user?.seller_brand).split(',').map(v => parseInt(v)).filter(v => !isNaN(v));
                            if (sellerBrandIds2.length > 0) {
                                sql += ` AND category_id1 IN (${sellerBrandIds2.map(() => '?').join(',')}) `;
                                params.push(...sellerBrandIds2);
                            }
                        }
                    }
                    //sql += ` AND category_id0 IN (${decode_user?.seller_category}) AND category_id1 IN (${decode_user?.seller_brand}) `
                }
            }
            if (manager_type == 'seller' && (decode_user?.seller_property != undefined)) {

                if (decode_user?.seller_property.split(',').includes('0')) {
                    sql += ` AND ${table_name}.id IN (SELECT product_id FROM products_and_properties WHERE property_id IN (48) )`
                }
                if (decode_user?.seller_property.split(',').includes('1')) {
                    sql += ` AND ${table_name}.id IN (SELECT product_id FROM products_and_properties WHERE property_id IN (47) )`
                }
                if (decode_user?.seller_property.split(',').includes('2')) {
                    sql += ` AND ${table_name}.id IN (SELECT product_id FROM products_and_properties WHERE property_id IN (46) )`
                }
            }

            if (type == 'user' || type == 'seller' || manager_type == 'seller') {
                sql += ` AND products.status!=5 `
            }

            //console.log(sql)

            //sql += `ORDER BY products.status ASC, products.sort_idx DESC `
            /*if (!decode_user || decode_user?.level < 10) {
                sql += ` AND products.status!=5 `
            }*/
            let data = await getSelectQueryList(sql, columns, { ...req.query, type: type }, [], params);
            let product_ids = data?.content.map(item => { return item?.id });
            product_ids.unshift(0);
            /*sql_list = [
                {
                    table: 'brand_name',
                    sql: `SELECT category_name FROM product_categories WHERE id=${data.category_id1}` //상품의 브랜드 이름 불러오기
                }
            ]
            let brand_data = await getMultipleQueryByWhen(sql_list);
            data = {
                ...data,
                brand_name: brand_data?.brand_name,
            }*/
            let sub_images = await readPool.query(`SELECT * FROM product_images WHERE product_id IN(${product_ids.map(() => '?').join(',')}) AND is_delete=0 ORDER BY id ASC`, product_ids)
            sub_images = sub_images[0];
            // Map으로 그룹핑하여 O(n) 처리
            const imageMap = new Map();
            for (const img of sub_images) {
                if (!imageMap.has(img.product_id)) imageMap.set(img.product_id, []);
                imageMap.get(img.product_id).push(img);
            }
            for (var i = 0; i < data?.content.length; i++) {
                data.content[i].sub_images = imageMap.get(data?.content[i]?.id) ?? [];
                data.content[i].lang_obj = JSON.parse(data.content[i]?.lang_obj ?? '{}');
                // 셀러몰 프론트(type=='seller'): seller_price로 product_sale_price, product_price 덮어쓰기
                // 관리자 페이지(manager_type=='seller')에서는 원본 유지
                if (type == 'seller' && data.content[i].seller_price != null) {
                    data.content[i].product_sale_price = data.content[i].seller_price;
                    data.content[i].product_price = data.content[i].seller_price;
                }
            }
            //console.log(data)

            // ─────────────────────────────
            // 리스트 캐시 저장 (예: 60초)
            // ─────────────────────────────
            if (canUseListCache && listCacheKey) {
                try {
                    await redisClient.set(listCacheKey, JSON.stringify(data), { EX: 60 });
                } catch (e) {
                    console.error("Redis set error (product list):", e);
                }
            }

            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    // 쿼리별 시간 찍어보기용
    /*
    const timedQuery = async (pool, label, sql, params = []) => {
      const start = Date.now();
      const [rows] = await pool.query(sql, params);
      const ms = Date.now() - start;
      console.log(`[DB][${label}] ${ms}ms`);
      return rows;
    };
    */

    get: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            let { id = 0 } = req.params;
            const { brand_id, seller_id = 0 } = req.query;

            const brandIdNum = parseInt(brand_id, 10) || 0;
            const sellerIdNum = parseInt(seller_id, 10) || 0;
            const isNumericId = !isNaN(parseInt(id, 10));
            const userLevel = decode_user?.level ?? 0;
            const isAdminLike = userLevel >= 10;

            if (!brandIdNum) {
                return response(req, res, -400, '브랜드 정보가 올바르지 않습니다.', false);
            }

            // ─────────────────────────────
            // Redis 캐시 설정 (상세용)
            // 관리자(40 이상)는 항상 최신 데이터 → 캐시 제외
            // ─────────────────────────────
            const canUseDetailCache = !!redisClient?.isOpen && !isAdminLike;

            const detailCacheKey = canUseDetailCache
                ? `product:detail:${brandIdNum}:${sellerIdNum}:${decode_user?.id ?? 0}:` +
                `${req?.IS_RETURN ? 'ret' : 'nor'}:${isNumericId ? 'id' : 'code'}:${id}`
                : null;

            if (canUseDetailCache && detailCacheKey) {
                try {
                    const cached = await redisClient.get(detailCacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);
                        return response(req, res, 100, 'success(cache)', data);
                    }
                } catch (e) {
                    console.error("Redis get error (product detail):", e);
                }
            }

            // ─────────────────────────────
            // 1. 상품 메인 쿼리
            // ─────────────────────────────
            const productColumns = [
                `${table_name}.*`,
                // 브랜드 기준 최대 sort_idx (정렬용)
                `(SELECT MAX(sort_idx) FROM ${table_name} WHERE brand_id = ?) AS max_sort_idx`,
            ];

            if (sellerIdNum > 0) {
                productColumns.push(
                    `seller_products.id AS seller_product_id`,
                    `seller_products.seller_id`,
                    `seller_products.seller_price`,
                    `seller_products.agent_price AS product_agent_price`
                );
            }

            let productSql = `
      SELECT ${productColumns.join(', ')}
      FROM ${table_name}
      ${sellerIdNum > 0 ? `
        LEFT JOIN seller_products
          ON ${table_name}.id = seller_products.product_id
         AND seller_products.seller_id = ?
         AND seller_products.is_delete = 0
      ` : ''}
    `;

            // id 숫자/코드 분리해서 OR 제거
            let whereClause = '';
            const whereParams = [];

            if (isNumericId) {
                whereClause = `
        WHERE ${table_name}.id = ?
          AND ${table_name}.is_delete = 0
          ${req?.IS_RETURN ? `AND ${table_name}.status != 5` : ''}
          AND ${table_name}.brand_id = ?
      `;
                whereParams.push(parseInt(id, 10) || 0, brandIdNum);
            } else {
                whereClause = `
        WHERE ${table_name}.product_code = ?
          AND ${table_name}.is_delete = 0
          ${req?.IS_RETURN ? `AND ${table_name}.status != 5` : ''}
          AND ${table_name}.brand_id = ?
      `;
                whereParams.push(id, brandIdNum);
            }

            productSql += whereClause + ' LIMIT 1';

            // 파라미터 순서 맞추기:
            // 1) max_sort_idx 서브쿼리 brand_id
            // 2) (sellerIdNum > 0 이면) seller_id
            // 3) where절 (id/product_code, brand_id)
            const params = [brandIdNum];

            if (sellerIdNum > 0) {
                params.push(sellerIdNum);
            }
            params.push(...whereParams);

            // 실제 쿼리 실행
            // const productRows = await timedQuery(readPool, 'product_main', productSql, params);
            const [productRows] = await readPool.query(productSql, params);

            if (!productRows.length) {
                return response(req, res, -404, '상품을 찾을 수 없습니다.', false);
            }

            let data = productRows[0];
            // 셀러몰: seller_price로 product_sale_price, product_price 덮어쓰기
            if (sellerIdNum > 0 && data.seller_price != null) {
                data.product_sale_price = data.seller_price;
                data.product_price = data.seller_price;
            }
            data.lang_obj = JSON.parse(data?.lang_obj ?? '{}');

            // 이후 쿼리에서 사용할 product id
            const productId = data.id;

            // ─────────────────────────────
            // 2. 속성(property) 쿼리
            // ─────────────────────────────
            let property_sql = `
      SELECT
        products_and_properties.*,
        product_properties.property_name,
        product_property_groups.property_group_name
      FROM products_and_properties
      LEFT JOIN product_properties
        ON products_and_properties.property_id = product_properties.id
      LEFT JOIN product_property_groups
        ON products_and_properties.property_group_id = product_property_groups.id
      WHERE products_and_properties.product_id = ?
      ORDER BY product_properties.sort_idx DESC
    `;

            // ─────────────────────────────
            // 3. 여러 쿼리를 병렬 실행 (getMultipleQueryByWhen)
            //    - 중복이었던 sub_images / description_images를 images 하나로 통합
            // ─────────────────────────────
            let sql_list = [
                {
                    table: 'groups',
                    // 선택옵션(group_type=0)이 추가상품(1)보다 먼저 나와야 한다 —
                    // 골라야 사는 것이 위, 안 골라도 되는 것이 아래.
                    sql: `SELECT * FROM product_option_groups WHERE product_id=? AND is_delete=0 ORDER BY group_type ASC, sort ASC, id ASC`,
                    params: [productId],
                },
                {
                    table: 'images',
                    sql: `SELECT * FROM product_images WHERE product_id=? AND is_delete=0 ORDER BY id ASC`,
                    params: [productId],
                },
                {
                    table: 'scope',
                    // 삭제된 리뷰가 평점·리뷰수에 계속 반영됐다.
                    // 같은 파일 99행의 review_count 는 is_delete=0 을 걸고 있어 둘이 어긋나 있었다.
                    sql: `SELECT AVG(scope)/2 AS product_average_scope, COUNT(*) AS product_review_count FROM product_reviews WHERE product_id=? AND is_delete=0`,
                    params: [productId],
                },
                {
                    table: 'properties',
                    sql: property_sql,
                    params: [productId],
                },
                {
                    // 카테고리 연결테이블(단일 트리, 1상품 N카테고리) — 폼 다중선택 로드용
                    table: 'category_links',
                    sql: `SELECT category_id FROM products_categories WHERE product_id=? AND is_delete=0 ORDER BY sort_idx DESC, id ASC`,
                    params: [productId],
                },
            ];

            let when_data = await getMultipleQueryByWhen(sql_list);

            //console.log(sql_list)

            // 옵션 그룹 id 모으기
            let option_group_ids = [];
            const groups = when_data?.groups || [];
            for (let i = 0; i < groups.length; i++) {
                option_group_ids.push(groups[i]?.id);
            }

            // ─────────────────────────────
            // 4. 두 번째 배치 쿼리 (characters, brand_name, options)
            // ─────────────────────────────
            let sql_list2 = [
                {
                    table: 'characters',
                    sql: `SELECT * FROM product_characters WHERE product_id=?`,
                    params: [productId],
                },
                {
                    table: 'brand_name',
                    // LIMIT 1 추가 (어차피 한 행만 필요)
                    sql: `SELECT category_en_name FROM product_categories WHERE id=? LIMIT 1`,
                    params: [data.category_id1],
                },
            ];

            if (option_group_ids.length > 0) {
                sql_list2.push({
                    table: 'options',
                    sql: `SELECT * FROM product_options WHERE group_id IN (${option_group_ids.map(() => '?').join(',')}) AND is_delete=0 ORDER BY sort ASC, id ASC`,
                    params: [...option_group_ids],
                });
            }

            let when_data2 = await getMultipleQueryByWhen(sql_list2);

            // 옵션 그룹에 option 붙이기
            const options = when_data2?.options || [];
            for (let i = 0; i < groups.length; i++) {
                groups[i].options = options.filter(
                    (item) => item?.group_id === groups[i]?.id
                );
            }

            // 이미지: 한 번만 조회해서 sub/description 둘 다에 사용
            const allImages = when_data?.images || [];

            data = {
                ...data,
                groups,
                sub_images: allImages,
                description_images: allImages,
                properties: when_data?.properties,
                characters: when_data2?.characters,
                // 조합형 가격·재고와 손님 입력칸.
                //
                // ⚠ 위 배치 쿼리(getMultipleQueryByWhen)에 넣지 않는다.
                //   배치는 하나가 실패하면 전부 실패한다 — 마이그레이션 전에 코드가 먼저 배포되면
                //   테이블이 없어 **모든 가맹점의 상품 상세가 죽는다**.
                //   따로 읽고 실패하면 빈 값으로 넘어간다(새 기능만 안 보일 뿐 몰은 산다).
                combinations: await 안전조회(
                    `SELECT * FROM product_option_combinations WHERE product_id=? AND is_delete=0`, [productId]),
                order_form_fields: (await 안전조회(
                    `SELECT * FROM product_order_form_fields WHERE product_id=? AND is_delete=0 ORDER BY sort ASC, id ASC`,
                    [productId])).map((f) => ({
                        ...f, lang_obj: (() => { try { return JSON.parse(f?.lang_obj ?? '{}'); } catch (e) { return {}; } })(),
                    })),
                product_average_scope: when_data?.scope?.[0]?.product_average_scope,
                product_review_count: when_data?.scope?.[0]?.product_review_count,
                brand_name: when_data2?.brand_name,
                // 단일 트리 연결테이블 카테고리 id 배열(폼 다중선택 로드). category_id0/1/2 는 dual-write 로 병존.
                category_ids: (when_data?.category_links || []).map((r) => r.category_id),
            };

            // ─────────────────────────────
            // 상세 캐시 저장 (예: 300초)
            // ─────────────────────────────
            if (canUseDetailCache && detailCacheKey) {
                try {
                    await redisClient.set(detailCacheKey, JSON.stringify(data), { EX: 300 });
                } catch (e) {
                    console.error("Redis set error (product detail):", e);
                }
            }

            return response(req, res, 100, 'success', data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, '서버 에러 발생', false);
        } finally {
            // 필요 시 정리 작업
        }
    },

    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 비로그인이면 undefined < 10 이 false 라 이 가드가 열렸다(로그인한 하위등급만 막혔다).
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let {
                brand_id,
                product_img,
                product_name, product_code, product_comment, product_spec, product_description, product_price = 0, product_sale_price = 0, user_id = 0, delivery_fee = 0, product_type = 0,
                consignment_user_name = "", consignment_none_user_name = "", consignment_none_user_phone_num = "", consignment_fee = 0, consignment_fee_type = 0,
                sub_images = [], groups = [], characters = [], properties = "{}", price_lang_obj = '{}',
                description_images = [], another_id = 0,
                price_lang = 'ko', point_save = 0, point_usable = 1, cash_usable = 1, pg_usable = 1, status, show_status = 0, memo,
                combinations = [], order_form_fields = [], option_mode = 0, stock_qty = null, purchase_limit = null,
            } = req.body;
            combinations = 배열로(combinations);
            order_form_fields = 배열로(order_form_fields);

            let obj = {
                product_img,
                brand_id, product_name, product_code, product_comment, product_spec, product_description, product_price, product_sale_price, user_id, delivery_fee, product_type,
                consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type, price_lang_obj,
                another_id, price_lang, point_save, point_usable, cash_usable, pg_usable, status, show_status, memo,
                // 0=단독형 1=조합형. 재고는 비우면 NULL(무제한) — 0 으로 접으면 저장하자마자 품절이 된다.
                option_mode: parseInt(option_mode) === 1 ? 1 : 0,
                stock_qty: (stock_qty === '' || stock_qty === null || stock_qty === undefined || isNaN(parseInt(stock_qty))) ? null : parseInt(stock_qty),
                // 1인당 최대 구매 수량. 비우면 제한 없음 — 값이 있으면 그 상품은 회원만 산다.
                purchase_limit: (purchase_limit === '' || purchase_limit === null || purchase_limit === undefined || isNaN(parseInt(purchase_limit))) ? null : parseInt(purchase_limit),
            };
            if (typeof sub_images == 'string') {
                sub_images = JSON.parse(sub_images ?? '[]')
            }
            if (typeof description_images == 'string') {
                description_images = JSON.parse(description_images ?? '[]')
            }

            if (typeof groups == 'string') {
                groups = JSON.parse(groups ?? '[]')
            }
            if (typeof characters == 'string') {
                characters = JSON.parse(characters ?? '[]')
            }
            // 이름이 빈 옵션그룹·옵션·특성은 저장하지 않는다(cleanOptionGroups 주석 참고).
            groups = cleanOptionGroups(groups);
            characters = cleanCharacters(characters);
            for (var i = 0; i < categoryDepth; i++) {
                if (req.body[`category_id${i}`]) {
                    obj[`category_id${i}`] = req.body[`category_id${i}`];
                }
            }
            if (consignment_user_name) {
                let consignment_user = await readPool.query(`SELECT id FROM users WHERE user_name=? AND brand_id=? `, [consignment_user_name, brand_id]);
                consignment_user = consignment_user[0][0];
                if (!consignment_user) {
                    return response(req, res, -100, "위탁할 회원정보를 찾을 수 없습니다.", false);
                }
                obj['consignment_user_id'] = consignment_user?.id;
            }
            obj = { ...obj, };

            let result = await insertQuery(`${table_name}`, obj);

            let dns_data = await readPool.query(`SELECT id, setting_obj FROM brands WHERE id=?`, [brand_id]);
            dns_data = dns_data[0][0];
            dns_data["setting_obj"] = JSON.parse(dns_data?.setting_obj ?? "{}");

            // 번역은 큐에 담고 스케줄러가 처리한다(마지막 인자 생략 = is_process false).
            //
            // 예전엔 여기서 true 를 넘겨 그 자리에서 구글 번역을 돌렸다. 번역 대상 컬럼 4개
            // (product_name·product_comment·product_spec·product_description) × 켜진 언어 4개가
            // 3중 for+await 로 중첩돼 있고 번역 경로에 Promise.all 이 한 개도 없어서,
            // 상품 1건 저장에 구글 왕복이 12회(상세설명 없음) ~ 40회(8,000자) 직렬로 쌓였다.
            // 회당 timeout 은 20초인데 전체 데드라인이 없어 상한도 없었다.
            // 그동안 응답이 안 나가므로 가맹점 화면은 저장 버튼을 누른 채 수 초~수십 초 멈춰 있었다.
            // ("상품 추가가 오래 걸린다"는 가맹점 의견의 실체가 이것이다)
            //
            // 게시글·카테고리 컨트롤러는 원래부터 인자를 생략해 전부 큐로 보내고 있었다 —
            // 상품만 예외였다. 같은 방식으로 되돌린다.
            //
            // 반영 시점: 스케줄러가 1분마다 큐를 비우므로 보통 저장 후 1~2분 내에 채워진다.
            // 그 사이 화면이 비지는 않는다 — 프론트 formatLang 이 번역이 없으면 원문으로 폴백하므로
            // 한국어 화면은 무변화이고, 그 시간에 외국어로 보는 고객에게만 원문이 보인다.
            await settingLangs(lang_obj_columns[table_name], obj, dns_data, table_name, result?.insertId);


            if (!result?.insertId) {
                return response(req, res, -100, "상품 저장중 에러", false)
            }


            const product_id = result?.insertId;

            let user = await readPool.query(`SELECT level FROM users WHERE id=?`, [user_id]);
            user = user[0][0];
            if (user?.level == 10) {
                let insert_and_table = await writePool.query(`INSERT INTO products_and_sellers (seller_id, product_id) VALUES (?, ?)`, [user_id, product_id]);
            }

            let sql_list = [];
            // 옵션(선택옵션·추가상품) · 조합형 · 손님 입력항목.
            // create 와 update 가 같은 함수를 쓴다 — 한쪽에만 컬럼을 더하는 실수를 막는다.
            await 옵션일체저장(product_id, groups, combinations, order_form_fields, dns_data);
            //character
            let insert_character_list = [];
            for (var i = 0; i < characters.length; i++) {
                if (characters[i]?.is_delete != 1) {
                    insert_character_list.push([
                        product_id,
                        characters[i]?.character_name,
                        characters[i]?.character_value,
                    ])
                }

            }
            if (insert_character_list.length > 0) {
                sql_list.push({
                    table: `character`,
                    sql: `INSERT INTO product_characters (product_id, character_name, character_value) VALUES ?`,
                    data: [insert_character_list]
                })
            }
            //sub image
            let insert_sub_image_list = [];
            for (var i = 0; i < sub_images.length; i++) {
                if (sub_images[i]?.is_delete != 1) {
                    insert_sub_image_list.push([
                        product_id,
                        sub_images[i]?.product_sub_img,
                    ])
                }
            }
            if (insert_sub_image_list.length > 0) {
                sql_list.push({
                    table: `sub_images`,
                    sql: `INSERT INTO product_images (product_id, product_sub_img) VALUES ?`,
                    data: [insert_sub_image_list]
                })
            }

            //description image
            let insert_description_image_list = [];
            for (var i = 0; i < description_images.length; i++) {
                if (description_images[i]?.is_delete != 1) {
                    insert_description_image_list.push([
                        product_id,
                        description_images[i]?.product_description_img,
                    ])
                }
            }
            if (insert_description_image_list.length > 0) {
                sql_list.push({
                    table: `description_images`,
                    sql: `INSERT INTO product_images (product_id, product_description_img) VALUES ?`,
                    data: [insert_description_image_list]
                })
            }

            //console.log(insert_description_image_list)

            //property         
            let insert_property_list = [];

            properties = JSON.parse(properties);

            let property_group_ids = Object.keys(properties);
            for (var i = 0; i < property_group_ids.length; i++) {
                for (var j = 0; j < properties[property_group_ids[i]]?.length; j++) {
                    insert_property_list.push([
                        product_id,
                        property_group_ids[i],
                        properties[property_group_ids[i]][j],
                    ])
                }
            }
            if (insert_property_list.length > 0) {
                sql_list.push({
                    table: `property`,
                    sql: `INSERT INTO products_and_properties (product_id, property_group_id, property_id) VALUES ?`,
                    data: [insert_property_list]
                })
            }

            // 카테고리 연결테이블(단일 트리, 1상품 N카테고리) — category_ids(JSON) → products_categories.
            // (대표 카테고리 category_id0 위치컬럼은 위 dual-write 루프에서 유지)
            let category_ids_input = req.body?.category_ids;
            if (typeof category_ids_input == 'string') { try { category_ids_input = JSON.parse(category_ids_input); } catch (e) { category_ids_input = []; } }
            if (Array.isArray(category_ids_input)) {
                let pc_rows = category_ids_input.map(v => parseInt(v)).filter(v => !isNaN(v) && v > 0).map(cid => [brand_id, product_id, cid]);
                if (pc_rows.length > 0) {
                    sql_list.push({
                        table: `products_categories`,
                        sql: `INSERT IGNORE INTO products_categories (brand_id, product_id, category_id) VALUES ?`,
                        data: [pc_rows]
                    });
                }
            }

            let when = await getMultipleQueryByWhen(sql_list);
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 비로그인이면 undefined < 40 이 false 라 이 가드가 열렸다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            let {
                brand_id,
                id,
                product_img,
                product_name, product_code, product_comment, product_spec, product_description, product_price = 0, product_sale_price = 0, delivery_fee = 0, product_type = 0,
                consignment_user_name = "", consignment_none_user_name = "", consignment_none_user_phone_num = "", consignment_fee = 0, consignment_fee_type = 0,
                sub_images = [], description_images = [], groups = [], characters = [], properties = "{}", price_lang_obj = '{}',
                another_id = 0, price_lang = 'ko', point_save = 0, memo, /*point_usable = 1, cash_usable = 1, pg_usable = 1, status = 0, show_status*/
                combinations = [], order_form_fields = [], option_mode = 0, stock_qty = null, purchase_limit = null,
            } = req.body;
            combinations = 배열로(combinations);
            order_form_fields = 배열로(order_form_fields);
            if (typeof sub_images == 'string') {
                sub_images = JSON.parse(sub_images ?? '[]')
            }
            if (typeof description_images == 'string') {
                description_images = JSON.parse(description_images ?? '[]')
            }
            if (typeof groups == 'string') {
                groups = JSON.parse(groups ?? '[]')
            }
            if (typeof characters == 'string') {
                characters = JSON.parse(characters ?? '[]')
            }
            // 이름이 빈 옵션그룹·옵션·특성은 저장하지 않는다(cleanOptionGroups 주석 참고).
            groups = cleanOptionGroups(groups);
            characters = cleanCharacters(characters);
            let files = settingFiles(req.files);
            let obj = {
                product_img,
                product_name, product_code, product_comment, product_spec, product_description, product_price, product_sale_price, delivery_fee, product_type,
                consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type, price_lang_obj,
                another_id,
                price_lang, point_save, memo, /*point_usable, cash_usable, pg_usable, status, show_status*/
                option_mode: parseInt(option_mode) === 1 ? 1 : 0,
                stock_qty: (stock_qty === '' || stock_qty === null || stock_qty === undefined || isNaN(parseInt(stock_qty))) ? null : parseInt(stock_qty),
                // 1인당 최대 구매 수량. 비우면 제한 없음 — 값이 있으면 그 상품은 회원만 산다.
                purchase_limit: (purchase_limit === '' || purchase_limit === null || purchase_limit === undefined || isNaN(parseInt(purchase_limit))) ? null : parseInt(purchase_limit),
            };
            /*
            if (brand_id = 5) { //임시
                let { sort_idx } = req.body;
                obj = {
                    product_img,
                    product_name, product_code, product_comment, product_spec, product_description, product_price, product_sale_price, delivery_fee, product_type,
                    consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type, price_lang_obj,
                    another_id,
                    price_lang, point_save, point_usable, cash_usable, pg_usable, status, show_status, sort_idx
                };
            }   
            */
            for (var i = 0; i < categoryDepth; i++) {
                if (req.body[`category_id${i}`]) {
                    obj[`category_id${i}`] = req.body[`category_id${i}`];
                }
            }

            if (consignment_user_name) {
                let consignment_user = await readPool.query(`SELECT id FROM users WHERE user_name=? AND brand_id=? `, [consignment_user_name, brand_id]);
                consignment_user = consignment_user[0][0];
                if (!consignment_user) {
                    return response(req, res, -100, "위탁할 회원정보를 찾을 수 없습니다.", false);
                }
                obj['consignment_user_id'] = consignment_user?.id;
            }
            obj = { ...obj, ...files, };
            let result = await updateQuery(`${table_name}`, obj, id);

            let dns_data = await readPool.query(`SELECT id, setting_obj FROM brands WHERE id=?`, [brand_id]);
            dns_data = dns_data[0][0];
            dns_data["setting_obj"] = JSON.parse(dns_data?.setting_obj ?? "{}");

            // 수정도 저장과 같은 이유로 큐에 담는다(create 쪽 주석 참고).
            // 큐의 else 분기가 같은 (table_name, item_id) 행을 먼저 지우고 새로 넣으므로,
            // 한 상품을 여러 번 저장해도 대기열에 중복으로 쌓이지 않는다.
            await settingLangs(lang_obj_columns[table_name], obj, dns_data, table_name, id);

            const product_id = id;
            // 옵션(선택옵션·추가상품) · 조합형 · 손님 입력항목.
            // create 와 **같은 함수**를 쓴다 — 예전엔 두 갈래에 비슷한 코드가 따로 있었다.
            await 옵션일체저장(product_id, groups, combinations, order_form_fields, dns_data);
            //character
            let insert_character_list = [];
            let delete_character_list = [];
            for (var i = 0; i < characters.length; i++) {
                let character = characters[i];
                if (character?.is_delete == 1) {
                    delete_character_list.push(character?.id ?? 0);
                } else {
                    if (character?.id) { // update
                        let character_result = await updateQuery(`product_characters`, {
                            character_name: character?.character_name,
                            character_value: character?.character_value,
                        }, character?.id);
                    } else { // insert
                        insert_character_list.push([
                            product_id,
                            characters[i]?.character_name,
                            characters[i]?.character_value,
                        ])
                    }
                }
            }
            if (insert_character_list.length > 0) {
                let option_result = await writePool.query(`INSERT INTO product_characters (product_id, character_name, character_value) VALUES ?`, [insert_character_list]);
            }
            if (delete_character_list.length > 0) {
                let option_result = await writePool.query(`DELETE FROM product_characters WHERE id IN (${delete_character_list.map(() => '?').join(',')})`, delete_character_list);
            }
            //sub image
            let insert_sub_image_list = [];
            let delete_sub_image_list = [];
            for (var i = 0; i < sub_images.length; i++) {
                if (sub_images[i]?.is_delete == 1) {
                    delete_sub_image_list.push(sub_images[i]?.id ?? 0);
                } else {
                    if (sub_images[i]?.id) {

                    } else {
                        insert_sub_image_list.push([
                            product_id,
                            sub_images[i]?.product_sub_img,
                        ])
                    }
                }
            }
            if (insert_sub_image_list.length > 0) {
                let sub_image_result = await writePool.query(`INSERT INTO product_images (product_id, product_sub_img) VALUES ?`, [insert_sub_image_list]);
            }
            if (delete_sub_image_list.length > 0) {
                let sub_image_result = await writePool.query(`UPDATE product_images SET is_delete=1 WHERE id IN (${delete_sub_image_list.map(() => '?').join(',')})`, delete_sub_image_list);
            }

            //description image
            let insert_description_image_list = [];
            let delete_description_image_list = [];
            for (var i = 0; i < description_images.length; i++) {
                if (description_images[i]?.is_delete == 1) {
                    delete_description_image_list.push(description_images[i]?.id ?? 0);
                } else {
                    if (description_images[i]?.id) {

                    } else {
                        insert_description_image_list.push([
                            product_id,
                            description_images[i]?.product_description_img,
                        ])
                    }
                }
            }
            if (insert_description_image_list.length > 0) {
                let description_image_result = await writePool.query(`INSERT INTO product_images (product_id, product_description_img) VALUES ?`, [insert_description_image_list]);
            }
            if (delete_description_image_list.length > 0) {
                let description_image_result = await writePool.query(`UPDATE product_images SET is_delete=1 WHERE id IN (${delete_description_image_list.map(() => '?').join(',')})`, delete_description_image_list);
            }

            //property
            let delete_property_result = await writePool.query(`DELETE FROM products_and_properties WHERE product_id=?`, [product_id]);

            let insert_property_list = [];
            properties = JSON.parse(properties);
            let property_group_ids = Object.keys(properties);
            for (var i = 0; i < property_group_ids.length; i++) {
                for (var j = 0; j < properties[property_group_ids[i]]?.length; j++) {
                    insert_property_list.push([
                        product_id,
                        property_group_ids[i],
                        properties[property_group_ids[i]][j],
                    ])
                }
            }
            if (insert_property_list.length > 0) {
                let property_result = await writePool.query(`INSERT INTO products_and_properties (product_id, property_group_id, property_id) VALUES ?`, [insert_property_list]);
            }

            //category (단일 트리, 1상품 N카테고리) — 연결테이블 재저장(delete → insert). category_id0 위치컬럼은 dual-write 로 유지.
            await writePool.query(`DELETE FROM products_categories WHERE product_id=?`, [product_id]);
            let category_ids_input = req.body?.category_ids;
            if (typeof category_ids_input == 'string') { try { category_ids_input = JSON.parse(category_ids_input); } catch (e) { category_ids_input = []; } }
            if (Array.isArray(category_ids_input)) {
                let pc_rows = category_ids_input.map(v => parseInt(v)).filter(v => !isNaN(v) && v > 0).map(cid => [brand_id, product_id, cid]);
                if (pc_rows.length > 0) {
                    await writePool.query(`INSERT IGNORE INTO products_categories (brand_id, product_id, category_id) VALUES ?`, [pc_rows]);
                }
            }

            // ─────────────────────────────
            // 캐시 무효화: 상품 수정 시 관련 캐시 삭제
            // ─────────────────────────────
            if (redisClient?.isOpen) {
                try {
                    // 상세 캐시 패턴 삭제 (product:detail:brandId:*:*:*:*:productId)
                    const detailPattern = `product:detail:${brand_id}:*`;

                    // SCAN으로 패턴 매칭 키 찾아서 삭제.
                    // deleteKeys 를 쓰는 이유는 utils.js/redis-scan.js 주석 참고 —
                    // redis v5 의 scanIterator 는 키를 하나씩이 아니라 묶음으로 내놓는다.
                    await deleteKeys(redisClient, detailPattern,
                        (key) => key.includes(`:${id}`) || key.includes(`:id:${id}`));
                    // 목록 캐시는 브랜드별로 전체 삭제 (필터 조합이 많아서)
                    await deleteKeys(redisClient, `product:list:*`,
                        (key) => key.includes(`"brandId":${brand_id}`) || key.includes(`"brandId": ${brand_id}`));
                    console.log(`[Cache] Product ${id} cache invalidated (brand: ${brand_id})`);
                } catch (e) {
                    console.error("Redis cache invalidation error:", e);
                    // 캐시 삭제 실패해도 서비스는 계속 진행 (TTL로 자연 만료됨)
                }
            }

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            const brand_id = decode_dns?.id ?? 0;
            // 레벨만 보고 소유를 안 봤다 — 가맹점 관리자(40)가 상품 id 만 알면
            // 남의 가맹점 상품을 지울 수 있었다. 상품 id 는 고객 화면 URL 에 그대로 노출된다.
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            if (decode_user?.level >= 40) {
                const owned = await loadOwnedRow(readPool, table_name, id, decode_user);
                if (!owned) {
                    return lowLevelException(req, res);
                }
            }

            if (decode_user?.level >= 40) {
                let result = await deleteQuery(`${table_name}`, {
                    id
                })
            } else {
                let result = await writePool.query(`DELETE FROM products_and_sellers WHERE seller_id=? AND product_id=?`, [decode_user?.id, id]);
            }

            // ─────────────────────────────
            // 캐시 무효화: 상품 삭제 시 관련 캐시 삭제
            // ─────────────────────────────
            if (redisClient?.isOpen && brand_id > 0) {
                try {
                    const detailPattern = `product:detail:${brand_id}:*`;

                    await deleteKeys(redisClient, detailPattern,
                        (key) => key.includes(`:${id}`) || key.includes(`:id:${id}`));
                    await deleteKeys(redisClient, `product:list:*`,
                        (key) => key.includes(`"brandId":${brand_id}`) || key.includes(`"brandId": ${brand_id}`));
                    console.log(`[Cache] Product ${id} cache invalidated on remove (brand: ${brand_id})`);
                } catch (e) {
                    console.error("Redis cache invalidation error:", e);
                }
            }

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default productCtrl;
