'use strict';
import _ from "lodash";
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
const table_name = 'post_categories';

const postCategoryCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { page, page_size } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;

            let data = await getSelectQueryList(sql, columns, { ...req.query, page_size: 10000 });

            data.content = await makeTree(data?.content);
            data.total = data?.content.length ?? 0;
            data.content = (data?.content ?? []).slice((page - 1) * (page_size), page * page_size);
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
            let data = await pool.query(`SELECT * FROM ${table_name} WHERE brand_id=${decode_dns?.id ?? 0}`);
            data = data?.result;
            let category = _.find(data, { id: id });
            data = await makeTree(data, category);
            category = _.find(data, { id: parseInt(id) });
            category.children = category?.children ?? []
            if (!isItemBrandIdSameDnsId(decode_dns, category)) {
                return lowLevelException(req, res);
            }
            return response(req, res, 100, "success", category)
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
                post_category_title, parent_id = -1, is_able_user_add = 0, post_category_type = 0, post_category_read_type = 0
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                post_category_title, parent_id, is_able_user_add, post_category_type, post_category_read_type, brand_id: decode_dns?.id,
            };

            obj = { ...obj, ...files };
            console.log(obj);
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
            const {
                post_category_title, parent_id = -1, is_able_user_add = 0, post_category_type = 0, post_category_read_type = 0, id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                post_category_title, parent_id, is_able_user_add, post_category_type, post_category_read_type
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

export default postCategoryCtrl;
