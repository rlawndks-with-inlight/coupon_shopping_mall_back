'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'users';

const userCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { is_user, is_seller, is_agent } = req.query;
            let columns = [
                `${table_name}.*`,
                `(SELECT SUM(point) FROM points WHERE user_id=${table_name}.id) AS point`
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;

            sql += ` WHERE brand_id=${decode_dns?.id ?? 0} `
            if (is_user) {
                sql += ` AND level=0 `
            }
            if (is_seller) {
                sql += ` AND level=10 `
            }

            if (is_agent) {
                sql += ` AND level=20 `
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

            let user_list = await readPool.query(`SELECT * FROM ${table_name} WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} AND ${table_name}.is_delete=0 `);
            let user_tree = makeTree(user_list[0], decode_user);
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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=${id}`)
            data = data[0][0];
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
            data['sns_obj'] = JSON.parse(data?.sns_obj ?? '{}');
            data['theme_css'] = JSON.parse(data?.theme_css ?? '{}');
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
                profile_img,
                brand_id, user_name, user_pw, name, nickname, level = 0, phone_num, note,
                contract_img, bsin_lic_img, company_name, business_num,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_point
            } = req.body;
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=${brand_id} AND is_delete = 0`, [user_name]);
            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }
            if (level > 0 && decode_user?.level < level) {
                return lowLevelException(req, res);
            }
            if (seller_trx_fee > 1) {
                return response(req, res, -100, "수수료율이 100%보다 큽니다.", false)
            }
            if (seller_point > 1) {
                return response(req, res, -100, "포인트 적립률이 100%보다 큽니다", false)
            }
            let pw_data = await createHashedPassword(user_pw);
            user_pw = pw_data.hashedPassword;
            let user_salt = pw_data.salt;
            let files = settingFiles(req.files);
            let obj = {
                profile_img,
                brand_id, user_name, user_pw, user_salt, name, nickname, level, phone_num, note,
                contract_img, bsin_lic_img, company_name, business_num,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_point
            };
            //console.log(obj)
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
                profile_img,
                brand_id, user_name, name, nickname, level, phone_num, note, id,
                company_name, business_num, contract_img, bsin_lic_img,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_point
            } = req.body;
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=${brand_id} AND is_delete = 0 AND id!=?`, [user_name, id]);
            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }
            if (seller_trx_fee > 1) {
                return response(req, res, -100, "수수료율이 100%보다 큽니다.", false)
            }
            if (seller_point > 1) {
                return response(req, res, -100, "포인트 적립률이 100%보다 큽니다", false)
            }
            let files = settingFiles(req.files);
            let obj = {
                profile_img,
                brand_id, user_name, name, nickname, level, phone_num, note,
                company_name, business_num, contract_img, bsin_lic_img,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_point
            };
            console.log('123')
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
    changePassword: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params
            let { user_pw } = req.body;

            let user = await selectQuerySimple(table_name, id);
            user = user[0];
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
            user = user[0];
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
export default userCtrl;
