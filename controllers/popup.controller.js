'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'popups';

const popupCtrl = {
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
            // 레벨 검사가 없어서, 일반 고객 계정(레벨0)으로 로그인만 하면
            // POST /api/popups 직접 호출로 그 브랜드 스토어프론트 홈에 팝업을 띄울 수 있었다.
            // (brand_id 강제는 아래 resolveWriteBrandId 로 이미 되어 있었고, 없던 것은 레벨 검사다)
            // 팝업관리는 관리자 화면 '디자인관리'(config-navigation 의 isManager, 레벨40) 하위 메뉴다.
            // checkLevel 은 실패 시 false 만 돌려주므로 !decode_user 를 먼저 본다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                popup_title, popup_content, open_s_dt, open_e_dt, brand_id
            } = req.body;
            let obj = {
                popup_title, popup_content, open_s_dt, open_e_dt,
                // body 의 brand_id 를 그대로 insert 하면 남의 가맹점 화면에 팝업을 띄울 수 있다.
                // 쓰기 대상 브랜드는 로그인 토큰 기준으로 확정한다(레벨50 이상만 교차 브랜드 허용).
                brand_id: resolveWriteBrandId(decode_user, brand_id, decode_dns)
            };

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
            // create 와 같은 이유로 운영자(레벨40) 이상만 수정할 수 있다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                popup_title, popup_content, open_s_dt, open_e_dt,
                id
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let obj = {
                popup_title, popup_content, open_s_dt, open_e_dt
            };

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
            const { id } = req.params;
            // create 와 같은 이유로 운영자(레벨40) 이상만 삭제할 수 있다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
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

export default popupCtrl;
