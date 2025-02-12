'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";

const table_name = 'consignments';

const consignmentCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { type } = req.query;

            let columns = [
                `${table_name}.*`,
                `products.product_code`,
                `products.product_img`,
                `products.product_name`,
                `products.product_price`,
                `products.product_sale_price`,
                `products.consignment_none_user_name`,
                `products.consignment_none_user_phone_num`,
                `users.user_name`,
                `users.name`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN products ON ${table_name}.product_id=products.id `;
            sql += ` LEFT JOIN users ON products.consignment_user_id=users.id `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            if (type >= 0) {
                sql += ` AND ${table_name}.type=${type}`
            }

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
                product_id,
                request_price,
                type,
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id: decode_dns?.id,
                product_id,
                request_price,
                type,
            };
            let product = await readPool.query(`SELECT * FROM products WHERE id=${product_id}`);
            product = product[0][0];
            if (product?.consignment_user_id != decode_user?.id && decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let is_exist_consignment = await readPool.query(`SELECT * FROM ${table_name} WHERE product_id=${product_id} AND type=${type} AND is_confirm=0 `);
            is_exist_consignment = is_exist_consignment[0];
            if (is_exist_consignment.length > 0) {
                return response(req, res, -100, "아직 처리중인 요청입니다.", false)
            }
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

export default consignmentCtrl;
