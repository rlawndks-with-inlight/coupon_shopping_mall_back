'use strict';
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';

const table_name = 'products';

const productCtrl = {
    list: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;
            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} WHERE 1=1 `;
            let category_group_sql = `SELECT * FROM product_category_groups WHERE brand_id=${decode_dns?.id} AND is_delete=0 ORDER BY sort_idx DESC `;
            let category_groups = await pool.query(category_group_sql);
            category_groups = category_groups?.result;
            let category_sql_list = [];
            for (var i = 0; i < categoryDepth; i++) {
                if (req.query[`category_id${i}`]) {

                    category_sql_list.push({
                        table: `category_id${i}`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=${category_groups[i]?.id} AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                }
            }
            let category_obj = await getMultipleQueryByWhen(category_sql_list);
            for (var i = 0; i < Object.keys(category_obj).length; i++) {
                let key = Object.keys(category_obj)[i];
                let category_ids = findChildIds(category_obj[key], req.query[key]);
                category_ids.unshift(parseInt(req.query[key]));
                sql += ` AND ${key} IN (${category_ids.join()}) `;
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
            let sql_list = [
                {
                    table: 'product',
                    sql: `SELECT * FROM ${table_name} WHERE id=${id} AND is_delete=0`
                },
                {
                    table: 'groups',
                    sql: `SELECT * FROM product_option_groups WHERE product_id=${id} AND is_delete=0 ORDER BY id ASC`
                },
                {
                    table: 'sub_images',
                    sql: `SELECT * FROM product_images WHERE product_id=${id} AND is_delete=0 ORDER BY id ASC`
                }
            ];
            let when_data = await getMultipleQueryByWhen(sql_list);
            let data = when_data?.product[0];
            let option_group_ids = [];
            for (var i = 0; i < when_data?.groups.length; i++) {
                option_group_ids.push(when_data?.groups[i]?.id);
            }
            let sql_list2 = [{
                table: 'characters',
                sql: `SELECT * FROM product_characters WHERE product_id=${id}`
            }]
            if (option_group_ids.length > 0) {
                sql_list2.push({
                    table: 'options',
                    sql: `SELECT * FROM product_options WHERE group_id IN (${option_group_ids.join()}) AND is_delete=0 ORDER BY id ASC`
                })
            }
            let when_data2 = await getMultipleQueryByWhen(sql_list2);
            let groups = when_data?.groups;
            for (var i = 0; i < groups.length; i++) {
                groups[i].options = when_data2.options.filter((item) => item?.group_id == groups[i]?.id);
            }
            data = {
                ...data,
                groups,
                sub_images: when_data?.sub_images,
                characters: when_data2?.characters,
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
            let {
                brand_id,
                product_img, product_name, product_comment, product_description, product_price = 0, product_sale_price = 0, sub_images = [], groups = [], characters = [],
            } = req.body;

            let obj = {
                product_img, product_name, product_comment, product_description, product_price, product_sale_price,
            };
            for (var i = 0; i < categoryDepth; i++) {
                if (req.body[`category_id${i}`]) {
                    obj[`category_id${i}`] = req.body[`category_id${i}`];
                }
            }

            await db.beginTransaction();
            let result = await insertQuery(`${table_name}`, obj);
            let product_id = result?.result?.insertId;
            let sql_list = [];
            for (var i = 0; i < groups.length; i++) {
                let group = groups[i];
                if (group?.is_delete != 1) {
                    let group_result = await insertQuery(`product_option_groups`, {
                        product_id,
                        group_name: group?.group_name,
                        is_able_duplicate_select: group?.is_able_duplicate_select ?? 0,
                        group_description: group?.group_description,
                    });
                    let group_id = group_result?.result?.insertId;
                    let options = group?.options ?? [];
                    let result_options = [];
                    for (var j = 0; j < options.length; j++) {
                        let option = options[j];
                        if (option?.is_delete != 1) {
                            result_options.push([
                                group_id,
                                option?.option_name,
                                option?.option_price,
                                option?.option_description,
                            ])
                        }
                    }
                    if (result_options.length > 0) {
                        sql_list.push({
                            table:`group_${group_id}`,
                            sql:`INSERT INTO product_options (group_id, option_name, option_price, option_description) VALUES ?`,
                            data: [result_options]
                        })
                    }
                }
            }
            let insert_character_list = [];
            for (var i = 0; i < characters.length; i++) {
                if (characters[i]?.is_delete != 1) {
                    insert_character_list.push([
                        product_id,
                        characters[i]?.character_name,
                        characters[i]?.character_value,
                    ])
                }

            }
            if (insert_character_list.length > 0) {
                sql_list.push({
                    table:`character`,
                    sql:`INSERT INTO product_characters (product_id, character_name, character_value) VALUES ?`,
                    data: [insert_character_list]
                })
            }
            let insert_sub_image_list = [];
            for (var i = 0; i < sub_images.length; i++) {
                if (sub_images[i]?.is_delete != 1) {
                    insert_sub_image_list.push([
                        product_id,
                        sub_images[i]?.product_sub_img,
                    ])
                }
            }

            if (insert_sub_image_list.length > 0) {
                sql_list.push({
                    table:`sub_images`,
                    sql:`INSERT INTO product_images (product_id, product_sub_img) VALUES ?`,
                    data: [insert_sub_image_list]
                })
            }
            let when = await getMultipleQueryByWhen(sql_list);

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
            let {
                id,
                product_img, product_name, product_comment, product_description, product_price = 0, product_sale_price = 0, sub_images = [], groups = [], characters = [],
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                product_img, product_name, product_comment, product_description, product_price, product_sale_price,
            };
            for (var i = 0; i < categoryDepth; i++) {
                if (req.body[`category_id${i}`]) {
                    obj[`category_id${i}`] = req.body[`category_id${i}`];
                }
            }
            obj = { ...obj, ...files };
            await db.beginTransaction();
            let result = await updateQuery(`${table_name}`, obj, id);

            const product_id = id;
            let insert_option_list = [];
            let delete_option_list = [];
            let delete_group_list = [0];
            for (var i = 0; i < groups.length; i++) {
                let group = groups[i];
                if (group?.is_delete == 1) {
                    delete_group_list.push(group?.id ?? 0);
                } else {
                    let group_result = undefined;
                    if (group?.id) {
                        group_result = await updateQuery(`product_option_groups`, {
                            group_name: group?.group_name,
                            is_able_duplicate_select: group?.is_able_duplicate_select ?? 0,
                            group_description: group?.group_description,
                        }, group?.id);
                    } else {
                        group_result = await insertQuery(`product_option_groups`, {
                            product_id,
                            group_name: group?.group_name,
                            is_able_duplicate_select: group?.is_able_duplicate_select ?? 0,
                            group_description: group?.group_description,
                        });
                    }
                    let group_id = group_result?.result?.insertId || group?.id;
                    let options = group?.options ?? [];

                    for (var j = 0; j < options.length; j++) {
                        let option = options[j];
                        if (option?.is_delete == 1) {
                            delete_option_list.push(option?.id ?? 0);
                        } else {
                            if (option?.id) {
                                let option_result = await updateQuery(`product_options`, {
                                    option_name: option?.option_name,
                                    option_price: option?.option_price,
                                    option_description: option?.option_description,
                                }, option?.id);
                            } else {
                                insert_option_list.push([
                                    group_id,
                                    option?.option_name,
                                    option?.option_price,
                                    option?.option_description,
                                ])
                            }
                        }
                    }
                }
            }
            if (insert_option_list.length > 0) {
                let option_result = await pool.query(`INSERT INTO product_options (group_id, option_name, option_price, option_description) VALUES ?`, [insert_option_list]);
            }
            if (delete_group_list.length > 0) {
                let option_result = await pool.query(`UPDATE product_option_groups SET is_delete=1 WHERE id IN (${delete_group_list.join()}) `);
            }
            if (delete_option_list.length > 0) {
                let option_result = await pool.query(`UPDATE product_options SET is_delete=1 WHERE id IN (${delete_option_list.join()}) OR group_id IN (${delete_group_list.join()})`);
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
                            character_name: character?.character_name,
                            character_value: character?.character_value,
                        }, character?.id);
                    } else { // insert
                        insert_character_list.push([
                            product_id,
                            characters[i]?.character_name,
                            characters[i]?.character_value,
                        ])
                    }
                }
            }
            if (insert_character_list.length > 0) {
                let option_result = await pool.query(`INSERT INTO product_characters (product_id, character_name, character_value) VALUES ?`, [insert_character_list]);
            }
            if (delete_character_list.length > 0) {
                let option_result = await pool.query(`DELETE FROM product_characters WHERE id IN (${delete_character_list.join()})`);
            }

            let insert_sub_image_list = [];
            let delete_sub_image_list = [];
            for (var i = 0; i < sub_images.length; i++) {
                if (sub_images[i]?.is_delete == 1) {
                    delete_sub_image_list.push(sub_images[i]?.id??0);
                } else {
                    if(sub_images[i]?.id){

                    }else{
                        insert_sub_image_list.push([
                            product_id,
                            sub_images[i]?.product_sub_img,
                        ])
                    }
                }
            }
            if (insert_sub_image_list.length > 0) {
                let sub_image_result = await pool.query(`INSERT INTO product_images (product_id, product_sub_img) VALUES ?`, [insert_sub_image_list]);
            }
            if (delete_sub_image_list.length > 0) {
                let sub_image_result = await pool.query(`UPDATE product_images SET is_delete=1 WHERE id IN (${delete_sub_image_list.join()})`);
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
};

export default productCtrl;
