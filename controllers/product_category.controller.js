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
            const { product_category_group_id, page, page_size, search } = req.query;

            // 쿼리스트링은 전부 문자열이라 "0" 도 truthy 다.
            // 마이그레이션된 브랜드는 shop.controller 가 합성 그룹 id=0 을 내려주고
            // 관리자 화면이 그 0 을 그대로 실어 보낸다. 예전엔 그게 truthy 로 걸려
            // `AND product_category_group_id=0` 이 붙어 카테고리 검색이 항상 0건이었다.
            const group_id = parseInt(product_category_group_id);
            const has_group_id = Number.isInteger(group_id) && group_id > 0;

            // 단일 트리 전환: product_category_group_id 는 선택적. 없으면 브랜드 전체 트리 조회.
            let category_groups = null;
            if (has_group_id) {
                let cg = await readPool.query(`SELECT sort_type FROM product_category_groups WHERE id=?`, [product_category_group_id]);
                category_groups = cg[0][0];
            }

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);
            if (has_group_id) {
                sql += ` AND product_category_group_id=? `;
                params.push(group_id);
            }

            let req_query = req.query;
            if (category_groups?.sort_type == 1) {
                req_query.order = 'category_name';
                req_query.is_asc = 1;
            }
            let data = await getSelectQueryList(sql, columns, req_query, [], params);
            // 검색 중에는 트리로 묶지 않는다.
            // makeTree 는 부모가 결과에 없는 항목을 통째로 버린다. 검색은 이름으로 걸러낸
            // 평평한 결과라 하위 카테고리가 걸려도 그 부모는 대개 결과에 없다 —
            // 트리를 만드는 순간 그 항목들이 전부 사라져 '검색해도 안 나온다'가 됐다.
            if (!search) {
                data.content = await makeTree(data?.content ?? []);
            }
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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
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
