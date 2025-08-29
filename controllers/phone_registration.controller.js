'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";

const table_name = 'phone_registration';

const phoneRegistrationCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { type = 'manager', brand_id, seller_id, phone_number } = req.query;

            let columns = [
                `${table_name}.*`,
                `users.dns`
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.seller_id=users.id `

            if (type == 'manager') {
                if (decode_user?.level >= 20) {
                    sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
                } else {
                    sql += ` WHERE ${table_name}.seller_id=${decode_user?.id ?? 0} `
                }
            } else {
                sql += ` WHERE ${table_name}.brand_id=${brand_id} AND ${table_name}.seller_id=${seller_id} AND ${table_name}.phone_number=${phone_number} `
            }
            //console.log(sql)

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
            const { brand_id, seller_id, phone_num } = req.params;
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE brand_id=${brand_id} AND seller_id=${seller_id} AND phone_number=${phone_num}`)
            data = data[0][0];

            //console.log(data)
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
                brand_id, seller_id, phone_number, registrar
            } = req.body;
            let files = settingFiles(req.files);

            let is_exist_number = await readPool.query(`SELECT * FROM ${table_name} WHERE phone_number=? AND brand_id=${brand_id} AND seller_id=${seller_id} AND is_delete=0`, [phone_number]);
            if (is_exist_number[0].length > 0) {
                return response(req, res, -100, "등록된 번호가 이미 존재합니다.", false)
            }

            let obj = {
                brand_id, seller_id, phone_number, registrar
            };

            obj = { ...obj, ...files };

            //console.log(obj)

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

            let is_exist_number = await readPool.query(`SELECT * FROM ${table_name} WHERE phone_number=? AND brand_id=${brand_id}`, [phone_number]);
            if (is_exist_number[0].length > 0) {
                return response(req, res, -100, "등록된 번호가 이미 존재합니다.", false)
            }

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

export default phoneRegistrationCtrl;
