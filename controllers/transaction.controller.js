'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import XLSX from 'xlsx';
import fs from 'fs';
const table_name = 'transactions';

const transactionCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies?.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const { trx_status, cancel_status, is_confirm, cancel_type } = req.query;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let columns = [
                `${table_name}.*`,
                `sellers.user_name AS seller_user_name`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += `LEFT JOIN users AS sellers ON ${table_name}.seller_id=sellers.id`
            sql += ` WHERE ${table_name}.brand_id=${decode_dns?.id ?? 0} `;
            if (decode_user?.level == 10) {
                sql += ` AND seller_id=${decode_user?.id} `;
            }
            if (decode_user?.level == 0 || !decode_user) {
                sql += ` AND user_id=${decode_user?.id ?? -1} `;
            }
            if (trx_status) {
                sql += ` AND trx_status=${trx_status} `;
            }
            if (is_confirm) {
                sql += ` AND trx_status>=1 `;
            }
            if (cancel_status) {
                if (cancel_status == 1) {
                    sql += ` AND trx_status=1 AND is_cancel=0  `;
                } else if (cancel_status == 5) {
                    sql += ` AND is_cancel=1 `;
                } else if (cancel_status == 0) {
                    sql += ` AND is_cancel=0  `;
                }
            } else {
                sql += ` AND is_cancel=0  `;
            }
            if(cancel_status != 5){
                sql += ` AND (select COUNT(*) FROM ${table_name} AS trxs WHERE trxs.transaction_id=${table_name}.id AND trxs.is_cancel=1)=0 `;
            }
            if (cancel_type) {
                sql += ` AND cancel_type=${cancel_type} `;
            }
            let data = await getSelectQueryList(sql, columns, req.query);
            let trx_ids = data?.content.map(trx => {
                return trx?.id
            })
            if (trx_ids?.length > 0) {
                let transaction_orders_column = [
                    `transaction_orders.*`,
                    `products.product_img`,
                    `products.product_code`,
                    `sellers.user_name AS seller_user_name`,
                ]
                let order_sql = `SELECT ${transaction_orders_column.join()} FROM transaction_orders `
                order_sql += ` LEFT JOIN products ON transaction_orders.product_id=products.id `
                order_sql += ` LEFT JOIN users AS sellers ON transaction_orders.seller_id=sellers.id `
                order_sql += ` WHERE transaction_orders.trans_id IN (${trx_ids.join()}) `
                order_sql += ` ORDER BY transaction_orders.id DESC `
                let order_data = await pool.query(order_sql);
                order_data = order_data?.result;
                console.log(order_data)
                for (var i = 0; i < order_data.length; i++) {
                    order_data[i].groups = JSON.parse(order_data[i]?.order_groups ?? "[]");
                    delete order_data[i].order_groups

                }
                let transactions_order_obj = {};
                let transactions_id_obj = {};
                for (var i = 0; i < data?.content.length; i++) {
                    transactions_id_obj[data?.content[i]?.id] = i;
                    transactions_order_obj[data?.content[i]?.id] = [];
                }
                for (var i = 0; i < order_data.length; i++) {
                    transactions_order_obj[order_data[i]?.trans_id].push(order_data[i]);
                }
                for (var i = 0; i < data?.content.length; i++) {
                    data.content[i].orders = transactions_order_obj[data?.content[i]?.id];
                }
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
            const { id, } = req.params;
            const { ord_num, password } = req.query;
            let sql = `SELECT * FROM ${table_name} WHERE id=${id}`
            if (ord_num) {
                sql = `SELECT * FROM ${table_name} WHERE ord_num='${ord_num}' AND password='${password}'`;
            } else {
                if (!id) {
                    return response(req, res, -100, "존재하지 않는 주문입니다.", false)
                }
            }
            let data = await pool.query(sql)
            data = data?.result[0];
            if (!data) {
                return response(req, res, -100, "존재하지 않는 주문번호 입니다.", {})
            }
            let order_data = await pool.query(`SELECT * FROM transaction_orders WHERE trans_id=${data?.id ?? 0} ORDER BY id DESC`);
            order_data = order_data?.result;
            for (var i = 0; i < order_data.length; i++) {
                order_data[i].groups = JSON.parse(order_data[i]?.groups ?? "[]");
            }
            data.orders = order_data;

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
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id
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
    update: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
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
    changeInvoice: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            const { invoice_num } = req.body;
            let result = await updateQuery(`${table_name}`, {
                invoice_num
            }, id)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    cancelRequest: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await pool.query(`SELECT * FROM ${table_name} WHERE id=${id}`);
            data = data?.result[0];
            if (data?.user_id != decode_user?.id) {
                return lowLevelException(req, res);
            }
            let result = await updateQuery(`${table_name}`, {
                trx_status: 1,
            }, id)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

const asdsadsad = async () => {
    try {
        let result = await transactionCtrl.list({
            query: {
                is_confirm: true,
                s_dt: '2024-03-13'
            }
        })
        let data = [
            ['승인번호', '구매자명', '구매자휴대폰번호', '구매금액', '구매상품', '구매시간', '주소', '결제타입'],
        ];
        console.log(result.content.length)
        for (var i = 0; i < result.content.length; i++) {
            let order_item = result.content[i];
            data.push([
                order_item?.appr_num,
                order_item?.buyer_name,
                order_item?.buyer_phone,
                order_item?.amount,
                order_item?.orders.map(itm => {
                    return `상품주문명:${itm?.order_name} 상품가:${itm?.order_amount} 배달가:${itm?.delivery_fee}`
                }).join(' / '),
                `${order_item?.trx_dt} ${order_item?.trx_tm}`,
                `${order_item?.addr} ${order_item?.detail_addr}`,
                `가상계좌`
            ])
        }


        // 새 워크북 생성
        const wb = XLSX.utils.book_new();
        // 새 워크시트 생성
        const ws = XLSX.utils.aoa_to_sheet(data);

        // 워크북에 워크시트 추가
        XLSX.utils.book_append_sheet(wb, ws, "데이터");

        // 엑셀 파일로 저장
        XLSX.writeFile(wb, '데이터.xlsx', { bookSST: true });

    } catch (err) {
        console.log(err);
    }
}
export default transactionCtrl;
