'use strict';
import axios from "axios";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'logs'
const logCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { response_result_type } = req.query;
            let columns = [
                `${table_name}.*`,
                'users.user_name',
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON users.id=${table_name}.user_id `
            sql += ` WHERE 1=1 `
            if (decode_dns?.is_main_dns != 1) {
                sql += ` AND ${table_name}.brand_id=${decode_dns?.id ?? 0}`
            }
            let sql_list = [
                { table: 'success', sql: (sql + ` ${sql.includes('WHERE') ? 'AND' : 'WHERE'} response_result > 0 `).replaceAll(process.env.SELECT_COLUMN_SECRET, 'COUNT(*) AS success') },
                { table: 'fail', sql: (sql + ` ${sql.includes('WHERE') ? 'AND' : 'WHERE'} response_result < 0 `).replaceAll(process.env.SELECT_COLUMN_SECRET, 'COUNT(*) AS fail') },
            ];
            if (response_result_type) {
                sql += ` AND ${table_name}.response_result ${response_result_type == 1 ? '>=' : '<'} 0 `
            }

            let data = await getSelectQueryList(sql, columns, req.query, sql_list);
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
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let result = await deleteQuery('brands', {
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

export default logCtrl;
