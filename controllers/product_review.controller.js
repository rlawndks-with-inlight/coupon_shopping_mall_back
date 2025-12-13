'use strict';
import { checkIsManagerUrl, generateRandomCode } from "../utils.js/function.js";
import {
    deleteQuery,
    getSelectQueryList,
    insertMultyQuery,
    insertQuery,
    insertQueryMultiRow,
    selectQuerySimple,
    updateQuery
} from "../utils.js/query-util.js";
import {
    checkDns,
    checkLevel,
    createHashedPassword,
    isItemBrandIdSameDnsId,
    lowLevelException,
    response,
    settingFiles
} from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import axios from "axios";
import _ from "lodash";
import { readPool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js"; // ✅ Redis 추가

const table_name = 'product_reviews';

// ✅ 리뷰 캐시 무효화 헬퍼
const invalidateReviewCache = async (brandId, productId = null, reviewId = null) => {
    try {
        if (!redisClient?.isOpen || !brandId) return;

        // 리스트 캐시 삭제
        const listPattern = productId
            ? `product_reviews:list:${brandId}:${productId}:*`
            : `product_reviews:list:${brandId}:*`;

        for await (const key of redisClient.scanIterator({ MATCH: listPattern })) {
            await redisClient.del(key);
        }

        // 상세 캐시 삭제
        if (reviewId) {
            const detailKey = `product_reviews:get:${brandId}:${reviewId}`;
            await redisClient.del(detailKey);
        } else {
            const detailPattern = `product_reviews:get:${brandId}:*`;
            for await (const key of redisClient.scanIterator({ MATCH: detailPattern })) {
                await redisClient.del(key);
            }
        }
    } catch (e) {
        console.error("Redis invalidateReviewCache error:", e);
    }
};

const productReviewCtrl = {

    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_id } = req.query;

            const brandId = decode_dns?.id ?? 0;
            const productIdNum = parseInt(product_id, 10) || 0;

            if (!brandId || !productIdNum) {
                return response(req, res, -400, "brand_id 또는 product_id가 올바르지 않습니다.", false);
            }

            let columns = [
                `${table_name}.*`,
                `users.nickname`,
                `users.user_name`,
            ];

            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `;
            sql += ` WHERE ${table_name}.brand_id=${brandId} `;
            sql += ` AND ${table_name}.product_id=${productIdNum} `;

            // ✅ Redis 캐시 사용
            const canUseCache = !!redisClient?.isOpen;
            const cacheKey = canUseCache
                ? `product_reviews:list:${brandId}:${productIdNum}:${JSON.stringify(req.query || {})}`
                : null;

            if (canUseCache && cacheKey) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);
                        return response(req, res, 100, "success(cache)", data);
                    }
                } catch (e) {
                    console.error("Redis get error (product_reviews list):", e);
                }
            }

            let data = await getSelectQueryList(sql, columns, req.query);

            // ✅ 캐시 저장 (예: 60초)
            if (canUseCache && cacheKey) {
                try {
                    await redisClient.set(cacheKey, JSON.stringify(data), { EX: 60 });
                } catch (e) {
                    console.error("Redis set error (product_reviews list):", e);
                }
            }

            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    get: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;

            const brandId = decode_dns?.id ?? 0;
            const reviewId = parseInt(id, 10) || 0;

            if (!reviewId) {
                return response(req, res, -400, "리뷰 id가 올바르지 않습니다.", false);
            }

            const canUseCache = !!redisClient?.isOpen && brandId > 0;
            const cacheKey = canUseCache
                ? `product_reviews:get:${brandId}:${reviewId}`
                : null;

            if (canUseCache && cacheKey) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);
                        if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                            return lowLevelException(req, res);
                        }
                        return response(req, res, 100, "success(cache)", data);
                    }
                } catch (e) {
                    console.error("Redis get error (product_reviews get):", e);
                }
            }

            let data = await readPool.query(
                `SELECT * FROM ${table_name} WHERE id = ?`,
                [reviewId]
            );
            data = data[0][0];

            if (!data) {
                return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            }

            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }

            if (canUseCache && cacheKey) {
                try {
                    await redisClient.set(cacheKey, JSON.stringify(data), { EX: 300 });
                } catch (e) {
                    console.error("Redis set error (product_reviews get):", e);
                }
            }

            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                brand_id,
                title,
                scope,
                content,
                profile_img,
                content_img,
                product_id,
                user_id,
            } = req.body;

            const brandId = brand_id || decode_dns?.id || 0;
            const productIdNum = parseInt(product_id, 10) || 0;

            if (!brandId || !productIdNum) {
                return response(req, res, -400, "brand_id 또는 product_id가 올바르지 않습니다.", false);
            }

            // (원래 코드에는 권한 제한이 없었으니 그대로 두되,
            //  필요하면 여기서 '본인만 작성 가능' 등의 체크 추가 가능)

            let files = settingFiles(req.files);
            let obj = {
                brand_id: brandId,
                title,
                scope,
                content,
                profile_img,
                content_img,
                product_id: productIdNum,
                user_id,
            };

            obj = { ...obj, ...files };

            let result = await insertQuery(`${table_name}`, obj);

            // ✅ 캐시 무효화
            await invalidateReviewCache(brandId, productIdNum, result?.insertId);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    update: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                id,
                title,
                scope,
                content,
                profile_img,
                content_img,
                user_id, // 프론트에서 보내주지만, 실제 권한 체크/캐시에는 DB 값 기준 사용
            } = req.body;

            const reviewId = parseInt(id, 10) || 0;
            if (!reviewId) {
                return response(req, res, -400, "리뷰 id가 올바르지 않습니다.", false);
            }

            // 먼저 DB에서 기존 리뷰 정보 조회 (권한 + 캐시 무효화용)
            let [rows] = await readPool.query(
                `SELECT brand_id, product_id, user_id FROM ${table_name} WHERE id = ?`,
                [reviewId]
            );

            const row = rows?.[0];
            if (!row) {
                return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            }

            const brandId = row.brand_id;
            const productIdNum = row.product_id;
            const ownerUserId = row.user_id;
            const loginUserId = decode_user?.id ?? 0;
            const loginLevel = decode_user?.level ?? 0;

            // 권한: 관리자(레벨>=10) or 리뷰 작성자 본인
            if (!(loginLevel >= 10 || ownerUserId === loginUserId)) {
                return lowLevelException(req, res);
            }

            let files = settingFiles(req.files);
            let obj = {
                title,
                scope,
                content,
                profile_img,
                content_img,
            };

            obj = { ...obj, ...files };

            let result = await updateQuery(`${table_name}`, obj, reviewId);

            // ✅ 캐시 무효화
            await invalidateReviewCache(brandId, productIdNum, reviewId);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    remove: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;

            const reviewId = parseInt(id, 10) || 0;
            if (!reviewId) {
                return response(req, res, -400, "리뷰 id가 올바르지 않습니다.", false);
            }

            // 삭제 전에 brand_id, product_id, user_id 조회
            let [rows] = await readPool.query(
                `SELECT brand_id, product_id, user_id FROM ${table_name} WHERE id = ?`,
                [reviewId]
            );
            const row = rows?.[0];
            if (!row) {
                return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            }

            const brandId = row.brand_id;
            const productIdNum = row.product_id;
            const ownerUserId = row.user_id;
            const loginUserId = decode_user?.id ?? 0;
            const loginLevel = decode_user?.level ?? 0;

            // 권한: 관리자(레벨>=10) or 리뷰 작성자 본인
            if (!(loginLevel >= 10 || ownerUserId === loginUserId)) {
                return lowLevelException(req, res);
            }

            let result = await deleteQuery(`${table_name}`, { id: reviewId });

            // ✅ 캐시 무효화
            await invalidateReviewCache(brandId, productIdNum, reviewId);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
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
};

export default productReviewCtrl;
