'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
const table_name = 'user_wishs';

const userWishCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let columns = [
                `${table_name}.*`,

            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            if (decode_user?.level >= 40) {
                columns.push(`products.product_name`);
                columns.push(`users.user_name`);
                sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
                sql += ` LEFT JOIN products ON ${table_name}.product_id=products.id `;
            }

            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            if (!(decode_user?.level >= 40)) {
                sql += ` AND ${table_name}.user_id=${decode_user?.id ?? 0} `;
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
    items: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let sql = `SELECT * FROM ${table_name} `;
            sql += ` WHERE ${table_name}.user_id=${decode_user?.id ?? 0} AND brand_id=${decode_dns?.id ?? 0} ORDER BY id DESC `;

            let data = await pool.query(sql);
            data = data?.result;
            data = data.map(item => {
                return item?.product_id
            })
            data.unshift(0);
            let items = await pool.query(`SELECT * FROM products WHERE id IN (${data.join()}) `);
            items = items?.result;

            return response(req, res, 100, "success", items);
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
            let data = await pool.query(`SELECT * FROM ${table_name} WHERE id=${id}`)
            data = data?.result[0];
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
                product_id
            } = req.body;
            let files = settingFiles(req.files);
            if (!decode_user) {
                return response(req, res, -100, "로그인을 해주세요.", false)
            }
            let exist_wish = await pool.query(`SELECT * FROM ${table_name} WHERE product_id=? AND user_id=?`, [product_id, decode_user?.id]);
            exist_wish = exist_wish?.result;
            if (exist_wish.length > 0) {
                return response(req, res, -100, "이미 찜한 상품입니다.", false)
            }
            let obj = {
                product_id,
                user_id: decode_user?.id,
                brand_id: decode_dns?.id
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

export default userWishCtrl;
