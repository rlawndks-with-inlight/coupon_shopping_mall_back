'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl, returnMoment } from "../utils.js/function.js";
import { insertQuery, updateQuery } from "../utils.js/query-util.js";
import { createHashedPassword, checkLevel, makeUserToken, response, checkDns, lowLevelException } from "../utils.js/util.js";
import 'dotenv/config';

const authCtrl = {
    signIn: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            let { user_name, user_pw, is_manager } = req.body;
            let user = await pool.query(`SELECT * FROM users WHERE user_name=? AND ( brand_id=${decode_dns?.id} OR level >=50 ) LIMIT 1`, user_name);
            user = user?.result[0];
            console.log(is_manager)
            if (!user) {
                return response(req, res, -100, "가입되지 않은 회원입니다.", {})
            }
            if (is_manager && user.level <= 0) {
                return response(req, res, -100, "가입되지 않은 회원입니다.", {})
            }
            if (user?.status == 1) {
                return response(req, res, -100, "승인 대기중입니다.", {})
            }
            if (user?.status == 2) {
                return response(req, res, -100, "로그인 불가 회원입니다.", {})
            }
            user_pw = (await createHashedPassword(user_pw, user.user_salt)).hashedPassword;
            if (user_pw != user.user_pw) {
                return response(req, res, -100, "가입되지 않은 회원입니다.", {})
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

            return response(req, res, 100, "success", user)
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    signUp: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            let {
                user_name,
                user_pw,
                name,
                nickname,
                parent_id,
                level = 0,
                phone_num,
                profile_img,
                brand_id
            } = req.body;
            if (!user_pw) {
                return response(req, res, -100, "비밀번호를 입력해 주세요.", {});
            }
            let pw_data = await createHashedPassword(user_pw);
            if (!is_manager) {
                if (level > 0) {
                    return lowLevelException(req, res);
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
                user_salt
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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            res.clearCookie('token');
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    checkSign: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, is_manager ? 1 : 0);
            const decode_dns = checkDns(req.cookies.dns);

            return response(req, res, 100, "success", decode_user)
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default authCtrl;