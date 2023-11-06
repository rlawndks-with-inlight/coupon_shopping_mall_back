'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
const table_name = 'transactions';

const transactionCtrl = {
    list: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { trx_status, cancel_status } = req.query;
            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += `LEFT JOIN users AS sellers ON ${table_name}.seller_id=sellers.id`
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id} `;
            if (decode_user?.level == 10) {
                sql += ` AND seller_id=${decode_user?.id} `;
            }
            if (decode_user?.level == 0 || !decode_user) {
                sql += ` AND user_id=${decode_user?.id ?? -1} `;
            }
            if (trx_status) {
                sql += ` AND trx_status=${trx_status} `;
            }
            if (cancel_status) {
                if (cancel_status == 1) {
                    sql += ` AND trx_status=1 `;
                } else if (cancel_status == 5) {
                    sql += ` AND is_cancel=1 `;
                }
            }
            let data = await getSelectQueryList(sql, columns, req.query);
            let trx_ids = data?.content.map(trx => {
                return trx?.id
            })
            if (trx_ids?.length > 0) {
                let transaction_orders_column = [
                    `transaction_orders.*`,
                    `products.product_img`,
                ]
                let order_sql = `SELECT ${transaction_orders_column.join()} FROM transaction_orders `
                order_sql += `LEFT JOIN products ON transaction_orders.product_id=products.id `
                order_sql += ` WHERE transaction_orders.trans_id IN (${trx_ids.join()}) `
                order_sql += ` ORDER BY transaction_orders.id DESC `
                let order_data = await pool.query(order_sql);
                order_data = order_data?.result;
                for (var i = 0; i < order_data.length; i++) {
                    order_data[i].groups = JSON.parse(order_data[i]?.order_groups ?? "[]");
                    delete order_data[i].order_groups
                }
                for (var i = 0; i < data?.content.length; i++) {
                    data.content[i].orders = order_data.filter((order) => order?.trans_id == data?.content[i]?.id);
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
    get: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id, } = req.params;
            const { ord_num, password } = req.query;
            console.log(req.query);
            let sql = `SELECT * FROM ${table_name} WHERE id=${id}`
            if (ord_num) {
                sql = `SELECT * FROM ${table_name} WHERE ord_num='${ord_num}' AND password='${password}'`;
            } else {
                if (!id) {
                    return response(req, res, -100, "존재하지 않는 주문입니다.", false)
                }
            }
            let data = await pool.query(sql)
            data = data?.result[0];
            if(!data){
                return response(req, res, -100, "존재하지 않는 주문번호 입니다.", {})
            }
            let order_data = await pool.query(`SELECT * FROM transaction_orders WHERE trans_id=${data?.id??0} ORDER BY id DESC`);
            order_data = order_data?.result;
            for (var i = 0; i < order_data.length; i++) {
                order_data[i].groups = JSON.parse(order_data[i]?.groups ?? "[]");
            }
            data.orders = order_data;

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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id
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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
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
            let is_manager = await checkIsManagerUrl(req);
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
    changeInvoice: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            const { invoice_num } = req.body;
            let result = await updateQuery(`${table_name}`, {
                invoice_num
            }, id)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    cancelRequest: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await pool.query(`SELECT * FROM ${table_name} WHERE id=${id}`);
            data = data?.result[0];
            if (data?.user_id != decode_user?.id) {
                return lowLevelException(req, res);
            }
            let result = await updateQuery(`${table_name}`, {
                trx_status: 1,
            }, id)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default transactionCtrl;
