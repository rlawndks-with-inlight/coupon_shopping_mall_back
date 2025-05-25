'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";

const table_name = 'seller_adjustments';

const sellerAdjustmentsCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { state } = req.query;

            let columns = [
                `${table_name}.*`,
                `COALESCE(seller_users.name, oper_users.name) AS seller_name`,  // seller_id가 0이면 oper_id의 name 사용
                `COALESCE(seller_users.phone_num, oper_users.phone_num) AS seller_phone`,
                `COALESCE(seller_users.acct_num, oper_users.acct_num) AS seller_acct_num`,
                `COALESCE(seller_users.acct_bank_code, oper_users.acct_bank_code) AS seller_acct_bank_code`
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            // seller_id 기준 JOIN
            sql += ` LEFT JOIN users AS seller_users ON ${table_name}.seller_id = seller_users.id `;

            // seller_id가 0일 경우 oper_id를 기준으로 JOIN
            sql += ` LEFT JOIN users AS oper_users ON (${table_name}.seller_id = 0 AND ${table_name}.oper_id = oper_users.id) `;

            sql += ` WHERE ${table_name}.state IN (${state})`
            if (decode_user?.level >= 40) {
                sql += ` AND ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            } else if (decode_user?.level == 15) {
                sql += ` AND ${table_name}.oper_id=${decode_user?.id ?? 0} `;
            } else if (decode_user?.level == 20) {
                sql += ` AND (users.oper_id=${decode_user?.id} OR users.oper_id IN (SELECT id FROM users WHERE oper_id=${decode_user?.id})) `
            } else {
                sql += ` AND ${table_name}.seller_id=${decode_user?.id ?? 0}`;
            }

            let data = await getSelectQueryList(sql, columns, req.query);

            //console.log(sql)

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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=${id}`)
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
                brand_id, seller_id, oper_id, /*amount*/
            } = req.body;

            let obj = {
                brand_id, seller_id, oper_id, /*amount*/
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
            const {
                id, state, //amount
            } = req.body;

            let obj = {
                state, //amount
            };

            console.log(id, state)

            if (!(decode_user?.level > 20 || user_id == decode_user?.id)) {
                return lowLevelException(req, res);
            }

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

export default sellerAdjustmentsCtrl;
