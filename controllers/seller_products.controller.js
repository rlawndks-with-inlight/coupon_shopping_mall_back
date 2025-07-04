'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";

const table_name = 'seller_products';

const sellerProductsCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} AND is_delete=0 `;
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;

            let data = await getSelectQueryList(sql, columns, req.query);

            console.log(sql)

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
                seller_id, product_id, seller_price, agent_price
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                seller_id, product_id, seller_price, agent_price
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
    all: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                seller_id, type, price_per
            } = req.body;

            let columns = [
                `products.*`,
                `sellers.user_name`,
                `sellers.seller_name`,
                `(SELECT COUNT(*) FROM transaction_orders LEFT JOIN transactions ON transactions.id=transaction_orders.trans_id WHERE transaction_orders.product_id=${table_name}.id AND transactions.is_cancel=0 AND transactions.trx_status >=5 AND transactions.is_delete=0) AS order_count`,
                `(SELECT COUNT(*) FROM product_reviews WHERE product_id=products.id AND is_delete=0) AS review_count`,
                `seller_products.id AS seller_product_id`,
                `seller_products.seller_id`,
                `seller_products.seller_price`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM products `;
            sql += ` LEFT JOIN users AS sellers ON products.user_id=sellers.id `;
            sql += ` LEFT JOIN seller_products ON products.id=seller_products.product_id AND seller_products.is_delete=0 `

            let where_sql = ` WHERE products.brand_id=${decode_dns?.id ?? 0} `;
            //where_sql += ` AND seller_products.seller_id=${seller_id} `;

            let category_group_sql = `SELECT * FROM product_category_groups WHERE brand_id=${decode_dns?.id ?? 0} AND is_delete=0 ORDER BY sort_idx DESC `;
            let category_groups = await readPool.query(category_group_sql);
            category_groups = category_groups[0];

            let category_sql_list = [];
            for (var i = 0; i < 3; i++) {
                sql += ` LEFT JOIN product_categories AS product_categories${i} ON product_categories${i}.id=products.category_id${i}`
                columns.push(`product_categories${i}.category_en_name AS category_en_name${i}`);
            }

            sql += where_sql;

            if (decode_user?.seller_range_o != 0) {
                sql += ` AND product_sale_price BETWEEN ${decode_user?.seller_range_u} AND ${decode_user?.seller_range_o}`
            }
            if ((decode_user?.seller_brand != undefined || decode_user?.seller_category != undefined)) {
                if (decode_user?.seller_brand && !decode_user?.seller_category) {
                    sql += ` AND category_id1 IN (${decode_user?.seller_brand})`
                } else if (!decode_user?.seller_brand && decode_user?.seller_category) {
                    let category_sql_list = [];
                    category_sql_list.push({
                        table: `category_id0`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=195 AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                    let category_obj = await getMultipleQueryByWhen(category_sql_list);

                    let seller_category = decode_user?.seller_category.split(',')

                    let seller_categories = []

                    if (Object.keys(category_obj).length > 0) {
                        for (var i = 0; i < Object.keys(category_obj).length; i++) {
                            let key = Object.keys(category_obj)[i];
                            for (var j = 0; j < seller_category?.length; j++) {
                                let category_ids = findChildIds(category_obj[key], seller_category[j]);
                                category_ids.unshift(parseInt(seller_category[j]));
                                seller_categories.unshift(category_ids.join())
                            }
                            sql += ` AND category_id0 IN (${seller_categories.join()})`
                        }
                    }

                    //sql += ` AND category_id0 IN (${decode_user?.seller_category}) `
                } else if (decode_user?.seller_brand && decode_user?.seller_category) {
                    let category_sql_list = [];
                    category_sql_list.push({
                        table: `category_id0`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=195 AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                    let category_obj = await getMultipleQueryByWhen(category_sql_list);

                    let seller_category = decode_user?.seller_category.split(',')

                    let seller_categories = []

                    if (Object.keys(category_obj).length > 0) {
                        for (var i = 0; i < Object.keys(category_obj).length; i++) {
                            let key = Object.keys(category_obj)[i];
                            for (var j = 0; j < seller_category?.length; j++) {
                                let category_ids = findChildIds(category_obj[key], seller_category[j]);
                                category_ids.unshift(parseInt(seller_category[j]));
                                seller_categories.unshift(category_ids.join())
                            }
                            sql += ` AND category_id0 IN (${seller_categories.join()})`
                            sql += ` AND category_id1 IN (${decode_user?.seller_brand}) `;
                        }
                    }
                    //sql += ` AND category_id0 IN (${decode_user?.seller_category}) AND category_id1 IN (${decode_user?.seller_brand}) `
                }
            }

            let data = await getSelectQueryList(sql, columns, {
                page: '1',
                page_size: '9999',
                s_dt: '',
                e_dt: '',
                search: '',
                category_id: 'null',
                seller_id: seller_id,
                order: 'id',
                manager_type: 'seller',
                brand_id: '74',
                root_id: '1'
            });

            //console.log(data.total)
            data = data?.content

            const chunkSize = 50; // 동시에 처리할 개수 제한

            const processCreateItem = async (item) => {
                try {
                    const product_id = item.id;
                    //console.log(item)
                    if (item.product_sale_price == 0 || item.seller_price == 0) return;

                    const is_exist_product = await readPool.query(
                        ` SELECT * FROM seller_products WHERE seller_id=? AND product_id=? AND is_delete = 0 `,
                        [seller_id, product_id]
                    );

                    const agent_price = Math.round(
                        Math.floor(
                            Number((item.product_sale_price * (1 + (decode_user?.oper_trx_fee ?? 0)) * (1 + (decode_user?.seller_trx_fee ?? 0))).toFixed(6))
                        ) / 1000
                    ) * 1000;

                    const seller_price = (price_per != 0
                        ? Math.round((agent_price * (1 + price_per / 100)) / 1000) * 1000
                        : agent_price);

                    if (agent_price == 0 || seller_price == 0) return;

                    if (is_exist_product[0].length > 0) {
                        const seller_product_id = item.seller_product_id;
                        const obj = { seller_price };
                        await updateQuery(`${table_name}`, obj, seller_product_id);
                    } else {
                        const obj = { seller_id, product_id, seller_price, agent_price };
                        //console.log(obj)
                        await insertQuery(`${table_name}`, obj);
                    }
                } catch (err) {
                    console.error(`상품 처리중 에러 발생: ${item.id}`, err);
                }
            };

            const processDeleteItem = async (item) => {
                try {
                    const product_id = item.seller_product_id;
                    const is_exist_product = await readPool.query(
                        ` SELECT * FROM seller_products WHERE seller_id=? AND id=? AND is_delete = 0 `,
                        [seller_id, product_id]
                    );

                    if (is_exist_product[0].length > 0) {
                        const id = item.seller_product_id;
                        await deleteQuery(`${table_name}`, { id });
                    }
                } catch (err) {
                    console.error(`상품 처리중 에러 발생: ${item.seller_product_id}`, err);
                }
            }

            const processInChunks = async (data, type) => {
                for (let i = 0; i < data.length; i += chunkSize) {
                    const chunk = data.slice(i, i + chunkSize);

                    if (type === 'create') {
                        await Promise.all(chunk.map(item => processCreateItem(item)));
                    } else if (type === 'delete') {
                        await Promise.all(chunk.map(item => processDeleteItem(item)));
                    }
                }
            };

            await processInChunks(data, type)

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
                id, seller_price
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                seller_price
            };
            obj = { ...obj, ...files };

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

export default sellerProductsCtrl;
