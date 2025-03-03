'use strict';
import { checkIsManagerUrl, differenceTwoDate, generateRandomCode, returnMoment } from "../utils.js/function.js";
import { insertQuery, updateQuery } from "../utils.js/query-util.js";
import { createHashedPassword, checkLevel, makeUserToken, response, checkDns, lowLevelException } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import axios from "axios";
import speakeasy from 'speakeasy';
import { readPool, writePool } from "../config/db-pool.js";

const authCtrl = {
    signIn: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let { user_name, user_pw, is_manager, otp_num } = req.body;
            let user = await readPool.query(`SELECT * FROM users WHERE user_name=? AND ( brand_id=${decode_dns?.id ?? 0} OR level >=50 ) LIMIT 1`, user_name);
            user = user[0][0];

            if (!user || (is_manager && user.level <= 0)) {
                return response(req, res, -100, "가입되지 않은 회원입니다.", {})
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
            const token = makeUserToken({
                id: user.id,
                user_name: user.user_name,
                name: user.name,
                nickname: user.nickname,
                parent_id: user.parent_id,
                level: user.level,
                phone_num: user.phone_num,
                profile_img: user.profile_img,
                brand_id: user.brand_id,
                company_name: user.company_name,
                business_num: user.business_num,
                contract_img: user.contract_img,
                bsin_lic_img: user.bsin_lic_img,
                oper_id: user.oper_id,
                seller_trx_fee: user.seller_trx_fee,
                seller_range_u: user.seller_range_u,
                seller_range_o: user.seller_range_o,
                seller_brand: user.seller_brand,
                seller_category: user.seller_category,
            })
            res.cookie("token", token, {
                httpOnly: true,
                maxAge: (60 * 60 * 1000) * 12 * 2,
                //sameSite: 'none', 
                //secure: true 
            });
            let check_last_login_time = await updateQuery('users', {
                last_login_time: returnMoment()
            }, user.id)
            let wish_columns = [
                `user_wishs.*`,
            ]
            let wish_sql = `SELECT ${wish_columns.join()} FROM user_wishs `;
            wish_sql += ` WHERE user_wishs.user_id=${user?.id ?? 0} `;
            let wish_data = await readPool.query(wish_sql);
            wish_data = wish_data[0];

            user = {
                ...user,
                wish_data
            }
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
                seller_id
            } = req.body;
            if (!user_pw) {
                return response(req, res, -100, "비밀번호를 입력해 주세요.", {});
            }
            let pw_data = await createHashedPassword(user_pw);
            let is_exist_user = await readPool.query(`SELECT * FROM users WHERE user_name=? AND brand_id=${decode_dns?.id ?? 0} ${seller_id > 0 ? `AND seller_id=${seller_id}` : ``}`, [user_name]);

            //console.log(decode_dns?.seller_id)
            //console.log(is_exist_user[0])

            if (is_exist_user[0].length > 0) {
                return response(req, res, -100, "유저아이디가 이미 존재합니다.", false)
            }

            if (!is_manager) {
                if (level > 10) {
                    return lowLevelException(req, res);
                }
            }

            if (decode_dns?.setting_obj?.is_use_seller == 1) {
                let is_exist_phone = await readPool.query(`SELECT * FROM phone_registration WHERE phone_number=? AND brand_id=${decode_dns?.id ?? 0}`, [phone_num]);
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
                seller_id
            }

            let result = await insertQuery('users', obj);
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
            let point_data = await readPool.query(`SELECT SUM(point) AS point FROM points WHERE user_id=${decode_user?.id ?? 0}`);
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
            let result = await updateQuery('users', {
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
            }, decode_user?.id);
            await res.clearCookie('token');
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
            let return_moment = returnMoment();
            let already_phone_send_list = await readPool.query(`SELECT * FROM phone_check_tokens WHERE phone_num=? AND brand_id=${decode_dns?.id ?? 0} ORDER BY id DESC LIMIT 0, 5 `, [phone_num]);
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
                let users = await readPool.query(`SELECT * FROM users WHERE phone_num=? AND brand_id=${decode_dns?.id} AND status=0 `, [send_log?.phone_num]);
                users = users[0];
                data['users'] = users;
            }
            if (find_password) {
                let user = await readPool.query(`SELECT * FROM users WHERE phone_num=? AND user_name=? AND brand_id=${decode_dns?.id} AND status=0 `, [send_log?.phone_num, user_name]);
                user = user[0][0];
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
            let user = await readPool.query(`SELECT * FROM users WHERE (phone_num=? AND user_name=? AND brand_id=${decode_dns?.id} AND status=0) OR (id=${decode_user?.id ?? 0}) `, [phone_num, user_name,]);
            user = user[0][0];
            if (decode_user?.id == user?.id) {//개인정보 변경일때
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

            let pw_data = await createHashedPassword(new_password);
            let result = updateQuery('users', {
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
    resign: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, is_manager ? 1 : 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                password
            } = req.body;
            let user = await readPool.query(`SELECT * FROM users WHERE id=${decode_user?.id ?? 0} `);
            user = user[0][0];
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