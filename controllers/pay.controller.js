"use strict";
import axios from "axios";
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
import { readPool, writePool } from "../config/db-pool.js";
import crypto from 'crypto';


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
        seller_id = 0,
      } = req.body;


      if (trx_type == 'auth') {
        trx_method = 2;
      } else if (trx_type == 'hand') {
        trx_method = 1;
      } else if (trx_type == 'hand_fintree') {
        trx_method = 3;
      } else if (trx_type == 'auth_fintree') {
        trx_method = 4;
      } else if (trx_type == 'virtual') {
        trx_method = 10;
      } else if (trx_type == 'gift_certificate') {
        trx_method = 11;
      } /*else if (trx_type == 'hand_weroute') {
        trx_method = 20;
      }*/ else if (trx_type == 'auth_weroute') {
        trx_method = 21;
      } else if (trx_type == 'card_hecto') {
        trx_method = 30;
      } else if (trx_type == 'phone_hecto') {
        trx_method = 31;
      } else {
        //console.log(trx_type);
        return response(req, res, -100, "잘못된 결제타입 입니다.", false)
      }
      let files = settingFiles(req.files);
      if (seller_id > 0) {
        let seller_columns = [
          `id`,
          `id`,
          `id`,
          `id`,
        ]
        let seller = await readPool.query(`SELECT ${seller_columns.join()} FROM users WHERE id=${seller_id} AND level=10`);
        seller = seller[0][0];
        if (!seller) {
          return response(req, res, -100, "셀러값이 잘못 되었습니다.", false)
        }
      }
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
      //console.log(req.body)

      let result = await insertQuery(`${table_name}`, obj);

      let trans_id = result?.insertId;
      let insert_item_data = [];
      let product_seller_ids = products.map((item) => {
        return item?.seller_id ?? 0;
      });
      product_seller_ids.unshift(0);
      let seller_data = await readPool.query(
        `SELECT * FROM users WHERE brand_id=${brand_id ?? 0
        } AND id IN (${product_seller_ids.join()})`
      );
      seller_data = seller_data[0];

      /*let trx_fee = await readPool.query(
        `SELECT seller_trx_fee FROM brands WHERE id=${brand_id ?? 0}`
      )
      let amount_ = amount * (1 + trx_fee[0][0].seller_trx_fee / 100)
      console.log(amount_)

      trx_fee = trx_fee[0][0].seller_trx_fee

      for (var i = 0; i < products.length; i++) {
        let val = parseInt(products[i]?.order_amount * (1 + trx_fee / 100))
        products[i].order_amount = val;
      }*/

      for (var i = 0; i < products.length; i++) {
        insert_item_data.push([
          trans_id,
          parseInt(products[i]?.id),
          products[i]?.order_name,
          parseInt(products[i]?.order_amount),
          parseInt(products[i]?.order_count),
          JSON.stringify(products[i]?.groups ?? []),
          (isNaN(products[i]?.delivery_fee) ? 0 : products[i]?.delivery_fee),
          parseInt(products[i]?.seller_id ?? 0),
          parseFloat(
            _.find(seller_data, { id: parseInt(products[i]?.seller_id) })
              ?.seller_trx_fee ?? 0
          ),
        ]);
      }
      //console.log(req.body)

      let insert_item_result = await writePool.query(
        `INSERT INTO transaction_orders (trans_id, product_id, order_name, order_amount, order_count, order_groups, delivery_fee, seller_id, seller_trx_fee) VALUES ?`,
        [insert_item_data]
      );
      if (trx_method == 1) {
        let result = await axios.post(
          `${process.env.NOTI_URL}/api/v2/pay/hand`,
          { ...req.body, temp: trans_id }
        );
        if (result?.data?.result_cd != "0000") {
          return response(req, res, -100, result?.data?.result_msg, false);
        }
      }

      if (trx_method == 3) {
        let result = await axios.post(
          `https://api.fintree.kr/payment.keyin`, { ...req.body }
        );
        console.log(result)
        if (result?.data?.resultCd == "9999") {
          return response(req, res, -100, result?.data?.resultMsg, false);
        } else {
          return;
        }
      }

      return response(req, res, 100, "success", {
        id: trans_id,
      });
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
        ori_trx_id,
      } = req.body;
      const id = temp;
      let obj = {};
      let pay_data = {};
      if (is_cancel) {
        pay_data = await readPool.query(
          `SELECT * FROM ${table_name} WHERE trx_id=? AND is_cancel=0`,
          [ori_trx_id]
        );
        pay_data = pay_data[0][0];
      } else {
        pay_data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [
          id,
        ]);
        pay_data = pay_data[0][0];
      }
      let dns_data = await readPool.query("SELECT * FROM brands WHERE id=?", [
        pay_data?.brand_id,
      ]);
      dns_data = dns_data[0][0];
      dns_data["setting_obj"] = JSON.parse(dns_data?.setting_obj ?? "{}");
      if (is_cancel) {
        obj = {
          ...pay_data,
          ori_trx_id,
          cxl_dt: trx_dttm.split(" ")[0],
          cxl_tm: trx_dttm.split(" ")[1],
          is_cancel: 1,
          amount: amount * -1,
          transaction_id: pay_data?.id,
        };
        delete obj.is_delete;
        delete obj.created_at;
        delete obj.updated_at;
        delete obj.id;
        let result = await insertQuery(`${table_name}`, obj);
        let update_pay_data = updateQuery(table_name, {//이미 결제된건 취소로 판별
          is_cancel_trans: 1,
        }, pay_data?.id);
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
            trans_id: result?.insertId,
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

      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
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
};
function generateArrayWithSum(products_ = [], targetSum = 0) {
  if (products_.length == 0) {
    return [];
  }
  let products = products_;
  products = products.sort((a, b) => {
    if (a.product_sale_price > b.product_sale_price) return -1
    if (a.product_sale_price < b.product_sale_price) return 1
    return 0
  })
  // 난수 생성 함수
  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // 원하는 합에 도달할 때까지 임의의 숫자를 반복해서 추가
  let currentSum = 0;
  let resultArray = [];
  while (currentSum < targetSum) {
    if ((targetSum - currentSum) < 10000) {
      break;
    }
    let find_items = products.filter(el => parseInt(el?.product_sale_price) <= (targetSum - currentSum));
    let price = find_items[0]?.product_sale_price;
    let same_price_product_list = find_items.filter(el => el?.product_sale_price == price);
    let randomNumberIndex = getRandomInt(0, same_price_product_list.length - 1);
    let randomNumber = same_price_product_list[randomNumberIndex]?.product_sale_price;
    resultArray.push(same_price_product_list[randomNumberIndex]);
    currentSum += randomNumber;
    if ((targetSum - currentSum) <= 10000) {
      let last_find_items = products.filter(el => el?.product_sale_price <= (targetSum - currentSum))
      if (last_find_items.length > 0) {
        resultArray.push(last_find_items[0]);
        currentSum += last_find_items[0]?.product_sale_price;
      }
      break;
    }
  }
  let remain = targetSum - currentSum;
  let result = [];
  for (var i = 0; i < resultArray.length; i++) {
    let find_index = _.findIndex(result, { id: parseInt(resultArray[i]?.id) });
    if (find_index >= 0) {
      result[find_index].order_count++;
      result[find_index].order_amount += resultArray[i]?.product_sale_price;
    } else {
      result.push({ ...resultArray[i], order_count: 1, order_amount: resultArray[i]?.product_sale_price, delivery_fee: (i == 0 ? remain : 0) })
    }
  }
  // 합계가 원하는 값에 도달하면 배열 반환
  return result;
}

const asdsadsad = async () => {
  try {
    let trxs = await readPool.query(`SELECT * FROM transactions WHERE brand_id IN (23, 24, 21) AND id <= 186863`);
    trxs = trxs[0];
    let products = await readPool.query(`SELECT * FROM products WHERE brand_id IN (23, 24, 21)`);
    products = products[0];
    for (var i = 0; i < trxs.length; i++) {
      let brand_products = products.filter(el => el?.brand_id == trxs[i]?.brand_id);
      let result_products = generateArrayWithSum(brand_products, trxs[i]?.amount)
      let insert_item_data = [];
      for (var j = 0; j < result_products.length; j++) {
        insert_item_data.push([
          trxs[i]?.id,
          parseInt(result_products[j]?.id),
          result_products[j]?.product_name,
          parseFloat(result_products[j]?.order_amount),
          parseInt(result_products[j]?.order_count),
          '[]',
          result_products[j]?.delivery_fee,
          0,
          0,
        ]);
      }
      if (insert_item_data.length > 0) {
        let insert_item_result = await writePool.query(
          `INSERT INTO transaction_orders (trans_id, product_id, order_name, order_amount, order_count, order_groups, delivery_fee, seller_id, seller_trx_fee) VALUES ?`,
          [insert_item_data]
        );
      }
    }
  } catch (err) {
    console.log(err)
  }
}
//asdsadsad();
export default payCtrl;