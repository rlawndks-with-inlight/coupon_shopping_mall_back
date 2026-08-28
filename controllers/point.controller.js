'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'points';

// 관리자가 회원에게 직접 주고 빼는 포인트. **여기 넣은 값이 곧 잔액**이다
// (결제는 `SELECT SUM(point) FROM points WHERE user_id=?` 로 잔액을 본다).
//
// [무엇이 뚫려 있었나 — 2026-08-28 운영 API 로 확인]
//   999,999,999,999 · 1.5 · 0 · 'abc' 가 전부 '성공' 으로 통과했다.
//   `points.point` 는 **double** 이라 DB 도 범위를 막지 않는다 —
//   실제로 잔액이 1조 원이 됐다(시험 행은 즉시 지웠다).
//   오타로 0 하나만 더 붙어도 그 회원은 그만큼을 결제에 그대로 쓴다.
//   'abc' 는 행이 안 생겼는데도 화면엔 '성공' 이 떴다(insertQuery 가 오류를 삼킨다).
//
// ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
const 한번상한 = 10000000;   // 1회 1천만 포인트. 더 필요하면 나눠 준다.
const 포인트검사 = (point) => {
    const 원값 = String(point ?? '').replace(/,/g, '').trim();
    if (원값 === '' || !/^-?\d+$/.test(원값)) return '포인트는 정수로만 입력해 주세요.';
    const n = parseInt(원값, 10);
    if (n === 0) return '0 포인트는 지급하거나 차감할 수 없습니다.';
    if (Math.abs(n) > 한번상한) return '한 번에 주고받을 수 있는 포인트를 넘었습니다. 다시 확인해 주세요.';
    return null;
};
const 포인트값 = (point) => parseInt(String(point).replace(/,/g, '').trim(), 10);

const pointCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let columns = [
                `${table_name}.*`,
                `users.user_name`,
                `users.nickname`,
                `sender.user_name AS sender_name`
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
            sql += ` LEFT JOIN users AS sender ON ${table_name}.sender_id=sender.id `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);
            // checkLevel 은 실패하면 false 를 반환할 뿐 throw 하지 않는다.
            // false.level 은 TypeError 가 아니라 undefined 이고 undefined < 10 은 false 라,
            // 비로그인 요청이 이 '내 것만 보기' 좁히기를 건너뛰고 브랜드 전체 포인트 내역을 받아갔다.
            // !decode_user 를 먼저 본다.
            if (!decode_user || decode_user?.level < 10) {
                sql += ` AND ${table_name}.user_id=? `;
                // undefined 를 바인딩하면 쿼리가 터지므로 0 으로 (비로그인은 0건이 된다)
                params.push(decode_user?.id ?? 0);
            }
            let data = await getSelectQueryList(sql, columns, req.query, [], params);

            return response(req, res, 100, "success", data);
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
            let sql = `SELECT ${table_name}.*, users.user_name FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
            sql += ` WHERE ${table_name}.id=? `
            let data = await readPool.query(sql, [id]);
            data = data[0][0];
            return response(req, res, 100, "success", data)
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
            // false.level 은 undefined 이고 undefined < 10 은 false 라 비로그인이 통과했다(fail-open).
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let type = undefined;

            let sender_id = decode_user?.id;
            const {
                user_name = "",
                point,
                note,
                brand_id
            } = req.body;
            let user = await readPool.query(`SELECT * FROM users WHERE user_name=? AND brand_id=?`, [user_name, decode_dns?.id ?? 0]);
            user = user[0][0];
            if (!user) {
                return response(req, res, -100, "유저가 존재하지 않습니다.", false)
            }
            const 값잘못 = 포인트검사(point);
            if (값잘못) { return response(req, res, -100, 값잘못, false); }
            type = point >= 0 ? 15 : 20
            let files = settingFiles(req.files);
            let obj = {
                point: 포인트값(point),
                note,
                type,
                user_id: user?.id,
                sender_id,
                // body 의 brand_id 를 그대로 insert 하면 남의 가맹점 앞으로 포인트 행을 만들 수 있다.
                // 쓰기 대상 브랜드는 로그인 토큰 기준으로 확정한다(레벨50 이상만 교차 브랜드 허용).
                brand_id: resolveWriteBrandId(decode_user, brand_id, decode_dns)
            };
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
            // false.level 은 undefined 이고 undefined < 10 은 false 라 비로그인이 통과했다(fail-open).
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            const {
                user_name = "",
                point,
                note,
                id
            } = req.body;
            let user = await readPool.query(`SELECT * FROM users WHERE user_name=? AND brand_id=? `, [user_name, decode_dns?.id ?? 0]);
            user = user[0][0];
            if (!user) {
                return response(req, res, -100, "유저가 존재하지 않습니다.", false)
            }
            const 값잘못 = 포인트검사(point);
            if (값잘못) { return response(req, res, -100, 값잘못, false); }
            let type = point >= 0 ? 15 : 20
            let files = settingFiles(req.files);
            let obj = {
                point: 포인트값(point),
                note,
                user_id: user?.id,
                type,
            };
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
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const { id } = req.params;
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
            data = data[0][0];
            // false.level 은 undefined 이고 undefined < 10 은 false 라 비로그인이 통과했다(fail-open).
            if (!decode_user || decode_user?.level < 10) {
                // 소유자 비교 대상이 잘못돼 있었다. id 는 '포인트 행의 id' 라
                // data.user_id 와 비교하면 우연히 값이 같은 행에서만 통과/차단이 갈렸다.
                // 비교해야 할 것은 요청자의 user id 다.
                // 또한 느슨비교라 null != undefined 가 false 다 —
                // user_id 가 NULL 인 행을 비로그인이 지울 수 있으므로 '로그인 + 일치' 를 양성 조건으로 쓴다.
                if (!(decode_user?.id > 0 && data?.user_id == decode_user?.id)) {
                    return lowLevelException(req, res);
                }
            }
            let result = await deleteQuery(`${table_name}`, {
                id
            }, true)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default pointCtrl;
