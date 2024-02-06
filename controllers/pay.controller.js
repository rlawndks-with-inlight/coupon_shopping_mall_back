"use strict";
import axios from "axios";
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl, returnMoment } from "../utils.js/function.js";
import {
  deleteQuery,
  getSelectQueryList,
  insertQuery,
  selectQuerySimple,
  updateQuery,
} from "../utils.js/query-util.js";
import {
  checkDns,
  checkLevel,
  isItemBrandIdSameDnsId,
  response,
  settingFiles,
} from "../utils.js/util.js";
import "dotenv/config";
import logger from "../utils.js/winston/index.js";
import _ from "lodash";
const table_name = "transactions";

const payCtrl = {
  ready: async (req, res, next) => {
    //인증결제
    try {
      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { trx_type } = req.params;
      let {
        brand_id,
        user_id = 0,
        password = "",
        ord_num,
        amount,
        item_name,
        addr,
        detail_addr,
        products = [],
        buyer_name,
        buyer_phone,
        mid,
        tid,
        pay_key,
        trx_method,
        virtual_bank_code = "",
        virtual_acct_num = "",
        virtual_acct_issued_seq = "",
        bank_code = "",
        acct_num = "",
        use_point = 0,
      } = req.body;
      if (trx_type == 'auth') {
        trx_method = 2;
      } else if (trx_type == 'hand') {
        trx_method = 1;
      } else if (trx_type == 'virtual') {
        trx_method = 10;
      } else {
        return response(req, res, -100, "잘못된 결제타입 입니다.", false)
      }
      let files = settingFiles(req.files);
      let obj = {
        brand_id,
        user_id,
        password,
        ord_num,
        amount,
        item_name,
        addr,
        detail_addr,
        buyer_name,
        buyer_phone,
        mid,
        tid,
        pay_key,
        trx_method,
        virtual_bank_code,
        virtual_acct_num,
        virtual_acct_issued_seq,
        bank_code,
        acct_num,
        use_point,
      };
      obj = { ...obj, ...files };
      await db.beginTransaction();

      let result = await insertQuery(`${table_name}`, obj);

      let trans_id = result?.result?.insertId;
      let insert_item_data = [];
      let product_seller_ids = products.map((item) => {
        return item?.seller_id ?? 0;
      });
      product_seller_ids.unshift(0);
      let seller_data = await pool.query(
        `SELECT * FROM users WHERE brand_id=${brand_id ?? 0
        } AND id IN (${product_seller_ids.join()})`
      );
      seller_data = seller_data?.result;
      for (var i = 0; i < products.length; i++) {
        insert_item_data.push([
          trans_id,
          parseInt(products[i]?.id),
          products[i]?.order_name,
          parseFloat(products[i]?.order_amount),
          parseInt(products[i]?.order_count),
          JSON.stringify(products[i]?.groups ?? []),
          products[i]?.delivery_fee,
          parseInt(products[i]?.seller_id ?? 0),
          parseFloat(
            _.find(seller_data, { id: parseInt(products[i]?.seller_id) })
              ?.seller_trx_fee ?? 0
          ),
        ]);
      }
      let insert_item_result = await pool.query(
        `INSERT INTO transaction_orders (trans_id, product_id, order_name, order_amount, order_count, order_groups, delivery_fee, seller_id, seller_trx_fee) VALUES ?`,
        [insert_item_data]
      );
      if (trx_method == 1) {
        let result = await axios.post(
          `${process.env.NOTI_URL}/api/v2/pay/hand`,
          { ...req.body, temp: trans_id }
        );
        if (result?.data?.result_cd != "0000") {
          await db.rollback();
          return response(req, res, -100, result?.data?.result_msg, false);
        }
      }
      await db.commit();
      return response(req, res, 100, "success", {
        id: trans_id,
      });
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      await db.rollback();
      return response(
        req,
        res,
        -200,
        err?.response?.data?.result_msg || "서버 에러 발생",
        false
      );
    } finally {
    }
  },
  result: async (req, res, next) => {
    //결제완료
    try {

      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);

      let {
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
        is_cancel = 0,
        temp,
      } = req.body;
      const id = temp;
      await db.beginTransaction();
      let obj = {};
      let pay_data = {};
      if (is_cancel) {
        pay_data = await pool.query(
          `SELECT * FROM ${table_name} WHERE trx_id=? AND is_cancel=0`,
          [trx_id]
        );
        pay_data = pay_data?.result[0];
      } else {
        pay_data = await pool.query(`SELECT * FROM ${table_name} WHERE id=?`, [
          id,
        ]);
        pay_data = pay_data?.result[0];
      }
      let dns_data = await pool.query("SELECT * FROM brands WHERE id=?", [
        pay_data?.brand_id,
      ]);
      dns_data = dns_data?.result[0];
      dns_data["setting_obj"] = JSON.parse(dns_data?.setting_obj ?? "{}");
      if (is_cancel) {
        obj = {
          ...pay_data,
          cxl_dt: trx_dttm.split(" ")[0],
          cxl_tm: trx_dttm.split(" ")[1],
          is_cancel: 1,
          amount: amount * -1,
        };
        delete obj.is_delete;
        delete obj.created_at;
        delete obj.updated_at;
        delete obj.id;
        let result = await insertQuery(`${table_name}`, obj);
        if (
          amount * -1 * ((dns_data?.setting_obj?.point_rate ?? 0) / 100) <
          0
        ) {
          let result2 = await insertQuery(`points`, {
            brand_id: dns_data?.id ?? 0,
            user_id: pay_data?.user_id,
            sender_id: 0,
            point:
              amount * -1 * ((dns_data?.setting_obj?.point_rate ?? 0) / 100),
            type: 5,
            trans_id: result?.result?.insertId,
          });
        }
      } else {
        obj = {
          trx_id,
          appr_num,
          acquirer,
          issuer,
          card_num,
          trx_dt: trx_dttm.split(" ")[0],
          trx_tm: trx_dttm.split(" ")[1],
          trx_status: 5,
        };
        let result = await updateQuery(`${table_name}`, obj, id);
        if (amount * ((dns_data?.setting_obj?.point_rate ?? 0) / 100) > 0) {
          let result2 = await insertQuery(`points`, {
            brand_id: dns_data?.id,
            user_id: pay_data?.user_id,
            sender_id: 0,
            point: amount * ((dns_data?.setting_obj?.point_rate ?? 0) / 100),
            type: 0,
            trans_id: id,
          });
        }
      }

      await db.commit();
      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      await db.rollback();
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
  cancel: async (req, res, next) => {
    //결제취소
    try {

      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { trx_id, pay_key, amount, mid, tid, id } = req.body;
      let files = settingFiles(req.files);
      let obj = {};
      let payvery_cancel = await axios.post(
        `${process.env.NOTI_URL}/api/v2/pay/cancel`,
        {
          trx_id,
          pay_key,
          amount,
          mid,
          tid,
        }
      );
      payvery_cancel = payvery_cancel?.data ?? {};
      if (payvery_cancel?.result_cd == "0000") {
        return response(req, res, 100, "success", {});
      } else {
        return response(req, res, -200, payvery_cancel?.result_msg, false);
      }
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(
        req,
        res,
        -200,
        err?.response?.data?.result_msg || "서버 에러 발생",
        false
      );
    } finally {
    }
  },
  virtualAcctNoti: async (req, res, next) => {
    //가상계좌노티
    try {

      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const {
        amount,
        pay_type = "",
        acct_num,
        acct_name,
        bank_code,
        virtual_bank_code,
        virtual_acct_num,
        virtual_acct_name,
        tid,
        dns,
        created_at,
      } = req.body;
      let brand = await pool.query(`SELECT * FROM brands WHERE dns=?`, [dns]);
      brand = brand?.result[0];
      brand["theme_css"] = JSON.parse(brand?.theme_css ?? "{}");
      brand["slider_css"] = JSON.parse(brand?.slider_css ?? "{}");
      brand["setting_obj"] = JSON.parse(brand?.setting_obj ?? "{}");
      brand["none_use_column_obj"] = JSON.parse(brand?.none_use_column_obj ?? "{}");
      brand["bonaeja_obj"] = JSON.parse(brand?.bonaeja_obj ?? "{}");
      brand["shop_obj"] = JSON.parse(brand?.shop_obj ?? "[]");
      brand["blog_obj"] = JSON.parse(brand?.blog_obj ?? "[]");
      brand["seo_obj"] = JSON.parse(brand?.seo_obj ?? "{}");
      let phone_num = '';
      for (let i = 0; i < 8; i++) {
        const randomNumber = Math.floor(Math.random() * 10);
        phone_num += randomNumber.toString();
      }
      let random_addr = await pool.query(`SELECT * FROM user_addresses ORDER BY RAND() LIMIT 1`);
      random_addr = random_addr?.result[0];
      let obj = {
        brand_id: brand?.id,
        user_id: 0,
        tid,
        appr_num: tid,
        amount,
        item_name: 'asdasdsa',
        addr: '',
        detail_addr: '',
        buyer_name: acct_name,
        buyer_phone: '010' + phone_num,
        trx_method: 10,
        virtual_bank_code,
        virtual_acct_num,
        bank_code,
        acct_num,
        trx_dt: created_at.split(' ')[0],
        trx_tm: created_at.split(' ')[1],
        trx_status: 5,
      }
      if (pay_type == 'deposit') {
        obj['addr'] = random_addr?.addr;
        obj['detail_addr'] = random_addr?.detail_addr;
      } else if (pay_type == 'withdraw') {
        obj['is_cancel'] = 1;
      } else if (pay_type == 'return') {
        obj['is_cancel'] = 1;
      }
      let result = await insertQuery(`${table_name}`, obj);
      if (pay_type == 'deposit') {

      }
      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(
        req,
        res,
        -200,
        err?.response?.data?.result_msg || "서버 에러 발생",
        false
      );
    } finally {
    }
  },
};

export default payCtrl;
