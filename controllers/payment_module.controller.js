'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'payment_modules';

const paymentModuleCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;

            let data = await getSelectQueryList(sql, columns, req.query);

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
                pay_key, mid, tid, trx_type = 0, is_old_auth = 0, brand_id, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, pay_key, mid, tid, trx_type, is_old_auth, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url
            };
            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            obj = { ...obj, ...files };
            let is_exist_trx_type = await readPool.query(`SELECT * FROM ${table_name} WHERE trx_type=${trx_type} AND brand_id=${decode_dns?.id ?? 0}`);
            is_exist_trx_type = is_exist_trx_type[0];
            if (is_exist_trx_type.length > 0) {
                return response(req, res, -100, `결제타입은 브랜드당 한개씩만 가능합니다.`, false)
            }
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
                pay_key, mid, tid, trx_type = 0, is_old_auth = 0, brand_id, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url,
                id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                pay_key, mid, tid, trx_type, is_old_auth, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url
            };
            obj = { ...obj, ...files };
            let is_exist_trx_type = await readPool.query(`SELECT * FROM ${table_name} WHERE trx_type=${trx_type} AND brand_id=${decode_dns?.id ?? 0} AND id!=${id}`);
            is_exist_trx_type = is_exist_trx_type[0];
            if (is_exist_trx_type.length > 0) {
                return response(req, res, -200, `결제타입은 브랜드당 한개씩만 가능합니다.`, false)
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
            }, true)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default paymentModuleCtrl;
