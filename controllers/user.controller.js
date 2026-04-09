'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
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
            let params = [];
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;

            sql += ` WHERE brand_id=? `
            params.push(decode_dns?.id ?? 0);
            if (is_user) {
                sql += ` AND level=0 `
            }
            if (is_seller) {
                sql += ` AND level=10 `
            }

            if (is_agent == 1) {
                sql += ` AND level=15 `
            }

            if (is_agent == 2) {
                sql += ` AND level=15 AND oper_id=? `
                params.push(decode_user?.id);
            }

            if (is_agent == 3) {
                sql += ` AND level=20 `
            }

            //console.log(sql)

            let data = await getSelectQueryList(sql, columns, req.query, [], params);

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

            let user_list = await readPool.query(`SELECT * FROM ${table_name} WHERE ${table_name}.brand_id=? AND ${table_name}.is_delete=0 `, [decode_dns?.id ?? 0]);
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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
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
                seller_trx_fee, seller_trx_fee_type = 0, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type = 0
            } = req.body;
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=? AND is_delete = 0`, [user_name, brand_id]);
            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }
            if (level > 0 && decode_user?.level < level) {
                return lowLevelException(req, res);
            }
            if (seller_trx_fee_type == 0 && seller_trx_fee > 1) {
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
                seller_trx_fee, seller_trx_fee_type, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type
            };
            //console.log(obj)
            if (level >= 15) {
                const { oper_id, seller_point, ...rest } = obj;
                obj = { ...rest, ...files }
            } else {
                obj = { ...obj, ...files };
            }
            let result = await insertQuery(`${table_name}`, obj);
            if (!result) {
                return response(req, res, -100, "추가중 에러", false)
            }
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
                seller_trx_fee, seller_trx_fee_type = 0, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type = 0,
            } = req.body;
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=? AND is_delete = 0 AND id!=?`, [user_name, brand_id, id]);
            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }
            if (seller_trx_fee_type == 0 && seller_trx_fee > 1) {
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
                seller_trx_fee, seller_trx_fee_type, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type
            };

            if (level >= 15) {
                const { oper_id, seller_point, ...rest } = obj;
                obj = { ...rest, ...files }
            } else {
                obj = { ...obj, ...files };
            }

            // 영업자(level>=15) 수수료 변경 시 하위 셀러들의 seller_products 재계산
            if (level >= 15 && (oper_trx_fee !== undefined || oper_trx_fee_type !== undefined)) {
                let [oldUserData] = await readPool.query(
                    `SELECT oper_trx_fee, oper_trx_fee_type FROM ${table_name} WHERE id = ?`, [id]
                );
                const oldOperFee = parseFloat(oldUserData?.[0]?.oper_trx_fee ?? 0);
                const oldOperFeeType = parseInt(oldUserData?.[0]?.oper_trx_fee_type ?? 0);
                const newOperFee = parseFloat(oper_trx_fee ?? 0);
                const newOperFeeType = parseInt(oper_trx_fee_type ?? 0);

                if (oldOperFee !== newOperFee || oldOperFeeType !== newOperFeeType) {
                    // 이 영업자 하위의 모든 셀러 조회
                    let [sellers] = await readPool.query(
                        `SELECT id, seller_trx_fee, seller_trx_fee_type FROM ${table_name} WHERE oper_id = ? AND level = 10 AND is_delete = 0`, [id]
                    );
                    for (const seller of sellers) {
                        let [sellerProducts] = await readPool.query(
                            `SELECT sp.id, sp.seller_price, sp.agent_price, p.product_sale_price
                             FROM seller_products sp
                             LEFT JOIN products p ON sp.product_id = p.id
                             WHERE sp.seller_id = ? AND sp.is_delete = 0`,
                            [seller.id]
                        );
                        for (const sp of sellerProducts) {
                            if (!sp.product_sale_price || sp.product_sale_price == 0) continue;
                            const margin = sp.seller_price - sp.agent_price;
                            const basePrice = sp.product_sale_price;
                            const afterOper = newOperFeeType == 1 ? basePrice + newOperFee : basePrice * (1 + newOperFee);
                            const sellerFee = parseFloat(seller.seller_trx_fee ?? 0);
                            const sellerFeeType = parseInt(seller.seller_trx_fee_type ?? 0);
                            const afterSeller = sellerFeeType == 1 ? afterOper + sellerFee : afterOper * (1 + sellerFee);
                            const newAgentPrice = Math.round(Math.floor(Number(afterSeller.toFixed(6))) / 1000) * 1000;
                            const newSellerPrice = newAgentPrice + margin;
                            const finalSellerPrice = newSellerPrice >= newAgentPrice ? newSellerPrice : newAgentPrice;
                            await writePool.query(
                                `UPDATE seller_products SET agent_price = ?, seller_price = ? WHERE id = ?`,
                                [newAgentPrice, finalSellerPrice, sp.id]
                            );
                        }
                    }
                }
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
