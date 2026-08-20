'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { canWriteBrand, checkDns, checkLevel, loadOwnedRow, createHashedPassword, isItemBrandIdSameDnsId, isTruthyFlag, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
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
            // 회원 목록은 관리자 화면 전용이다(프론트 호출부가 전부 pages/manager/**).
            // 예전엔 checkLevel 결과를 담아만 두고 한 번도 보지 않았다. dns 쿠키는 사이트에
            // 접속만 하면 발급되므로, 누구든 그 가맹점 전 회원 명단을 받아갈 수 있었다.
            // 게다가 아래에서 decListContent 로 실명·전화를 복호화해 응답에 실어 보낸다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            const { is_user, is_seller, is_agent } = req.query;
            let columns = [
                `${table_name}.*`,
                // 회원 목록의 보유 포인트도 이 몰 것만 센다 — 브랜드를 넘나들면
                // 관리자 화면과 고객 화면의 숫자가 서로 달라진다.
                `(SELECT SUM(point) FROM points WHERE user_id=${table_name}.id AND brand_id=${table_name}.brand_id) AS point`
            ]
            let params = [];
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;

            sql += ` WHERE brand_id=? `
            // 조회 대상 브랜드는 organizationalChart 와 같은 기준으로 고정한다 —
            // 레벨50(마스터)만 지금 보고 있는 브랜드(dns)를 따르고, 그 외는 토큰의 brand_id 다.
            // dns 쿠키는 GET /api/domain?dns=... 로 누구나 임의 브랜드 것을 발급받을 수 있어서,
            // dns 기준이면 가맹점 관리자가 다른 브랜드 dns 쿠키를 붙여 그 브랜드 전 회원 명단
            // (복호화된 실명·전화 포함)을 그대로 받아갈 수 있었다.
            params.push(Number(decode_user?.level) >= 50
                ? (decode_dns?.id ?? 0)
                : Number(decode_user?.brand_id ?? 0));
            // multipart 로 오면 값이 문자열이라 "0" 도 truthy 다.
            // 프론트는 마스터(본사)에서 is_user=0 을 보내 '전체(운영자 포함)'를 뜻하는데,
            // 그게 truthy 로 걸려 늘 `AND level=0` 이 붙었다 —
            // 본사 회원관리에서 레벨40·50 운영자 계정이 영영 안 보였다.
            if (isTruthyFlag(is_user)) {
                sql += ` AND level=0 `
            }
            if (isTruthyFlag(is_seller)) {
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

            // dns 쿠키는 GET /api/domain 으로 누구나 발급받는다 — 신원이 아니다.
            // 로그인 검사가 없어 비로그인으로 브랜드 전 회원의 복호화된 실명·전화를 덤프할 수 있었다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            // 조회 대상 브랜드도 토큰 기준으로 고정한다(레벨50 마스터만 dns 브랜드를 따른다).
            const chart_brand_id = Number(decode_user?.level) >= 50
                ? (decode_dns?.id ?? 0)
                : Number(decode_user?.brand_id ?? 0);

            let user_list = await readPool.query(`SELECT * FROM ${table_name} WHERE ${table_name}.brand_id=? AND ${table_name}.is_delete=0 `, [chart_brand_id]);
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
            // isItemBrandIdSameDnsId 는 dns 쿠키만 본다. 그 쿠키는 누구나 발급받으므로
            // 로그인 검사가 없으면 비로그인으로 복호화된 실명·전화를 id 순회로 긁어갈 수 있다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
            data = data[0][0];
            // 브랜드 경계를 dns 가 아니라 토큰 기준으로 본다(레벨50 마스터는 교차 허용).
            if (!data || !canWriteBrand(decode_user, data?.brand_id)) {
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
            // 예전엔 decode_user·decode_dns 를 선언만 하고 쓰지 않았다 —
            // 쿠키 없이 DELETE /api/users/:id 만 호출해도 임의 회원이 삭제 처리됐다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let target_rows = await readPool.query(`SELECT id, brand_id, level FROM ${table_name} WHERE id=? LIMIT 1`, [id]);
            const target_user = target_rows[0][0];
            if (!target_user || !canWriteBrand(decode_user, target_user?.brand_id)) {
                return lowLevelException(req, res);
            }
            // 자기보다 높은 레벨(가맹점 관리자가 마스터 계정 등)은 지울 수 없다.
            // 자기 자신도 지울 수 없다(스스로 계정을 날리는 사고 방지).
            if (Number(target_user?.level) > Number(decode_user?.level)
                || Number(target_user?.id) === Number(decode_user?.id)) {
                return lowLevelException(req, res);
            }
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
            // 관리자가 회원을 만드는 경로다.
            // 일반 고객 회원가입은 여기가 아니라 auth.controller 의 signUp(POST /api/auth/sign-up)이 처리한다
            // — 확인함. 프론트에서 apiManager('users','create') 를 부르는 곳도
            //   pages/manager/users/**(회원관리·총판관리·영업자관리) 세 곳뿐이다.
            //   따라서 여기에 운영자 가드를 넣어도 고객 가입은 영향받지 않는다.
            //
            // 예전 조건은 `if (!decode_user || (level > 0 && decode_user?.level < level))` 이었다.
            // level=0 이면 `level > 0` 이 false → && 가 통째로 false 가 되어,
            // 로그인만 한 레벨0 고객도 임의 브랜드에 회원을 찍어낼 수 있었다.
            // 운영자(레벨10) 이상을 먼저 요구하고, 그 다음 '자기 레벨 이하만 생성' 을 본다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            if (decode_user?.level < Number(level || 0)) {
                return lowLevelException(req, res);
            }
            // 생성 대상 브랜드는 body 가 아니라 로그인 토큰 기준으로 확정한다(update 와 동일).
            // body 의 brand_id 를 그대로 INSERT 하면 다른 가맹점에 계정을 만들어 넣을 수 있었다.
            // 아이디 중복 검사도 '실제로 저장될 브랜드' 기준이어야 한다 —
            // body 의 brand_id 로 검사하면 엉뚱한 브랜드에서 검사해 통과한 뒤 강제된 브랜드에 중복이 생긴다.
            const write_brand_id = resolveWriteBrandId(decode_user, brand_id, decode_dns);
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=? AND is_delete = 0`, [user_name, write_brand_id]);
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
                profile_img,
                // body 의 brand_id 를 그대로 쓰면 다른 브랜드에 계정을 심을 수 있었다(update 와 동일 규칙).
                brand_id: write_brand_id,
                user_name, user_pw, user_salt, name, nickname, level, phone_num, note,
                contract_img, bsin_lic_img, company_name, business_num,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_trx_fee_type, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type
            };
            //console.log(obj)
            // 영업자(15)는 '소속 총판'을 oper_id 로 갖는다. 여기서 같이 버리는 바람에
            // 관리자 화면에서 총판을 지정해 저장해도 반영되지 않았고,
            // 정산관리의 '총판 매출확인'과 대시보드 영업자 집계가 늘 0 이었다.
            // oper_id 가 의미 없는 건 총판(20 이상)부터다 — 그때만 뺀다.
            // seller_point(셀러 적립률)는 15 이상에서 계속 제거한다.
            if (level >= 15) {
                const { seller_point, ...rest } = obj;
                if (level >= 20) delete rest.oper_id;
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
            // 검사가 하나도 없었다. body 에 level 과 brand_id 가 그대로 들어오므로
            // 아무나 임의 회원을 관리자 등급으로 올리거나 다른 브랜드로 옮길 수 있었다(권한상승).
            // 프론트 호출부는 pages/manager/users/** 뿐이다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }

            const {
                profile_img,
                brand_id, user_name, name, nickname, level, phone_num, note, id,
                company_name, business_num, contract_img, bsin_lic_img,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_trx_fee_type = 0, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type = 0,
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다.
            // 소유 검증이 없으면 가맹점 관리자가 id 만 바꿔 다른 가맹점 회원을 수정할 수 있었다.
            const t = await readPool.query(`SELECT id, brand_id, level FROM ${table_name} WHERE id=? LIMIT 1`, [id]);
            const target = t[0][0];
            if (!target || !canWriteBrand(decode_user, target.brand_id)) return lowLevelException(req, res);
            // 자기 레벨보다 높은 레벨을 부여하는 권한상승을 막는다.
            if (Number(level) > Number(decode_user?.level)) return lowLevelException(req, res);
            // 쓰기 대상 브랜드는 로그인 토큰 기준으로 확정한다(레벨50 이상만 교차 브랜드 허용).
            // 아이디 중복 검사도 같은 브랜드 기준으로 봐야 한다 —
            // body 의 brand_id 로 검사하면 엉뚱한 브랜드에서 검사해 통과한 뒤 실제로는 강제된 브랜드에 중복이 생긴다.
            const write_brand_id = resolveWriteBrandId(decode_user, brand_id, decode_dns);
            let is_exist_user = await readPool.query(`SELECT * FROM ${table_name} WHERE user_name=? AND brand_id=? AND is_delete = 0 AND id!=?`, [user_name, write_brand_id, id]);
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
                // body 의 brand_id 를 그대로 쓰면 임의 회원을 다른 브랜드로 옮길 수 있었다.
                brand_id: write_brand_id,
                user_name, name, nickname, level, phone_num, note,
                company_name, business_num, contract_img, bsin_lic_img,
                acct_num, acct_name, acct_bank_name, acct_bank_code, shareholder_img, register_img,
                seller_trx_fee, seller_trx_fee_type, seller_point,
                oper_id, oper_trx_fee, oper_trx_fee_type
            };

            // 영업자(15)는 '소속 총판'을 oper_id 로 갖는다. 여기서 같이 버리는 바람에
            // 관리자 화면에서 총판을 지정해 저장해도 반영되지 않았고,
            // 정산관리의 '총판 매출확인'과 대시보드 영업자 집계가 늘 0 이었다.
            // oper_id 가 의미 없는 건 총판(20 이상)부터다 — 그때만 뺀다.
            // seller_point(셀러 적립률)는 15 이상에서 계속 제거한다.
            if (level >= 15) {
                const { seller_point, ...rest } = obj;
                if (level >= 20) delete rest.oper_id;
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
            // !user 는 '대상'만 본다. 요청자 로그인 여부를 안 봐서 비로그인이면
            // undefined < user.level 이 false → 아무나 남의 계정 상태를 바꿀 수 있었다.
            // 예전엔 레벨 비교만 했다. 고객끼리는 둘 다 0 이라 0 < 0 이 false 가 되어
            // 로그인한 일반회원이 다른 브랜드 회원까지 상태를 바꿀 수 있었다.
            // 운영자 이상만, 자기 브랜드 안에서, 자기보다 낮은 레벨만 바꿀 수 있게 한다.
            // 동급(>=)까지 막으면 마스터가 다른 마스터 계정을, 관리자가 동급 관리자 계정을
            // 다루던 정상 조작이 새로 막힌다. 원래 버그(고객끼리 0<0 통과)는 앞의
            // level<10 + canWriteBrand 로 이미 완전히 막히므로 동급 차단은 불필요하다.
            // 대신 자기 자신 상태 변경만 따로 막는다(스스로 정지·탈퇴 처리 방지).
            if (!decode_user || !user || decode_user?.level < 10
                || !canWriteBrand(decode_user, user?.brand_id)
                || Number(user?.level) > Number(decode_user?.level)
                || Number(user?.id) === Number(decode_user?.id)) {
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
