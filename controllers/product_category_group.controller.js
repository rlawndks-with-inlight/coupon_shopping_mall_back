'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, resolveWriteBrandId, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'product_category_groups';



const productCategoryGroupCtrl = {
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
            const {
                category_group_name,
                max_depth = 10,
                sort_type = 0,
                is_show_header_menu = 1,
                is_use_en_name = 0,
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                category_group_name,
                // dns 쿠키는 GET /api/domain 으로 누구나 발급받으므로 쓰기 대상 브랜드의 근거가 될 수 없다.
                // 로그인 토큰 기준으로 확정하되, 레벨50(개발사)만 접속 도메인의 브랜드로 교차 생성이 가능하다.
                brand_id: resolveWriteBrandId(decode_user, decode_dns?.id, decode_dns),
                max_depth,
                sort_type,
                is_show_header_menu,
                is_use_en_name,
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
            const {
                category_group_name,
                max_depth = 10,
                sort_type = 0,
                is_show_header_menu = 1,
                is_use_en_name = 0,
                id
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let files = settingFiles(req.files);
            let obj = {
                category_group_name,
                max_depth,
                sort_type,
                is_show_header_menu,
                is_use_en_name,
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

export default productCategoryGroupCtrl;
