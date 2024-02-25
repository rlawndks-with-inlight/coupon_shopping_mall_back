'use strict';
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, findChildIds, findParent, findParents, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { grandPool } from '../config/grandparis-db.js'
import _ from "lodash";
const utilCtrl = {
    sort: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let { source_id, source_sort_idx, dest_id, dest_sort_idx } = req.body;
            const { table } = req.params;
            await db.beginTransaction();
            let update_sql = ` UPDATE ${table} SET `
            source_id = parseInt(source_id);
            source_sort_idx = parseInt(source_sort_idx);
            dest_id = parseInt(dest_id);
            dest_sort_idx = parseInt(dest_sort_idx);
            if (source_sort_idx >= dest_sort_idx) {//드래그한게 더 클때
                update_sql += ` sort_idx=sort_idx+1 WHERE sort_idx < ${source_sort_idx} AND sort_idx >= ${dest_sort_idx} AND id!=${source_id} `;
            } else {//드래그한게 더 작을때
                update_sql += ` sort_idx=sort_idx-1 WHERE sort_idx > ${source_sort_idx} AND sort_idx <= ${dest_sort_idx} AND id!=${source_id} `;
            }
            let update_result = await pool.query(update_sql);

            let result = await pool.query(`UPDATE ${table} SET sort_idx=? WHERE id=?`, [dest_sort_idx, source_id]);

            await db.commit();
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    changeStatus: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 10);
            const decode_dns = checkDns(req.cookies.dns);
            const { table, column_name } = req.params;
            const { value, id } = req.body;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let result = await pool.query(`UPDATE ${table} SET ${column_name}=? WHERE id=?`, [value, id]);
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    copy: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 50);
            const decode_dns = checkDns(req.cookies.dns);

            const {
                sender_brand_id = 0,
                dns = "",
                is_copy_brand_setting = 0,
                is_copy_product = 0,
                is_copy_post = 0,
                is_use_tikitaka = 0,
            } = req.body;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let dns_data = await pool.query(`SELECT * FROM brands WHERE dns=?`, [dns]);
            dns_data = dns_data?.result[0];
            if (!dns_data) {
                return response(req, res, -100, "받을 도메인이 존재하지 않습니다.", false)
            }
            let sender_brand = await pool.query(`SELECT * FROM brands WHERE id=${sender_brand_id}`)
            sender_brand = sender_brand?.result[0];
            if (!sender_brand) {
                return response(req, res, -100, "복사할 도메인이 존재하지 않습니다.", false)
            }
            if (dns_data?.id == sender_brand?.id) {
                return response(req, res, -100, "같은 도메인은 복사할 수 없습니다.", false)
            }
            let manager = await pool.query(`SELECT * FROM users WHERE brand_id=${dns_data?.id} AND level=40`);
            manager = manager?.result[0];
            if (!manager) {
                return response(req, res, -100, "관리자 계정이 없는 브랜드입니다.", false);
            }
            await db.beginTransaction();
            if (is_copy_brand_setting == 1) {//브랜드 기본세팅 복사 원할시
                let result = await updateQuery('brands', {
                    name: sender_brand?.name,
                    logo_img: sender_brand?.logo_img,
                    dark_logo_img: sender_brand?.dark_logo_img,
                    favicon_img: sender_brand?.favicon_img,
                    og_img: sender_brand?.og_img,
                    og_description: sender_brand?.og_description,
                    theme_css: sender_brand?.theme_css,
                    //slider_css: sender_brand?.slider_css,
                    blog_obj: sender_brand?.blog_obj,
                    shop_obj: sender_brand?.shop_obj,
                    brand_type: sender_brand?.brand_type,
                }, dns_data?.id)
            }
            if (is_copy_product == 1) {//상품 복사 원할시

                let product_category_group_columns = ['category_group_name', 'max_depth', 'id'];
                let product_category_groups = await pool.query(`SELECT ${product_category_group_columns.join()} FROM product_category_groups WHERE brand_id=${sender_brand?.id} AND is_delete=0`);
                product_category_groups = product_category_groups?.result;
                let product_category_group_connect_ids = {};
                for (var i = 0; i < product_category_groups.length; i++) {
                    let obj = { ...product_category_groups[i] };
                    delete obj['id'];
                    let result = await insertQuery('product_category_groups', {
                        ...obj,
                        brand_id: dns_data?.id,
                    })
                    product_category_group_connect_ids[product_category_groups[i]?.id] = result?.result?.insertId;
                }

                let product_category_columns = ['product_category_group_id', 'parent_id', 'category_type', 'category_name', 'category_img', 'category_description', 'id'];
                let product_categories = await pool.query(`SELECT ${product_category_columns.join()} FROM product_categories WHERE product_category_group_id IN (${product_category_groups.map(item => { return item?.id }).join()})`);
                product_categories = product_categories?.result;
                let product_category_connect_ids = {};
                for (var i = 0; i < product_categories.length; i++) {
                    product_categories[i].depth = await findParents(product_categories, product_categories[i]);
                    product_categories[i].depth = product_categories[i].depth.length;
                }

                for (var i = 0; i < 10; i++) {
                    let product_category_depth_list = product_categories.filter(item => parseInt(item?.depth) == parseInt(i));
                    if (product_category_depth_list.length > 0) {
                        for (var j = 0; j < product_category_depth_list.length; j++) {
                            let obj = { ...product_category_depth_list[j] };
                            delete obj['id'];
                            delete obj['depth'];
                            let result = await insertQuery('product_categories', {
                                ...obj,
                                brand_id: dns_data?.id,
                                product_category_group_id: product_category_group_connect_ids[product_category_depth_list[j]?.product_category_group_id],
                                parent_id: product_category_connect_ids[product_category_depth_list[j]?.parent_id] ?? -1,
                            })
                            product_category_connect_ids[product_category_depth_list[j]?.id] = result?.result?.insertId;
                        }
                    }
                }


                let product_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                let products = await pool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                products = products?.result;
                let product_connect_ids = {};
                let first_insert_product_idx = 0;
                for (var i = 0; i < parseInt(products.length / 1000) + 1; i++) {
                    let insert_data = [];
                    let product_list = products.slice(i * 1000, (i + 1) * 1000);
                    for (var j = 0; j < product_list.length; j++) {
                        let product_price = product_list[j]?.product_price;
                        let product_sale_price = product_list[j]?.product_sale_price;
                        if (is_use_tikitaka == 1) {
                            product_price = ((parseInt(product_price) + 10000) / 10000).toFixed(0) * 10000;
                            product_sale_price = ((parseInt(product_sale_price) + 10000) / 10000).toFixed(0) * 10000;
                        }
                        insert_data.push([
                            product_category_connect_ids[product_list[j]?.category_id0],
                            product_category_connect_ids[product_list[j]?.category_id1],
                            product_category_connect_ids[product_list[j]?.category_id2],
                            product_list[j]?.product_name,
                            product_price,
                            product_sale_price,
                            product_list[j]?.product_img,
                            product_list[j]?.product_comment,
                            product_list[j]?.product_description,
                            dns_data?.id,
                            manager?.id
                        ])
                    }
                    if (insert_data.length > 0) {
                        let result = await pool.query('INSERT INTO products (category_id0,category_id1,category_id2,product_name,product_price,product_sale_price,product_img,product_comment,product_description,brand_id,user_id) VALUES ?', [insert_data])
                        if (i == 0) {
                            first_insert_product_idx = result?.result?.insertId
                        }
                    }
                }
                let update_sort_idx = await pool.query(`UPDATE products SET sort_idx=id WHERE brand_id=${dns_data?.id} AND id>=${first_insert_product_idx}`);
                let new_products = await pool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 AND id>=${first_insert_product_idx} ORDER BY id DESC`);
                new_products = new_products?.result;

                for (var i = 0; i < products.length; i++) {
                    product_connect_ids[products[i]?.id] = new_products[i]?.id;
                }
                // let product_option_group_columns = ['id', 'product_id', 'is_able_duplicate_select', 'group_name', 'group_description', 'group_img'];
                // let product_option_groups = await pool.query(`SELECT ${product_option_group_columns.join()} FROM product_option_groups WHERE product_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_option_groups = product_option_groups?.result;

                // let product_option_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                // let product_options = await pool.query(`SELECT ${product_option_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_options = product_options?.result;

                // let product_character_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                // let product_characters = await pool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_characters = product_characters?.result;
            }
            if (is_copy_post == 1) {//게시글 복사 원할시
                let post_category_columns = ['id', 'parent_id', 'post_category_title', 'post_category_type', 'post_category_read_type', 'is_able_user_add'];
                let post_categories = await pool.query(`SELECT ${post_category_columns.join()} FROM post_categories WHERE brand_id=${sender_brand?.id} AND is_delete=0`);
                post_categories = post_categories?.result;
                let post_category_connect_ids = {};
                for (var i = 0; i < post_categories.length; i++) {
                    post_categories[i].depth = await findParents(post_categories, post_categories[i]);
                    post_categories[i].depth = post_categories[i].depth.length;
                }
                for (var i = 0; i < 10; i++) {
                    let post_category_depth_list = post_categories.filter(item => parseInt(item?.depth) == parseInt(i));
                    if (post_category_depth_list.length > 0) {
                        for (var j = 0; j < post_category_depth_list.length; j++) {
                            let obj = { ...post_category_depth_list[j] };
                            delete obj['id'];
                            delete obj['depth'];
                            let result = await insertQuery('post_categories', {
                                ...obj,
                                brand_id: dns_data?.id,
                                parent_id: post_category_connect_ids[post_category_depth_list[j]?.parent_id] ?? -1,
                            })
                            post_category_connect_ids[post_category_depth_list[j]?.id] = result?.result?.insertId;
                        }
                    }
                }

                let first_insert_post_idx = 0;
                let posts = await pool.query(`SELECT posts.* FROM posts LEFT JOIN post_categories ON posts.category_id=post_categories.id WHERE post_categories.brand_id=${sender_brand?.id} AND post_categories.is_delete=0 AND posts.is_delete=0 AND posts.parent_id=-1`);
                posts = posts?.result;
                for (var i = 0; i < parseInt(posts.length / 1000) + 1; i++) {
                    let insert_data = [];
                    let post_list = posts.slice(i * 1000, (i + 1) * 1000);
                    for (var j = 0; j < post_list.length; j++) {
                        insert_data.push([
                            post_category_connect_ids[post_list[j]?.category_id],
                            manager?.id,
                            post_list[j]?.post_title,
                            post_list[j]?.post_content,
                            post_list[j]?.post_title_img,
                            post_list[j]?.is_reply,
                        ])
                    }
                    if (insert_data.length > 0) {
                        let result = await pool.query('INSERT INTO posts (category_id,user_id,post_title,post_content,post_title_img,is_reply) VALUES ?', [insert_data])
                        if (i == 0) {
                            first_insert_post_idx = result?.result?.insertId
                        }
                    }
                }
            }
            await db.commit();

            return response(req, res, 100, "success", {});
        } catch (err) {
            await db.rollback();
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export const setGrandParisProducts = async () => {
    try {
        //상품 메인이미지o
        //상품 서브이미지o
        //상품명o
        //상품코드o
        //상품가격o
        //상품카테고리
        //상품브랜드
        //상품등급o
        //상품코너o
        //상품설명o
        //
        let grand_products = await grandPool.query(`SELECT * FROM PRODUCT ORDER BY SEQ ASC`);
        grand_products = grand_products?.result;

        let grand_product_imgs = await grandPool.query(`SELECT * FROM PRODUCT_IMG WHERE IMG_FOLDER='/product' AND IMG_TYPE IN ('main','detail') AND DELETE_FLAG='N' ORDER BY SEQ ASC`);
        grand_product_imgs = grand_product_imgs?.result;

        let grand_product_categories = await grandPool.query(`SELECT * FROM PRODUCT_CATEGORY ORDER BY SEQ ASC`);
        grand_product_categories = grand_product_categories?.result;

        let grand_product_brands = await grandPool.query(`SELECT * FROM PRODUCT_BRAND ORDER BY SEQ ASC`);
        grand_product_brands = grand_product_brands?.result;

        await db.beginTransaction();

        let products = await pool.query(`SELECT * FROM products WHERE brand_id=5 ORDER BY id ASC`);
        products = products?.result;

        let product_obj = {};

        for (var i = 0; i < products.length; i++) {
            product_obj[products[i]?.product_code] = products[i];
        }

        let insert_property_list = [];

        let property_obj = {
            'N': 17,
            'N-S': 16,
            '특A': 15,
            'A+': 14,
            'A': 13,
            'A-': 12,
            '특B': 24,
        }
        for (var i = 0; i < grand_products.length; i++) {
            if (!product_obj[grand_products[i]?.PRODUCT_CODE]) {
                let insert_product = await pool.query(`INSERT INTO products (brand_id, product_name, product_code, product_price, product_sale_price, product_description) VALUES (?, ?, ?, ?, ?, ?)`, [
                    5,
                    grand_products[i]?.PRODUCT_NAME,
                    grand_products[i]?.PRODUCT_CODE,
                    grand_products[i]?.ORGIN_PRICE,
                    grand_products[i]?.PRICE,
                    grand_products[i]?.PRODUCT_DETAIL_INFO,
                ]);
                let insert_id = insert_product?.result?.insertId;
                let product_imgs = grand_product_imgs.filter(el => el?.PRODUCT_SEQ == grand_products[i]?.SEQ);
                let main_img = product_imgs.filter(el => el?.IMG_TYPE == 'main')[0]?.IMG_URL;
                let category_id = _.find(grand_product_categories, { CATEGORY_CODE: grand_products[i]?.CATEGORY_CODE })?.SEQ ? (_.find(grand_product_categories, { CATEGORY_CODE: grand_products[i]?.CATEGORY_CODE })?.SEQ + 1000) : 0;
                let bnd_id = _.find(grand_product_brands, { SEQ: parseInt(grand_products[i]?.BRAND_SEQ) })?.SEQ + 500;
                let sex_id = grand_products[i]?.PRODUCT_SEX == 'U' ? 2511 : (grand_products[i]?.PRODUCT_SEX == 'M' ? 2510 : 2509);
                let sql = `UPDATE products SET product_img=?, consignment_none_user_name=?, consignment_none_user_phone_num=?, consignment_user_id=?, sort_idx=? `;
                let value = [`https://kr.object.ncloudstorage.com/grandparis${main_img}`, grand_products[i]?.SELLER_NAME ?? "", grand_products[i]?.SELLER_MOBILE ?? "", grand_products[i]?.SELLER_MEMBER_SEQ + 1000, insert_id];
                if (category_id > 0) {
                    sql += `, category_id0=? `
                    value.push(category_id)
                }
                if (bnd_id > 0) {
                    sql += `, category_id1=? `
                    value.push(bnd_id)

                }
                if (sex_id > 0) {
                    sql += `, category_id2=? `
                    value.push(sex_id)
                }
                sql += ` WHERE id=? `
                value.push(insert_id)
                let update_item = await pool.query(sql, value);
                let sub_imgs = [];
                for (var j = 0; j < product_imgs.length; j++) {
                    if (product_imgs[j]?.IMG_TYPE == 'detail') {
                        sub_imgs.push([
                            insert_id,
                            `https://kr.object.ncloudstorage.com/grandparis${product_imgs[j]?.IMG_URL}`,
                        ])
                    }
                }
                let insert_sub_imgs = await pool.query(`INSERT INTO product_images (product_id, product_sub_img) VALUES ?`, [sub_imgs]);
                if (property_obj[grand_products[i].PRODUCT_USED_FLAG]) {
                    insert_property_list.push([
                        insert_id,//product_id
                        property_obj[grand_products[i].PRODUCT_USED_FLAG],//property_id
                        4//property_group_id
                    ])
                }
                if (grand_products[i].BEST_FLAG == 'Y') {
                    insert_property_list.push([
                        insert_id,
                        22,
                        3,
                    ])
                }
                if (grand_products[i].NEW_ARRIVAL_FLAG == 'Y') {
                    insert_property_list.push([
                        insert_id,
                        21,
                        3,
                    ])
                }
                if (grand_products[i].PRICE_DOWN_FLAG == 'Y') {
                    insert_property_list.push([
                        insert_id,
                        20,
                        3,
                    ])
                }
                if (grand_products[i].CLOTHES_FLAG == 'Y') {
                    insert_property_list.push([
                        insert_id,
                        19,
                        3,
                    ])
                }
                if (grand_products[i].WATCH_JEWELRY_FLAG == 'Y') {
                    insert_property_list.push([
                        insert_id,
                        18,
                        3,
                    ])
                }
            }
            if (i % 1000 == 0) {
                console.log(i);
            }
        }
        for (var i = 0; i < insert_property_list.length / 1000; i++) {
            let insert_property_list_z = insert_property_list.splice(i * 1000, (i + 1) * 1000);
            let result2 = await pool.query(`INSERT INTO products_and_properties (product_id,property_id,property_group_id) VALUES ?`, [insert_property_list])
        }
        await db.commit();
        console.log('success')
    } catch (err) {
        await db.rollback();
        console.log(err)
    }

}

export default utilCtrl;
