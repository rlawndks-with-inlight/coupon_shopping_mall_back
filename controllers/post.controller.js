'use strict';
import _ from "lodash";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, findParent, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'posts';


const postCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { category_id } = req.query;

            let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
            category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id ?? 0} `;
            let category_list = await readPool.query(category_sql);
            category_list = category_list[0];

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

            if (category_id == 91) {
                if (decode_user?.level < 20) {
                    if (decode_user?.level == 15) {
                        sql += ` AND ${table_name}.user_id IN (SELECT id FROM users WHERE oper_id=${decode_user?.id ?? 0})`
                    } else if (decode_user?.level == 10) {
                        sql += ` AND ${table_name}.user_id = ${decode_user?.id ?? 0}`
                    }
                }
            }

            if (req.IS_RETURN) {
                if (top_parent?.post_category_read_type == 1) {
                    sql += ` AND user_id=${decode_user?.id ?? 0} `;
                }
            }
            let data = await getSelectQueryList(sql, columns, req.query);

            let post_ids = data.content.map(item => {
                return item?.id
            });
            post_ids.unshift(0);
            let child_posts = await readPool.query(`SELECT * FROM posts WHERE parent_id IN (${post_ids.join()}) ORDER BY id DESC`);
            child_posts = child_posts[0];
            data.content = data.content.map((item) => {
                return {
                    ...item,
                    replies: child_posts.filter(itm => itm.parent_id == item.id),
                    lang_obj: JSON.parse(item?.lang_obj ?? `{}`),
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
            let data = await readPool.query(sql);
            data = data[0][0];
            data.lang_obj = JSON.parse(data?.lang_obj ?? '{}')
            let child_posts = await readPool.query(`SELECT * FROM posts WHERE parent_id=${id} ORDER BY id DESC`);
            child_posts = child_posts[0];
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

            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, result?.insertId);


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
            const {
                post_title_img,
                category_id, parent_id = -1, post_title, post_content, is_reply = 0, id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                post_title_img,
                category_id, parent_id, post_title, post_content, is_reply,
            };
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, id);
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
