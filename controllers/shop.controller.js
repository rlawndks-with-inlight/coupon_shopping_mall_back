'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { getMultipleQueryByWhen, getSelectQueryList } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, homeItemsSetting, homeItemsWithCategoriesSetting, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, makeTree, makeUserToken, response } from "../utils.js/util.js";
import 'dotenv/config';


const shopCtrl = {
    setting: async (req, res, next) => {
        try {
            // 상품 카테고리 그룹, 상품 리뷰, 상품 포스트카테고리
            const decode_user = checkLevel(req.cookies.token, 0);
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
            product_category_sql += ` AND product_categories.is_delete=0 ORDER BY sort_idx DESC`;

            let post_category_columns = [
                `post_categories.*`,
            ]
            let post_category_sql = `SELECT ${post_category_columns.join()} FROM post_categories `;
            post_category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id} `;
            post_category_sql += ` AND post_categories.is_delete=0 ORDER BY sort_idx DESC`;

            //when
            let sql_list = [
                { table: 'products', sql: product_sql },
                { table: 'product_categories', sql: product_category_sql },
                { table: 'post_categories', sql: post_category_sql },
                { table: 'product_category_groups', sql: product_category_group_sql },
            ]

            let data = await getMultipleQueryByWhen(sql_list);
            
            for (var i = 0; i < data?.product_category_groups.length; i++) {
                let category_list = data?.product_categories.filter((item) => item?.product_category_group_id == data?.product_category_groups[i]?.id);
                category_list = await makeTree(category_list ?? []);
                data.product_category_groups[i].product_categories = category_list;
            }
            data.post_categories = await makeTree(data?.post_categories ?? []);

            brand_data['shop_obj'] = await finallySettingMainObj(brand_data['shop_obj'], data);
            brand_data['blog_obj'] = await finallySettingMainObj(brand_data['blog_obj'], data);

            delete data.product_categories;
            delete data.products;

            return response(req, res, 100, "success", {
                ...data,
                ...brand_data,
            });
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    main: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            let dns_data = await pool.query(`SELECT shop_obj FROM brands WHERE id=${decode_dns?.id}`);
            dns_data = dns_data?.result[0];
            dns_data['shop_obj'] = JSON.parse(dns_data?.shop_obj ?? '{}');
            let content_list = dns_data['shop_obj'];
            let sql_list = [];
            // sql_list.push({
            //     table:'post',
            //     sql: `SELECT * FROM posts `,
            // })
            sql_list.push({
                table: 'product',
                sql: `SELECT * FROM products WHERE brand_id=${decode_dns?.id} `,
            })
            let sql_data = await getMultipleQueryByWhen(sql_list);
            let posts = sql_data['post'] ?? [];
            let products = sql_data['product'] ?? [];
            let item_id_list = [0];
            item_id_list = [...item_id_list, ...products.map(item => { return item.id })];
            let budget_data = await pool.query(`SELECT * FROM budget_products WHERE product_id IN (${item_id_list.join()}) AND user_id=${decode_user?.id ?? 0}`)
            budget_data = budget_data?.result;
            budget_data = makeObjByList('product_id', budget_data);
            for (var i = 0; i < products.length; i++) {
                let budget_item = budget_data[`${products[i]?.id}`] ?? []
                products[i]['budget'] = budget_item[0] ?? {}
            }

            for (var i = 0; i < content_list.length; i++) {
                if (content_list[i]?.type == 'items' && products.length > 0) {
                    content_list[i] = homeItemsSetting(content_list[i], products);
                }
                if (content_list[i]?.type == 'items-with-categories' && products.length > 0) {
                    content_list[i] = homeItemsWithCategoriesSetting(content_list[i], products);
                }
                if (content_list[i]?.type == 'post') {
                    content_list[i] = {
                        ...content_list[i],
                        posts: post_obj,
                        categories: themePostCategoryList,
                    };
                }
                if (content_list[i]?.type == 'item-reviews') {
                    let review_list = [...test_product_reviews];
                    for (var j = 0; j < review_list.length; j++) {
                        review_list[j].product = _.find(products, { id: review_list[j]?.product_id });
                    }
                    content_list[i] = {
                        ...content_list[i],
                        title: '상품후기',
                        sub_title: 'REVIEW',
                        list: [...review_list],
                    }
                }
            }
            return response(req, res, 100, "success", content_list);
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    items: async (req, res, next) => { //상품 리스트출력
        try {
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { category_id } = req.query;

            let columns = [
                `products.*`,
                `product_categories.name AS category_name`
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM products `;
            sql += ` LEFT JOIN product_categories ON products.category_id=product_categories.id `;
            sql += ` WHERE products.brand_id=${decode_dns?.id} `;
            if (category_id) sql += ` AND products.category_id=${category_id} `;
            let data = await getSelectQueryList(sql, columns, req.query);
            let item_id_list = [0];
            item_id_list = [...item_id_list, ...data.content.map(item => { return item.id })];
            let budget_data = await pool.query(`SELECT * FROM budget_products WHERE product_id IN (${item_id_list.join()}) AND user_id=${decode_user?.id ?? 0}`)
            budget_data = budget_data?.result;
            budget_data = makeObjByList('product_id', budget_data);
            for (var i = 0; i < data?.content.length; i++) {
                let budget_item = budget_data[`${data?.content[i]?.id}`] ?? []
                data.content[i]['budget'] = budget_item[0] ?? {}
            }
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    item: async (req, res, next) => { //상품 단일 출력
        try {
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await pool.query(`SELECT * FROM products WHERE id=${id}`)
            data = data?.result[0];
            data['product_sub_imgs'] = JSON.parse(data?.product_sub_imgs ?? "[]");
            let budget_product = await pool.query(`SELECT * FROM budget_products WHERE user_id=${decode_user?.id ?? 0} AND product_id=${id}`);
            budget_product = budget_product?.result[0];
            data['budget'] = budget_product;
            let product_groups = await pool.query(`SELECT * FROM product_options WHERE product_id=${id} AND is_delete=0 ORDER BY id ASC `);
            product_groups = product_groups?.result;
            let groups = [];
            let option_obj = makeObjByList('parent_id', product_groups);
            for (var i = 0; i < product_groups.length; i++) {
                if (product_groups[i].parent_id < 0) {
                    option_obj[product_groups[i]?.id] = (option_obj[product_groups[i]?.id] ?? []).map(option => {
                        return {
                            ...option,
                            option_name: option?.name,
                            option_price: option?.price,
                        }
                    })
                    groups.push({
                        ...product_groups[i],
                        group_name: product_groups[i]?.name,
                        group_price: product_groups[i]?.price,
                        options: option_obj[product_groups[i]?.id]
                    })
                }
            }
            data['groups'] = groups;
            let product_characters = await pool.query(`SELECT * FROM product_characters WHERE product_id=${id} AND is_delete=0 ORDER BY id ASC `);
            product_characters = product_characters?.result;
            for (var i = 0; i < product_characters.length; i++) {
                product_characters[i] = {
                    ...product_characters[i],
                    character_key: product_characters[i]?.key_name,
                    character_value: product_characters[i]?.value,
                }
            }
            data['characters'] = product_characters;
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },

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
            main_obj[i].list = data?.post_categories ?? [];
        }
    }
    return main_obj;
}
export default shopCtrl;