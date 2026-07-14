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
import qs from 'qs';
import { requestPayment, getStatusByOrderNo, cancelPayment } from "../utils.js/payments/payletter.js";


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
        seller_amount,
        agent_amount,
        have_brother
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
      } else if (trx_type == 'card_payletter') {
        trx_method = 40;
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
        let seller = await readPool.query(`SELECT ${seller_columns.join()} FROM users WHERE id=? AND level=10`, [seller_id]);
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
        seller_id,
        seller_amount,
        agent_amount,
        have_brother
      };
      obj = { ...obj, ...files };
      //console.log(req.body)

      if (trx_method == 4) {
        obj = { ...obj, trx_status: 5 }
      }

      //console.log(obj)

      let result = await insertQuery(`${table_name}`, obj);

      //console.log(result)

      let trans_id = result?.insertId;
      let insert_item_data = [];

      products = Array.isArray(products) ? products : [products];

      let product_seller_ids = products.map((item) => {
        return item?.seller_id ?? 0;
      });
      product_seller_ids.unshift(0);
      const sellerPlaceholders = product_seller_ids.map(() => '?').join(',');
      let seller_data = await readPool.query(
        `SELECT * FROM users WHERE brand_id=? AND id IN (${sellerPlaceholders})`,
        [brand_id ?? 0, ...product_seller_ids]
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
        const matchedSeller = _.find(seller_data, { id: parseInt(products[i]?.seller_id) });
        insert_item_data.push([
          trans_id,
          parseInt(products[i]?.id),
          products[i]?.order_name,
          parseInt(products[i]?.order_amount),
          parseInt(products[i]?.order_count),
          JSON.stringify(products[i]?.groups ?? []),
          (isNaN(products[i]?.delivery_fee) ? 0 : products[i]?.delivery_fee),
          parseInt(products[i]?.seller_id ?? 0),
          parseFloat(matchedSeller?.seller_trx_fee ?? 0),
          parseInt(matchedSeller?.seller_trx_fee_type ?? 0),
        ]);
      }
      //console.log(req.body)

      if (insert_item_data.length > 0) {
        let insert_item_result = await writePool.query(
          `INSERT INTO transaction_orders (trans_id, product_id, order_name, order_amount, order_count, order_groups, delivery_fee, seller_id, seller_trx_fee, seller_trx_fee_type) VALUES ?`,
          [insert_item_data]
        );
      }
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
        const formData = qs.stringify({ ...req.body });

        let result = await axios.post(
          `https://api.fintree.kr/payment.keyin`, formData, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
        );
        //console.log(result)
        if (result?.data?.resultCd == "9999") {
          return response(req, res, -100, result?.data?.resultMsg, false);
        } else {
          return;
        }
      }

      if (trx_method == 4) {
        const { tid, ediDate, mid, goodsAmt, charSet, encData, signData } = req.body
        const formData = qs.stringify({ tid, ediDate, mid, goodsAmt, charSet, encData, signData });
        //console.log(formData)
        let result = await axios.post(
          `https://api.fintree.kr/payment.do`, formData, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
        );
        //console.log(result)
        if (!["0000", "3001"].includes(result?.data?.resultCd)) {
          return response(req, res, -100, result?.data?.resultMsg, false);
        } else {
          return response(req, res, 100, "success", {
            id: trans_id,
          });
        }
      }

      if (trx_method == 5) {
        let result = await axios.post(
          `https://api.weroutefincorp.com/api/v2/pay/hand`,
          { ...req.body, },
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': pay_key,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
            }
          }
        );
        if (result?.data?.result_cd != "0000") {
          return response(req, res, -100, result?.data?.result_msg, false);
        }
      }

      // ─────────────────────────────
      // 페이레터(PayLetter) 결제요청
      //  - 거래 생성 후 결제요청 API 호출 → 결제창 URL(online/mobile) 반환
      //  - 확정은 return/callback 핸들러에서 상태조회로 재검증 후 처리
      // ─────────────────────────────
      if (trx_method == 40) {
        try {
          // 인증정보는 payment_modules 테이블에서 조회 (MID=client_id, 결제키=API키)
          const creds = await getPayletterCreds(brand_id);
          if (!creds?.client_id || !creds?.payment_key) {
            return response(req, res, -100, "페이레터 결제모듈 설정이 필요합니다. (관리자 결제모듈에 MID=client_id, 결제키=API키 입력)", false);
          }
          // return/callback 주소는 요청에서 유도 (별도 env 불필요)
          const front_url = (req.body.front_url || "").toString().trim();
          const backBase = `${req.protocol}://${req.get('host')}`;
          const order_no = String(ord_num || `PL${trans_id}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 50);
          const return_url = `${backBase}/api/pays/payletter/return?front=${encodeURIComponent(front_url)}`;
          const callback_url = `${backBase}/api/pays/payletter/callback`;

          const pl = await requestPayment({
            client_id: creds.client_id,
            payment_key: creds.payment_key,
            pgcode: 'creditcard',
            user_id: String(user_id || buyer_phone || trans_id),
            user_name: buyer_name,
            order_no,
            amount,
            product_name: item_name || '상품',
            return_url,
            callback_url,
            custom_parameter: String(trans_id),
          });

          if (!pl?.online_url && !pl?.mobile_url) {
            return response(req, res, -100, pl?.message || "페이레터 결제요청 실패", false);
          }

          // 상태조회 검증 시 사용할 order_no를 거래에 동기화(원본 ord_num을 정규화한 값)
          await updateQuery(table_name, { ord_num: order_no }, trans_id);

          return response(req, res, 100, "success", {
            id: trans_id,
            token: pl?.token,
            online_url: pl?.online_url,
            mobile_url: pl?.mobile_url,
          });
        } catch (e) {
          logger.error(JSON.stringify(e?.response?.data || e));
          return response(req, res, -100, e?.response?.data?.message || "페이레터 결제요청 오류", false);
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
      const { trx_id, pay_key, amount, mid, tid, canAmt, canMsg, partCanFlg, encData, ediDate, id, pg } = req.body;
      let files = settingFiles(req.files);
      let obj = {};
      const formData = qs.stringify({ trx_id, pay_key, amount, mid, tid, canAmt, canMsg, partCanFlg, encData, ediDate });

      // 페이레터 취소: 거래에서 user_id/tid(trx_id)를 읽어 취소 API 호출
      if (pg === 'payletter') {
        let trx = await readPool.query(`SELECT * FROM transactions WHERE id=?`, [id]);
        trx = trx[0][0];
        if (!trx) {
          return response(req, res, -100, "거래를 찾을 수 없습니다.", false);
        }
        const creds = await getPayletterCreds(trx.brand_id);
        if (!creds?.client_id || !creds?.payment_key) {
          return response(req, res, -100, "페이레터 결제모듈 설정이 없습니다.", false);
        }
        const ip_addr = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '127.0.0.1').toString().split(',')[0].trim();
        const cancelRes = await cancelPayment({ client_id: creds.client_id, payment_key: creds.payment_key, user_id: trx.user_id, tid: trx.trx_id, ip_addr, pgcode: 'creditcard' });
        if (cancelRes?.tid) {
          await updateQuery('transactions', { is_cancel_trans: 1 }, id);
          return response(req, res, 100, "success", {});
        }
        return response(req, res, -200, cancelRes?.message || "페이레터 취소 실패", false);
      }

      if (decode_dns.id == 74) {
        let fintree_cancel = await axios.post(
          `https://api.fintree.kr/payment.cancel`, formData,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );
        //console.log(fintree_cancel)
        fintree_cancel = fintree_cancel?.data ?? {};
        if (fintree_cancel?.resultCd == "0000") {
          let update_transaction = await updateQuery('transactions', { is_cancel: 1 }, id)
          return response(req, res, 100, "success", {});
        } else {
          return response(req, res, -200, fintree_cancel?.result_msg, false);
        }
      } else if (decode_dns.id == 95) {
        let pay_cancel = await axios.post(
          `https://api.weroutefincorp.com/api/v2/pay/cancel`,
          {
            trx_id,
            pay_key,
            amount,
            mid,
            tid,
          },
          {
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'Authorization': pay_key,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
            }
          }
        );
        pay_cancel = pay_cancel?.data ?? {};
        if (pay_cancel?.result_cd == "0000") {
          let update_transaction = await updateQuery('transactions', { is_cancel_trans: 1 }, id)
          return response(req, res, 100, "success", {});
        } else {
          return response(req, res, -200, pay_cancel?.result_msg, false);
        }
      } else {
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
  payletterCallback: async (req, res, next) => {
    // 페이레터 서버→서버 콜백 (성공 시에만 호출). 반드시 {code:0} 으로 응답해야 함.
    try {
      const body = { ...req.query, ...req.body };
      const trx = (await readPool.query(`SELECT brand_id FROM transactions WHERE id=?`, [body.custom_parameter]))[0][0];
      const creds = trx ? await getPayletterCreds(trx.brand_id) : null;
      let status = {};
      try { status = await getStatusByOrderNo({ client_id: creds?.client_id, payment_key: creds?.payment_key, order_no: body.order_no }); } catch (e) { status = {}; }
      if (String(status?.status_code) !== '5') {
        return res.status(200).send({ code: -1, message: "결제 미완료 상태" });
      }
      await settlePayletterTransaction(body.custom_parameter, body);
      return res.status(200).send({ code: 0 });
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return res.status(200).send({ code: -1, message: "콜백 처리 오류" });
    }
  },
  payletterReturn: async (req, res, next) => {
    // 결제창 종료 후 브라우저가 도달하는 URL. 상태조회로 재검증 후 프론트 결과페이지로 리다이렉트.
    const data = { ...req.query, ...req.body };
    let front = (data.front || "").toString().trim();
    if (front && !/^https?:\/\//.test(front)) front = `https://${front}`;
    const resultBase = `${front}/shop/auth/pay-result`;
    try {
      const trx = (await readPool.query(`SELECT brand_id FROM transactions WHERE id=?`, [data.custom_parameter]))[0][0];
      const creds = trx ? await getPayletterCreds(trx.brand_id) : null;
      let status = {};
      try { status = await getStatusByOrderNo({ client_id: creds?.client_id, payment_key: creds?.payment_key, order_no: data.order_no }); } catch (e) { status = {}; }
      if (String(status?.status_code) === '5') {
        await settlePayletterTransaction(data.custom_parameter, data);
        const q = new URLSearchParams({
          result_cd: '0000',
          ord_num: (data.order_no || '').toString(),
          buyer_name: (data.user_name || '').toString(),
          trx_dttm: (data.transaction_date || '').toString(),
        }).toString();
        return res.redirect(302, `${resultBase}?${q}`);
      }
      return res.redirect(302, `${resultBase}?result_cd=9999`);
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return res.redirect(302, `${resultBase}?result_cd=9999`);
    }
  },
};

// 브랜드별 페이레터 인증정보를 payment_modules(trx_type=40)에서 조회
//  MID=client_id, 결제키(pay_key)=결제 API키, TID=조회 API키
async function getPayletterCreds(brand_id) {
  let rows = await readPool.query(
    `SELECT mid, pay_key, tid FROM payment_modules WHERE brand_id=? AND trx_type=40 ORDER BY id DESC LIMIT 1`,
    [brand_id]
  );
  let m = rows[0][0];
  if (!m) return null;
  return { client_id: m.mid, payment_key: m.pay_key, search_key: m.tid };
}

// 페이레터 거래 확정(멱등): 상태조회로 완료 확인된 거래를 결제완료 처리 + 포인트 적립
async function settlePayletterTransaction(transId, data = {}) {
  if (!transId) return false;
  let rows = await readPool.query(`SELECT * FROM transactions WHERE id=?`, [transId]);
  let trx = rows[0][0];
  if (!trx) return false;
  if (trx.trx_status == 5) return true; // 이미 확정됨(중복 콜백/리턴 방지)

  let trx_dttm = (data.transaction_date || '').toString();
  let trx_dt = trx_dttm.includes(' ') ? trx_dttm.split(' ')[0] : trx_dttm;
  let trx_tm = trx_dttm.includes(' ') ? trx_dttm.split(' ')[1] : '';

  await updateQuery('transactions', {
    trx_id: data.tid ?? trx.trx_id,
    appr_num: (data.cid ?? '').toString(),
    card_num: (data.card_info ?? '').toString(),
    trx_dt,
    trx_tm,
    trx_status: 5,
  }, transId);

  // 포인트 적립 (기존 pays.result 성공 로직과 동일)
  let brandRows = await readPool.query(`SELECT * FROM brands WHERE id=?`, [trx.brand_id]);
  let brand = brandRows[0][0];
  let setting = JSON.parse(brand?.setting_obj ?? '{}');
  let point = (trx.amount) * ((setting?.point_rate ?? 0) / 100);
  if (point > 0) {
    await insertQuery('points', {
      brand_id: trx.brand_id,
      user_id: trx.user_id,
      sender_id: 0,
      point,
      type: 0,
      trans_id: transId,
    });
  }
  return true;
}

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
          0,
        ]);
      }
      if (insert_item_data.length > 0) {
        let insert_item_result = await writePool.query(
          `INSERT INTO transaction_orders (trans_id, product_id, order_name, order_amount, order_count, order_groups, delivery_fee, seller_id, seller_trx_fee, seller_trx_fee_type) VALUES ?`,
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