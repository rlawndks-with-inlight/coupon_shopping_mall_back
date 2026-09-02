'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { canWriteBrand, checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, makeObjByList, makeUserChildrenList, makeTree, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { encForSave, decListContent, decField, decRow, decRows } from "../utils.js/pii.js";
import { stripUserSecrets, stripUserSecretsList } from "../utils.js/security-question.js";
const table_name = 'users';

// ── 셀러 상세(get) 공개 프로필 컬럼 화이트리스트 ────────────────────────────────
// GET /api/sellers/:id 는 '비로그인 고객 화면'이 부른다.
//   front: src/views/shop/demo-{1,2,3,6,7,8}/seller/[id].js, src/views/blog/seller/id/demo-{1..5}.js
//   (그 화면들이 실제로 쓰는 값은 nickname / seller_name / background_img / sns_obj / id / products 뿐)
// 그래서 여기엔 레벨 가드를 걸 수 없다. 대신 '무엇을 내려주는가'를 좁힌다.
// 예전엔 dns 쿠키(GET /api/domain 으로 누구나 발급)만 확인하고 SELECT * 를 그대로 내려서,
// 복호화된 실명·전화번호·계좌번호·사업자번호·계약서/신분증 이미지까지 비로그인으로 새어나갔다.
const SELLER_PUBLIC_COLUMNS = [
    'id',
    'brand_id',
    'level',
    'user_name',
    'nickname',
    'seller_name',
    'comment',
    'profile_img',
    'background_img',
    'seller_logo_img',
    'seller_color',
    'seller_demo_num',
    'seller_brand',
    'seller_category',
    'seller_property',
    'seller_range_u',
    'seller_range_o',
    'sns_obj',
    'theme_css',
    'dns',
    'created_at',
];
const pickPublicSeller = (row = {}) => {
    let result = {};
    for (const key of SELLER_PUBLIC_COLUMNS) {
        if (key in row) result[key] = row[key];
    }
    return result;
};

const sellerCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 셀러 목록은 관리자 화면 전용이다(프론트 호출부는 pages/manager/users/sellers/index.js 와
            // views/manager/mui/table/ManagerTable.js 뿐). 고객 화면은 이 엔드포인트를 부르지 않는다.
            // 예전엔 아래 좁히기 조건이 전부 `decode_user?.level` 비교라, 비로그인이면
            // undefined <= 10 / undefined == 15 가 모두 false 가 되어 좁히기가 통째로 건너뛰어졌다 —
            // dns 쿠키만 있으면 그 브랜드 전 셀러의 복호화된 실명·전화·계좌가 통째로 나갔다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            const { is_seller } = req.query;
            let columns = [
                `${table_name}.*`,
                `agent.name AS agent_name`
            ]
            let params = [];
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN ${table_name} AS agent ON ${table_name}.oper_id=agent.id `
            sql += ` WHERE users.brand_id=? `
            // 조회 대상 브랜드도 토큰 기준으로 고정한다(레벨50 마스터만 dns 브랜드를 따른다).
            // dns 쿠키는 GET /api/domain?dns=... 로 누구나 임의 브랜드 것을 받을 수 있어,
            // dns 만 보면 레벨40 관리자가 다른 브랜드 dns 를 붙여 그 브랜드 셀러 명단을 받아갈 수 있었다.
            params.push(Number(decode_user?.level) >= 50
                ? (decode_dns?.id ?? 0)
                : Number(decode_user?.brand_id ?? 0));
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
            // ⚠ 이 핸들러는 routes/seller.route.js 에 등록돼 있지 않다(등록된 건 '/', '/:id', '/change-pw/:id' 뿐).
            //    즉 HTTP 로 도달할 수 없어 실제 노출 경로가 아니다 — 확인만 하고 그대로 둔다.
            //    라우트를 붙이려면 user.controller.organizationalChart 와 동일한 가드
            //    (로그인 + 레벨10 이상 + 브랜드를 dns 가 아닌 토큰 기준으로 고정)를 먼저 넣어야 한다.

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
            // ── 응답 화이트리스트 ────────────────────────────────────────────────
            // 관리자 판정: 이 코드베이스의 관례는 checkIsManagerUrl(req) 이지만,
            // /api/manager/** 는 라우터에 마운트된 적이 없어(routes/index.js) 항상 false 다
            // — auth.controller.signUp 주석에도 같은 사실이 적혀 있다.
            // 그래서 그것만으로 판정하면 관리자 셀러수정 화면
            // (front: pages/manager/users/sellers/[edit_category]/[id].js — 계좌·사업자·계약서 컬럼을 채운다)이 깨진다.
            // 관례는 그대로 두되(/manager 가 마운트되면 자동으로 동작), 실질 판정은 서명된 토큰으로 한다.
            //   · 셀러관리 메뉴는 레벨15 이상(front: layouts/manager/nav/config-navigation.js) → 같은 브랜드면 전체 컬럼
            //   · 셀러 본인이 자기 상세를 볼 때도 전체 컬럼
            // dns 쿠키는 누구나 발급받으므로 판정 근거에 넣지 않는다.
            const is_manager_url = await checkIsManagerUrl(req);
            const is_admin = is_manager_url
                || (!!decode_user && Number(decode_user?.level) >= 15 && canWriteBrand(decode_user, data?.brand_id))
                || (!!decode_user && Number(decode_user?.id) === Number(id));
            if (!is_admin) {
                return response(req, res, 100, "success", { ...pickPublicSeller(data), products })
            }
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
            // 이 컨트롤러의 table_name 은 'users' 다(파일 상단). 즉 user.controller.remove 에
            // 넣은 가드가 여기로 그대로 우회됐다 — 쿠키 없이 DELETE /api/sellers/:id 만 호출해도
            // 임의 회원이 삭제 처리됐다. 같은 가드를 건다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let target_rows = await readPool.query(`SELECT id, brand_id, level FROM ${table_name} WHERE id=? LIMIT 1`, [id]);
            const target_user = target_rows[0][0];
            if (!target_user || !canWriteBrand(decode_user, target_user?.brand_id)) {
                return lowLevelException(req, res);
            }
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
            // 셀러 계정 생성은 운영자(레벨10+)만. 예전엔 인증 없이 아무 등급·아무 브랜드 계정을 만들 수 있었다.
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
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
            // brand_id 는 body 를 믿지 않는다(마스터만 지정 가능). 등급은 자기 등급을 넘지 못한다.
            brand_id = resolveWriteBrandId(decode_user, brand_id, decode_dns);
            level = Math.min(Number(level) || 0, Number(decode_user?.level) || 0);
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
            // 수정은 운영자(레벨10+)가 '자기 브랜드' 계정만. 예전엔 로그인만 하면(dns 쿠키만으로도) 아무 users 행이나 덮어썼다.
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            if (!(await loadOwnedRow(readPool, table_name, id, decode_user))) {
                return lowLevelException(req, res);
            }
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
            // ⚠ 이 컨트롤러의 table_name 은 'users' 다(파일 상단). 즉 PUT /api/sellers/change-pw/:id 는
            //    user.controller.changePassword 와 '같은 테이블·같은 행'을 건드린다.
            //    user 쪽에만 가드를 넣으면 이 경로로 그대로 우회된다 — 검사를 동일하게 맞춘다.
            // !user 는 '대상'만 확인한다. 요청자 로그인 여부를 안 봐서 비로그인이면
            // undefined < user.level 이 false → 남의 계정 비밀번호·상태를 바꿀 수 있었다.
            if (!decode_user || !user || decode_user?.level < user?.level) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            // 브랜드 스코프 검증: 레벨 체크만으로는 다른 가맹점 계정의 비밀번호까지 바꿀 수 있었다.
            // 레벨 비교가 '<' 라 동급(레벨10 셀러 ↔ 레벨10 셀러)은 통과하므로,
            // 브랜드 검사 없이는 레벨10 셀러가 다른 브랜드의 레벨10 이하 계정을 탈취할 수 있었다.
            // 본사/마스터(레벨50 이상)는 전 브랜드 허용, 그 외는 자기 브랜드 소속 계정만 허용.
            // ⚠ 기준은 '토큰의 brand_id'(서명됨)다. dns 쿠키는 GET /api/domain?dns=... 로 누구나
            //    임의 브랜드 것을 발급받을 수 있어 단독 기준이 될 수 없다. (토큰 brand_id + dns 둘 다 일치 요구)
            const user_brand_id = Number(decode_user?.brand_id ?? 0);
            const dns_brand_id = Number(decode_dns?.id ?? 0);
            const target_brand_id = Number(user?.brand_id ?? 0);
            if (!(decode_user?.level >= 50)
                && (!user_brand_id || user_brand_id !== target_brand_id || dns_brand_id !== target_brand_id)) {
                return response(req, res, -100, "잘못된 접근입니다.", false)
            }
            // 일반 회원(레벨10 미만)은 '본인' 비밀번호만 변경 가능.
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
            // ⚠ organizationalChart 와 마찬가지로 이 핸들러도 routes/seller.route.js 에 등록돼 있지 않다
            //    (change-status 라우트가 없다) — HTTP 로 도달 불가라 그대로 둔다.
            //    라우트를 붙이려면 user.controller.changeStatus 와 동일한 가드
            //    (레벨10 이상 + canWriteBrand + 자기 자신 제외)를 먼저 넣어야 한다.
            // !user 는 '대상'만 확인한다. 요청자 로그인 여부를 안 봐서 비로그인이면
            // undefined < user.level 이 false → 남의 계정 비밀번호·상태를 바꿀 수 있었다.
            if (!decode_user || !user || decode_user?.level < user?.level) {
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
