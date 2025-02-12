'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, findChildIds, findParent, findParents, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import _ from "lodash";
import { readPool, writePool } from "../config/db-pool.js";
const utilCtrl = {
    sort: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let { source_id, source_sort_idx, dest_id, dest_sort_idx } = req.body;
            const { table } = req.params;
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
            let update_result = await writePool.query(update_sql);

            let result = await writePool.query(`UPDATE ${table} SET sort_idx=? WHERE id=?`, [dest_sort_idx, source_id]);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
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
            let result = await writePool.query(`UPDATE ${table} SET ${column_name}=? WHERE id=?`, [value, id]);
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
                is_selected_categories = [],
            } = req.body;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let dns_data = await readPool.query(`SELECT * FROM brands WHERE dns=?`, [dns]);
            dns_data = dns_data[0][0];
            if (!dns_data) {
                return response(req, res, -100, "받을 도메인이 존재하지 않습니다.", false)
            }
            let sender_brand = await readPool.query(`SELECT * FROM brands WHERE id=${sender_brand_id}`)
            sender_brand = sender_brand[0][0];
            if (!sender_brand) {
                return response(req, res, -100, "복사할 도메인이 존재하지 않습니다.", false)
            }
            if (dns_data?.id == sender_brand?.id) {
                return response(req, res, -100, "같은 도메인은 복사할 수 없습니다.", false)
            }
            let manager = await readPool.query(`SELECT * FROM users WHERE brand_id=${dns_data?.id} AND level=40`);
            manager = manager[0][0];
            if (!manager) {
                return response(req, res, -100, "관리자 계정이 없는 브랜드입니다.", false);
            }
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
                let product_category_groups = await readPool.query(`SELECT ${product_category_group_columns.join()} FROM product_category_groups WHERE brand_id=${sender_brand?.id} AND is_delete=0`);
                product_category_groups = product_category_groups[0];
                let product_category_group_connect_ids = {};
                for (var i = product_category_groups.length; i >= 1; i--) {
                    let obj = { ...product_category_groups[i - 1] };
                    delete obj['id'];
                    let result = await insertQuery('product_category_groups', {
                        ...obj,
                        brand_id: dns_data?.id,
                    })
                    product_category_group_connect_ids[product_category_groups[i - 1]?.id] = result?.insertId;
                }
                //console.log(product_category_groups)

                let product_category_columns = ['product_category_group_id', 'parent_id', 'category_type', 'category_name', 'category_img', 'category_description', 'id'];
                let product_categories = await readPool.query(`SELECT ${product_category_columns.join()} FROM product_categories WHERE product_category_group_id IN (${product_category_groups.map(item => { return item?.id }).join()})`);
                product_categories = product_categories[0];
                let product_category_connect_ids = {};
                for (var i = product_categories.length; i >= 1; i--) {
                    product_categories[i - 1].depth = await findParents(product_categories, product_categories[i - 1]);
                    product_categories[i - 1].depth = product_categories[i - 1].depth.length;
                }
                //console.log(product_categories)

                for (var i = 0; i < 10; i++) {
                    let product_category_depth_list = product_categories.filter(item => parseInt(item?.depth) == parseInt(i));
                    if (product_category_depth_list.length > 0) {
                        for (var j = product_category_depth_list.length; j >= 1; j--) {
                            let obj = { ...product_category_depth_list[j - 1] };
                            delete obj['id'];
                            delete obj['depth'];
                            let result = await insertQuery('product_categories', {
                                ...obj,
                                brand_id: dns_data?.id,
                                product_category_group_id: product_category_group_connect_ids[product_category_depth_list[j - 1]?.product_category_group_id],
                                parent_id: product_category_connect_ids[product_category_depth_list[j - 1]?.parent_id] ?? -1,
                            })
                            product_category_connect_ids[product_category_depth_list[j - 1]?.id] = result?.insertId;
                        }
                    }
                }


                let product_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'another_id', 'id',];
                let product_sub_img_columns = ['product_sub_img'];

                let products = await readPool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                products = products[0];
                let product_connect_ids = {};
                let first_insert_product_idx = 0;
                let first_insert_product_sub_img_idx = 0;

                for (var i = 0; i < parseInt(products.length / 1000) + 1; i++) {
                    let insert_data = [];
                    let insert_sub_img_data = [];
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
                            product_list[j]?.another_id,
                            dns_data?.id,
                            manager?.id
                        ])
                    }
                    if (insert_data.length > 0) {
                        let result = await writePool.query('INSERT INTO products (category_id0,category_id1,category_id2,product_name,product_price,product_sale_price,product_img,product_comment,product_description,another_id,brand_id,user_id) VALUES ?', [insert_data])
                        if (i == 0) {
                            first_insert_product_idx = result[0]?.insertId
                        }

                        for (let j = 0; j < product_list.length; j++) {
                            product_connect_ids[product_list[j].id] = result[0].insertId + j;
                        }
                    }
                    for (var j = 0; j < product_list.length; j++) {
                        let sub_images = await readPool.query(`SELECT ${product_sub_img_columns.join()} FROM product_images WHERE product_id=${product_list[j]?.id} AND is_delete=0 ORDER BY id DESC`);
                        sub_images = sub_images[0];

                        for (var k = sub_images.length; k >= 1; k--) {
                            insert_sub_img_data.push([
                                product_connect_ids[product_list[j].id], // 새로운 상품 ID 사용
                                sub_images[k - 1]['product_sub_img']
                            ]);
                        }
                    }
                    if (insert_sub_img_data.length > 0) {
                        let result = await writePool.query('INSERT INTO product_images (product_id, product_sub_img) VALUES ?', [insert_sub_img_data]);
                        if (i == 0) {
                            first_insert_product_sub_img_idx = result[0]?.insertId;
                        }
                    }
                }
                let update_sort_idx = await writePool.query(`UPDATE products SET sort_idx=id WHERE brand_id=${dns_data?.id} AND id>=${first_insert_product_idx}`);
                let new_products = await readPool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 AND id>=${first_insert_product_idx} ORDER BY id DESC`);
                new_products = new_products[0];

                for (var i = 0; i < products.length; i++) {
                    product_connect_ids[products[i]?.id] = new_products[i]?.id;
                }

                // let product_option_group_columns = ['id', 'product_id', 'is_able_duplicate_select', 'group_name', 'group_description', 'group_img'];
                // let product_option_groups = await readPool.query(`SELECT ${product_option_group_columns.join()} FROM product_option_groups WHERE product_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_option_groups = product_option_groups[0];

                // let product_option_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                // let product_options = await readPool.query(`SELECT ${product_option_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_options = product_options[0];

                // let product_character_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                // let product_characters = await readPool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_characters = product_characters[0];
            }
            if (is_copy_post == 1) {//게시글 복사 원할시
                let post_category_columns = ['id', 'parent_id', 'post_category_title', 'post_category_type', 'post_category_read_type', 'is_able_user_add'];
                let post_categories = await readPool.query(`SELECT ${post_category_columns.join()} FROM post_categories WHERE brand_id=${sender_brand?.id} AND is_delete=0`);
                post_categories = post_categories[0];
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
                            post_category_connect_ids[post_category_depth_list[j]?.id] = result?.insertId;
                        }
                    }
                }

                let first_insert_post_idx = 0;
                let posts = await readPool.query(`SELECT posts.* FROM posts LEFT JOIN post_categories ON posts.category_id=post_categories.id WHERE post_categories.brand_id=${sender_brand?.id} AND post_categories.is_delete=0 AND posts.is_delete=0 AND posts.parent_id=-1`);
                posts = posts[0];
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
                        let result = await writePool.query('INSERT INTO posts (category_id,user_id,post_title,post_content,post_title_img,is_reply) VALUES ?', [insert_data])
                        if (i == 0) {
                            first_insert_post_idx = result[0]?.insertId
                        }
                    }
                }
            }


            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default utilCtrl;
