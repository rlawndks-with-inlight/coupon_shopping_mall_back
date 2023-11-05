'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';

const table_name = 'points';

const pointCtrl = {
    list: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
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
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id} `;
            if (decode_user.level < 10) {
                sql += ` WHERE ${table_name}.user_id=${decode_user.id} `;
            }
            let data = await getSelectQueryList(sql, columns, req.query);

            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    get: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let sql = `SELECT ${table_name}.*, users.user_name FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
            sql += ` WHERE ${table_name}.id=${id} `
            let data = await pool.query(sql);
            data = data?.result[0];
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    create: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (decode_user.level < 10) {
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
            let user = await pool.query(`SELECT * FROM users WHERE user_name=? AND brand_id=${decode_dns?.id}`, [user_name]);
            user = user?.result[0];
            if (!user) {
                return response(req, res, -100, "유저가 존재하지 않습니다.", false)
            }
            type = point >= 0 ? 15 : 20
            let files = settingFiles(req.files);
            let obj = {
                point,
                note,
                type,
                user_id: user?.id,
                sender_id,
                brand_id
            };
            obj = { ...obj, ...files };
            let result = await insertQuery(`${table_name}`, obj);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (decode_user.level < 10) {
                return lowLevelException(req, res);
            }
            const {
                user_name = "",
                point,
                note,
                id
            } = req.body;
            let user = await pool.query(`SELECT * FROM users WHERE user_name=? AND brand_id=${decode_dns?.id} `, [user_name]);
            user = user?.result[0];
            if (!user) {
                return response(req, res, -100, "유저가 존재하지 않습니다.", false)
            }
            let type = point >= 0 ? 15 : 20
            let files = settingFiles(req.files);
            let obj = {
                point,
                note,
                user_id: user?.id,
                type,
            };
            obj = { ...obj, ...files };
            let result = await updateQuery(`${table_name}`, obj, id);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const { id } = req.params;
            let data = await pool.query(`SELECT * FROM ${table_name} WHERE id=${id}`)
            data = data?.result[0];
            if (decode_user.level < 10) {
                if (data?.user_id != id) {
                    return lowLevelException(req, res);
                }
            }
            let result = await deleteQuery(`${table_name}`, {
                id
            }, true)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default pointCtrl;
