'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { encForSave, decListContent, decField, decRow, decRows } from "../utils.js/pii.js";
import { stripUserSecrets, stripUserSecretsList } from "../utils.js/security-question.js";
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

            decListContent('users', data); // 셀러(users) 실명·전화 복호화
            stripUserSecretsList(data?.content); // ⚠ users.* 이므로 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트 제거 후 반환
            (data?.content || []).forEach((r) => { if (r.agent_name) r.agent_name = decField(r.agent_name); }); // 상위 영업자 실명 복호화
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
            decRows('users', user_list[0]); // 이름·전화 복호화(암호문 노출 방지) — 라우팅된 user.organizationalChart와 동일
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
            let products = await readPool.query(`SELECT * FROM products WHERE id IN (SELECT product_id FROM products_and_sellers WHERE seller_id=? ORDER BY id DESC)`, [id]);
            products = products[0];
            data['sns_obj'] = JSON.parse(data?.sns_obj ?? '{}');
            data['theme_css'] = JSON.parse(data?.theme_css ?? '{}');
            //data["slider_css"] = JSON.parse(data?.slider_css ?? "{}");
            decRow('users', data); // 셀러(users) 실명·전화 복호화
            stripUserSecrets(data); // ⚠ SELECT * 이므로 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트 제거 후 반환
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
            obj = encForSave('users', obj); // 셀러(users) 실명·전화 암호화 + blind-index
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
            // ⚠ user_pw 는 아래 obj 에 그대로 넣지 않는다. 저장 여부·해싱은 encForSave 직전의 가드에서만 처리한다.
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
                name, phone_num, user_name, oper_id, seller_trx_fee, seller_trx_fee_type, seller_point,
                seller_range_u, seller_range_o, seller_brand, seller_category, seller_property, seller_demo_num, seller_color, seller_logo_img,
                seller_name, addr, acct_num, acct_name, acct_bank_name, acct_bank_code, comment, sns_obj, theme_css, dns,
            };
            obj['sns_obj'] = JSON.stringify(obj.sns_obj);
            obj['theme_css'] = JSON.stringify(obj.theme_css);
            obj = { ...obj, ...files };

            let [sellerData] = await writePool.query(
                `SELECT seller_brand, seller_category, seller_trx_fee, seller_trx_fee_type, oper_id, user_pw, level, brand_id FROM ${table_name} WHERE id = ?`,
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

            // ── 비밀번호는 '새로 입력했을 때만' 갱신한다 ─────────────────────────────────────
            // (구) 이 핸들러는 req.body.user_pw 를 해싱 없이 users.user_pw 에 그대로 덮어썼다.
            //      프론트가 GET 으로 받은 '해시'를 그대로 되돌려 보내서 우연히 동작했을 뿐이라,
            //      - 값이 비거나 키가 없으면 user_pw 가 ''/NULL 로 덮어써져 그 계정은 영구 로그인 불가,
            //      - 새 비밀번호를 입력하면 '평문'이 저장돼 signIn(해시 비교)에서 항상 실패했다.
            // (신) 규칙 — 이 세 갈래 외에는 user_pw/user_salt 를 절대 UPDATE 문에 넣지 않는다.
            //      1) 값이 없거나 공백뿐  → 건드리지 않음(기존 비밀번호 유지). ← 계정 잠김 원천 차단
            //      2) 저장된 해시와 동일  → 구버전 프론트가 조회값을 되돌려준 것 → 건드리지 않음
            //      3) 그 외(새 비밀번호)  → createHashedPassword 로 해싱 + 새 salt 를 '항상 함께' 저장
            //      비밀번호만 바꾸는 정식 경로는 PUT /api/sellers/change-pw/:id (changePassword) 다.
            const target_user = sellerData?.[0] ?? {};
            const input_user_pw = typeof user_pw === 'string' ? user_pw.trim() : user_pw;
            if (input_user_pw && input_user_pw !== target_user?.user_pw) {
                // ⚠ 여기서부터가 '실제로 비밀번호를 바꾸는' 유일한 분기다.
                //    이 핸들러는 진입 조건이 checkLevel(token, 0) 뿐이라 '로그인한 아무나' 통과한다.
                //    해싱을 붙이면서 권한 검사를 같이 넣지 않으면, 아무 회원이나 남의 비밀번호를
                //    원하는 값으로 바꿔 그 계정으로 로그인할 수 있게 된다(= 계정 탈취).
                //    검사 규칙은 이미 강화된 user.controller.js changePassword 와 동일하게 맞춘다.
                //    (위의 1)빈값 / 2)저장된 해시 되돌림 은 이 검사 '이전'에 걸러지므로,
                //     비밀번호를 건드리지 않는 일반 수정 저장은 이 가드의 영향을 전혀 받지 않는다.)
                const target_level = Number(target_user?.level ?? 0);
                const user_brand_id = Number(decode_user?.brand_id ?? 0);
                const dns_brand_id = Number(decode_dns?.id ?? 0);
                const target_brand_id = Number(target_user?.brand_id ?? 0);
                if (!decode_user || decode_user?.level < target_level) {
                    return response(req, res, -100, "잘못된 접근입니다.", false)
                }
                // 본사/마스터(50 이상)는 전 브랜드 허용. 그 외는 '토큰의 brand_id(서명됨)' 와 dns 가 모두 대상과 같아야 한다.
                // (dns 쿠키는 GET /api/domain?dns=... 로 누구나 임의 브랜드 것을 받을 수 있어 단독 기준이 될 수 없다)
                if (!(decode_user?.level >= 50)
                    && (!user_brand_id || user_brand_id !== target_brand_id || dns_brand_id !== target_brand_id)) {
                    return response(req, res, -100, "잘못된 접근입니다.", false)
                }
                // 일반 회원(레벨10 미만)은 '본인' 비밀번호만 변경 가능.
                if (!(decode_user?.level >= 10) && Number(decode_user?.id) !== Number(id)) {
                    return response(req, res, -100, "잘못된 접근입니다.", false)
                }
                let pw_data = await createHashedPassword(input_user_pw);
                obj['user_pw'] = pw_data.hashedPassword;
                obj['user_salt'] = pw_data.salt; // ⚠ salt 없이 user_pw 만 갱신하면 로그인이 깨진다. 반드시 쌍으로.
            }

            obj = encForSave('users', obj); // 셀러(users) 실명·전화 암호화 + blind-index(부분 업데이트)
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
export default sellerCtrl;
