'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
const table_name = 'users';

const sellerCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { is_seller } = req.query;
            let columns = [
                `${table_name}.*`,
                `agent.name AS agent_name`
            ]
            let params = [];
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN ${table_name} AS agent ON ${table_name}.oper_id=agent.id `
            sql += ` WHERE users.brand_id=? `
            params.push(decode_dns?.id ?? 0);
            if (is_seller == 1) {
                sql += ` AND users.level=10 `
            }

            if (decode_user?.level <= 10) {
                sql += `AND users.id=?`;
                params.push(decode_user?.id);
            }

            if (decode_user?.level == 15) {
                sql += `AND users.oper_id=?`
                params.push(decode_user?.id);
            }

            /*if (decode_user?.level == 20) {
                sql += `AND (users.oper_id=? OR users.oper_id IN (SELECT id FROM users WHERE oper_id=?)) `
                params.push(decode_user?.id, decode_user?.id);
            }*/

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
            let products = await readPool.query(`SELECT * FROM products WHERE id IN (SELECT product_id FROM products_and_sellers WHERE seller_id=? ORDER BY id DESC)`, [id]);
            products = products[0];
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
                brand_id, name, phone_num, user_name, user_pw, level, oper_id, seller_trx_fee, seller_trx_fee_type = 0, seller_point,
                seller_range_u = 0, seller_range_o = 0, seller_brand, seller_category, seller_property, seller_demo_num, seller_color, seller_logo_img,
                addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj = {}, theme_css = {}, dns,
                product_ids = [],
            } = req.body;
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=? AND is_delete = 0`, [user_name, brand_id]);
            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
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
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                brand_id, name, phone_num, user_name, user_pw, user_salt, level, oper_id, seller_trx_fee, seller_trx_fee_type, seller_point,
                seller_range_u, seller_range_o, seller_brand, seller_category, seller_property, seller_demo_num, seller_color, seller_logo_img,
                addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj, theme_css, dns,
            };
            obj['sns_obj'] = JSON.stringify(obj.sns_obj);
            obj['theme_css'] = JSON.stringify(obj.theme_css);
            obj = { ...obj, ...files };
            let result = await insertQuery(`${table_name}`, obj);
            if (!result) {
                return response(req, res, -100, "셀러추가중 에러", false)
            }
            let user_id = result?.insertId;

            //console.log(result)


            if (product_ids.length > 0) {
                let insert_products = [];
                for (var i = 0; i < product_ids.length; i++) {
                    insert_products.push([
                        user_id,
                        product_ids[i],
                    ])
                }
                let result2 = await writePool.query(`INSERT INTO products_and_sellers (seller_id, product_id) VALUES ?`, [insert_products]);
            }
            return response(req, res, 100, "success", {
                id: user_id
            })
        } catch (err) {
            //console.log(123)
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
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                name, phone_num, user_name, user_pw, oper_id, seller_trx_fee, seller_trx_fee_type = 0, seller_point,
                seller_range_u = 0, seller_range_o = 0, seller_brand, seller_category, seller_property, seller_demo_num, seller_color, seller_logo_img,
                seller_name, addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj = {}, theme_css = {}, dns,
                product_ids = [],
                id
            } = req.body;
            if (seller_trx_fee_type == 0 && seller_trx_fee > 1) {
                return response(req, res, -100, "수수료율이 100%보다 큽니다.", false)
            }
            if (seller_point > 1) {
                return response(req, res, -100, "포인트 적립률이 100%보다 큽니다", false)
            }
            let files = settingFiles(req.files);
            let obj = {
                background_img,
                passbook_img,
                contract_img,
                bsin_lic_img,
                id_img,
                profile_img,
                name, phone_num, user_name, user_pw, oper_id, seller_trx_fee, seller_trx_fee_type, seller_point,
                seller_range_u, seller_range_o, seller_brand, seller_category, seller_property, seller_demo_num, seller_color, seller_logo_img,
                seller_name, addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj, theme_css, dns,
            };
            obj['sns_obj'] = JSON.stringify(obj.sns_obj);
            obj['theme_css'] = JSON.stringify(obj.theme_css);
            obj = { ...obj, ...files };

            let [sellerData] = await writePool.query(
                `SELECT seller_brand, seller_category, seller_trx_fee, seller_trx_fee_type, oper_id FROM ${table_name} WHERE id = ?`,
                [id]
            );
            // 영업자의 기존 수수료도 조회
            let oldOper = sellerData[0];
            let [agentData] = await readPool.query(
                `SELECT oper_trx_fee, oper_trx_fee_type FROM ${table_name} WHERE id = ?`,
                [oper_id || oldOper.oper_id || 0]
            );
            let agent = agentData?.[0] ?? {};

            const normalize = (val) => (val ?? '').toString().replace(/\s/g, '').split(',').filter(Boolean).sort().join(',');
            let isSellerBrandChanged = normalize(sellerData[0].seller_brand) !== normalize(seller_brand);
            let isSellerCategoryChanged = normalize(sellerData[0].seller_category) !== normalize(seller_category);

            if (isSellerBrandChanged || isSellerCategoryChanged) {
                await writePool.query(
                    `UPDATE seller_products SET is_delete = 1 WHERE seller_id = ?`,
                    [id]
                );
            }

            // 수수료 변경 시 기존 seller_products 가격 재계산
            const oldSellerFee = parseFloat(sellerData[0].seller_trx_fee ?? 0);
            const oldSellerFeeType = parseInt(sellerData[0].seller_trx_fee_type ?? 0);
            const newSellerFee = parseFloat(seller_trx_fee ?? 0);
            const newSellerFeeType = parseInt(seller_trx_fee_type ?? 0);

            if (oldSellerFee !== newSellerFee || oldSellerFeeType !== newSellerFeeType) {
                // 해당 셀러의 모든 seller_products 조회
                let [sellerProducts] = await readPool.query(
                    `SELECT sp.id, sp.product_id, sp.seller_price, sp.agent_price, p.product_sale_price
                     FROM seller_products sp
                     LEFT JOIN products p ON sp.product_id = p.id
                     WHERE sp.seller_id = ? AND sp.is_delete = 0`,
                    [id]
                );

                let bulkUpdates = [];
                for (const sp of sellerProducts) {
                    if (!sp.product_sale_price || sp.product_sale_price == 0) continue;
                    const margin = sp.seller_price - sp.agent_price; // 기존 마진 보존
                    // 새 agent_price 계산
                    const basePrice = sp.product_sale_price;
                    const operFee = parseFloat(agent?.oper_trx_fee ?? 0);
                    const operFeeType = parseInt(agent?.oper_trx_fee_type ?? 0);
                    const afterOper = operFeeType == 1 ? basePrice + operFee : basePrice * (1 + operFee);
                    const afterSeller = newSellerFeeType == 1 ? afterOper + newSellerFee : afterOper * (1 + newSellerFee);
                    const newAgentPrice = Math.round(Math.floor(Number(afterSeller.toFixed(6))) / 1000) * 1000;
                    const newSellerPrice = newAgentPrice + margin;
                    // seller_price가 agent_price보다 낮아지지 않도록
                    const finalSellerPrice = newSellerPrice >= newAgentPrice ? newSellerPrice : newAgentPrice;
                    bulkUpdates.push({ id: sp.id, agent_price: newAgentPrice, seller_price: finalSellerPrice });
                }

                // 벌크 UPDATE: CASE WHEN으로 한 번에 (파라미터화)
                if (bulkUpdates.length > 0) {
                    let ids = bulkUpdates.map(u => u.id);
                    let agentCase = bulkUpdates.map(() => `WHEN ? THEN ?`).join(' ');
                    let sellerCase = bulkUpdates.map(() => `WHEN ? THEN ?`).join(' ');
                    let params = [];
                    for (const u of bulkUpdates) { params.push(u.id, u.agent_price); }
                    for (const u of bulkUpdates) { params.push(u.id, u.seller_price); }
                    params.push(...ids);
                    await writePool.query(
                        `UPDATE seller_products SET agent_price = CASE id ${agentCase} END, seller_price = CASE id ${sellerCase} END WHERE id IN (${ids.map(() => '?').join(',')})`,
                        params
                    );
                }
            }

            let result = await updateQuery(`${table_name}`, obj, id);
            //let delete_connect = await writePool.query(`DELETE FROM products_and_sellers WHERE seller_id=${id}`);

            if (product_ids.length > 0) {
                let insert_products = [];
                for (var i = 0; i < product_ids.length; i++) {
                    insert_products.push([
                        id,
                        product_ids[i],
                    ])
                }
                let result2 = await writePool.query(`INSERT INTO products_and_sellers (seller_id, product_id) VALUES ?`, [insert_products]);
            }
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
export default sellerCtrl;
