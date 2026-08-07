'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, makeTree, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'product_properties';

const productPropertyCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_property_group_id } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN product_property_groups ON ${table_name}.product_property_group_id=product_property_groups.id `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);
            sql += ` AND ${table_name}.product_property_group_id=? `;
            params.push(product_property_group_id);

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
                property_img,
                property_type = 0,
                property_name,
                property_description,
                product_property_group_id,
                brand_id,
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                property_img,
                property_type,
                property_name,
                property_description,
                product_property_group_id,
                // body 의 brand_id 를 그대로 insert 하면 남의 가맹점에 속성을 만들 수 있다.
                // 쓰기 대상 브랜드는 로그인 토큰 기준으로 확정한다(레벨50 이상만 교차 브랜드 허용).
                brand_id: resolveWriteBrandId(decode_user, brand_id, decode_dns),
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
            const {
                property_img,
                property_type = 0,
                property_name,
                property_description,
                product_property_group_id,
                id
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let files = settingFiles(req.files);
            let obj = {
                property_img,
                property_type,
                property_name,
                property_description,
                product_property_group_id,
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

export default productPropertyCtrl;
