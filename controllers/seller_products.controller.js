'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { loadSellerScope, parseIdList, sellerBrandCondition } from "../utils.js/seller-scope.js";
import { calcAgentPrice, loadSellerFees } from "../utils.js/seller-price.js";

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
            let params = [];
            // seller_products 엔 brand_id 컬럼이 없다(예전 WHERE seller_products.brand_id 는 항상 SQL 오류 → 관리자 셀러상품 목록이 늘 500).
            // 셀러(users) 의 brand_id 로 범위를 잡고, 셀러 본인(레벨 15 미만)은 자기 것만 본다.
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users AS sellers ON sellers.id=${table_name}.seller_id `;
            sql += ` WHERE sellers.brand_id=? `;
            params.push(Number(decode_user?.level) >= 50 ? (decode_dns?.id ?? 0) : (decode_user?.brand_id ?? 0));
            if (decode_user && Number(decode_user?.level) < 15) {
                sql += ` AND ${table_name}.seller_id=? `;
                params.push(decode_user?.id ?? 0);
            }

            let data = await getSelectQueryList(sql, columns, req.query, [], params);

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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
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
            let {
                seller_id, product_id, seller_price, agent_price
            } = req.body;
            // 인증: 로그인 필수. 셀러(레벨10~14)는 자기 seller_id 만, 운영자(15+)는 지정 가능.
            // 예전엔 인증 없이 아무 셀러의 판매가를 넣거나 바꿀 수 있었다(결제금액 불일치로 셀러몰 결제 전부 실패 = DoS + 가격 훼손).
            if (!(decode_user?.id > 0) || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            if (Number(decode_user?.level) < 15) seller_id = decode_user.id;
            let files = settingFiles(req.files);
            // 공급가는 서버가 계산한다(utils.js/seller-price.js). 화면이 보낸 agent_price 는 쓰지 않는다 —
            // 예전엔 그대로 저장해서, 낮춰 보내면 본사 몫이 깎이고 셀러 정산(결제×0.9 − 공급가)이 부풀었다.
            const fees = await loadSellerFees(seller_id);
            if (!fees || Number(fees.brand_id) !== Number(decode_dns?.id ?? 0)) {
                return response(req, res, -100, "셀러 정보를 확인할 수 없습니다.", false);
            }
            const [[product]] = await readPool.query(
                `SELECT product_sale_price FROM products WHERE id=? AND brand_id=? AND is_delete=0`,
                [Number(product_id) || 0, Number(fees.brand_id)]);
            if (!product) {
                return response(req, res, -100, "상품을 찾을 수 없습니다.", false);
            }
            agent_price = calcAgentPrice(product.product_sale_price, fees);
            if (!(agent_price > 0)) {
                return response(req, res, -100, "본사 가격이 없는 상품은 등록할 수 없습니다.", false);
            }
            if (!(Number(seller_price) >= agent_price)) {
                return response(req, res, -100, "본사 가격보다 낮게 등록할 수 없습니다.", false);
            }
            await writePool.query(
                `INSERT INTO seller_products (seller_id, product_id, seller_price, agent_price, is_delete)
                 VALUES (?, ?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE seller_price=VALUES(seller_price), agent_price=VALUES(agent_price), is_delete=0`,
                [seller_id, product_id, seller_price, agent_price]
            );

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
            let {
                seller_id, type, price_per
            } = req.body;
            // 일괄 등록/삭제: 로그인 필수, 셀러는 자기 seller_id 만(운영자 15+ 는 지정 가능). 예전엔 인증 없이 가능.
            if (!(decode_user?.id > 0) || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            if (Number(decode_user?.level) < 15) seller_id = decode_user.id;

            let params = [];
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
            sql += ` LEFT JOIN seller_products ON products.id=seller_products.product_id AND seller_products.is_delete=0 AND seller_products.seller_id=? `
            params.push(seller_id);

            let where_sql = ` WHERE products.brand_id=? `;
            params.push(decode_dns?.id ?? 0);

            let category_group_sql = `SELECT * FROM product_category_groups WHERE brand_id=? AND is_delete=0 ORDER BY sort_idx DESC `;
            let category_groups = await readPool.query(category_group_sql, [decode_dns?.id ?? 0]);
            category_groups = category_groups[0];

            let category_sql_list = [];
            for (var i = 0; i < 3; i++) {
                sql += ` LEFT JOIN product_categories AS product_categories${i} ON product_categories${i}.id=products.category_id${i}`
                columns.push(`product_categories${i}.category_en_name AS category_en_name${i}`);
            }

            sql += where_sql;

            // 범위는 '등록 대상 셀러' 의 것이다(운영자가 셀러를 지정해 일괄등록할 때도). 토큰이 아니라 DB 에서 읽는다
            // — 예전엔 호출한 사람의 토큰 값을 써서, 운영자가 대신 등록하면 셀러 범위가 통째로 무시됐다.
            const sellerUser = await loadSellerScope(seller_id);
            const sellerFees = await loadSellerFees(seller_id);
            if (!sellerFees || Number(sellerFees.brand_id) !== Number(decode_dns?.id ?? 0)) {
                return response(req, res, -100, "셀러 정보를 확인할 수 없습니다.", false);
            }
            if (sellerUser?.seller_range_o != 0) {
                sql += ` AND product_sale_price BETWEEN ? AND ?`;
                params.push(sellerUser?.seller_range_u, sellerUser?.seller_range_o);
            }
            if ((sellerUser?.seller_brand != undefined || sellerUser?.seller_category != undefined)) {
                if (sellerUser?.seller_brand && !sellerUser?.seller_category) {
                    const brandCond = await sellerBrandCondition(decode_dns?.id ?? 0, sellerUser?.seller_brand, 'products');
                    sql += brandCond.sql;
                    params.push(...brandCond.params);
                } else if (!sellerUser?.seller_brand && sellerUser?.seller_category) {
                    let category_sql_list = [];
                    category_sql_list.push({
                        table: `category_id0`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=195 AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                    let category_obj = await getMultipleQueryByWhen(category_sql_list);

                    let seller_category = parseIdList(sellerUser?.seller_category).map(String)

                    let seller_categories = []

                    if (Object.keys(category_obj).length > 0) {
                        for (var i = 0; i < Object.keys(category_obj).length; i++) {
                            let key = Object.keys(category_obj)[i];
                            for (var j = 0; j < seller_category?.length; j++) {
                                let category_ids = findChildIds(category_obj[key], seller_category[j]);
                                category_ids.unshift(parseInt(seller_category[j]));
                                seller_categories.unshift(category_ids.join())
                            }
                            let catIds = seller_categories.join().split(',');
                            // dual-read(단계 이행): 연결테이블(products_categories) OR 위치컬럼 category_id0
                            sql += ` AND (products.id IN (SELECT product_id FROM products_categories WHERE category_id IN (${catIds.map(() => '?').join(',')}) AND is_delete=0) OR category_id0 IN (${catIds.map(() => '?').join(',')}))`;
                            params.push(...catIds, ...catIds);
                        }
                    }

                    //sql += ` AND category_id0 IN (${sellerUser?.seller_category}) `
                } else if (sellerUser?.seller_brand && sellerUser?.seller_category) {
                    let category_sql_list = [];
                    category_sql_list.push({
                        table: `category_id0`,
                        sql: `SELECT * FROM product_categories WHERE product_category_group_id=195 AND is_delete=0 ORDER BY sort_idx DESC`
                    })
                    let category_obj = await getMultipleQueryByWhen(category_sql_list);

                    let seller_category = parseIdList(sellerUser?.seller_category).map(String)

                    let seller_categories = []

                    if (Object.keys(category_obj).length > 0) {
                        for (var i = 0; i < Object.keys(category_obj).length; i++) {
                            let key = Object.keys(category_obj)[i];
                            for (var j = 0; j < seller_category?.length; j++) {
                                let category_ids = findChildIds(category_obj[key], seller_category[j]);
                                category_ids.unshift(parseInt(seller_category[j]));
                                seller_categories.unshift(category_ids.join())
                            }
                            let catIds2 = seller_categories.join().split(',');
                            // dual-read(단계 이행): 연결테이블 OR 위치컬럼 category_id0
                            sql += ` AND (products.id IN (SELECT product_id FROM products_categories WHERE category_id IN (${catIds2.map(() => '?').join(',')}) AND is_delete=0) OR category_id0 IN (${catIds2.map(() => '?').join(',')}))`;
                            params.push(...catIds2, ...catIds2);
                            const brandCond2 = await sellerBrandCondition(decode_dns?.id ?? 0, sellerUser?.seller_brand, 'products');
                            sql += brandCond2.sql;
                            params.push(...brandCond2.params);
                        }
                    }
                    //sql += ` AND category_id0 IN (${sellerUser?.seller_category}) AND category_id1 IN (${sellerUser?.seller_brand}) `
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
            }, [], params);

            //console.log(data.total)
            data = data?.content

            console.log(`[일괄판매] seller_id=${seller_id}, type=${type}, price_per=${price_per}, 상품수=${data?.length ?? 0}`);

            const chunkSize = 5; // 동시에 처리할 개수 제한 (Too many connections 방지)

            const processCreateItem = async (item) => {
                try {
                    const product_id = item.id;
                    if (!item.product_sale_price || item.product_sale_price == 0) return;

                    // 수수료는 '등록 대상 셀러' 의 현재 값(DB)으로 — 예전엔 등록하는 사람의 로그인 토큰 값이라
                    // 영업자가 대신 등록하면 영업자 본인 수수료로, 셀러 본인이어도 로그인 뒤 바뀐 수수료는 빠졌다.
                    const agent_price = calcAgentPrice(item.product_sale_price, sellerFees);

                    const seller_price = (price_per != 0
                        ? Math.round((agent_price * (1 + price_per / 100)) / 1000) * 1000
                        : agent_price);

                    if (agent_price == 0 || seller_price == 0) return;

                    await writePool.query(
                        `INSERT INTO seller_products (seller_id, product_id, seller_price, agent_price, is_delete)
                         VALUES (?, ?, ?, ?, 0)
                         ON DUPLICATE KEY UPDATE seller_price=VALUES(seller_price), agent_price=VALUES(agent_price), is_delete=0`,
                        [seller_id, product_id, seller_price, agent_price]
                    );
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
            // 인증 + 소유: 셀러는 자기 행만, 운영자(15+)는 모두. (예전엔 인증 없이 아무 행이나 갱신)
            if (!(decode_user?.id > 0) || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            const ownRow = (await readPool.query(`SELECT id, seller_id FROM ${table_name} WHERE id=? LIMIT 1`, [id]))[0][0];
            if (!ownRow || (Number(decode_user?.level) < 15 && Number(ownRow.seller_id) !== Number(decode_user.id))) {
                return lowLevelException(req, res);
            }
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
            // 인증 + 소유(셀러는 자기 행만, 운영자 15+ 는 모두). 예전엔 인증 없이 삭제 가능.
            if (!(decode_user?.id > 0) || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            const ownRow = (await readPool.query(`SELECT id, seller_id FROM ${table_name} WHERE id=? LIMIT 1`, [id]))[0][0];
            if (!ownRow || (Number(decode_user?.level) < 15 && Number(ownRow.seller_id) !== Number(decode_user.id))) {
                return lowLevelException(req, res);
            }
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
