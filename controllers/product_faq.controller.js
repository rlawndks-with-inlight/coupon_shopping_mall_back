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
            // ⚠ 예전엔 검사가 하나도 없었다. decode_user 를 선언만 하고 쓰지 않았고,
            //   brand_id 와 user_id 를 **요청 본문에서 그대로** 받아 저장했다.
            //   즉 로그인 없이 /api/product-faq 를 직접 부르면
            //   남의 가맹점에, 남의 회원 이름으로 문의를 만들 수 있었다(스팸·사칭).
            //   상품문의 화면은 현재 어느 판매 프레임에도 노출되지 않지만 API 는 열려 있었다.
            //   → 로그인 필수 + 소속 브랜드와 작성자는 **서버가 확정한다**.
            if (!(Number(decode_user?.id) > 0)) {
                return lowLevelException(req, res);
            }
            if (!(Number(decode_dns?.id) > 0)) {
                return response(req, res, -100, "잘못된 접근입니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.", false);
            }
            const { title, content, product_id } = req.body;
            // 다른 브랜드 상품에 문의를 다는 것도 막는다.
            let product = await readPool.query(
                `SELECT id FROM products WHERE id=? AND brand_id=? AND is_delete=0 LIMIT 1`,
                [product_id, decode_dns.id]);
            if (!product[0][0]) {
                return lowLevelException(req, res);
            }
            let files = settingFiles(req.files);
            let obj = {
                brand_id: Number(decode_dns.id),
                title, content, product_id,
                user_id: Number(decode_user.id),
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
