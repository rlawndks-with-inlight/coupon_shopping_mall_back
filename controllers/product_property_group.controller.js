'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'product_property_groups';

// 특성그룹 이름이 비어 있으면 상품 등록 화면에 이름 없는 묶음이 뜬다.
// [확인 2026-08-28] 운영 API 로 빈 이름이 그대로 저장됐다.
// ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
const 그룹이름검사 = (property_group_name) => {
    const v = String(property_group_name ?? '').trim();
    if (!v) return '특성그룹 이름을 입력해 주세요.';
    if ([...v].length > 50) return '특성그룹 이름은 50자 이내로 입력해 주세요.';
    return null;
};
const productPropertyGroupCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);

            let data = await getSelectQueryList(sql, columns, req.query, [], params);
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
                property_group_name,
                is_can_select_multiple = 0,
            } = req.body;
            const 이름잘못 = 그룹이름검사(property_group_name);
            if (이름잘못) { return response(req, res, -100, 이름잘못, false); }
            let files = settingFiles(req.files);
            let obj = {
                property_group_name,
                is_can_select_multiple,
                // dns 쿠키는 GET /api/domain 으로 누구나 발급받으므로 쓰기 대상 브랜드의 근거가 될 수 없다.
                // 로그인 토큰 기준으로 확정하되, 레벨50(개발사)만 접속 도메인의 브랜드로 교차 생성이 가능하다.
                brand_id: resolveWriteBrandId(decode_user, decode_dns?.id, decode_dns),
            };
            obj = { ...obj, ...files };

            let result = await insertQuery(`${table_name}`, obj);

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
                property_group_name,
                is_can_select_multiple = 0,
                id
            } = req.body;
            const 이름잘못 = 그룹이름검사(property_group_name);
            if (이름잘못) { return response(req, res, -100, 이름잘못, false); }
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let files = settingFiles(req.files);
            let obj = {
                property_group_name,
                is_can_select_multiple,
            };
            obj = { ...obj, ...files };

            let result = await updateQuery(`${table_name}`, obj, id);

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

export default productPropertyGroupCtrl;
