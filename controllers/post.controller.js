'use strict';
import _ from "lodash";
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, findParent, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
const table_name = 'posts';

const postCtrl = {
    list: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { category_id } = req.query;

            let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
            category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id??0} `;
            let category_list = await pool.query(category_sql);
            category_list = category_list?.result;

            let category = _.find(category_list, { id: parseInt(category_id) });
            let top_parent = findParent(category_list, category);
            top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });

            let category_ids = findChildIds(category_list, category_id)
            category_ids.unshift(parseInt(category_id))
            let columns = [
                `${table_name}.*`,
                `users.nickname AS writer_nickname`,
                `users.user_name AS writer_user_name`,
                `users.nickname AS writer_nickname`,
                `post_categories.post_category_title`,
            ]

            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `
            sql += ` LEFT JOIN post_categories ON ${table_name}.category_id=post_categories.id `
            sql += ` WHERE ${table_name}.parent_id=-1 `
            if (category_id) {
                sql += ` AND ${table_name}.category_id IN (${category_ids.join()}) `
            }
            if(req.IS_RETURN){
                if (top_parent?.post_category_read_type == 1) {
                    sql += ` AND user_id=${decode_user?.id ?? 0} `;
                }
            }
            let data = await getSelectQueryList(sql, columns, req.query);

            let post_ids = data.content.map(item=>{
                return item?.id
            });
            post_ids.unshift(0);
            let child_posts = await pool.query(`SELECT * FROM posts WHERE parent_id IN (${post_ids.join()}) ORDER BY id DESC`);
            child_posts = child_posts?.result;
            data.content = data.content.map((item)=>{
                return {
                    ...item,
                    replies:child_posts.filter(itm=> itm.parent_id == item.id),
                }
            })
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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
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
            let child_posts = await pool.query(`SELECT * FROM posts WHERE parent_id=${id} ORDER BY id DESC`);
            child_posts = child_posts?.result;
            data.replies = child_posts;
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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                post_title_img,
                category_id, parent_id = -1, post_title, post_content, is_reply = 0
            } = req.body;
            let files = settingFiles(req.files);

            let obj = {
                post_title_img,
                category_id, parent_id, post_title, post_content, is_reply,
                user_id: decode_user?.id,
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
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                post_title_img,
                category_id, parent_id = -1, post_title, post_content, is_reply = 0, id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                post_title_img,
                category_id, parent_id, post_title, post_content, is_reply,
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
            let is_manager = await checkIsManagerUrl(req);
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
};

export default postCtrl;
