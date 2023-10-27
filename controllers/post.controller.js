'use strict';
import _ from "lodash";
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQuery, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';

const table_name = 'posts';

const postCtrl = {
    list: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { category_id } = req.query;

            let category_sql = `SELECT id, parent_id FROM post_categories `;
            category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id} `;
            let category_list = await pool.query(category_sql);
            category_list = category_list?.result;
            
            let category_ids = findChildIds(category_list, category_id)
            category_ids.unshift(parseInt(category_id))
            let columns = [
                `${table_name}.*`,
                `users.nickname AS writer_nickname`,
                `users.user_name AS writer_user_name`,
                `post_categories.post_category_title`,
            ]

            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `
            sql += ` LEFT JOIN post_categories ON ${table_name}.category_id=post_categories.id `
            if (category_id) {
                sql += ` WHERE ${table_name}.category_id IN (${category_ids.join()}) `
            }
            let data = await getSelectQuery(sql, columns, req.query);

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
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let columns = [
                `${table_name}.*`,
                `post_categories.brand_id`
            ]
            let sql = ` SELECT ${columns.join()} FROM ${table_name} `
            sql += ` LEFT JOIN post_categories ON ${table_name}.category_id=post_categories.id `;
            sql += ` WHERE ${table_name}.id=${id} `
            let data = await pool.query(sql);
            data = data?.result[0];
            data.replies = [];
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
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
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                category_id, parent_id = -1, post_title, post_content, is_reply=0
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                category_id, parent_id, post_title, post_content, is_reply, 
                user_id: decode_user?.id,
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
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                category_id, parent_id = -1, post_title, post_content, is_reply=0, id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                category_id, parent_id, post_title, post_content, is_reply, 
            };
            console.log(obj)
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
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let result = await deleteQuery(`${table_name}`, {
                id
            })
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default postCtrl;
