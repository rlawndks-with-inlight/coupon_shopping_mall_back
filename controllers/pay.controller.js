'use strict';
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';

const table_name = 'transactions';

const payCtrl = {
    hand:{
        ready:async (req, res, next) => { //수기결제준비
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
               
                await db.commit();
                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                await db.rollback();
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {
    
            }
        },
       
    },
    auth:{
        ready:async (req, res, next) => { //인증결제
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                let {
                    brand_id,
                    user_id=0,
                    password="",
                    seller_id=0,
                    seller_trx_fee=0,
                    ord_num,
                    amount,
                    item_name,
                    addr,
                    detail_addr,
                    products=[],
                    buyer_name,
                    buyer_phone,
                    mid,
                    tid,
                    trx_method=2
                } = req.body;
                let files = settingFiles(req.files);
                let obj = {
                    brand_id,
                    user_id,
                    password,
                    seller_id,
                    seller_trx_fee,
                    ord_num,
                    amount,
                    item_name,
                    addr,
                    detail_addr,
                    buyer_name,
                    buyer_phone,
                    mid,
                    tid,
                    trx_method,
                };
                
                obj = { ...obj, ...files };
                await db.beginTransaction();
                let result = await insertQuery(`${table_name}`, obj);
                let trans_id = result?.result?.insertId
                let insert_item_data = [];
                for(var i = 0;i<products.length;i++){
                    insert_item_data.push([
                        trans_id,
                        parseInt(products[i]?.id),
                        products[i]?.order_name,
                        parseFloat(products[i]?.order_amount),
                        parseInt(products[i]?.order_count),
                        JSON.stringify(products[i]?.groups??[]),
                        products[i]?.delivery_fee,
                    ])
                }
                console.log(insert_item_data)
                let insert_item_result = await pool.query(`INSERT INTO transaction_orders (trans_id, product_id, order_name, order_amount, order_count, order_groups, delivery_fee) VALUES ?`,[insert_item_data])
                await db.commit();
                return response(req, res, 100, "success", {
                    id: trans_id 
                })
            } catch (err) {
                console.log(err)
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {
    
            }
        },
       
    },
    result:async (req, res, next) => { //결제완료
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let 
            {
              mid,
              tid,
              trx_id,
              amount,
              ord_num,
              appr_num,
              item_name,
              buyer_name,
              buyer_phone,
              acquirer,
              issuer,
              card_num,
              installment,
              trx_dttm,
              is_cancel,
              temp
            } = req.body;
            const id = temp;
            console.log(req.body);
            let files = settingFiles(req.files);
            let obj = {
                trx_id,
                appr_num,
                acquirer,
                issuer,
                card_num,
                trx_dt:trx_dttm.split(' ')[0],
                trx_tm:trx_dttm.split(' ')[1],
                trx_status: 5,
            };
            obj = { ...obj, ...files };

            let result = await updateQuery(`${table_name}`, obj, id);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    cancel: async (req, res, next) => { //결제취소
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                id
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
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default payCtrl;
