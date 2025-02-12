'use strict';
import { checkIsManagerUrl, generateRandomCode } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertMultyQuery, insertQuery, insertQueryMultiRow, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import axios from "axios";
import _ from "lodash";
import { readPool } from "../config/db-pool.js";
const table_name = 'product_reviews';

const productReviewCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_id } = req.query;
            let columns = [
                `${table_name}.*`,
                `users.nickname`,
                `users.user_name`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            sql += ` AND ${table_name}.product_id=${product_id} `;

            let data = await getSelectQueryList(sql, columns, req.query);

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
                brand_id, title, scope, content, profile_img, content_img, product_id, user_id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, title, scope, content, profile_img, content_img, product_id, user_id
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
                title, scope, content, profile_img, content_img, user_id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                title, scope, content, profile_img, content_img
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

const sadsadasdasd = async () => {
    try {
        const brand_id = 70;
        let { data: categories } = await axios.get(`https://www.cumamarket.co.kr/_next/data/eb38b54477fe79382b5b37cb4cb5706e84e3f0ad/category-list.json`);
        categories = categories?.pageProps?.ssrCategoryList ?? [];
        let db_products = await readPool.query(`SELECT * FROM products WHERE brand_id=${brand_id}`);
        db_products = db_products[0];
        let db_users = await readPool.query(`SELECT * FROM users WHERE brand_id=${brand_id}`);
        db_users = db_users[0];
        let review_list = [];
        let products = [];
        for (var i = 0; i < categories.length; i++) {
            let { data: res_products } = await axios.get(`https://service.cumamarket.co.kr/v1/products/category/${categories[i]?.id}?orderby=latest&take=500&productStatus=stock_in`);
            products = [...products, ...res_products?.list];
        }
        let reviews = [];
        for (var i = 0; i < products.length; i++) {
            let { data: res_reviews } = await axios.get(`https://service.cumamarket.co.kr/v1/products/${products[i]?.id}/reviews?page=0&take=500&orderBy=score`);
            if (res_reviews?.page?.count > 0) {
                reviews = [...reviews, ...res_reviews?.reviews];
            }
        }
        for (var i = 0; i < reviews.length; i++) {
            let user_name = reviews[i]?.appUser?.nickname;
            let user = _.find(db_users, { user_name: user_name });
            let product = _.find(db_products, { another_id: reviews[i]?.product?.id })
            if (product && user) {
                review_list.push([
                    product?.id,
                    brand_id,
                    reviews[i]?.score * 2,
                    user?.id,
                    reviews[i]?.contents,
                    reviews[i]?.reviewType == 'photoReview' ? reviews[i]?.reviewImages[0] : '',
                    reviews[i]?.createDate.replaceAll('T', ' ').substring(0, 19)
                ])
                if (i % 50 == 0) {
                    console.log(i);
                }
            } else {
                console.log(reviews[i])
            }
        }

        let result = await insertMultyQuery('product_reviews', [
            'product_id',
            'brand_id',
            'scope',
            'user_id',
            'content',
            'content_img',
            'created_at',
        ], review_list)
        console.log('success')
    } catch (err) {
        console.log(err);
    }
}
export default productReviewCtrl;
