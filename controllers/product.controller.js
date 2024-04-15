'use strict';
import axios from "axios";
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { categoryDepth, checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, lowLevelException, makeObjByList, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
const table_name = 'products';

/*const productInserter = () => {
    obj = {}
    const initalize = (req) => {
        let {
            brand_id,
            product_img,
            product_name, product_code, product_comment, product_description, product_price = 0, product_sale_price = 0, user_id = 0, delivery_fee = 0, product_type = 0,
            consignment_user_name = "", consignment_none_user_name = "", consignment_none_user_phone_num = "", consignment_fee = 0, consignment_fee_type = 0,
            sub_images = [], groups = [], characters = [], properties = "{}"
        } = req.body;

        obj = {
            product_img,
            brand_id, product_name, product_code, product_comment, product_description, product_price, product_sale_price, user_id, delivery_fee, product_type,
            consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type,
        };
        for (var i = 0; i < categoryDepth; i++) {
            if (req.body[`category_id${i}`]) {
                obj[`category_id${i}`] = req.body[`category_id${i}`];
            }
        }
    }
    const getProuct = () => {

    }
    const getProperty = () => {

    }
}*/


const productCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { seller_id, property_id, is_consignment, status } = req.query;
            const { type } = req;
            let columns = [
                `${table_name}.*`,
                `sellers.user_name`,
                `sellers.seller_name`,
                `(SELECT COUNT(*) FROM transaction_orders LEFT JOIN transactions ON transactions.id=transaction_orders.trans_id WHERE transaction_orders.product_id=${table_name}.id AND transactions.is_cancel=0 AND transactions.trx_status >=5 AND transactions.is_delete=0) AS order_count`,
                `(SELECT COUNT(*) FROM product_reviews WHERE product_id=${table_name}.id AND is_delete=0) AS review_count`,
                `consignment_users.user_name AS consignment_user_name`,
                `consignment_users.phone_num AS consignment_phone_num`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users AS sellers ON ${table_name}.user_id=sellers.id `;
            sql += ` LEFT JOIN users AS consignment_users ON ${table_name}.consignment_user_id=consignment_users.id `;

            let where_sql = ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            if (seller_id > 0) {
                let connect_data = await pool.query(`SELECT * FROM products_and_sellers WHERE seller_id=${seller_id}`);
                connect_data = connect_data?.result.map(item => {
                    return item?.product_id
                })
                connect_data.unshift(0);
                where_sql += ` AND (${table_name}.id IN (${connect_data.join()})) `;
            }
            let category_group_sql = `SELECT * FROM product_category_groups WHERE brand_id=${decode_dns?.id ?? 0} AND is_delete=0 ORDER BY sort_idx DESC `;
            let category_groups = await pool.query(category_group_sql);
            category_groups = category_groups?.result;

            let category_sql_list = [];
            for (var i = 0; i < categoryDepth; i++) {
                sql += ` LEFT JOIN product_categories AS product_categories_${i} ON product_categories_${i}.id=${table_name}.category_id${i}`
                if (req.query[`category_id${i}`]) {
                    category_sql_list.push({
                        table: `category_id${i}`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=${category_groups[i]?.id} AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                }
            }
            let category_obj = await getMultipleQueryByWhen(category_sql_list);

            if (Object.keys(category_obj).length > 0) {
                for (var i = 0; i < Object.keys(category_obj).length; i++) {
                    let key = Object.keys(category_obj)[i];
                    let category_ids = findChildIds(category_obj[key], req.query[key]);
                    category_ids.unshift(parseInt(req.query[key]));
                    where_sql += ` AND ${key} IN (${category_ids.join()}) `;
                }
            }

            for (var i = 0; i < 20; i++) {
                if (req.query[`property_ids${i}`]) {
                    where_sql += ` AND ${table_name}.id IN (SELECT product_id FROM products_and_properties WHERE property_id IN (${req.query[`property_ids${i}`]}) ) `
                }
            }

            if (status) {
                where_sql += ` AND ${table_name}.id IN (SELECT products.id FROM products WHERE status IN (${status}) ) `
            }

            if (is_consignment) {
                where_sql += ` AND products.consignment_user_id=${decode_user?.id ?? 0} `;
            }
            sql += where_sql;
            if (type == 'user') {
                sql += ` AND products.status!=5 `
            }
            //sql += `ORDER BY products.status ASC, products.sort_idx DESC `
            /*if (!decode_user || decode_user?.level < 10) {
                sql += ` AND products.status!=5 `
            }*/
            let data = await getSelectQueryList(sql, columns, req.query);

            let product_ids = data?.content.map(item => { return item?.id });
            product_ids.unshift(0);
            /*sql_list = [
                {
                    table: 'brand_name',
                    sql: `SELECT category_name FROM product_categories WHERE id=${data.category_id1}` //상품의 브랜드 이름 불러오기
                }
            ]
            let brand_data = await getMultipleQueryByWhen(sql_list);
            data = {
                ...data,
                brand_name: brand_data?.brand_name,
            }*/
            let sub_images = await pool.query(`SELECT * FROM product_images WHERE product_id IN(${product_ids.join()}) AND is_delete=0 ORDER BY id ASC`)
            sub_images = sub_images?.result;
            for (var i = 0; i < data?.content.length; i++) {
                let images = sub_images.filter(item => item?.product_id == data?.content[i]?.id);
                data.content[i].sub_images = images ?? [];
                data.content[i].lang_obj = JSON.parse(data.content[i]?.lang_obj ?? '{}');
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
            let { id = 0 } = req.params;
            const { brand_id } = req.query;

            let product_columns = [
                `${table_name}.*`,
                `consignment_user.user_name AS consignment_user_name`,
                `consignment_user.name AS consignment_name`,
                `consignment_user.phone_num AS consignment_user_phone_num`,
            ]
            let product_sql = ` SELECT ${product_columns.join()} FROM ${table_name} `;
            product_sql += ` LEFT JOIN users AS consignment_user ON ${table_name}.consignment_user_id=consignment_user.id `;
            product_sql += ` WHERE ( ${table_name}.product_code='${id}' OR ${table_name}.id=${isNaN(parseInt(id)) ? 0 : id} ) AND ${table_name}.is_delete=0 AND ${table_name}.status!=5 AND ${table_name}.brand_id=${brand_id} `;

            //console.log(product_sql)
            let data = await pool.query(product_sql);
            data = data?.result[0];
            data.lang_obj = JSON.parse(data?.lang_obj ?? '{}');

            id = data?.id;

            let property_sql = `SELECT products_and_properties.*,product_properties.property_name,product_property_groups.property_group_name FROM products_and_properties `;
            property_sql += ` LEFT JOIN product_properties ON products_and_properties.property_id=product_properties.id `;
            property_sql += ` LEFT JOIN product_property_groups ON products_and_properties.property_group_id=product_property_groups.id `;
            property_sql += ` WHERE products_and_properties.product_id=${id} ORDER BY product_properties.sort_idx DESC `;

            let sql_list = [
                {
                    table: 'groups',
                    sql: `SELECT * FROM product_option_groups WHERE product_id=${id} AND is_delete=0 ORDER BY id ASC`
                },
                {
                    table: 'sub_images',
                    sql: `SELECT * FROM product_images WHERE product_id=${id} AND is_delete=0 ORDER BY id ASC`
                },
                {
                    table: 'scope',
                    sql: `SELECT AVG(scope)/2 AS product_average_scope, COUNT(*) AS product_review_count FROM product_reviews WHERE product_id=${id} `
                },
                {
                    table: 'properties',
                    sql: property_sql,
                },
            ];
            let when_data = await getMultipleQueryByWhen(sql_list);
            let option_group_ids = [];
            for (var i = 0; i < when_data?.groups.length; i++) {
                option_group_ids.push(when_data?.groups[i]?.id);
            }
            let sql_list2 = [
                {
                    table: 'characters',
                    sql: `SELECT * FROM product_characters WHERE product_id=${id}`
                },
                {
                    table: 'brand_name',
                    sql: `SELECT category_en_name FROM product_categories WHERE id=${data.category_id1}` //상품의 브랜드 이름 불러오기
                }
            ]
            if (option_group_ids.length > 0) {
                sql_list2.push({
                    table: 'options',
                    sql: `SELECT * FROM product_options WHERE group_id IN (${option_group_ids.join()}) AND is_delete=0 AND status!=5 ORDER BY id ASC`
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
                properties: when_data?.properties,
                characters: when_data2?.characters,
                product_average_scope: when_data?.scope[0]?.product_average_scope,
                brand_name: when_data2?.brand_name,
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
            if (decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            let {
                brand_id,
                product_img,
                product_name, product_code, product_comment, product_description, product_price = 0, product_sale_price = 0, user_id = 0, delivery_fee = 0, product_type = 0,
                consignment_user_name = "", consignment_none_user_name = "", consignment_none_user_phone_num = "", consignment_fee = 0, consignment_fee_type = 0,
                sub_images = [], groups = [], characters = [], properties = "{}", price_lang_obj = '{}',
                another_id = 0,
                price_lang = 'ko',
            } = req.body;

            let obj = {
                product_img,
                brand_id, product_name, product_code, product_comment, product_description, product_price, product_sale_price, user_id, delivery_fee, product_type,
                consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type, price_lang_obj,
                another_id, price_lang
            };
            for (var i = 0; i < categoryDepth; i++) {
                if (req.body[`category_id${i}`]) {
                    obj[`category_id${i}`] = req.body[`category_id${i}`];
                }
            }
            await db.beginTransaction();
            if (consignment_user_name) {
                let consignment_user = await pool.query(`SELECT id FROM users WHERE user_name=? AND brand_id=${brand_id} `, [consignment_user_name]);
                consignment_user = consignment_user?.result[0];
                if (!consignment_user) {
                    return response(req, res, -100, "위탁할 회원정보를 찾을 수 없습니다.", false);
                }
                obj['consignment_user_id'] = consignment_user?.id;
            }
            obj = { ...obj, };

            let result = await insertQuery(`${table_name}`, obj);

            let dns_data = await pool.query(`SELECT id, setting_obj FROM brands WHERE id=${brand_id}`);
            dns_data = dns_data?.result[0];
            dns_data["setting_obj"] = JSON.parse(dns_data?.setting_obj ?? "{}");

            let langs = await settingLangs(lang_obj_columns[table_name], obj, dns_data, table_name, result?.result?.insertId);


            if (!result?.result?.insertId) {
                await db.rollback();
                return response(req, res, -100, "상품 저장중 에러", false)
            }


            const product_id = result?.result?.insertId;

            let user = await pool.query(`SELECT level FROM users WHERE id=?`, [user_id]);
            user = user?.result[0];
            if (user?.level == 10) {
                let insert_and_table = await pool.query(`INSERT INTO products_and_sellers (seller_id, product_id) VALUES (?, ?)`, [user_id, product_id]);
            }

            let sql_list = [];
            //option
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
                                (isNaN(parseInt(option?.option_price)) ? 0 : option?.option_price),
                                option?.option_description,
                            ])
                        }
                    }
                    if (result_options.length > 0) {
                        sql_list.push({
                            table: `group_${group_id}`,
                            sql: `INSERT INTO product_options (group_id, option_name, option_price, option_description) VALUES ?`,
                            data: [result_options]
                        })
                    }
                }
            }
            //character
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
                    table: `character`,
                    sql: `INSERT INTO product_characters (product_id, character_name, character_value) VALUES ?`,
                    data: [insert_character_list]
                })
            }
            //sub image
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
                    table: `sub_images`,
                    sql: `INSERT INTO product_images (product_id, product_sub_img) VALUES ?`,
                    data: [insert_sub_image_list]
                })
            }
            //property         
            let insert_property_list = [];

            properties = JSON.parse(properties);

            let property_group_ids = Object.keys(properties);
            for (var i = 0; i < property_group_ids.length; i++) {
                for (var j = 0; j < properties[property_group_ids[i]]?.length; j++) {
                    insert_property_list.push([
                        product_id,
                        property_group_ids[i],
                        properties[property_group_ids[i]][j],
                    ])
                }
            }
            if (insert_property_list.length > 0) {
                sql_list.push({
                    table: `property`,
                    sql: `INSERT INTO products_and_properties (product_id, property_group_id, property_id) VALUES ?`,
                    data: [insert_property_list]
                })
            }

            let when = await getMultipleQueryByWhen(sql_list);
            await db.commit();
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            let {
                brand_id,
                id,
                product_img,
                product_name, product_code, product_comment, product_description, product_price = 0, product_sale_price = 0, delivery_fee = 0, product_type = 0,
                consignment_user_name = "", consignment_none_user_name = "", consignment_none_user_phone_num = "", consignment_fee = 0, consignment_fee_type = 0,
                sub_images = [], groups = [], characters = [], properties = "{}", price_lang_obj = '{}',
                another_id = 0, price_lang = 'ko',
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                product_img,
                product_name, product_code, product_comment, product_description, product_price, product_sale_price, delivery_fee, product_type,
                consignment_none_user_name, consignment_none_user_phone_num, consignment_fee, consignment_fee_type, price_lang_obj,
                another_id,
                price_lang,
            };
            for (var i = 0; i < categoryDepth; i++) {
                if (req.body[`category_id${i}`]) {
                    obj[`category_id${i}`] = req.body[`category_id${i}`];
                }
            }
            await db.beginTransaction();

            if (consignment_user_name) {
                let consignment_user = await pool.query(`SELECT id FROM users WHERE user_name=? AND brand_id=${brand_id} `, [consignment_user_name]);
                consignment_user = consignment_user?.result[0];
                if (!consignment_user) {
                    return response(req, res, -100, "위탁할 회원정보를 찾을 수 없습니다.", false);
                }
                obj['consignment_user_id'] = consignment_user?.id;
            }
            obj = { ...obj, ...files, };
            let result = await updateQuery(`${table_name}`, obj, id);

            let dns_data = await pool.query(`SELECT id, setting_obj FROM brands WHERE id=${brand_id}`);
            dns_data = dns_data?.result[0];
            dns_data["setting_obj"] = JSON.parse(dns_data?.setting_obj ?? "{}");

            let langs = await settingLangs(lang_obj_columns[table_name], obj, dns_data, table_name, id);

            const product_id = id;
            //option
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
                                    option_price: (isNaN(parseInt(option?.option_price)) ? 0 : option?.option_price),
                                    option_description: option?.option_description,
                                }, option?.id);
                            } else {
                                insert_option_list.push([
                                    group_id,
                                    option?.option_name,
                                    (isNaN(parseInt(option?.option_price)) ? 0 : option?.option_price),
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
            //character
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
            //sub image
            let insert_sub_image_list = [];
            let delete_sub_image_list = [];
            for (var i = 0; i < sub_images.length; i++) {
                if (sub_images[i]?.is_delete == 1) {
                    delete_sub_image_list.push(sub_images[i]?.id ?? 0);
                } else {
                    if (sub_images[i]?.id) {

                    } else {
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
            //property
            let delete_property_result = await pool.query(`DELETE FROM products_and_properties WHERE product_id=${product_id}`);

            let insert_property_list = [];
            properties = JSON.parse(properties);
            let property_group_ids = Object.keys(properties);
            for (var i = 0; i < property_group_ids.length; i++) {
                for (var j = 0; j < properties[property_group_ids[i]]?.length; j++) {
                    insert_property_list.push([
                        product_id,
                        property_group_ids[i],
                        properties[property_group_ids[i]][j],
                    ])
                }
            }
            if (insert_property_list.length > 0) {
                let property_result = await pool.query(`INSERT INTO products_and_properties (product_id, property_group_id, property_id) VALUES ?`, [insert_property_list]);
            }
            await db.commit();
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err));
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            if (decode_user?.level >= 40) {
                let result = await deleteQuery(`${table_name}`, {
                    id
                })
            } else {
                let result = await pool.query(`DELETE FROM products_and_sellers WHERE seller_id=${decode_user?.id} AND product_id=${id}`);
            }

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default productCtrl;
