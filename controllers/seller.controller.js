'use strict';
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
const table_name = 'sellers';

const sellerCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { is_seller } = req.query;
            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE brand_id=${decode_dns?.id ?? 0} `

            /*if (is_seller) {
                sql += ` AND level=10 `
            }*/
            if (decode_user?.level <= 10) {
                sql += `AND id=${decode_user?.id}`;
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
    organizationalChart: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            let user_list = await pool.query(`SELECT * FROM ${table_name} WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} AND ${table_name}.is_delete=0 `);
            let user_tree = makeTree(user_list?.result, decode_user);
            return response(req, res, 100, "success", user_tree);
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
            let products = await pool.query(`SELECT * FROM products WHERE id IN (SELECT product_id FROM products_and_sellers WHERE seller_id=${id} ORDER BY id DESC)`);
            products = products?.result;
            data['sns_obj'] = JSON.parse(data?.sns_obj ?? '{}');
            data['theme_css'] = JSON.parse(data?.theme_css ?? '{}');
            //data["slider_css"] = JSON.parse(data?.slider_css ?? "{}");
            return response(req, res, 100, "success", { ...data, products })
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
    create: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let {
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                brand_id, name, phone_num, title,
                addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj = {}, theme_css = {}, seller_trx_fee = 0, dns,
                product_ids = [],
            } = req.body;
            /*let is_exist_user = await pool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=${brand_id}`, [user_name]);
            if (is_exist_user?.result.length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }*/

            //let pw_data = await createHashedPassword(user_pw);
            //user_pw = pw_data.hashedPassword;
            //let user_salt = pw_data.salt;
            let files = settingFiles(req.files);
            let obj = {
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                brand_id, name, phone_num, title,
                addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj, theme_css, seller_trx_fee, dns,
            };
            obj['sns_obj'] = JSON.stringify(obj.sns_obj);
            obj['theme_css'] = JSON.stringify(obj.theme_css);
            obj = { ...obj, ...files };
            await db.beginTransaction();
            let result = await insertQuery(`${table_name}`, obj);
            if (!result) {
                return response(req, res, -100, "셀러추가중 에러", false)
            }
            let user_id = result?.result?.insertId;


            if (product_ids.length > 0) {
                let insert_products = [];
                for (var i = 0; i < product_ids.length; i++) {
                    insert_products.push([
                        user_id,
                        product_ids[i],
                    ])
                }
                let result2 = await pool.query(`INSERT INTO products_and_sellers (seller_id, product_id) VALUES ?`, [insert_products]);
            }
            await db.commit();
            return response(req, res, 100, "success", {
                id: user_id
            })
        } catch (err) {
            //console.log(123)
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                name, phone_num, title,
                seller_name, addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj = {}, theme_css = {}, seller_trx_fee = 0, dns,
                product_ids = [],
                id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                name, phone_num, title,
                seller_name, addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj, theme_css, seller_trx_fee, dns,
            };
            obj['sns_obj'] = JSON.stringify(obj.sns_obj);
            obj['theme_css'] = JSON.stringify(obj.theme_css);
            obj = { ...obj, ...files };
            await db.beginTransaction();
            let result = await updateQuery(`${table_name}`, obj, id);
            let delete_connect = await pool.query(`DELETE FROM products_and_sellers WHERE seller_id=${id}`);

            if (product_ids.length > 0) {
                let insert_products = [];
                for (var i = 0; i < product_ids.length; i++) {
                    insert_products.push([
                        id,
                        product_ids[i],
                    ])
                }
                let result2 = await pool.query(`INSERT INTO products_and_sellers (seller_id, product_id) VALUES ?`, [insert_products]);
            }
            await db.commit();
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    changePassword: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params
            let { user_pw } = req.body;

            let user = await selectQuerySimple(table_name, id);
            user = user?.result[0];
            if (!user || decode_user?.level < user?.level) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            let pw_data = await createHashedPassword(user_pw);
            user_pw = pw_data.hashedPassword;
            let user_salt = pw_data.salt;
            let obj = {
                user_pw, user_salt
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
    changeStatus: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params
            let { status } = req.body;
            let user = await selectQuerySimple(table_name, id);
            user = user?.result[0];
            if (!user || decode_user?.level < user?.level) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            let obj = {
                status
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
}
export default sellerCtrl;
