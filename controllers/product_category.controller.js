'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, makeTree, resolveWriteBrandId, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'product_categories';



// 카테고리 이름은 varchar(50) 이고 손님 메뉴에 그대로 뜬다.
// 빈 이름은 메뉴에 빈 칸으로 나가고, 50자를 넘으면 DB 가 막는데 화면엔 사유가 안 보인다.
// ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
const 이름검사 = (category_name) => {
    const v = String(category_name ?? '').trim();
    if (!v) return '카테고리 이름을 입력해 주세요.';
    if ([...v].length > 50) return '카테고리 이름은 50자 이내로 입력해 주세요.';
    return null;
};
const productCategoryCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_category_group_id, page, page_size, search } = req.query;

            // 쿼리스트링은 전부 문자열이라 "0" 도 truthy 다.
            // 마이그레이션된 브랜드는 shop.controller 가 합성 그룹 id=0 을 내려주고
            // 관리자 화면이 그 0 을 그대로 실어 보낸다. 예전엔 그게 truthy 로 걸려
            // `AND product_category_group_id=0` 이 붙어 카테고리 검색이 항상 0건이었다.
            const group_id = parseInt(product_category_group_id);
            const has_group_id = Number.isInteger(group_id) && group_id > 0;

            // 단일 트리 전환: product_category_group_id 는 선택적. 없으면 브랜드 전체 트리 조회.
            let category_groups = null;
            if (has_group_id) {
                let cg = await readPool.query(`SELECT sort_type FROM product_category_groups WHERE id=?`, [product_category_group_id]);
                category_groups = cg[0][0];
            }

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);
            if (has_group_id) {
                sql += ` AND product_category_group_id=? `;
                params.push(group_id);
            }

            let req_query = req.query;
            if (category_groups?.sort_type == 1) {
                req_query.order = 'category_name';
                req_query.is_asc = 1;
            }
            let data = await getSelectQueryList(sql, columns, req_query, [], params);
            // 검색 중에는 트리로 묶지 않는다.
            // makeTree 는 부모가 결과에 없는 항목을 통째로 버린다. 검색은 이름으로 걸러낸
            // 평평한 결과라 하위 카테고리가 걸려도 그 부모는 대개 결과에 없다 —
            // 트리를 만드는 순간 그 항목들이 전부 사라져 '검색해도 안 나온다'가 됐다.
            if (!search) {
                data.content = await makeTree(data?.content ?? []);
            }
            data.total = data?.content.length ?? 0;
            data.content = (data?.content ?? []).slice((page - 1) * (page_size), page * page_size);

            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    get: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
            data = data[0][0];
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    create: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 상품 카테고리/그룹/특성그룹의 쓰기는 관리자(레벨40) 전용이다.
            // 이 화면들은 관리자 메뉴에서 isManager()=level>=40 으로만 열린다
            // (front: layouts/manager/nav/config-navigation.js:247-262).
            // 그런데 여기엔 checkLevel(...,0) 뿐이라 레벨 검사가 없었다 —
            // 그 몰에 가입한 일반 고객(레벨0) 토큰으로 API 를 직접 불러
            // 카테고리를 만들거나 지워 고객 메뉴 트리를 훼손할 수 있었다.
            // (brand_id 강제·소유 검증은 이미 있었고, 없던 것은 레벨 검사다)
            // popup.controller.js:67 과 같은 형태로 맞춘다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                category_img,
                parent_id = -1,
                category_type = 0,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                brand_id,
                another_id = 0,
            } = req.body;
            const 이름잘못 = 이름검사(category_name);
            if (이름잘못) { return response(req, res, -100, 이름잘못, false); }
            let files = settingFiles(req.files);
            let obj = {
                category_img,
                parent_id,
                category_type,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                // body 의 brand_id 를 그대로 insert 하면 남의 가맹점 트리에 카테고리를 꽂을 수 있다.
                // 쓰기 대상 브랜드는 로그인 토큰 기준으로 확정한다(레벨50 이상만 교차 브랜드 허용).
                brand_id: resolveWriteBrandId(decode_user, brand_id, decode_dns),
                another_id,
            };
            obj = { ...obj, ...files, };

            let result = await insertQuery(`${table_name}`, obj);
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, result?.insertId);

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
            // 상품 카테고리/그룹/특성그룹의 쓰기는 관리자(레벨40) 전용이다.
            // 이 화면들은 관리자 메뉴에서 isManager()=level>=40 으로만 열린다
            // (front: layouts/manager/nav/config-navigation.js:247-262).
            // 그런데 여기엔 checkLevel(...,0) 뿐이라 레벨 검사가 없었다 —
            // 그 몰에 가입한 일반 고객(레벨0) 토큰으로 API 를 직접 불러
            // 카테고리를 만들거나 지워 고객 메뉴 트리를 훼손할 수 있었다.
            // (brand_id 강제·소유 검증은 이미 있었고, 없던 것은 레벨 검사다)
            // popup.controller.js:67 과 같은 형태로 맞춘다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                category_img,
                parent_id = -1,
                category_type = 0,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                another_id = 0,
                id
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다.
            // 소유 검증이 없으면 id 만 바꿔 남의 가맹점 카테고리를 수정할 수 있었다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            const 이름잘못 = 이름검사(category_name);
            if (이름잘못) { return response(req, res, -100, 이름잘못, false); }
            let files = settingFiles(req.files);
            let obj = {
                category_img,
                parent_id,
                category_type,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                another_id,
            };
            obj = { ...obj, ...files, };

            let result = await updateQuery(`${table_name}`, obj, id);
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, id);
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
            // 상품 카테고리/그룹/특성그룹의 쓰기는 관리자(레벨40) 전용이다.
            // 이 화면들은 관리자 메뉴에서 isManager()=level>=40 으로만 열린다
            // (front: layouts/manager/nav/config-navigation.js:247-262).
            // 그런데 여기엔 checkLevel(...,0) 뿐이라 레벨 검사가 없었다 —
            // 그 몰에 가입한 일반 고객(레벨0) 토큰으로 API 를 직접 불러
            // 카테고리를 만들거나 지워 고객 메뉴 트리를 훼손할 수 있었다.
            // (brand_id 강제·소유 검증은 이미 있었고, 없던 것은 레벨 검사다)
            // popup.controller.js:67 과 같은 형태로 맞춘다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const { id } = req.params;

            // deleteQuery 도 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);

            // 카테고리 삭제는 카테고리 행 하나만 is_delete=1 로 만들 뿐 상품을 전혀 건드리지 않는다.
            // 그래서 참조 검사 없이 지우면
            //   - 그 카테고리에 걸려 있던 상품이 고아가 되고(관리자 화면에서 카테고리가 빈칸으로 보임),
            //   - products_categories 에 고아행이 남아 /shop/items?category_id=<삭제된id> 가 계속 열린다.
            // 삭제 전에 참조를 확인하고 걸리면 거부한다.
            const brand_id_for_check = target?.brand_id ?? decode_dns?.id ?? 0;

            // (a) 하위 카테고리 검사 — 지금까지는 프론트에서 버튼을 disabled 하는 것뿐이라
            //     API 를 직접 부르면 그대로 뚫렸다.
            let child_cnt = await readPool.query(
                `SELECT COUNT(*) AS cnt FROM ${table_name} WHERE parent_id=? AND is_delete=0`,
                [id]
            );
            child_cnt = child_cnt[0][0]?.cnt ?? 0;
            if (child_cnt > 0) {
                return response(req, res, -100, "하위 카테고리가 있어 삭제할 수 없습니다. 하위 카테고리를 먼저 삭제해 주세요.", false)
            }

            // (b) 상품 연결 검사 — 연결테이블(products_categories)과 레거시 위치컬럼(category_id0~2)을 모두 본다.
            //     마이그레이션이 안 된 테넌트는 연결테이블이 비어 있어서,
            //     연결테이블만 보면 상품이 걸려 있어도 0건으로 나와 가드가 무력화된다.
            let product_cnt = await readPool.query(
                `SELECT COUNT(DISTINCT p.id) AS cnt FROM products p
                  WHERE p.is_delete=0 AND p.brand_id=?
                    AND ( p.id IN (SELECT product_id FROM products_categories WHERE category_id=? AND is_delete=0)
                          OR p.category_id0=? OR p.category_id1=? OR p.category_id2=? )`,
                [brand_id_for_check, id, id, id, id]
            );
            product_cnt = product_cnt[0][0]?.cnt ?? 0;
            if (product_cnt > 0) {
                return response(req, res, -100, `이 카테고리에 상품 ${product_cnt}개가 연결되어 있어 삭제할 수 없습니다. 상품의 카테고리를 먼저 옮기거나, 삭제 대신 '숨김'을 사용해 주세요.`, false)
            }

            let result = await deleteQuery(`${table_name}`, {
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
};

export default productCategoryCtrl;
