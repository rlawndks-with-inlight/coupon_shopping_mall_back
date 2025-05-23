'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'product_categories';



const productCategoryCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_category_group_id, page, page_size } = req.query;

            let category_groups = await readPool.query(`SELECT sort_type FROM product_category_groups WHERE id=${product_category_group_id}`);
            category_groups = category_groups[0][0];

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            sql += ` AND product_category_group_id=${product_category_group_id} `;

            let req_query = req.query;
            if (category_groups?.sort_type == 1) {
                req_query.order = 'category_name';
                req_query.is_asc = 1;
            }
            let data = await getSelectQueryList(sql, columns, req_query);
            data.content = await makeTree(data?.content ?? []);
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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=${id}`)
            data = data[0][0];
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
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
                category_img,
                parent_id = -1,
                category_type = 0,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                brand_id,
                another_id = 0,
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                category_img,
                parent_id,
                category_type,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                brand_id,
                another_id,
            };
            obj = { ...obj, ...files, };

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
                category_img,
                parent_id = -1,
                category_type = 0,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                another_id = 0,
                id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                category_img,
                parent_id,
                category_type,
                category_name,
                category_en_name,
                category_description,
                product_category_group_id,
                another_id,
            };
            obj = { ...obj, ...files, };

            let result = await updateQuery(`${table_name}`, obj, id);
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, id);
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

export default productCategoryCtrl;
