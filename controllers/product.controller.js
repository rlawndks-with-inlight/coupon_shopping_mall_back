'use strict';
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';

const table_name = 'products';

const productCtrl = {
    list: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;
            console.log(req.query)
            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;

            let category_group_sql = `SELECT * FROM product_category_groups WHERE brand_id=${decode_dns?.id} AND is_delete=0 ORDER BY sort_idx DESC `;
            let category_groups = await pool.query(category_group_sql);
            category_groups = category_groups?.result;
            let category_sql_list = [];
            for (var i = 0; i < categoryDepth; i++) {
                if(req.query[`category_id${i}`]){
                    category_sql_list.push({
                        table: `category_id${i}`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=${category_groups[i]?.id} AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                }
            }
            let category_obj = await getMultipleQueryByWhen(category_sql_list);
            for(var i = 0;i<Object.keys(category_obj).length;i++){
                let key = Object.keys(category_obj)[i];

            }
            
            let data = await getSelectQueryList(sql, columns, req.query);

            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    get: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await pool.query(`SELECT * FROM ${table_name} WHERE id=${id}`)
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
    create: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            if (decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                brand_id, name, note, price = 0, category_id, product_sub_imgs = [], sub_name, status = 0, groups = [], characters = [],
            } = req.body;


            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id, product_sub_imgs, sub_name, status,
            };
            obj['product_sub_imgs'] = JSON.stringify(obj['product_sub_imgs']);

            let is_exist_category = await selectQuerySimple('product_categories', category_id);
            if (!(is_exist_category?.result.length > 0)) {
                return response(req, res, -100, "잘못된 상품 카테고리입니다.", {})
            }
            is_exist_category = is_exist_category?.result[0];

            if (is_exist_category?.brand_id != decode_dns?.id) {
                return response(req, res, -100, "잘못된 상품 카테고리입니다.", {})
            }
            obj = { ...obj, ...files };
            await db.beginTransaction();
            let result = await insertQuery(`${table_name}`, obj);
            let product_id = result?.result?.insertId;
            for (var i = 0; i < groups.length; i++) {
                let group = groups[i];
                if (group?.is_delete != 1) {
                    let group_result = await insertQuery(`product_options`, {
                        product_id,
                        brand_id,
                        name: group?.group_name,
                    });
                    let group_id = group_result?.result?.insertId;
                    let options = group?.options ?? [];
                    let result_options = [];
                    for (var j = 0; j < options.length; j++) {
                        let option = options[j];
                        if (option?.is_delete != 1) {
                            result_options.push([
                                product_id,
                                brand_id,
                                group_id,
                                option?.option_name,
                                option?.option_price,
                            ])
                        }
                    }
                    if (result_options.length > 0) {
                        let option_result = await pool.query(`INSERT INTO product_options (product_id, brand_id, parent_id, name, price) VALUES ?`, [result_options]);
                    }
                }
            }
            let insert_character_list = [];
            for (var i = 0; i < characters.length; i++) {
                insert_character_list.push([
                    product_id,
                    brand_id,
                    characters[i]?.character_key,
                    characters[i]?.character_value,
                ])
            }
            if (insert_character_list.length > 0) {
                let option_result = await pool.query(`INSERT INTO product_characters (product_id, brand_id, key_name, value) VALUES ?`, [insert_character_list]);
            }
            await db.commit();
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            if (decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                brand_id, name, note, price = 0, category_id, id, product_sub_imgs = [], sub_name, status = 0, groups = [], characters = [],
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id, product_sub_imgs, sub_name, status,
            };
            obj['product_sub_imgs'] = JSON.stringify(obj['product_sub_imgs']);
            let is_exist_category = await selectQuerySimple('product_categories', category_id);
            if (!(is_exist_category?.result.length > 0)) {
                return response(req, res, -100, "잘못된 상품 카테고리입니다.", {})
            }
            is_exist_category = is_exist_category?.result[0];

            if (is_exist_category?.brand_id != decode_dns?.id) {
                return response(req, res, -100, "잘못된 상품 카테고리입니다.", {})
            }
            obj = { ...obj, ...files };
            await db.beginTransaction();
            let result = await updateQuery(`${table_name}`, obj, id);

            let result2 = await pool.query(`UPDATE budget_products SET budget_price=? WHERE product_id=${id} AND budget_price < ?  `, [price, price]);
            const product_id = id;
            let insert_option_list = [];
            let delete_option_list = [];
            for (var i = 0; i < groups.length; i++) {
                let group = groups[i];
                if (group?.is_delete == 1) {
                    delete_option_list.push(group?.id ?? 0);
                } else {
                    let group_result = undefined;
                    if (group?.id) {
                        group_result = await updateQuery(`product_options`, {
                            name: group?.group_name,
                        }, group?.id);
                    } else {
                        group_result = await insertQuery(`product_options`, {
                            product_id,
                            brand_id,
                            name: group?.group_name,
                        });
                    }
                    let group_id = group_result?.result?.insertId || group?.id;
                    let options = group?.options ?? [];
                    let result_options = [];
                    for (var j = 0; j < options.length; j++) {
                        let option = options[j];
                        if (option?.is_delete == 1) {
                            delete_option_list.push(option?.id ?? 0);
                        } else {
                            if (option?.id) {
                                let option_result = await updateQuery(`product_options`, {
                                    name: option?.option_name,
                                    price: option?.option_price,
                                }, option?.id);
                            } else {
                                insert_option_list.push([
                                    product_id,
                                    brand_id,
                                    group_id,
                                    option?.option_name,
                                    option?.option_price,
                                ])
                            }
                        }
                    }
                }
            }
            if (insert_option_list.length > 0) {
                let option_result = await pool.query(`INSERT INTO product_options (product_id, brand_id, parent_id, name, price) VALUES ?`, [insert_option_list]);
            }
            if (delete_option_list.length > 0) {
                let option_result = await pool.query(`UPDATE product_options SET is_delete=1 WHERE id IN (${delete_option_list.join()}) OR parent_id IN (${delete_option_list.join()})`);
            }
            let insert_character_list = [];
            let delete_character_list = [];
            for (var i = 0; i < characters.length; i++) {
                let character = characters[i];
                if (character?.is_delete == 1) {
                    delete_character_list.push(character?.id ?? 0);
                } else {
                    if (character?.id) { // update
                        let character_result = await updateQuery(`product_characters`, {
                            key_name: character?.character_key,
                            value: character?.character_value,
                        }, character?.id);
                    } else { // insert
                        insert_character_list.push([
                            product_id,
                            brand_id,
                            character?.character_key,
                            character?.character_value,
                        ])
                    }
                }
            }
            if (insert_character_list.length > 0) {
                let option_result = await pool.query(`INSERT INTO product_characters (product_id, brand_id, key_name, value) VALUES ?`, [insert_character_list]);
            }
            if (delete_character_list.length > 0) {
                let option_result = await pool.query(`UPDATE product_characters SET is_delete=1 WHERE id IN (${delete_character_list.join()}) OR parent_id IN (${delete_character_list.join()})`);
            }
            await db.commit();
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err);
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let result = await deleteQuery(`${table_name}`, {
                id
            })
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    budget: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                product_id,
                budget_price,
                user_id
            } = req.body;
            let data = await pool.query(`SELECT * FROM budget_products WHERE user_id=${user_id} AND product_id=${product_id} `)
            data = data?.result[0];
            if (data) {
                let result = await updateQuery(`budget_products`, {
                    budget_price
                }, data?.id);
            } else {
                let result = await insertQuery(`budget_products`, {
                    budget_price,
                    product_id,
                    user_id
                }, data?.id);
            }
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default productCtrl;
