'use strict';
import { checkIsManagerUrl, differenceTwoDate, generateRandomCode, returnMoment } from "../utils.js/function.js";
import { insertQuery, updateQuery } from "../utils.js/query-util.js";
import { createHashedPassword, checkLevel, makeUserToken, response, checkDns, lowLevelException } from "../utils.js/util.js";
import { encForSave, decRow, decRows, blindIndex } from "../utils.js/pii.js";
import { isShopgoBrand } from "../utils.js/is-shopgo.js";
import {
    isValidSecurityQuestionId,
    normalizeAnswer,
    hashAnswer,
    verifyAnswer,
    stripUserSecrets,
    stripUserSecretsList,
} from "../utils.js/security-question.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import axios from "axios";
import speakeasy from 'speakeasy';
import { readPool, writePool } from "../config/db-pool.js";

// ─────────────────────────────────────────────────────────────────────────────
// 보안질문(SMS 없는 아이디찾기·비밀번호 재설정) 공용 상수/헬퍼.
// ⚠ 이 블록은 shopgo 본사(brands.id=98)와 그 하위 가맹점(brands.parent_id=98) 전용 신규 플로우에만 쓰인다.
//   (2026-08-06 사장님 결정: 본사 포함. shopgo.co.kr 자체도 SMS 게이트웨이가 없어 이 플로우를 써야 한다.)
//   기존 SMS 엔드포인트(sendPhoneVerifyCode / checkPhoneVerifyCode / changePassword)는 손대지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
const SECURITY_MAX_FAIL = 5;        // 연속 오답 허용 횟수
const SECURITY_LOCK_MINUTES = 30;   // 초과 시 잠금 시간(분)

// 계정 존재여부를 노출하지 않는 단일 실패 메시지(열거 공격 방지).
const SECURITY_GENERIC_NOT_FOUND = "일치하는 회원 정보를 찾을 수 없습니다.";
const SECURITY_GENERIC_NO_QUESTION = "일치하는 회원 정보를 찾을 수 없거나, 보안질문이 설정되어 있지 않습니다. 관리자에게 문의해 주세요.";
const SECURITY_GENERIC_MISMATCH = "아이디·이름·답변이 일치하지 않습니다.";

// 잠금 남은시간(초) → 사람이 읽는 분(최소 1분).
const lockLeftMinutes = (left_sec) => Math.max(1, Math.ceil((Number(left_sec) || 0) / 60));

// 아이디 찾기 결과 마스킹.
// 이 흐름은 문자 인증 없이 이름+휴대폰만으로 조회되므로, 아이디를 그대로 돌려주면
// 지인이 남의 로그인 아이디를 알아낼 수 있다. 앞 3자만 남기고 나머지를 가린다(본인 식별은 가능).
//   hongkildong -> hon********,  ab -> a*,  abcd -> abc*
const maskUserName = (user_name) => {
    const s = String(user_name ?? '');
    if (!s) return '';
    const visible = s.length <= 3 ? 1 : 3;
    return s.slice(0, visible) + '*'.repeat(Math.max(1, s.length - visible));
};

// shopgo 본사(98) 및 그 하위 가맹점(parent_id=98)에서만 동작하는 비로그인 엔드포인트의 공통 가드.
// (이름의 'ShopgoDns' 는 '본사+하위' 전체를 뜻한다 — 판정은 isShopgoBrand 하나뿐이다.)
// 통과하면 decode_dns, 아니면 이미 응답을 보낸 뒤 null 을 돌려준다(호출부는 즉시 return).
const guardShopgoDns = (req, res) => {
    const decode_dns = checkDns(req.cookies.dns);
    if (!decode_dns?.id) {
        response(req, res, -100, "도메인 정보를 확인할 수 없습니다.", false);
        return null;
    }
    if (!isShopgoBrand(decode_dns)) {
        response(req, res, -100, "지원하지 않는 기능입니다.", false);
        return null;
    }
    return decode_dns;
};

// 로그인 토큰 payload. signIn 과 setSecurityQuestion 이 '반드시' 같은 모양을 만들도록 한 곳에 모았다.
// (한쪽만 바뀌면 보안질문 저장 후 재발급된 토큰에서 필드가 사라져 화면이 깨진다.)
const makeUserTokenPayload = (user, agent) => ({
    id: user.id,
    user_name: user.user_name,
    name: user.name,
    nickname: user.nickname,
    parent_id: user.parent_id,
    level: user.level,
    phone_num: user.phone_num,
    unipass: user.unipass,
    profile_img: user.profile_img,
    brand_id: user.brand_id,
    company_name: user.company_name,
    business_num: user.business_num,
    contract_img: user.contract_img,
    bsin_lic_img: user.bsin_lic_img,
    oper_id: user.oper_id,
    seller_trx_fee: user.seller_trx_fee,
    seller_trx_fee_type: user.seller_trx_fee_type ?? 0,
    seller_range_u: user.seller_range_u,
    seller_range_o: user.seller_range_o,
    seller_brand: user.seller_brand,
    seller_category: user.seller_category,
    seller_property: user.seller_property,
    seller_point: user.seller_point,

    // ⚠ 기존 signIn 코드 그대로(옵셔널체이닝 추가 금지) — level==10 일 때만 agent 를 참조한다.
    oper_trx_fee: user.level == 10 ? agent.oper_trx_fee : user.oper_trx_fee,
    oper_trx_fee_type: user.level == 10 ? (agent.oper_trx_fee_type ?? 0) : (user.oper_trx_fee_type ?? 0),

    // 보안질문 설정 여부(1/0). 프론트 '보안질문 설정하기' 배너 노출 판단용.
    // ⚠ 값이 아니라 '설정됐는지'만 담는다(질문 id 는 토큰에 넣지 않는다).
    has_security_question: (user.security_question_id === null || user.security_question_id === undefined) ? 0 : 1,
});

// 토큰 쿠키 발급. signIn 의 res.cookie 옵션과 100% 동일해야 한다.
const issueUserTokenCookie = (res, token) => {
    res.cookie("token", token, {
        httpOnly: true,
        maxAge: (60 * 60 * 1000) * 12 * 2,
        sameSite: 'lax',
        secure: process.env.NODE_ENV !== 'development',
    });
};

const authCtrl = {
    signIn: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let { user_name, user_pw, is_manager, otp_num } = req.body;
            let user = '';
            if (decode_dns?.setting_obj?.is_use_seller == 1) {
                // `OR level >= 10` 에 brand_id 조건이 없어서, 아이디만 같으면
                // 다른 가맹점의 셀러·관리자 계정으로 이 몰에 로그인이 됐다(테넌트 경계 침범).
                // 의도는 '셀러 지정 없이도 이 브랜드의 셀러·관리자는 로그인' 이므로 브랜드를 묶는다.
                // level 50(개발사)은 전 브랜드 관리가 정상 동작이라 아래 else 분기와 동일하게 열어둔다.
                user = await readPool.query(`SELECT * FROM users WHERE user_name=? AND ((seller_id=? AND brand_id=?) OR (level >= 10 AND brand_id=?) OR level >= 50 ) LIMIT 1`, [user_name, decode_dns?.seller_id ?? 0, decode_dns?.id ?? 0, decode_dns?.id ?? 0]);
            } else {
                user = await readPool.query(`SELECT * FROM users WHERE user_name=? AND ( brand_id=? OR level >= 50 ) LIMIT 1`, [user_name, decode_dns?.id ?? 0]);
            }
            user = user[0][0];

            //console.log(decode_dns)
            let agent = '';

            if (user?.level == 10) {
                agent = await readPool.query(`SELECT * FROM users WHERE id=?`, [user?.oper_id]);
                agent = agent[0][0]
            }

            if (!user || (is_manager && user.level <= 0)) {
                return response(req, res, -100, "가입되지 않은 회원입니다.", {})
            }
            // 비밀번호가 없으면 createHashedPassword 가 TypeError 로 죽어 500 이 난다(계정이 실재할 때).
            if (!user_pw) {
                return response(req, res, -100, "아이디와 비밀번호를 입력해 주세요.", {})
            }
            user_pw = (await createHashedPassword(user_pw, user.user_salt)).hashedPassword;
            if (user_pw != user.user_pw) {
                return response(req, res, -100, "가입되지 않은 회원입니다.", {})
            }
            if (user?.status == 1) {
                return response(req, res, -100, "승인 대기중입니다.", {})
            }
            if (user?.status == 2) {
                return response(req, res, -100, "로그인 불가 회원입니다.", {})
            }
            if (user?.status == 3) {
                return response(req, res, -100, "탈퇴회원입니다.", {})
            }

            if (user?.level < 40 && !is_manager && decode_dns?.is_use_otp == 1) {
                var verified = speakeasy.totp.verify({
                    secret: user?.otp_token,
                    encoding: 'base32',
                    token: otp_num
                });
                if (!verified) {
                    return response(req, res, -100, "OTP번호가 잘못되었습니다.", {})
                }
            }
            decRow('users', user); // 토큰에 담기 전 실명·전화 복호화
            const token = makeUserToken(makeUserTokenPayload(user, agent))
            issueUserTokenCookie(res, token);
            let check_last_login_time = await updateQuery('users', {
                last_login_time: returnMoment()
            }, user.id)
            let wish_columns = [
                `user_wishs.*`,
            ]
            let wish_sql = `SELECT ${wish_columns.join()} FROM user_wishs `;
            wish_sql += ` WHERE user_wishs.user_id=? `;
            let wish_data = await readPool.query(wish_sql, [user?.id ?? 0]);
            wish_data = wish_data[0];

            user = stripUserSecrets({
                ...user,
                wish_data
            }) // ⚠ SELECT * 이므로 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트 제거 후 반환
            //    (비밀번호 비교·OTP 검증·토큰 발급을 모두 끝낸 '뒤'라서 로그인 동작에는 영향이 없다)
            return response(req, res, 100, "success", user)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    signUp: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let {
                user_name,
                user_pw,
                name,
                nickname,
                parent_id = -1,
                level = 0,
                phone_num,
                unipass,
                profile_img,
                brand_id,
                acct_num = "", acct_name = "", acct_bank_name = "", acct_bank_code = "",
                otp_token = "",
                company_name,
                business_num,
                contract_img,
                bsin_lic_img,
                shareholder_img,
                register_img,
                seller_id,
                security_question_id,
                security_answer
            } = req.body;
            if (!user_pw) {
                return response(req, res, -100, "비밀번호를 입력해 주세요.", {});
            }
            // shopgo 본사(brands.id=98)와 그 하위 가맹점(brands.parent_id=98)만 보안질문 필수.
            // → 본사 스토어프론트(shopgo.co.kr)에서 가입하는 일반 회원도 보안질문 선택+답변이 필수가 된다.
            // 그 외 브랜드는 값이 와도 무시 → 기존 동작 100% 불변.
            let security_fields = {};
            if (isShopgoBrand(decode_dns)) {
                const qid = parseInt(security_question_id, 10);
                if (!isValidSecurityQuestionId(qid)) {
                    return response(req, res, -100, "보안질문을 선택해 주세요.", {});
                }
                if (normalizeAnswer(security_answer).length < 2) {
                    return response(req, res, -100, "보안질문 답변을 2자 이상 입력해 주세요.", {});
                }
                const ans = await hashAnswer(security_answer); // 내부에서 normalizeAnswer 적용
                security_fields = {
                    security_question_id: qid,
                    security_answer_hash: ans.hashedPassword,
                    security_answer_salt: ans.salt,
                    security_set_at: returnMoment(),
                };
            }
            let pw_data = await createHashedPassword(user_pw);
            let is_exist_user_params = [user_name, decode_dns?.id ?? 0];
            let is_exist_user_sql = `SELECT * FROM users WHERE user_name=? AND brand_id=? AND is_delete = 0`;
            if (seller_id > 0) {
                is_exist_user_sql += ` AND seller_id=?`;
                is_exist_user_params.push(seller_id);
            }
            let is_exist_user = await readPool.query(is_exist_user_sql, is_exist_user_params);

            //console.log(decode_dns?.seller_id)
            //console.log(is_exist_user[0])

            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }

            // 공개 회원가입으로는 일반회원(0)만 만들 수 있다.
            //
            // 예전 기준은 `level > 10` 이었다. 즉 level=10(셀러)을 스스로 지정해 가입할 수 있었고,
            // 셀러 등급은 셀러 메뉴 접근에 더해 util/changeStatus 같은 엔드포인트의 기준선이기도 하다.
            // 게다가 is_manager 는 checkIsManagerUrl(req) 로 정해지는데 /manager 경로가
            // 라우터에 마운트된 적이 없어(routes/index.js) 항상 false 다 — 즉 위 조건이 유일한 방어였다.
            // 셀러·영업자·총판 계정은 관리자 화면의 users/create 로 만든다(그쪽은 등급 검증이 있다).
            if (!is_manager) {
                if (level > 0) {
                    return lowLevelException(req, res);
                }
            }

            if (decode_dns?.setting_obj?.is_use_seller == 1) {
                let is_exist_phone = await readPool.query(`SELECT * FROM phone_registration WHERE (phone_number=? OR phone_idx=?) AND brand_id=? AND is_delete = 0`, [phone_num, blindIndex(phone_num), decode_dns?.id ?? 0]);
                if (is_exist_phone[0].length <= 0) {
                    //console.log(is_exist_phone[0])
                    return response(req, res, -100, "가입 허락된 전화번호가 아닙니다. 관리자에 문의하세요.", false)
                }
            }

            user_pw = pw_data.hashedPassword;
            let user_salt = pw_data.salt;
            let obj = {
                user_name,
                user_pw,
                name,
                nickname,
                parent_id,
                level,
                phone_num,
                unipass,
                profile_img,
                brand_id,
                user_salt,
                acct_num, acct_name, acct_bank_name, acct_bank_code,
                otp_token,
                status: decode_dns?.setting_obj?.is_sign_up_status_1 == 1 ? 1 : 0,
                company_name,
                business_num,
                contract_img,
                bsin_lic_img,
                shareholder_img,
                register_img,
                seller_id,
                ...security_fields
            }

            obj = encForSave('users', obj); // 실명·전화 암호화 + blind-index (신규 security_* 키는 그대로 통과)
            let result = await insertQuery('users', obj);
            if (!result) {
                // insertQuery 는 실패 시 false 를 돌려주고 삼킨다(query-util.js).
                // 검사하지 않으면 '가입 성공' 응답을 주면서 실제로는 회원이 없는 무증상 유실이 된다.
                return response(req, res, -100, "회원가입 중 에러가 발생했습니다.", false)
            }
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(JSON.stringify(err))
            return response(req, res, -200, err?.message || "서버 에러 발생", false)
        } finally {

        }
    },
    signOut: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            res.clearCookie('token');
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    checkSign: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let point_data = await readPool.query(`SELECT SUM(point) AS point FROM points WHERE user_id=?`, [decode_user?.id ?? 0]);
            let point = point_data[0][0]?.point;
            return response(req, res, 100, "success", { ...decode_user, point })
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    changeInfo: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                nickname,
                phone_num,
                phone_token,
                profile_img,
                acct_num,
                acct_name,
                acct_bank_name,
                company_name,
                business_num,
                contract_img,
                bsin_lic_img,
                shareholder_img,
                register_img
            } = req.body
            let return_moment = returnMoment();
            // 휴대폰 인증 토큰은 '보내온 경우에만' 검증한다.
            //
            // 기존엔 phone_token 을 무조건 요구했다. 그런데 이 API 를 부르는 화면 중
            // 인증칸이 있는 곳은 프레임3 정보수정 하나뿐이고, 블로그형 마이페이지
            // 회원정보 수정(프레임4~11)은 nickname·phone_num 만 보낸다.
            // 그래서 닉네임 한 글자 바꾸는 것도 "토큰을 찾을 수 없습니다." 로 거절됐다 —
            // 블로그형 프레임 전체에서 회원정보 수정이 아예 불가능했다.
            // 게다가 문자 게이트웨이(bonaeja)를 쓰지 않기로 해서 토큰을 받을 방법 자체가 없다.
            //
            // 토큰을 함께 보내는 브랜드에서는 검증이 그대로 동작한다(기존 동작 보존).
            if (phone_token) {
                let send_log = await readPool.query(`SELECT * FROM phone_check_tokens WHERE phone_token=? ORDER BY id DESC LIMIT 1`, [
                    phone_token,
                ])
                send_log = send_log[0][0];
                if (!send_log) {
                    return response(req, res, -100, "토큰을 찾을 수 없습니다.", false)
                }
                if (differenceTwoDate(return_moment, send_log?.created_at).second > 180) {
                    return response(req, res, -100, "인증시간이 지났습니다. 다시 인증해 주세요.", false)
                }
            }
            let result = await updateQuery('users', encForSave('users', {
                nickname,
                phone_num,
                profile_img,
                acct_num,
                acct_name,
                acct_bank_name,
                company_name,
                business_num,
                contract_img,
                bsin_lic_img,
                shareholder_img,
                register_img
            }), decode_user?.id); // phone_num 암호화 + phone_idx 세팅(부분 업데이트 안전, name 없음)

            // 토큰 재발급 — payload 에 nickname·phone_num·profile_img 가 들어 있어서
            // 저장만 하고 두면 화면이 옛 값을 계속 보여준다.
            // 기존에는 clearCookie 로 강제 로그아웃시켰는데, 블로그형 마이페이지는
            // 성공 토스트만 띄우고 그 자리에 머물러서 이후 요청이 전부 실패했다.
            // setSecurityQuestion 과 같은 방식으로 재발급한다(payload 모양도 한 곳에서 관리).
            let fresh_user = await readPool.query(`SELECT * FROM users WHERE id=? AND is_delete=0 LIMIT 1`, [decode_user?.id]);
            fresh_user = fresh_user[0][0];
            if (fresh_user) {
                let agent = '';
                if (fresh_user?.level == 10) {
                    agent = await readPool.query(`SELECT * FROM users WHERE id=?`, [fresh_user?.oper_id]);
                    agent = agent[0][0]
                }
                decRow('users', fresh_user); // 토큰에 담기 전 실명·전화 복호화(signIn 과 동일)
                const token = makeUserToken(makeUserTokenPayload(fresh_user, agent));
                issueUserTokenCookie(res, token);
            }
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    sendPhoneVerifyCode: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const {
                phone_num,
            } = req.body;
            // 값이 없으면 아래 createHashedPassword(phone_num) 에서 pbkdf2 가 TypeError 로 죽는다
            // (ERR_INVALID_ARG_TYPE → 500 "서버 에러 발생"). 입력 검증으로 먼저 걸러낸다.
            if (!phone_num) {
                return response(req, res, -100, "휴대폰 번호를 입력해 주세요.", false)
            }
            let return_moment = returnMoment();
            let already_phone_send_list = await readPool.query(`SELECT * FROM phone_check_tokens WHERE phone_num=? AND brand_id=? ORDER BY id DESC LIMIT 0, 5 `, [phone_num, decode_dns?.id ?? 0]);
            already_phone_send_list = already_phone_send_list[0];
            if (already_phone_send_list.length >= 5 && differenceTwoDate(return_moment, already_phone_send_list[4]?.created_at).second < 60) {
                return response(req, res, -100, "너무 많은 문자를 발송했습니다. 1분뒤에 시도해 주세요.", false)
            }
            let phone_token = await createHashedPassword(phone_num);
            phone_token = phone_token.hashedPassword;
            let rand_num = generateRandomCode(6);
            if (
                !decode_dns?.bonaeja_obj?.api_key ||
                !decode_dns?.bonaeja_obj?.user_id ||
                !decode_dns?.bonaeja_obj?.sender
            ) {
                return response(req, res, -100, "인증번호 발송기능이 제공되지 않습니다. 본사에 문의해 주세요.", false)
            }

            let { data: send_message } = await axios.post(`${process.env.BONAEJA_URL}/api/msg/v1/send`, {
                api_key: decode_dns?.bonaeja_obj?.api_key,
                user_id: decode_dns?.bonaeja_obj?.user_id,
                sender: decode_dns?.bonaeja_obj?.sender,
                receiver: phone_num.replaceAll(' ', '').replaceAll('-', ''),
                msg: `[${decode_dns?.name}] 인증번호 ${rand_num}을(를) 입력해주세요.`,
            })

            if (send_message?.code == 100) {
                let result = await writePool.query(`INSERT INTO phone_check_tokens (brand_id, phone_num, phone_token, rand_num) VALUES (?, ?, ?, ?)`, [
                    decode_dns?.id,
                    phone_num,
                    phone_token,
                    rand_num,
                ])
                return response(req, res, 100, "success", {
                    phone_token
                })
            } else {
                return response(req, res, -100, "발송중에러", false)
            }
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    checkPhoneVerifyCode: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                rand_num,
                phone_token,
                find_user_name,
                find_password,
                user_name
            } = req.body;

            let return_moment = returnMoment();

            let send_log = await readPool.query(`SELECT * FROM phone_check_tokens WHERE phone_token=? ORDER BY id DESC LIMIT 1`, [
                phone_token,
            ])
            send_log = send_log[0][0];
            if (!send_log) {
                return response(req, res, -100, "발송이력을 찾을 수 없습니다.", false)
            }
            if (send_log?.rand_num != rand_num) {
                return response(req, res, -100, "인증번호가 일치하지 않습니다.", false)
            }
            if (differenceTwoDate(return_moment, send_log?.created_at).second > 180) {
                return response(req, res, -100, "인증시간이 지났습니다. 다시 인증해 주세요.", false)
            }
            let data = {};
            if (find_user_name) {
                let users = await readPool.query(`SELECT * FROM users WHERE (phone_num=? OR phone_idx=?) AND brand_id=? AND status=0 `, [send_log?.phone_num, blindIndex(send_log?.phone_num), decode_dns?.id]);
                users = users[0];
                decRows('users', users); // 읽기 복호화
                stripUserSecretsList(users); // ⚠ 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트는 클라이언트로 내보내지 않는다
                data['users'] = users;
            }
            if (find_password) {
                let user = await readPool.query(`SELECT * FROM users WHERE (phone_num=? OR phone_idx=?) AND user_name=? AND brand_id=? AND status=0 `, [send_log?.phone_num, blindIndex(send_log?.phone_num), user_name, decode_dns?.id]);
                user = user[0][0];
                decRow('users', user); // 읽기 복호화
                stripUserSecrets(user); // ⚠ 자격증명(user_pw/user_salt/otp_token)·보안질문 해시/솔트는 클라이언트로 내보내지 않는다
                if (user?.status == 1) {
                    return response(req, res, -100, "승인 대기중입니다.", {})
                }
                if (user?.status == 2) {
                    return response(req, res, -100, "로그인 불가 회원입니다.", {})
                }
                if (user?.status == 3) {
                    return response(req, res, -100, "탈퇴회원입니다.", {})
                }
                data['users'] = [
                    { ...user }
                ];
            }
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    // ─────────────────────────────────────────────────────────────────────────
    // [신규] SMS 없이 아이디찾기 — POST /api/auth/find-id
    // body: { name, phone_num }  →  data: { users: [{ user_name }] }
    // 이름과 휴대폰번호 '둘 다' 일치해야 한다(아이디 열거 방지). user_name 외 컬럼은 절대 반환하지 않는다.
    // ─────────────────────────────────────────────────────────────────────────
    findId: async (req, res, next) => {
        try {
            const decode_dns = guardShopgoDns(req, res);
            if (!decode_dns) return;
            let { name, phone_num } = req.body;
            name = String(name ?? '').trim();
            phone_num = String(phone_num ?? '').trim();
            if (!name || !phone_num) {
                return response(req, res, -100, "이름과 휴대폰번호를 모두 입력해 주세요.", false)
            }
            // 이름·전화 모두 dual leg: 평문(백필 전 행) OR blind-index(암호화된 행).
            // blindIndex 는 공백/하이픈을 제거하므로 010-1234-5678 과 01012345678 이 같이 잡힌다.
            let users = await readPool.query(`SELECT user_name FROM users WHERE (name=? OR name_idx=?) AND (phone_num=? OR phone_idx=?) AND brand_id=? AND status=0 AND is_delete=0 ORDER BY id ASC LIMIT 20`, [
                name,
                blindIndex(name),
                phone_num,
                blindIndex(phone_num),
                decode_dns?.id,
            ]);
            // 아이디 일부 마스킹. 이름+휴대폰만 알면 조회되는 흐름이라(문자 인증이 없다)
            // 지인이 남의 로그인 아이디를 그대로 알아내는 것을 막는다. 본인은 앞자리로 식별 가능.
            users = users[0].map((item) => ({ user_name: maskUserName(item?.user_name) })); // 그 외 컬럼(PII·해시)은 반환 금지
            if (users.length <= 0) {
                return response(req, res, -100, SECURITY_GENERIC_NOT_FOUND, false)
            }
            return response(req, res, 100, "success", { users })
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    // ─────────────────────────────────────────────────────────────────────────
    // [신규] 보안질문 조회(비로그인) — POST /api/auth/security-question
    // body: { user_name, name }  →  data: { security_question_id }
    // 아이디+이름 두 가지를 모두 알아야 질문을 볼 수 있다. 없는 계정/이름 불일치/질문 미설정은
    // 전부 같은 메시지로 응답해 어느 경우인지 구분되지 않게 한다(계정 열거 방지).
    // ─────────────────────────────────────────────────────────────────────────
    getSecurityQuestion: async (req, res, next) => {
        try {
            const decode_dns = guardShopgoDns(req, res);
            if (!decode_dns) return;
            let { user_name, name } = req.body;
            user_name = String(user_name ?? '').trim();
            name = String(name ?? '').trim();
            if (!user_name || !name) {
                return response(req, res, -100, "아이디와 이름을 모두 입력해 주세요.", false)
            }
            // 잠금 판정은 반드시 DB NOW() 기준(노드↔DB 시간대 어긋남 방지).
            let rows = await readPool.query(`SELECT security_question_id, (security_locked_until IS NOT NULL AND security_locked_until > NOW()) AS is_locked, TIMESTAMPDIFF(SECOND, NOW(), security_locked_until) AS lock_left_sec FROM users WHERE user_name=? AND (name=? OR name_idx=?) AND brand_id=? AND status=0 AND is_delete=0 LIMIT 1`, [
                user_name,
                name,
                blindIndex(name),
                decode_dns?.id,
            ]);
            let row = rows[0][0];
            if (!row || !(row?.security_question_id > 0)) {
                return response(req, res, -100, SECURITY_GENERIC_NO_QUESTION, false)
            }
            if (Number(row?.is_locked) === 1) {
                return response(req, res, -100, `답변을 ${SECURITY_MAX_FAIL}회 틀려 잠겨 있습니다. ${lockLeftMinutes(row?.lock_left_sec)}분 후 다시 시도하거나 관리자에게 문의해 주세요.`, false)
            }
            return response(req, res, 100, "success", { security_question_id: Number(row?.security_question_id) })
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    // ─────────────────────────────────────────────────────────────────────────
    // [신규] 보안질문 답변으로 비밀번호 재설정 — POST /api/auth/reset-password-by-answer
    // body: { user_name, name, security_answer, new_password }
    // 잠금 정책: 연속 오답 5회 → 30분 잠금(카운트는 0으로 리셋). 성공 시 카운트·잠금 모두 해제.
    // 시간 계산은 전부 DB의 NOW()/DATE_ADD 로만 한다.
    // ─────────────────────────────────────────────────────────────────────────
    resetPasswordByAnswer: async (req, res, next) => {
        try {
            const decode_dns = guardShopgoDns(req, res);
            if (!decode_dns) return;
            let { user_name, name, security_answer, new_password } = req.body;
            user_name = String(user_name ?? '').trim();
            name = String(name ?? '').trim();
            new_password = String(new_password ?? ''); // 비밀번호는 trim 하지 않는다(공백도 유효 문자)
            if (!user_name || !name || !normalizeAnswer(security_answer) || !new_password) {
                return response(req, res, -100, "입력값을 모두 입력해 주세요.", false)
            }
            if (new_password.length < 8) {
                return response(req, res, -100, "비밀번호는 8자 이상으로 입력해 주세요.", false)
            }
            if (new_password.length > 100) {
                return response(req, res, -100, "비밀번호는 100자 이하로 입력해 주세요.", false)
            }
            let rows = await readPool.query(`SELECT id, security_answer_hash, security_answer_salt, security_fail_count, (security_locked_until IS NOT NULL AND security_locked_until > NOW()) AS is_locked, TIMESTAMPDIFF(SECOND, NOW(), security_locked_until) AS lock_left_sec FROM users WHERE user_name=? AND (name=? OR name_idx=?) AND brand_id=? AND status=0 AND is_delete=0 LIMIT 1`, [
                user_name,
                name,
                blindIndex(name),
                decode_dns?.id,
            ]);
            let user = rows[0][0];
            if (!user || !user?.security_answer_hash || !user?.security_answer_salt) {
                // 존재하지 않는 계정 / 보안질문 미설정 계정 — 동일 메시지
                return response(req, res, -100, SECURITY_GENERIC_NO_QUESTION, false)
            }
            if (Number(user?.is_locked) === 1) {
                return response(req, res, -100, `답변을 ${SECURITY_MAX_FAIL}회 틀려 잠겨 있습니다. ${lockLeftMinutes(user?.lock_left_sec)}분 후 다시 시도하거나 관리자에게 문의해 주세요.`, false)
            }
            let is_correct = await verifyAnswer(security_answer, user?.security_answer_hash, user?.security_answer_salt);
            if (!is_correct) {
                // 원자적 1문장. MySQL 은 SET 을 좌→우로 평가하므로 첫 줄 시점의 security_fail_count 는 아직 '이전 값'.
                await writePool.query(`UPDATE users SET security_locked_until = IF(security_fail_count + 1 >= ?, DATE_ADD(NOW(), INTERVAL ? MINUTE), security_locked_until), security_fail_count = IF(security_fail_count + 1 >= ?, 0, security_fail_count + 1) WHERE id=?`, [
                    SECURITY_MAX_FAIL,
                    SECURITY_LOCK_MINUTES,
                    SECURITY_MAX_FAIL,
                    user?.id,
                ]);
                let fail_count = (Number(user?.security_fail_count) || 0) + 1;
                if (fail_count >= SECURITY_MAX_FAIL) {
                    return response(req, res, -100, `${SECURITY_GENERIC_MISMATCH} ${SECURITY_MAX_FAIL}회 틀려 ${SECURITY_LOCK_MINUTES}분간 잠겼습니다. ${SECURITY_LOCK_MINUTES}분 후 다시 시도하거나 관리자에게 문의해 주세요.`, false)
                }
                return response(req, res, -100, `${SECURITY_GENERIC_MISMATCH} 남은 시도 횟수 ${SECURITY_MAX_FAIL - fail_count}회 (${SECURITY_MAX_FAIL}회 틀리면 ${SECURITY_LOCK_MINUTES}분간 잠깁니다.)`, false)
            }
            // 성공 — 비밀번호는 파일 전체와 동일한 방식(PBKDF2 + 새 salt → users.user_salt)으로 저장하고 실패/잠금 해제.
            let pw_data = await createHashedPassword(new_password);
            await writePool.query(`UPDATE users SET user_pw=?, user_salt=?, security_fail_count=0, security_locked_until=NULL WHERE id=?`, [
                pw_data.hashedPassword,
                pw_data.salt,
                user?.id,
            ]);
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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, is_manager ? 1 : 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                phone_token,
                password,
                new_password,
                phone_num,
                user_name,
            } = req.body;

            let return_moment = returnMoment();
            let user = await readPool.query(`SELECT * FROM users WHERE ((phone_num=? OR phone_idx=?) AND user_name=? AND brand_id=? AND status=0) OR (id=?) `, [phone_num, blindIndex(phone_num), user_name, decode_dns?.id, decode_user?.id ?? 0]);
            user = user[0][0];
            // 회원을 못 찾으면 아래 user.user_salt 에서, 비밀번호가 비면 createHashedPassword 에서 각각
            // TypeError 로 죽는다(→ 500 "서버 에러 발생"). 두 경우 모두 명시적으로 먼저 걸러낸다.
            if (!user) {
                return response(req, res, -100, "일치하는 회원 정보를 찾을 수 없습니다.", false)
            }
            if (decode_user?.id == user?.id) {//개인정보 변경일때
                if (!password) {
                    return response(req, res, -100, "현재 비밀번호를 입력해 주세요.", false)
                }
                let user_pw = (await createHashedPassword(password, user.user_salt)).hashedPassword;
                if (user_pw != user.user_pw) {
                    return response(req, res, -100, "현재비밀번호가 일치하지 않습니다.", {})
                }
            } else {//비밀번호 찾기일때
                let send_log = await readPool.query(`SELECT * FROM phone_check_tokens WHERE phone_token=? ORDER BY id DESC LIMIT 1`, [
                    phone_token,
                ])
                send_log = send_log[0][0];
                if (send_log?.phone_num != phone_num) {
                    return response(req, res, -100, "휴대폰번호가 일치하지 않습니다.", false)
                }
                if (differenceTwoDate(return_moment, send_log?.created_at).second > 60 * 60) {
                    return response(req, res, -100, "토큰이 만료되었습니다. 다시 인증해 주세요.", false)
                }
            }
            if (user?.status == 1) {
                return response(req, res, -100, "승인 대기중입니다.", {})
            }
            if (user?.status == 2) {
                return response(req, res, -100, "로그인 불가 회원입니다.", {})
            }
            if (user?.status == 3) {
                return response(req, res, -100, "탈퇴회원입니다.", {})
            }

            // 빈 새 비밀번호로 덮어쓰지 않는다. hash('') 가 저장되면 signIn 에 빈값 체크가 없어서
            // 그 계정은 아이디만 알면 비밀번호 없이 열린다(프론트 화면들의 검증만 믿으면 안 된다).
            // ⚠ 비밀번호는 trim 하지 않는다(공백도 유효 문자) — resetPasswordByAnswer 와 동일 규칙.
            if (!new_password) {
                return response(req, res, -100, "새 비밀번호를 입력해 주세요.", false)
            }
            let pw_data = await createHashedPassword(new_password);
            // ⚠ user_pw 와 user_salt 는 항상 쌍으로 갱신한다(salt 만 옛 값이면 로그인 불가).
            let result = await updateQuery('users', {
                user_pw: pw_data.hashedPassword,
                user_salt: pw_data.salt,
            }, user?.id);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    // ─────────────────────────────────────────────────────────────────────────
    // [신규] 보안질문 설정/변경(로그인 상태) — PUT /api/auth/security-question
    // body: { security_question_id, security_answer }
    // 권한 근거는 쿠키 토큰뿐이다(대상 id 를 body 로 받지 않는다).
    // 저장 후 토큰을 재발급해 has_security_question 이 재로그인 없이 1 로 바뀌게 한다.
    // ─────────────────────────────────────────────────────────────────────────
    setSecurityQuestion: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user?.id) {
                return lowLevelException(req, res);
            }
            if (!decode_dns?.id) {
                return response(req, res, -100, "도메인 정보를 확인할 수 없습니다.", false)
            }
            if (!isShopgoBrand(decode_dns)) { // 본사(98) 포함
                return response(req, res, -100, "지원하지 않는 기능입니다.", false)
            }
            const { security_question_id, security_answer } = req.body;
            const qid = parseInt(security_question_id, 10); // multipart 라 body 는 전부 문자열
            if (!isValidSecurityQuestionId(qid)) {
                return response(req, res, -100, "보안질문을 선택해 주세요.", false)
            }
            if (normalizeAnswer(security_answer).length < 2) {
                return response(req, res, -100, "답변을 2자 이상 입력해 주세요.", false)
            }
            let user = await readPool.query(`SELECT * FROM users WHERE id=? AND is_delete=0 LIMIT 1`, [decode_user?.id]);
            user = user[0][0];
            if (!user) {
                return lowLevelException(req, res);
            }
            // 토큰 재발급에 필요한 상위(오퍼레이터) 정보는 저장 '전에' 읽는다(signIn 과 동일한 조회).
            let agent = '';
            if (user?.level == 10) {
                agent = await readPool.query(`SELECT * FROM users WHERE id=?`, [user?.oper_id]);
                agent = agent[0][0]
            }
            const ans = await hashAnswer(security_answer); // 내부에서 normalizeAnswer 적용
            // security_set_at 도 DB NOW() 로 기록(노드 로컬시각 사용 금지).
            await writePool.query(`UPDATE users SET security_question_id=?, security_answer_hash=?, security_answer_salt=?, security_fail_count=0, security_locked_until=NULL, security_set_at=NOW() WHERE id=?`, [
                qid,
                ans.hashedPassword,
                ans.salt,
                user?.id,
            ]);

            // 토큰 재발급 — signIn 과 동일한 payload/쿠키 옵션.
            // 이걸 빼면 has_security_question 이 옛 토큰 값(0)으로 남아 재로그인 전까지 배너가 계속 뜬다.
            decRow('users', user); // 토큰에 담기 전 실명·전화 복호화(signIn 과 동일)
            user.security_question_id = qid; // 방금 저장한 값을 payload 에 반영
            const token = makeUserToken(makeUserTokenPayload(user, agent))
            issueUserTokenCookie(res, token);
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    resign: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, is_manager ? 1 : 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                password
            } = req.body;
            let user = await readPool.query(`SELECT * FROM users WHERE id=? `, [decode_user?.id ?? 0]);
            user = user[0][0];
            // 토큰이 없거나 만료돼 회원을 못 찾으면 user.user_salt 에서, 비밀번호가 비면
            // createHashedPassword 에서 TypeError 로 죽는다(→ 500). 먼저 걸러낸다.
            if (!user) {
                return response(req, res, -100, "로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요.", false)
            }
            if (!password) {
                return response(req, res, -100, "비밀번호를 입력해 주세요.", false)
            }
            let user_pw = (await createHashedPassword(password, user.user_salt)).hashedPassword;
            if (user_pw != user.user_pw) {
                return response(req, res, -100, "비밀번호가 일치하지 않습니다.", {})
            }
            await updateQuery('users', {
                status: 3,
                is_delete: 1
            }, user?.id);
            await res.clearCookie('token');
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default authCtrl;