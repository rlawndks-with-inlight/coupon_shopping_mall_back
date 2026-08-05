'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { encForSave, decRow, decRows, decListContent } from "../utils.js/pii.js";
import { stripUserSecrets, stripUserSecretsList } from "../utils.js/security-question.js";
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

            decListContent('users', data); // 읽기 복호화(실명·전화)
            stripUserSecretsList(data?.content); // ⚠ users.* 이므로 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트 제거 후 반환
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
            decRows('users', user_list[0]); // 읽기 복호화(실명·전화)
            stripUserSecretsList(user_list[0]); // ⚠ SELECT * 이므로 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트 제거 후 반환
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
            decRow('users', data); // 읽기 복호화(실명·전화)
            stripUserSecrets(data); // ⚠ SELECT * 이므로 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트 제거 후 반환
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
            // 빈 비밀번호를 그대로 해싱하면 hash('') 가 저장된다 → signIn 에 빈값 체크가 없어 아이디만 알면 로그인된다.
            user_pw = typeof user_pw === 'string' ? user_pw.trim() : user_pw;
            if (!user_pw) {
                return response(req, res, -100, "비밀번호를 입력해 주세요.", false)
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
            obj = encForSave('users', obj); // 실명·전화 암호화 + blind-index
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
                    if (sellers.length > 0) {
                        let sellerIds = sellers.map(s => s.id);
                        let sellerMap = {};
                        for (const s of sellers) sellerMap[s.id] = s;

                        // 벌크 조회: 모든 셀러의 상품을 한 번에
                        let [allProducts] = await readPool.query(
                            `SELECT sp.id, sp.seller_id, sp.seller_price, sp.agent_price, p.product_sale_price
                             FROM seller_products sp
                             LEFT JOIN products p ON sp.product_id = p.id
                             WHERE sp.seller_id IN (${sellerIds.map(() => '?').join(',')}) AND sp.is_delete = 0`,
                            sellerIds
                        );

                        let bulkUpdates = [];
                        for (const sp of allProducts) {
                            if (!sp.product_sale_price || sp.product_sale_price == 0) continue;
                            const seller = sellerMap[sp.seller_id];
                            const margin = sp.seller_price - sp.agent_price;
                            const basePrice = sp.product_sale_price;
                            const afterOper = newOperFeeType == 1 ? basePrice + newOperFee : basePrice * (1 + newOperFee);
                            const sellerFee = parseFloat(seller.seller_trx_fee ?? 0);
                            const sellerFeeType = parseInt(seller.seller_trx_fee_type ?? 0);
                            const afterSeller = sellerFeeType == 1 ? afterOper + sellerFee : afterOper * (1 + sellerFee);
                            const newAgentPrice = Math.round(Math.floor(Number(afterSeller.toFixed(6))) / 1000) * 1000;
                            const newSellerPrice = newAgentPrice + margin;
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
                }
            }

            obj = encForSave('users', obj); // 실명·전화 암호화 + blind-index(부분 업데이트)
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
            // ⚠ 로그인 필수. decode_user가 false면 decode_user?.level 은 undefined 이고
            //    undefined < 40 은 false 라서, 이 가드가 없으면 비로그인 요청이 레벨 비교를 통과한다.
            if (!decode_user || !user || decode_user?.level < user?.level) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            // 브랜드 스코프 검증: 레벨 체크만으로는 다른 가맹점 계정의 비밀번호까지 바꿀 수 있었다.
            // 본사/마스터(레벨50 이상)는 전 브랜드 허용, 그 외(가맹점 관리자 등)는 자기 브랜드 소속 계정만 허용.
            // ⚠ 기준은 '토큰의 brand_id'(서명됨)다. dns 쿠키는 GET /api/domain?dns=... 로 누구나
            //    임의 브랜드 것을 발급받을 수 있어, dns만 비교하면 가맹점 관리자가 다른 브랜드의
            //    dns 쿠키를 붙여 그 브랜드 계정 비밀번호를 바꿀 수 있다. (토큰 brand_id + dns 둘 다 일치 요구)
            const user_brand_id = Number(decode_user?.brand_id ?? 0);
            const dns_brand_id = Number(decode_dns?.id ?? 0);
            const target_brand_id = Number(user?.brand_id ?? 0);
            if (!(decode_user?.level >= 50)
                && (!user_brand_id || user_brand_id !== target_brand_id || dns_brand_id !== target_brand_id)) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            // 일반 회원(레벨10 미만)은 '본인' 비밀번호만 변경 가능.
            // (레벨 비교는 '<' 라서 같은 레벨끼리는 통과 → 같은 브랜드 회원끼리 계정 탈취가 가능했다)
            if (!(decode_user?.level >= 10) && Number(decode_user?.id) !== Number(id)) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            // 빈 비밀번호로 덮어쓰지 않는다. hash('') 가 저장되면 그 계정은 사실상 비밀번호 없이 열린다.
            user_pw = typeof user_pw === 'string' ? user_pw.trim() : user_pw;
            if (!user_pw) {
                return response(req, res, -100, "새 비밀번호를 입력해 주세요.", false)
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
