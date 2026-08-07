'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
import { decField } from "../utils.js/crypto-util.js";

const table_name = 'product_faq';

const productFaqCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_id } = req.query;

            const is_manager = await checkIsManagerUrl(req);
            let columns = [
                `${table_name}.*`,
                `users.nickname AS writer_nickname`,
                `users.user_name AS writer_user_name`,
                ...(is_manager ? [`users.name AS writer_name`] : []),
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);
            sql += ` AND ${table_name}.product_id=? `;
            params.push(product_id);

            let data = await getSelectQueryList(sql, columns, req.query, [], params);
            if (is_manager) {
                data.content = (data.content || []).map((item) => ({ ...item, writer_name: decField(item?.writer_name) }));
            }

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
                brand_id, title, content, product_id, user_id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, title, content, product_id, user_id
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
            const {
                id,
                title, content, user_id
            } = req.body;
            // 인가가 전혀 없어 남의 상품문의를 수정할 수 있었다.
            // 상품문의는 고객이 쓰는 글이라 레벨 가드를 걸면 고객 화면이 죽는다 —
            // 로그인 필수 + (운영자이거나 본인 글) 로만 제한한다.
            if (!decode_user?.id) {
                return lowLevelException(req, res);
            }
            let faq_rows = await readPool.query(`SELECT id, brand_id, user_id FROM ${table_name} WHERE id=? LIMIT 1`, [id]);
            const faq_row = faq_rows[0][0];
            const is_faq_staff = Number(decode_user?.level) >= 10;
            if (!faq_row
                || !isItemBrandIdSameDnsId(decode_dns, faq_row)
                || !(is_faq_staff || Number(faq_row?.user_id) === Number(decode_user?.id))) {
                return lowLevelException(req, res);
            }
            let files = settingFiles(req.files);
            let obj = {
                title, content
            };
            obj = { ...obj, ...files };
            if (!(decode_user?.level >= 10 || user_id == decode_user?.id)) {
                return lowLevelException(req, res);
            }

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
            // 인가가 전혀 없어 비로그인으로도 남의 상품문의를 지울 수 있었다.
            if (!decode_user?.id) {
                return lowLevelException(req, res);
            }
            let faq_rows = await readPool.query(`SELECT id, brand_id, user_id FROM ${table_name} WHERE id=? LIMIT 1`, [id]);
            const faq_row = faq_rows[0][0];
            const is_faq_staff = Number(decode_user?.level) >= 10;
            if (!faq_row
                || !isItemBrandIdSameDnsId(decode_dns, faq_row)
                || !(is_faq_staff || Number(faq_row?.user_id) === Number(decode_user?.id))) {
                return lowLevelException(req, res);
            }
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

export default productFaqCtrl;
