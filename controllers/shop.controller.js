'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, findChildIds, findParent, homeItemsSetting, homeItemsWithCategoriesSetting, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeTree, makeUserToken, response, getPayType } from "../utils.js/util.js";
import 'dotenv/config';
import productCtrl from "./product.controller.js";
import postCtrl from "./post.controller.js";
import _ from "lodash";
import logger from "../utils.js/winston/index.js";

const shopCtrl = {
    setting: async (req, res, next) => {
        try {
            // 상품 카테고리 그룹, 상품 리뷰, 상품 포스트카테고리
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let brand_column = [
                'shop_obj',
                'blog_obj',
            ]
            let brand_data = await pool.query(`SELECT ${brand_column.join()} FROM brands WHERE id=${decode_dns?.id}`);
            brand_data = brand_data?.result[0];
            brand_data['shop_obj'] = JSON.parse(brand_data?.shop_obj ?? '[]');
            brand_data['blog_obj'] = JSON.parse(brand_data?.blog_obj ?? '[]');
            let product_ids = [...(await settingMainObj(brand_data['shop_obj'])).product_ids, ...(await settingMainObj(brand_data['blog_obj'])).product_ids,];
            product_ids = new Set(product_ids);
            product_ids = [0, ...product_ids];
            let product_review_ids = [...(await settingMainObj(brand_data['shop_obj'])).product_review_ids, ...(await settingMainObj(brand_data['blog_obj'])).product_review_ids,];
            product_review_ids = new Set(product_review_ids);
            product_review_ids = [...product_review_ids];
            //products
            let product_columns = [
                `products.id`,
                `products.sort_idx`,
                `products.product_name`,
                `products.product_price`,
                `products.product_sale_price`,
                `products.product_img`,
                `products.product_comment`,
            ]
            let product_sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM products `;
            for (var i = 0; i < categoryDepth; i++) {
                product_sql += ` LEFT JOIN product_categories AS product_categories${i} ON products.category_id${i}=product_categories${i}.id `;
                product_columns.push(`product_categories${i}.category_name AS category_name${i}`);
            }
            product_sql += ` WHERE products.id IN(${product_ids.join()}) `;
            product_sql += ` AND products.is_delete=0 `
            product_sql = product_sql.replaceAll(process.env.SELECT_COLUMN_SECRET, product_columns.join());
            //product categories
            let product_category_group_columns = [
                `product_category_groups.*`,
            ]
            let product_category_group_sql = `SELECT ${product_category_group_columns.join()} FROM product_category_groups `;
            product_category_group_sql += ` WHERE product_category_groups.brand_id=${decode_dns?.id} `;
            product_category_group_sql += ` AND product_category_groups.is_delete=0 ORDER BY sort_idx DESC`;

            let product_category_columns = [
                `product_categories.*`,
            ]
            let product_category_sql = `SELECT ${product_category_columns.join()} FROM product_categories `;
            product_category_sql += ` WHERE product_categories.brand_id=${decode_dns?.id} `;
            product_category_sql += ` AND product_categories.is_delete=0 ORDER BY id DESC LIMIT 0, 10 `;

            let product_review_columns = [
                `product_reviews.*`,
            ]
            let product_review_sql = `SELECT ${product_review_columns.join()} FROM product_reviews `;
            product_review_sql += ` WHERE product_reviews.brand_id=${decode_dns?.id} `;
            product_review_sql += ` AND product_reviews.is_delete=0 ORDER BY id DESC`;


            let post_category_columns = [
                `post_categories.*`,
            ]
            let post_category_sql = `SELECT ${post_category_columns.join()} FROM post_categories `;
            post_category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id} `;
            post_category_sql += ` AND post_categories.is_delete=0 ORDER BY sort_idx DESC`;

            let seller_columns = [
                `users.*`,
            ]
            let seller_sql = `SELECT ${seller_columns.join()} FROM users `;
            seller_sql += ` WHERE users.brand_id=${decode_dns?.id} `;
            seller_sql += ` AND level=10 `;
            seller_sql += ` AND is_delete=0 `;
            seller_sql += ` ORDER BY id DESC`;

            let payment_module_columns = [
                `payment_modules.*`,
            ]
            let payment_module_sql = `SELECT ${payment_module_columns.join()} FROM payment_modules `;
            payment_module_sql += ` WHERE payment_modules.brand_id=${decode_dns?.id} `;
            payment_module_sql += ` ORDER BY id DESC`;

            let user_wish_columns = [
                `user_wishs.*`,

            ]
            let user_wish_sql = `SELECT ${user_wish_columns.join()} FROM user_wishs `;
            user_wish_sql += ` WHERE user_wishs.brand_id=${decode_dns?.id ?? 0} AND user_wishs.user_id=${decode_user?.id ?? 0} `;
            user_wish_sql += ` ORDER BY id DESC`;

            //when
            let sql_list = [
                { table: 'products', sql: product_sql },
                { table: 'product_categories', sql: product_category_sql },
                { table: 'post_categories', sql: post_category_sql },
                { table: 'product_category_groups', sql: product_category_group_sql },
                { table: 'product_reviews', sql: product_review_sql },
                { table: 'sellers', sql: seller_sql },
                { table: 'payment_modules', sql: payment_module_sql },
                { table: 'user_wishs', sql: user_wish_sql },
            ]

            let data = await getMultipleQueryByWhen(sql_list);

            //셀러처리
            data['sellers'] = data?.sellers.map((item) => {
                return {
                    ...item,
                    sns_obj: JSON.parse(item?.sns_obj ?? '{}'),
                    theme_css: JSON.parse(item?.theme_css ?? '{}'),
                }
            })
            //결제모듈처리
            data['payment_modules'] = data?.payment_modules.map((item) => {
                return {
                    ...item,
                    ...getPayType(item?.trx_type)
                }
            })
            //상품카테고리처리
            for (var i = 0; i < data?.product_category_groups.length; i++) {
                let category_list = data?.product_categories.filter((item) => item?.product_category_group_id == data?.product_category_groups[i]?.id);
                category_list = await makeTree(category_list ?? []);
                data.product_category_groups[i].product_categories = category_list;
            }
            //게시물카테고리처리
            let post_category_ids = data.post_categories.map(item => {
                return item?.id
            })
            post_category_ids.unshift(0);
            let recent_post_sql = `SELECT id, category_id, post_title FROM posts WHERE category_id IN (${post_category_ids.join()}) AND is_delete=0 GROUP BY category_id, id HAVING COUNT(*) <= 10`;
            let recent_post_data = await pool.query(recent_post_sql)
            recent_post_data = recent_post_data?.result;
            for (var i = 0; i < data?.post_categories.length; i++) {
                if (!(data?.post_categories[i]?.parent_id > 0)) {
                    let children_ids = findChildIds(data?.post_categories, data?.post_categories[i]?.id);
                    children_ids.unshift(data?.post_categories[i]?.id);
                    data.post_categories[i].recent_posts = recent_post_data.filter(item => children_ids.includes(item?.category_id));
                    data.post_categories[i].recent_posts = data.post_categories[i].recent_posts.slice(0, 10);
                }
            }
            data.post_categories = await makeTree(data?.post_categories ?? []);
            //메인obj처리
            brand_data['shop_obj'] = await finallySettingMainObj(brand_data['shop_obj'], data);
            brand_data['blog_obj'] = await finallySettingMainObj(brand_data['blog_obj'], data);

            delete data.product_categories;

            return response(req, res, 100, "success", {
                ...data,
                ...brand_data,
            });
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    main: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    items: async (req, res, next) => { //상품 리스트출력
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { seller_id } = req.query;

            let data = await productCtrl.list({ ...req, IS_RETURN: true }, res, next);
            data = data?.data;
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    item: async (req, res, next) => { //상품 단일 출력
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await productCtrl.get({ ...req, IS_RETURN: true }, res, next);
            data = data?.data;
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    post: {
        list: async (req, res, next) => { //게시물 리스트출력
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id } = req.query;

                if (!category_id) {
                    return response(req, res, -200, "카테고리 id는 필수 입니다.", false)
                }
                let data = await postCtrl.list({ ...req, IS_RETURN: true }, res, next);
                data = data?.data;
                return response(req, res, 100, "success", data);
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        get: async (req, res, next) => { //게시물 단일 출력
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { id } = req.params;
                let data = await postCtrl.get({ ...req, IS_RETURN: true }, res, next);
                data = data?.data;
                return response(req, res, 100, "success", data);
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        create: async (req, res, next) => { //게시물 추가
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id } = req.body;

                let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
                category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id} `;
                let category_list = await pool.query(category_sql);
                category_list = category_list?.result;

                let category = _.find(category_list, { id: parseInt(category_id) });
                let top_parent = findParent(category_list, category);
                top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });
                if (top_parent?.is_able_user_add != 1) {
                    return lowLevelException(req, res);
                }
                let result = await postCtrl.create({ ...req, IS_RETURN: true }, res, next);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                logger.error(JSON.stringify(err?.response?.data || err))
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        update: async (req, res, next) => { //게시물 수정
            try {
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const { category_id, id } = req.body;

                let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
                category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id} `;
                let category_list = await pool.query(category_sql);
                category_list = category_list?.result;

                let category = _.find(category_list, { id: parseInt(category_id) });
                let top_parent = findParent(category_list, category);
                top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });
                if (top_parent?.is_able_user_add != 1) {
                    return lowLevelException(req, res);
                }
                let post = await pool.query(`SELECT * FROM posts WHERE id=${id}`);
                post = post?.result[0];
                if (!(post?.user_id == decode_user?.id || decode_user?.level >= 10)) {
                    return lowLevelException(req, res);
                }
                let result = await postCtrl.update({ ...req, IS_RETURN: true }, res, next);

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
                let post = await pool.query(`SELECT * FROM posts WHERE id=${id}`);
                post = post?.result[0];
                if (!(post?.user_id == decode_user?.id || decode_user?.level >= 10)) {
                    return lowLevelException(req, res);
                }
                let result = await deleteQuery(`posts`, {
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
    }
}
const getMainObjIdList = (main_obj = [], type, id_list_ = [], is_children) => {// 같은 타입에서 WHERE IN 문에 사용될 ids를 세팅한다.
    let id_list = id_list_;
    for (var i = 0; i < main_obj.length; i++) {
        if (main_obj[i]?.type == type) {
            if (is_children) {
                for (var j = 0; j < main_obj[i]?.list.length; j++) {
                    id_list = [...id_list, ...main_obj[i]?.list[j]?.list ?? []];
                }
            } else {
                id_list = [...id_list, ...main_obj[i]?.list ?? []];
            }
        }
    }
    id_list = new Set(id_list);
    id_list = [...id_list];
    return id_list;
}

const getMainObjContentByIdList = (main_obj_ = [], type, content_list = [], is_children, is_new) => {//ids 를 가지고 컨텐츠로 채워 넣는다.
    let main_obj = main_obj_
    let content_obj = makeObjByList('id', content_list);
    main_obj = main_obj.map(section => {
        if (section?.type == type) {
            if (is_new) {
                let new_list = content_list.sort((a, b) => {
                    if (a.id < b.id) return 1;
                    if (a.id > b.id) return -1;
                    return 0;
                });
                return {
                    ...section,
                    list: new_list.splice(0, 10)
                }
            } else if (is_children) {
                section.list = (section?.list ?? []).map(children => {
                    children.list = (children?.list ?? []).map(id => {
                        if (content_obj[id]) {
                            return {
                                ...content_obj[id][0],
                            }
                        } else {
                            return {}
                        }
                    })
                    return {
                        ...children,
                    }
                })
                return { ...section };
            } else {
                let section_list = (section?.list ?? []).map(id => {
                    if (content_obj[id]) {
                        return {
                            ...content_obj[id][0],
                        }
                    } else {
                        return {}
                    }
                })
                return {
                    ...section,
                    list: section_list,
                }
            }

        } else {
            return { ...section };
        }
    })
    return main_obj;
}

const settingMainObj = async (main_obj_ = []) => {
    let main_obj = main_obj_;
    let product_review_ids = [];
    product_review_ids = getMainObjIdList(main_obj, 'item-reviews-select', product_review_ids);
    let product_ids = [];
    product_ids = getMainObjIdList(main_obj, 'items', product_ids);
    product_ids = getMainObjIdList(main_obj, 'items-ids', product_ids);
    product_ids = getMainObjIdList(main_obj, 'items-with-categories', product_ids, true);
    return {
        product_ids,
        product_review_ids,
    }
}
const finallySettingMainObj = async (main_obj_ = [], data) => {
    let main_obj = main_obj_;
    main_obj = getMainObjContentByIdList(main_obj, 'item-reviews-select', data?.product_reviews);
    main_obj = getMainObjContentByIdList(main_obj, 'item-reviews', data?.product_reviews, false, true);
    main_obj = getMainObjContentByIdList(main_obj, 'items', data?.products);
    main_obj = getMainObjContentByIdList(main_obj, 'items-ids', data?.products);
    main_obj = getMainObjContentByIdList(main_obj, 'items-with-categories', data?.products, true);
    for (var i = 0; i < main_obj.length; i++) {
        if (main_obj[i]?.type == 'post') {
            main_obj[i].list = (main_obj[i]?.list ?? []).map(id => {
                return _.find(data?.post_categories, { id: parseInt(id) })
            })
        }
    }
    for (var i = 0; i < main_obj.length; i++) {
        if (main_obj[i]?.type == 'sellers') {
            main_obj[i].list = data?.sellers ?? [];
        }
    }

    return main_obj;
}
export default shopCtrl;