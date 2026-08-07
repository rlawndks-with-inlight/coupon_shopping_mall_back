'use strict';
import { checkIsManagerUrl, getMainObjType, returnMoment } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, findChildIds, findParent, homeItemsSetting, homeItemsWithCategoriesSetting, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeTree, makeUserToken, response, getPayType } from "../utils.js/util.js";
import { FORSPAY_METHODS, getAvailableMethodIds } from "../utils.js/payments/forspay.js";
import 'dotenv/config';
import productCtrl from "./product.controller.js";
import postCtrl from "./post.controller.js";
import productFaqCtrl from "./product_faq.controller.js";
import _ from "lodash";
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { decRows } from "../utils.js/pii.js";
import { stripUserSecretsList } from "../utils.js/security-question.js";

const shopCtrl = {
    setting: async (req, res, next) => {
        try {

            // 상품 카테고리 그룹, 상품 리뷰, 상품 포스트카테고리
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { is_manager = 0 } = req.query;

            // Redis 캐시 체크 (일반 유저만, 관리자는 항상 최신 데이터)
            const isAdminLike = decode_user && decode_user?.level >= 10;
            const canUseCache = !!redisClient?.isOpen && !isAdminLike && is_manager != 1 && decode_dns?.id > 0;
            if (canUseCache) {
                const cacheKey = `shop:setting:${decode_dns.id}:${decode_user?.id ?? 0}`;
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    return response(req, res, 100, "success(cache)", JSON.parse(cached));
                }
            }

            let return_moment = returnMoment();
            let brand_column = [
                'shop_obj',
                'blog_obj',
                'basic_info',
                'is_category_migrated',   // 단계 이행: 1이면 단일 트리, 0/NULL이면 기존 그룹 유지
            ]

            let brand_data = await readPool.query(`SELECT ${brand_column.join()} FROM brands WHERE id=?`, [decode_dns?.id ?? 0]);
            brand_data = brand_data[0][0];
            if (!brand_data) {
                return response(req, res, -100, "브랜드 정보를 찾을 수 없습니다.", false);
            }
            brand_data['shop_obj'] = JSON.parse(brand_data?.shop_obj ?? '[]');
            brand_data['blog_obj'] = JSON.parse(brand_data?.blog_obj ?? '[]');
            let product_ids = [...(await settingMainObj(brand_data['shop_obj'])).product_ids, ...(await settingMainObj(brand_data['blog_obj'])).product_ids,];
            product_ids = new Set(product_ids);
            product_ids = [0, ...product_ids];

            let product_review_ids = [...(await settingMainObj(brand_data['shop_obj'])).product_review_ids, ...(await settingMainObj(brand_data['blog_obj'])).product_review_ids,];
            product_review_ids = new Set(product_review_ids);
            product_review_ids = [...product_review_ids];

            let product_property_ids = [...(await settingMainObj(brand_data['shop_obj'])).product_property_ids, ...(await settingMainObj(brand_data['blog_obj'])).product_property_ids,];
            product_property_ids = new Set(product_property_ids);
            product_property_ids = [0, ...product_property_ids];
            //products
            let product_columns = [
                `products.id`,
                `products.sort_idx`,
                `products.product_name`,
                `products.product_price`,
                `products.product_sale_price`,
                `products.product_img`,
                `products.product_comment`,
                `products.lang_obj`,
                `products.status`,
                `products.price_lang`,
                `products.show_status`,
                `products.price_lang_obj`,
                `products.buying_count`
            ]
            let product_sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM products `;
            let product_category_left_join_sql = '';
            for (var i = 0; i < categoryDepth; i++) {
                product_category_left_join_sql += ` LEFT JOIN product_categories AS product_categories${i} ON products.category_id${i}=product_categories${i}.id `;
                product_columns.push(`product_categories${i}.category_en_name AS category_en_name${i}`);

            }
            product_sql += product_category_left_join_sql;
            product_sql += ` WHERE products.id IN(${product_ids.map(() => '?').join(',')}) `;
            product_sql += ` AND products.is_delete=0 `;
            product_sql += ` AND products.status!=5 `
            product_sql = product_sql.replaceAll(process.env.SELECT_COLUMN_SECRET, product_columns.join());

            //메인obj 에서 items-property-groups가 존재할시
            let product_and_property_columns = [
                `products.id`,
                `products.sort_idx`,
                `products.product_name`,
                `products.product_price`,
                `products.product_sale_price`,
                `products.product_img`,
                `products.product_comment`,
                `products.status`,
                `products.price_lang`,
                `products.show_status`,
                `RankedProperties.property_id`,
            ]
            for (var i = 0; i < categoryDepth; i++) {
                product_and_property_columns.push(`product_categories${i}.category_en_name AS category_en_name${i}`);
            }
            let product_and_property_sql = `
            WITH RankedProperties AS (
                SELECT
                products_and_properties.id,
                products_and_properties.product_id,
                products_and_properties.property_id,
                products_and_properties.property_group_id,
                    ROW_NUMBER() OVER (PARTITION BY products_and_properties.property_id ORDER BY id DESC) AS row_num
                FROM
                    products_and_properties
                    LEFT JOIN products ON products_and_properties.product_id=products.id
                    WHERE products.is_delete=0
                    AND (products.status=0 OR products.status=1 OR products.status=6 OR products.status=7)
                    AND products.brand_id=?
            )
            SELECT
                ${product_and_property_columns.join()}
            FROM
                RankedProperties
                LEFT JOIN products ON RankedProperties.product_id=products.id
                ${product_category_left_join_sql}
            WHERE
                row_num <= 50
                AND RankedProperties.property_id IN (${product_property_ids.map(() => '?').join(',')})
                AND products.brand_id=?
                ORDER BY products.sort_idx DESC
            `;
            //상품카테고리그룹
            let product_category_group_columns = [
                `product_category_groups.*`,
            ]
            let product_category_group_sql = `SELECT ${product_category_group_columns.join()} FROM product_category_groups `;
            product_category_group_sql += ` WHERE product_category_groups.brand_id=? `;
            product_category_group_sql += ` AND product_category_groups.is_delete=0 ORDER BY sort_idx DESC`;

            //상품카테고리  
            let product_category_columns = [
                `product_categories.*`,
            ]
            let product_category_sql = `SELECT ${product_category_columns.join()} FROM product_categories `;
            product_category_sql += ` WHERE product_categories.brand_id=? `;
            if (is_manager != 1) {
                product_category_sql += ` AND product_categories.status=0 `
            }
            product_category_sql += ` AND product_categories.is_delete=0 ORDER BY sort_idx DESC`;

            //상품특성그룹
            let product_property_group_columns = [
                `product_property_groups.*`,
            ]
            let product_property_group_sql = `SELECT ${product_property_group_columns.join()} FROM product_property_groups `;
            product_property_group_sql += ` WHERE product_property_groups.brand_id=? `;
            product_property_group_sql += ` AND product_property_groups.is_delete=0 ORDER BY sort_idx DESC`;

            //상품특성 
            let product_property_columns = [
                `product_properties.*`,
            ]
            let product_property_sql = `SELECT ${product_property_columns.join()} FROM product_properties `;
            product_property_sql += ` WHERE product_properties.brand_id=? `;
            if (is_manager != 1) {
                product_property_sql += ` AND product_properties.status=0 `
            }
            product_property_sql += ` AND product_properties.is_delete=0 ORDER BY sort_idx DESC`;

            //상품리뷰     
            let product_review_columns = [
                `product_reviews.*`,
                `products.product_img`,
            ]
            let product_review_sql = `SELECT ${product_review_columns.join()} FROM product_reviews `;
            product_review_sql += ` LEFT JOIN products ON product_reviews.product_id=products.id `;
            product_review_sql += ` WHERE product_reviews.brand_id=? `;
            product_review_sql += ` AND product_reviews.is_delete=0 ORDER BY id DESC LIMIT 0, 10`;

            //상품문의
            let product_faq_columns = [
                `product_faq.*`,
            ]
            let product_faq_sql = ` SELECT ${product_faq_columns.join()} FROM product_faq `;
            product_faq_sql += ` LEFT JOIN products ON product_faq.product_id=products.id `;
            product_faq_sql += ` WHERE product_faq.brand_id=? `;
            product_faq_sql += ` AND product_faq.is_delete=0 ORDER BY id DESC LIMIT 0, 10`;

            //게시물카테고리
            let post_category_columns = [
                `post_categories.*`,
            ]
            let post_category_sql = `SELECT ${post_category_columns.join()} FROM post_categories `;
            post_category_sql += ` WHERE post_categories.brand_id=? `;
            post_category_sql += ` AND post_categories.is_delete=0 ORDER BY sort_idx DESC`;

            //셀러
            let seller_columns = [
                `users.*`,
            ]
            let seller_sql = `SELECT ${seller_columns.join()} FROM users `;
            seller_sql += ` WHERE users.brand_id=? `;
            seller_sql += ` AND level=10 `;
            seller_sql += ` AND is_delete=0 `;
            seller_sql += ` ORDER BY id DESC`;

            //결제모듈
            let payment_module_columns = [
                `payment_modules.*`,
            ]
            let payment_module_sql = `SELECT ${payment_module_columns.join()} FROM payment_modules `;
            payment_module_sql += ` WHERE payment_modules.brand_id=? `;
            payment_module_sql += ` ORDER BY sort_idx DESC`;

            //유저찜
            let user_wish_columns = [
                `user_wishs.*`,
            ]
            let user_wish_sql = `SELECT ${user_wish_columns.join()} FROM user_wishs `;
            user_wish_sql += ` WHERE user_wishs.brand_id=? AND user_wishs.user_id=? `;
            user_wish_sql += ` ORDER BY id DESC`;

            //팝업
            let popup_columns = [
                `popups.*`,

            ]
            let popup_sql = `SELECT ${popup_columns.join()} FROM popups `;
            popup_sql += ` WHERE popups.brand_id=? AND popups.is_delete=0 AND popups.open_s_dt <= ? AND popups.open_e_dt >= ? `;
            popup_sql += ` ORDER BY id DESC`;

            //when
            let sql_list = [
                { table: 'products', sql: product_sql, data: [...product_ids] },
                { table: 'product_categories', sql: product_category_sql, data: [decode_dns?.id ?? 0] },
                { table: 'product_category_groups', sql: product_category_group_sql, data: [decode_dns?.id ?? 0] },
                { table: 'product_and_properties', sql: product_and_property_sql, data: [decode_dns?.id, ...product_property_ids, decode_dns?.id] },
                { table: 'product_properties', sql: product_property_sql, data: [decode_dns?.id ?? 0] },
                { table: 'product_property_groups', sql: product_property_group_sql, data: [decode_dns?.id ?? 0] },
                { table: 'post_categories', sql: post_category_sql, data: [decode_dns?.id ?? 0] },
                { table: 'product_reviews', sql: product_review_sql, data: [decode_dns?.id ?? 0] },
                { table: 'product_faq', sql: product_faq_sql, data: [decode_dns?.id ?? 0] },
                { table: 'sellers', sql: seller_sql, data: [decode_dns?.id ?? 0] },
                { table: 'payment_modules', sql: payment_module_sql, data: [decode_dns?.id ?? 0] },
                { table: 'user_wishs', sql: user_wish_sql, data: [decode_dns?.id ?? 0, decode_user?.id ?? 0] },
                { table: 'popups', sql: popup_sql, data: [decode_dns?.id ?? 0, return_moment.substring(0, 10), return_moment.substring(0, 10)] },
            ]

            let data = await getMultipleQueryByWhen(sql_list);

            for (var i = 0; i < Object.keys(data).length; i++) {
                let table = Object.keys(data)[i];
                for (var j = 0; j < data[table].length; j++) {
                    data[table][j].lang_obj = JSON.parse(data[table][j]?.lang_obj ?? '{}');
                }
            }
            //상품이미지처리
            let sub_images = await readPool.query(`SELECT * FROM product_images WHERE product_id IN(${product_ids.map(() => '?').join(',')}) AND is_delete=0 ORDER BY id ASC`, [...product_ids])
            sub_images = sub_images[0];
            for (var i = 0; i < data?.products.length; i++) {
                let images = sub_images.filter(item => item?.product_id == data?.products[i]?.id);
                data.products[i].sub_images = images ?? [];
            }
            //상품설명이미지처리
            let description_images = await readPool.query(`SELECT * FROM product_images WHERE product_id IN(${product_ids.map(() => '?').join(',')}) AND is_delete=0 ORDER BY id ASC`, [...product_ids])
            description_images = description_images[0];
            for (var i = 0; i < data?.products.length; i++) {
                let images = description_images.filter(item => item?.product_id == data?.products[i]?.id);
                data.products[i].description_images = images ?? [];
            }
            //셀러처리
            decRows('users', data?.sellers || []); // 셀러(users) 실명·전화 복호화
            stripUserSecretsList(data?.sellers || []); // ⚠ users.* 이므로 자격증명(user_pw/user_salt/otp_token) + 보안질문 해시/솔트 제거(비로그인 스토어프론트 응답 + 3분 Redis 캐시로 나간다)
            // ⚠ 이 응답은 비로그인 방문자에게 그대로 나가고 Redis 에 3분 캐시된다.
            //    seller_sql 이 users.* 라서 자격증명·개인정보까지 실려 나가므로 반드시 제거한다.
            //    - 자격증명: 조회 응답의 해시는 어디에서도 재사용되지 않는다(user.controller 의 create/update/
            //      changePassword 는 항상 req.body 의 평문을 새로 해싱하고, 프론트의 user_pw 는 전부 "새 비밀번호 입력칸").
            //    - 개인정보: 스토어프론트 셀러 카드/셀러몰은 nickname·profile_img·seller_name 만 사용하므로
            //      복호화된 실명·휴대폰을 내려줄 이유가 없다(개인정보 암호화 취지 무력화 방지).
            //    ※ 근본 해법은 seller_sql 을 users.* 대신 필요한 컬럼만 SELECT 하도록 바꾸는 것.
            // user_pw/user_salt/otp_token 은 위 stripUserSecretsList 가 이미 지운다(중복이지만 이중 안전장치로 남겨둔다).
            // name/phone_num(복호화된 개인정보)은 헬퍼가 지우지 않으므로 여기서 반드시 지워야 한다.
            (data?.sellers || []).forEach((seller) => {
                delete seller.user_pw;
                delete seller.user_salt;
                delete seller.otp_token;
                delete seller.name;
                delete seller.phone_num;
            });
            data['sellers'] = data?.sellers.map((item) => {
                return {
                    ...item,
                    sns_obj: JSON.parse(item?.sns_obj ?? '{}'),
                    theme_css: JSON.parse(item?.theme_css ?? '{}'),
                }
            })

            // 포스페이(41) 모듈이 있으면, 그 키(계정)가 지원하는 결제수단(대분류)을 ping으로 조회해 노출을 자동 필터.
            // 계정 capability는 자주 안 바뀌므로 브랜드별 1시간 캐시. 조회 실패 시 null → 필터 미적용(기존처럼 전부 노출).
            let forspayAllowedMethodIds = null;
            const forspayModule = (data?.payment_modules || []).find((m) => m?.trx_type == 41);
            if (forspayModule?.pay_key) {
                const fkey = `forspay:allowed_methods:${decode_dns?.id ?? 0}`;
                try {
                    const cachedFm = redisClient?.isOpen ? await redisClient.get(fkey) : null;
                    if (cachedFm) {
                        forspayAllowedMethodIds = JSON.parse(cachedFm);
                    } else {
                        forspayAllowedMethodIds = await getAvailableMethodIds({ app_key: forspayModule.pay_key });
                        if (redisClient?.isOpen && Array.isArray(forspayAllowedMethodIds)) {
                            await redisClient.set(fkey, JSON.stringify(forspayAllowedMethodIds), { EX: 3600 });
                        }
                    }
                } catch (e) {
                    forspayAllowedMethodIds = null;
                }
            }

            //결제모듈처리 (포스페이(41)는 활성 결제수단별 옵션으로 분리 — 구매자가 수단 선택)
            data['payment_modules'] = (data?.payment_modules || []).flatMap((item) => {
                if (item?.trx_type != 41) {
                    // 예전엔 행 전체를 그대로 내려보내 pay_key·mid·tid 가 비로그인 방문자에게도
                    // 노출됐다(localStorage.themeDnsData 에도 그대로 저장된다).
                    // 포스페이(41)는 아래에서 이미 화이트리스트로 구성하므로 여기만 문제였다.
                    const { pay_key, mid, tid, forspay_config, ...safe_item } = item ?? {};
                    return [{ ...safe_item, ...getPayType(item?.trx_type) }];
                }
                // 수단별 노출 설정(enabled) 파싱. 설정 없으면 pending(삼성페이) 제외 전부 노출.
                let methodsCfg = {};
                try {
                    const cfg = item?.forspay_config ? JSON.parse(item.forspay_config) : {};
                    methodsCfg = cfg?.methods || {};
                } catch (e) { methodsCfg = {}; }
                const base = getPayType(item?.trx_type); // type: 'auth_forspay'
                // 비밀값(App key 등)은 프론트로 내보내지 않는다 — 화이트리스트 필드만 구성
                return FORSPAY_METHODS
                    .filter((m) => {
                        // 포스페이(계정)가 지원하지 않는 대분류는 무조건 숨김 (ping 조회 성공 시)
                        if (Array.isArray(forspayAllowedMethodIds) && !forspayAllowedMethodIds.includes(m.pg_method_id)) return false;
                        const mc = methodsCfg[m.key];
                        if (mc && typeof mc.enabled !== 'undefined') return !!mc.enabled;
                        return !m.pending;
                    })
                    .map((m) => ({
                        id: item?.id,
                        trx_type: item?.trx_type,
                        is_old_auth: item?.is_old_auth,
                        sort_idx: item?.sort_idx,
                        ...base,
                        title: m.label,                                   // 접두어 없이 수단명만
                        description: m.desc || '포스페이로 결제합니다.',   // 수단별 안내 문구
                        pay_method: m.key,
                    }));
            })

            //상품카테고리처리 (단계 이행 dual-mode)
            if (brand_data?.is_category_migrated == 1) {
                // 마이그레이션 완료: 단일 카테고리 트리(그룹 레이어 폐지) — 전체 브랜드 트리를 '단일 합성 그룹'으로 래핑.
                //  facet 카테고리는 백필 시 soft-delete → is_delete=0 트리에 미포함.
                let tree_categories = await makeTree(data?.product_categories ?? []);
                data.product_category_groups = [{
                    id: 0,
                    brand_id: decode_dns?.id ?? 0,
                    category_group_name: '카테고리',
                    is_show_header_menu: 1,
                    sort_type: 0,
                    max_depth: 10,
                    is_use_en_name: 0,
                    product_categories: tree_categories,
                }];
            } else {
                // 미마이그레이션: 기존 그룹 구조 유지(그룹명 분기하는 데모 등 기존 동작 보존).
                for (var i = 0; i < data?.product_category_groups.length; i++) {
                    let category_list = data?.product_categories.filter((item) => item?.product_category_group_id == data?.product_category_groups[i]?.id);
                    if (data?.product_category_groups[i]?.sort_type == 1) {
                        category_list = category_list.sort((a, b) => {
                            if (a.category_name > b.category_name) return 1
                            if (a.category_name < b.category_name) return -1
                            return 0
                        })
                    }
                    category_list = await makeTree(category_list ?? []);
                    data.product_category_groups[i].product_categories = category_list;
                }
            }
            delete data.product_categories;

            //상품그룹처리
            for (var i = 0; i < data?.product_property_groups.length; i++) {
                let property_list = data?.product_properties.filter((item) => item?.product_property_group_id == data?.product_property_groups[i]?.id);
                if (data?.product_property_groups[i]?.sort_type == 1) {
                    property_list = property_list.sort((a, b) => {
                        if (a.property_name > b.property_name) return 1
                        if (a.property_name < b.property_name) return -1
                        return 0
                    })
                }
                data.product_property_groups[i].product_properties = property_list;
            }
            delete data.product_properties;

            //게시물카테고리처리
            let post_category_ids = data.post_categories.map(item => {
                return item?.id
            })
            post_category_ids.unshift(0);
            let recent_post_sql = `SELECT id, category_id, post_title FROM posts WHERE category_id IN (${post_category_ids.map(() => '?').join(',')}) AND is_delete=0 GROUP BY category_id, id HAVING COUNT(*) <= 10`;
            let recent_post_data = await readPool.query(recent_post_sql, [...post_category_ids])
            recent_post_data = recent_post_data[0];
            for (var i = 0; i < data?.post_categories.length; i++) {
                if (!(data?.post_categories[i]?.parent_id > 0)) {
                    let children_ids = findChildIds(data?.post_categories, data?.post_categories[i]?.id);
                    children_ids.unshift(data?.post_categories[i]?.id);
                    data.post_categories[i].recent_posts = recent_post_data.filter(item => children_ids.includes(item?.category_id));
                    data.post_categories[i].recent_posts = data.post_categories[i].recent_posts.slice(0, 10);
                }
            }
            data.post_categories = await makeTree(data?.post_categories ?? []);

            //메인obj처리
            brand_data['shop_obj'] = await finallySettingMainObj(brand_data['shop_obj'], data);
            brand_data['blog_obj'] = await finallySettingMainObj(brand_data['blog_obj'], data);
            let responseData = { ...data, ...brand_data };

            // Redis 캐시 저장 (180초 TTL)
            if (canUseCache) {
                const cacheKey = `shop:setting:${decode_dns.id}:${decode_user?.id ?? 0}`;
                try {
                    await redisClient.set(cacheKey, JSON.stringify(responseData), { EX: 180 });
                } catch (e) { /* Redis 실패해도 정상 응답 */ }
            }

            return response(req, res, 100, "success", responseData);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    main: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let order_sql = `SELECT * FROM transactions WHERE user_id=? AND is_cancel=0 ORDER BY id DESC LIMIT 0, 10`;
            let sql_list = [
                { table: 'orders', sql: order_sql, data: [decode_user?.id] },
            ]

            let data = await getMultipleQueryByWhen(sql_list);
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    items: async (req, res, next) => { //상품 리스트출력
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { seller_id } = req.query;

            let data = 0;

            //console.log(seller_id)

            if (seller_id > 0) {
                data = await productCtrl.list({ ...req, IS_RETURN: true, type: 'seller', seller_id: seller_id }, res, next)
            } else {
                data = await productCtrl.list({ ...req, IS_RETURN: true, type: 'user' }, res, next);
            }
            data = data?.data;
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    item: async (req, res, next) => { //상품 단일 출력
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id, seller_id } = req.params;
            let data = 0;

            if (seller_id > 0) {
                data = await productCtrl.get({ ...req, IS_RETURN: true, seller_id: seller_id }, res, next);
            } else {
                data = await productCtrl.get({ ...req, IS_RETURN: true }, res, next);
            }

            //console.log(seller_id)

            data = data?.data;
            if (decode_user?.id > 0) {
                let view_delete = await writePool.query('DELETE FROM product_views WHERE product_id=? AND user_id=? AND brand_id=? ', [
                    id,
                    decode_user?.id ?? -1,
                    decode_dns?.id
                ]);
                let view_count = await writePool.query('INSERT INTO product_views (product_id, user_id, brand_id) VALUES (?, ?, ?)', [
                    id,
                    decode_user?.id ?? -1,
                    decode_dns?.id
                ]);
            }

            //console.log(data)

            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    userInfo: async (req, res, next) => { //유저정보
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let data = {
                user: decode_user,
            }
            let point_sql = `SELECT SUM(point) FROM points WHERE user_id=?`;
            let order_sql = `SELECT * FROM transactions WHERE user_id=? AND trx_status>=5 ORDER BY id DESC LIMIT 0, 5`;
            let product_view_sql = `SELECT product_views.*, products.product_name, products.product_img, products.product_comment, products.status, products.product_price, products.product_sale_price FROM product_views `;
            product_view_sql += ` LEFT JOIN products ON product_views.product_id=products.id `;
            product_view_sql += ` WHERE product_views.user_id=? AND product_views.brand_id=? ORDER BY id DESC `;

            let sql_list = [
                { table: 'point', sql: point_sql, data: [decode_user?.id] },
                { table: 'orders', sql: order_sql, data: [decode_user?.id] },
                { table: 'product_views', sql: product_view_sql, data: [decode_user?.id, decode_dns?.id] },
            ]
            if (decode_dns?.setting_obj?.is_use_consignment == 1) {
                sql_list.push({
                    table: `consignment_products`,
                    sql: `SELECT * FROM products WHERE consignment_user_id=? ORDER BY id DESC LIMIT 0, 5`,
                    data: [decode_user?.id]
                })
            }

            let sql_result = await getMultipleQueryByWhen(sql_list);

            let trx_ids = sql_result['orders'].map(trx => {
                return trx?.id
            })
            if (trx_ids?.length > 0) {
                let transaction_orders_column = [
                    `transaction_orders.*`,
                    `products.product_img`,
                    `products.product_code`,
                    `sellers.user_name AS seller_user_name`,
                ]
                let order_sql = `SELECT ${transaction_orders_column.join()} FROM transaction_orders `
                order_sql += ` LEFT JOIN products ON transaction_orders.product_id=products.id `
                order_sql += ` LEFT JOIN users AS sellers ON transaction_orders.seller_id=sellers.id `
                order_sql += ` WHERE transaction_orders.trans_id IN (${trx_ids.map(() => '?').join(',')}) `
                order_sql += ` ORDER BY transaction_orders.id DESC `
                let order_data = await readPool.query(order_sql, [...trx_ids]);
                order_data = order_data[0];
                for (var i = 0; i < order_data.length; i++) {
                    order_data[i].groups = JSON.parse(order_data[i]?.order_groups ?? "[]");
                    delete order_data[i].order_groups
                }
                for (var i = 0; i < sql_result['orders'].length; i++) {
                    sql_result['orders'][i].orders = order_data.filter((order) => order?.trans_id == sql_result['orders'][i]?.id);
                }
            }

            decRows('transactions', sql_result['orders']); // 주문자명·전화·주소 복호화
            data = {
                ...data,
                ...sql_result,
            }
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    post: {
        list: async (req, res, next) => { //게시물 리스트출력
            try {

                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id } = req.query;

                if (!category_id) {
                    return response(req, res, -200, "카테고리 id는 필수 입니다.", false)
                }
                let data = await postCtrl.list({ ...req, IS_RETURN: true }, res, next);
                data = data?.data;
                return response(req, res, 100, "success", data);
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        get: async (req, res, next) => { //게시물 단일 출력
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { id } = req.params;
                let data = await postCtrl.get({ ...req, IS_RETURN: true }, res, next);
                data = data?.data;
                return response(req, res, 100, "success", data);
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        create: async (req, res, next) => { //게시물 추가
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id } = req.body;
                // 비회원 1:1문의 작성 차단. 프론트는 로그인 화면으로 보내지만 백엔드가 막지 않아서
                // API 를 직접 부르면 postCtrl.create 가 user_id=undefined 인 글을 그대로 저장했다.
                // 소유자가 없는 글은 '작성자만 열람' 판정도 헐거워진다.
                // (아래 productFaq.create 는 상품문의라 정책이 다르므로 여기만 막는다)
                if (!decode_user?.id) {
                    return lowLevelException(req, res);
                }

                let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
                category_sql += ` WHERE post_categories.brand_id=? `;
                let category_list = await readPool.query(category_sql, [decode_dns?.id ?? 0]);
                category_list = category_list[0];

                let category = _.find(category_list, { id: parseInt(category_id) });
                let top_parent = findParent(category_list, category);
                top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });
                if (top_parent?.is_able_user_add != 1) {
                    return lowLevelException(req, res);
                }
                let result = await postCtrl.create({ ...req, IS_RETURN: true }, res, next);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        update: async (req, res, next) => { //게시물 수정
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id, id } = req.body;

                let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
                category_sql += ` WHERE post_categories.brand_id=? `;
                let category_list = await readPool.query(category_sql, [decode_dns?.id ?? 0]);
                category_list = category_list[0];

                let category = _.find(category_list, { id: parseInt(category_id) });
                let top_parent = findParent(category_list, category);
                top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });
                if (top_parent?.is_able_user_add != 1) {
                    return lowLevelException(req, res);
                }
                let post = await readPool.query(`SELECT * FROM posts WHERE id=?`, [id]);
                post = post[0][0];
                if (!(post?.user_id == decode_user?.id || decode_user?.level >= 10)) {
                    return lowLevelException(req, res);
                }
                let result = await postCtrl.update({ ...req, IS_RETURN: true }, res, next);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        remove: async (req, res, next) => {
            try {

                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { id } = req.params;
                let post = await readPool.query(`SELECT * FROM posts WHERE id=?`, [id]);
                post = post[0][0];
                if (!(post?.user_id == decode_user?.id || decode_user?.level >= 10)) {
                    return lowLevelException(req, res);
                }
                let result = await deleteQuery(`posts`, {
                    id
                })
                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
    },
    productFaq: {
        list: async (req, res, next) => { //게시물 리스트출력
            try {

                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                let data = await productFaqCtrl.list({ ...req, IS_RETURN: true }, res, next);
                data = data?.data;
                return response(req, res, 100, "success", data);
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        get: async (req, res, next) => { //게시물 단일 출력
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { id } = req.params;
                let data = await productFaqCtrl.get({ ...req, IS_RETURN: true }, res, next);
                data = data?.data;
                return response(req, res, 100, "success", data);
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        create: async (req, res, next) => { //게시물 추가
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id } = req.body;

                let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
                category_sql += ` WHERE post_categories.brand_id=? `;
                let category_list = await readPool.query(category_sql, [decode_dns?.id ?? 0]);
                category_list = category_list[0];

                let category = _.find(category_list, { id: parseInt(category_id) });
                let top_parent = findParent(category_list, category);
                top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });
                if (top_parent?.is_able_user_add != 1) {
                    return lowLevelException(req, res);
                }
                let result = await postCtrl.create({ ...req, IS_RETURN: true }, res, next);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        update: async (req, res, next) => { //게시물 수정
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id, id } = req.body;

                let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
                category_sql += ` WHERE post_categories.brand_id=? `;
                let category_list = await readPool.query(category_sql, [decode_dns?.id ?? 0]);
                category_list = category_list[0];

                let category = _.find(category_list, { id: parseInt(category_id) });
                let top_parent = findParent(category_list, category);
                top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });
                if (top_parent?.is_able_user_add != 1) {
                    return lowLevelException(req, res);
                }
                let post = await readPool.query(`SELECT * FROM posts WHERE id=?`, [id]);
                post = post[0][0];
                if (!(post?.user_id == decode_user?.id || decode_user?.level >= 10)) {
                    return lowLevelException(req, res);
                }
                let result = await postCtrl.update({ ...req, IS_RETURN: true }, res, next);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        remove: async (req, res, next) => {
            try {

                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { id } = req.params;
                let post = await readPool.query(`SELECT * FROM posts WHERE id=?`, [id]);
                post = post[0][0];
                if (!(post?.user_id == decode_user?.id || decode_user?.level >= 10)) {
                    return lowLevelException(req, res);
                }
                let result = await deleteQuery(`posts`, {
                    id
                })
                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
    }
}
const getMainObjIdList = (main_obj = [], type, id_list_ = [], is_children) => {// 같은 타입에서 WHERE IN 문에 사용될 ids를 세팅한다.
    let id_list = id_list_;
    for (var i = 0; i < main_obj.length; i++) {
        if (main_obj[i]?.type == type) {
            if (is_children) {
                for (var j = 0; j < main_obj[i]?.list?.length; j++) {
                    id_list = [...id_list, ...main_obj[i]?.list[j]?.list ?? []];
                }
            } else {
                id_list = [...id_list, ...main_obj[i]?.list ?? []];
            }
        }
    }
    id_list = new Set(id_list);
    id_list = [...id_list];
    return id_list;
}

const getMainObjContentByIdList = (main_obj_ = [], type, content_list = [], is_children, is_new) => {//ids 를 가지고 컨텐츠로 채워 넣는다.
    let main_obj = main_obj_
    let content_obj = makeObjByList('id', content_list);
    main_obj = main_obj.map(section => {
        if (section?.type == type) {
            if (is_new) {
                let new_list = content_list.sort((a, b) => {
                    if (a.id < b.id) return 1;
                    if (a.id > b.id) return -1;
                    return 0;
                });
                return {
                    ...section,
                    list: new_list.splice(0, 10)
                }
            } else if (is_children) {
                section.list = (section?.list ?? []).map(children => {
                    children.list = (children?.list ?? []).map(id => {
                        if (content_obj[id]) {
                            return {
                                ...content_obj[id][0],
                            }
                        } else {
                            return {}
                        }
                    })
                    return {
                        ...children,
                    }
                })
                return { ...section };
            } else {
                let section_list = (section?.list ?? []).map(id => {
                    if (content_obj[id]) {
                        return {
                            ...content_obj[id][0],
                        }
                    } else {
                        return {}
                    }
                })
                return {
                    ...section,
                    list: section_list,
                }
            }

        } else {
            return { ...section };
        }
    })
    return main_obj;
}

const settingMainObj = async (main_obj_ = []) => {
    let main_obj = main_obj_;
    let product_review_ids = [];
    product_review_ids = getMainObjIdList(main_obj, 'item-reviews-select', product_review_ids);
    let product_ids = [];
    product_ids = getMainObjIdList(main_obj, 'item-hero', product_ids);
    product_ids = getMainObjIdList(main_obj, 'items', product_ids);
    product_ids = getMainObjIdList(main_obj, 'items-ids', product_ids);
    product_ids = getMainObjIdList(main_obj, 'items-with-categories', product_ids, true);
    let product_property_ids = [];
    for (var i = 0; i < main_obj.length; i++) {
        if (getMainObjType(main_obj[i]?.type) == `items-property-group-:num`) {
            product_property_ids.push(parseInt(main_obj[i]?.type.split('items-property-group-')[1]))
        }
    }
    return {
        product_ids,
        product_review_ids,
        product_property_ids,
    }
}
const finallySettingMainObj = async (main_obj_ = [], data = {}) => {
    let main_obj = main_obj_;
    main_obj = getMainObjContentByIdList(main_obj, 'item-reviews-select', data?.product_reviews);
    main_obj = getMainObjContentByIdList(main_obj, 'item-reviews', data?.product_reviews, false, true);
    main_obj = getMainObjContentByIdList(main_obj, 'item-hero', data?.products);
    main_obj = getMainObjContentByIdList(main_obj, 'items', data?.products);
    main_obj = getMainObjContentByIdList(main_obj, 'items-ids', data?.products);
    main_obj = getMainObjContentByIdList(main_obj, 'items-with-categories', data?.products, true);
    main_obj = getMainObjContentByIdList(main_obj, 'item-faq', data?.product_faq)

    for (var i = 0; i < main_obj.length; i++) {
        if (getMainObjType(main_obj[i]?.type) == `items-property-group-:num`) {
            main_obj[i].list = (data['product_and_properties'] ?? []).filter(el => el?.property_id == main_obj[i]?.type?.split('items-property-group-')[1]);
        }
    }
    for (var i = 0; i < main_obj.length; i++) {
        if (main_obj[i]?.type == 'post') {
            main_obj[i].list = (main_obj[i]?.list ?? []).map(id => {
                return _.find(data?.post_categories, { id: parseInt(id) })
            })
        }
    }
    for (var i = 0; i < main_obj.length; i++) {
        if (main_obj[i]?.type == 'sellers') {
            main_obj[i].list = data?.sellers ?? [];
        }
    }
    return main_obj;
}
export default shopCtrl;