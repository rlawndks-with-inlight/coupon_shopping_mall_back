"use strict";
import axios from "axios";
import { 포인트사용상한, 적립예정 } from '../utils.js/point-policy.js';
import { checkIsManagerUrl, returnMoment } from "../utils.js/function.js";
import { hashOrderPassword } from "../utils.js/order-password.js";
import {
  deleteQuery,
  getSelectQueryList,
  insertQuery,
  selectQuerySimple,
  updateQuery, hasColumn } from "../utils.js/query-util.js";
import { canWriteBrand, checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles, errText } from "../utils.js/util.js";
import "dotenv/config";
import logger from "../utils.js/winston/index.js";
import _ from "lodash";
import { readPool, writePool } from "../config/db-pool.js";
import crypto from 'crypto';
import qs from 'qs';
import { requestPayment, getStatusByOrderNo, cancelPayment } from "../utils.js/payments/payletter.js";
import { createSession as forspayCreateSession, getLaunch as forspayGetLaunch, getTransaction as forspayGetTransaction, cancelTransaction as forspayCancelTransaction, verifyWebhookSignature as forspayVerifySig, getForspayMethod, FORSPAY_API_BASE } from "../utils.js/payments/forspay.js";
import { encForSave } from "../utils.js/pii.js";
import { saveOrderFormValues, findMissingOrderFormField } from "../utils.js/order-form.js";
import { checkStock, decreaseStock, restoreStock, findMissingRequiredOption, checkPurchaseLimit } from "../utils.js/product-options.js";
import { applyCancelEffects, markCanceled, getCancelState, cancelLines } from "../utils.js/cancel.js";


const table_name = "transactions";

// 부분취소를 지원하는 결제수단(trx_method).
//
// 41 = 포스페이. cancel API 의 amount 가 선택 파라미터이고(생략 시 전액),
//      조회의 cxl_seq 가 "취소 순번(0=원승인, 부분취소는 1,2,…)" 이라 여러 번 나눠 취소도 된다.
// 40 = 페이레터는 우리 연동이 전체취소뿐이다(함수 주석부터 '전체취소', body 에 금액이 없다).
// 핀트리·헥토는 partCanFlg='1' 로 가능하지만 mid·tid·encData 를 화면이 만들어 보내는 구조라
// 부분취소용 서명을 다시 설계해야 한다 — 쓰는 가맹점이 생기면 그때 붙인다.
//
// ⚠ 지원 안 하는 PG 에 부분취소를 걸면 **전액이 취소된다**. 목록에 없으면 막는다.
const PARTIAL_CANCEL_METHODS = [41];

// 결제가 실패로 끝나면 주문을 만들며 잡아둔 것들을 전부 놓아준다.
//
// 주문을 만들 때 두 가지를 미리 잡는다:
//   재고        결제창을 띄운 사이 남이 사가면 안 되니까
//   사용 포인트 같은 포인트로 두 번 할인받으면 안 되니까(type 10 음수 행)
// 그런데 놓아주는 자리가 없었다. PG 가 거절하거나 설정이 없어 되돌아가면
//   · 재고가 그대로 잠기고 (카드 실패가 반복되면 팔지도 못한 채 품절)
//   · **고객 포인트가 차감된 채 사라진다** (결제는 안 됐는데 포인트만 없어진다)
//
// applyCancelEffects 가 둘 다 처리한다. 실패 시점에는 적립(type 0)이 아직 없으므로
// 회수할 것도 없다 — 같은 함수를 그대로 써도 안전하다.
// response 와 인자 모양이 같아 실패 응답 자리에 그대로 갈아끼운다.
const 결제실패응답 = async (trans_id, req, res, code, msg, data) => {
  await 결제실패정리(trans_id);
  return response(req, res, code, msg, data);
};

// 결제창을 열지 못했을 때 손님에게 보일 문구.
//
// [왜 우리가 정하나] 포스페이는 실패 사유를 **자기 서버의 원문 오류**로 돌려준다.
//   2026-08-28 실제로 온 값:
//     {"error":"SQLSTATE[HY000] [1045] Access denied for user 'overseer'@'10.0.41.191'
//               (using password: YES) (SQL: select * from `merchandises` where `user_id`=2 ...)"}
//   이걸 그대로 message 에 담아 내려보내면 **결제하려던 손님 화면에 SQL 문이 뜬다**
//   (프론트 utils/api.js 가 서버 message 를 그대로 토스트로 띄운다).
//   몰이 고장난 것처럼 보이고, 협력사의 DB 계정명·내부 IP·테이블 구조가 아무에게나 새어 나간다.
//
// [사유를 안 보여줘도 되는 이유] 이 자리는 **결제창을 열기도 전**이다. 손님은 아직 카드번호를
//   넣지 않았다 — '한도 초과' 처럼 손님이 손쓸 수 있는 사유가 나올 수가 없다.
//   여기서 나는 실패는 전부 설정·시스템 문제이고, 손님이 할 수 있는 일은 '나중에 다시' 뿐이다.
//
// 사유는 바로 위 logger.error 로 logs/error 에 30일 남는다 — 진단에 필요한 것은 하나도 안 잃는다.
// 설정 누락(결제모듈 미입력·Base URL 없음)도 같은 자리다. 예전엔 손님 화면에
//   'MID=client_id, 결제키=API키 입력' · 'FORSPAY_API_BASE 설정이 필요합니다' 가 그대로 떴다 —
//   손님은 알 필요도 없고 알아도 할 수 있는 게 없다. 고쳐야 할 사람은 가맹점·본사다.
//   그래서 **사유는 로그에 brand_id 와 함께** 남기고 화면에는 같은 한 문장을 보낸다.
// 페이레터의 결제요청 실패도 같은 단계라 같은 문구를 쓴다.
// ⚠ 헥토·핀트리의 result_msg(승인 거절 사유)는 다르다 — 그때는 손님이 카드번호를 이미 넣었고
//   '한도 초과'처럼 손님이 손쓸 수 있는 사유라서 그대로 보여 준다. 그 자리는 건드리지 말 것.
// ⚠ 협력사 응답 문자열을 이 자리에 다시 끌어다 쓰지 말 것. 검사 scripts/checks/pg-message.mjs 가 막는다.
const 결제시작실패문구 = '결제를 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.';

const 결제실패정리 = async (trans_id) => {
  try {
    await applyCancelEffects(trans_id);
  } catch (e) {
    logger.error('결제 실패 정리 중 오류(응답은 그대로 나간다): ' + (e?.sqlMessage || e?.message || e));
  }
};

// ── 결제금액 서버 재계산 ──────────────────────────────────────────────────────
//
// 예전엔 프론트가 계산한 amount / order_amount 를 그대로 저장하고 PG 에도 그대로 넘겼다.
// 상품 상태 하드블록은 '살 수 있는 상품인가'만 보고 '얼마인가'는 전혀 보지 않았다.
// 즉 브라우저에서 금액만 바꾸면 10만원짜리를 100원에 결제할 수 있었고,
// 그 값이 transaction_orders 에까지 들어가 정산·매출 집계도 오염됐다.
//
// 프론트 공식(front: src/utils/shop-util.js 의 calculatorPrice + makePayData)을 그대로 재현한다:
//   라인 상품가 = (product_sale_price + Σ option_price) * order_count
//   라인 배송비 = 브랜드 배송비 정책이 켜져 있으면 '첫 라인에만' 1회 부과, 아니면 상품별 delivery_fee
//   결제금액    = Σ(라인 상품가 + 라인 배송비) - use_point
//
// 값의 출처를 전부 DB 로 바꾼다 — 상품가·상품별 배송비는 products,
// 옵션가는 product_options(클라이언트가 보낸 option_price 는 쓰지 않는다),
// 배송비 정책은 brands.setting_obj.
// 문자열 옵션({value:'블랙'})은 id 도 가격도 없으므로 0 원으로 본다.
const recalcOrderAmount = async (brand_id, products, use_point) => {
  const lines = Array.isArray(products) ? products : [products];

  const product_ids = [...new Set(
    lines.map((p) => parseInt(p?.id)).filter((v) => Number.isInteger(v) && v > 0)
  )];
  if (product_ids.length === 0) return null;

  const ph = product_ids.map(() => '?').join(',');
  let rows = await readPool.query(
    `SELECT id, product_sale_price, delivery_fee FROM products WHERE id IN (${ph})`,
    product_ids
  );
  const productById = new Map(rows[0].map((r) => [parseInt(r.id), r]));

  // 주문에 실린 옵션 id 를 모아 실제 가격을 한 번에 읽는다.
  const option_ids = [...new Set(
    lines.flatMap((p) => (p?.groups ?? []).flatMap((g) => (g?.options ?? [])
      .map((o) => parseInt(o?.id)).filter((v) => Number.isInteger(v) && v > 0)))
  )];
  // 옵션 id 가 '그 상품의 옵션'인지까지 확인한다.
  //
  // 예전엔 id 만 보고 가격을 읽었다. 그래서 다른 상품(심지어 다른 가맹점)의 옵션 id 를
  // 실어 보내면 그 옵션 가격이 그대로 적용됐다. 변동가가 음수인 옵션을 붙이면
  // 결제금액을 임의로 깎을 수 있다(관리자 폼이 음수 변동가를 막지 않는다).
  // 삭제된 옵션·그룹도 함께 걸러낸다.
  let optionPriceById = new Map();   // `${product_id}:${option_id}` -> 가격
  if (option_ids.length > 0) {
    const oph = option_ids.map(() => '?').join(',');
    let orows = await readPool.query(
      `SELECT o.id, o.option_price, g.product_id
         FROM product_options o
         JOIN product_option_groups g ON g.id = o.group_id
        WHERE o.id IN (${oph}) AND o.is_delete = 0 AND g.is_delete = 0`,
      option_ids
    );
    optionPriceById = new Map(orows[0].map(
      (r) => [`${parseInt(r.product_id)}:${parseInt(r.id)}`, Number(r.option_price) || 0]
    ));
  }

  // 조합형(option_mode=1) 상품은 조합마다 추가금이 따로다.
  // 이걸 빼먹으면 '분홍/M +5,000' 을 고른 주문이 5,000원 싸게 결제된다(가맹점 손실).
  //
  // ⚠ 새 컬럼·새 테이블이라 마이그레이션 전이면 쿼리가 터진다.
  //   여기서 던지면 recalc 가 통째로 죽어 **결제가 전부 막힌다**.
  //   못 읽으면 조합 추가금 0 원 = 개편 전과 똑같이 동작한다.
  let optionModeById = new Map();   // product_id -> 0|1
  let comboPriceByKey = new Map();  // `${product_id}:${combo_key}` -> add_price
  let groupTypeByOption = new Map();// `${product_id}:${option_id}` -> 0|1
  try {
    const [mrows] = await readPool.query(
      `SELECT id, option_mode FROM products WHERE id IN (${ph})`, product_ids);
    optionModeById = new Map(mrows.map((r) => [parseInt(r.id), parseInt(r.option_mode) || 0]));

    const [crows] = await readPool.query(
      `SELECT product_id, combo_key, add_price FROM product_option_combinations
        WHERE product_id IN (${ph}) AND is_delete=0`, product_ids);
    comboPriceByKey = new Map(crows.map(
      (r) => [`${parseInt(r.product_id)}:${r.combo_key}`, Number(r.add_price) || 0]));

    if (option_ids.length > 0) {
      const oph2 = option_ids.map(() => '?').join(',');
      const [grows] = await readPool.query(
        `SELECT o.id, g.product_id, g.group_type FROM product_options o
           JOIN product_option_groups g ON g.id = o.group_id
          WHERE o.id IN (${oph2}) AND o.is_delete=0 AND g.is_delete=0`, option_ids);
      groupTypeByOption = new Map(grows.map(
        (r) => [`${parseInt(r.product_id)}:${parseInt(r.id)}`, parseInt(r.group_type) || 0]));
    }
  } catch (e) {
    logger.error('조합형 금액 조회 실패(추가금 0원으로 진행): ' + (e?.sqlMessage || e?.message || e));
  }

  // 브랜드 배송비 정책 (front: getBrandShipping 과 동일 규칙)
  let brand = await readPool.query(`SELECT setting_obj FROM brands WHERE id=?`, [brand_id ?? 0]);
  let setting = {};
  try { setting = JSON.parse(brand[0][0]?.setting_obj ?? '{}'); } catch (e) { setting = {}; }
  const shipBase = parseInt(setting.delivery_fee_default || 0) || 0;
  const shipFreeMin = parseInt(setting.free_ship_min || 0) || 0;
  const shipActive = shipBase > 0 || shipFreeMin > 0;

  // 1) 라인별 상품가(배송비 제외)
  const merchByIdx = [];
  let merchTotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const p = productById.get(parseInt(lines[i]?.id));
    if (!p) return null; // 없는 상품 — 호출부의 상태 하드블록이 이미 걸러내지만 방어

    let optionPrice = 0;
    // 같은 옵션 id 를 여러 그룹에 중복해 보내면 그만큼 중복 가산·감산됐다.
    // 라인 안에서 한 번만 센다. 그리고 그 라인 상품에 속한 옵션만 인정한다 —
    // 남의 상품 옵션 id 는 가격 0 으로 무시된다(주문 자체는 상태 하드블록이 따로 본다).
    const counted = new Set();
    const line_product_id = parseInt(lines[i]?.id);
    const 조합형 = optionModeById.get(line_product_id) === 1;
    const 선택옵션ids = [];
    for (const g of (lines[i]?.groups ?? [])) {
      for (const o of (g?.options ?? [])) {
        const oid = parseInt(o?.id);
        if (!(Number.isInteger(oid) && oid > 0)) continue;
        if (counted.has(oid)) continue;
        counted.add(oid);
        const 종류 = groupTypeByOption.get(`${line_product_id}:${oid}`) ?? 0;
        // 조합형 상품의 **선택옵션**은 개별 가격이 아니라 조합 추가금으로 값이 매겨진다.
        // 추가상품(종류 1)은 조합과 무관하게 늘 개별 가격이 붙는다.
        if (조합형 && 종류 === 0) { 선택옵션ids.push(oid); continue; }
        optionPrice += (optionPriceById.get(`${line_product_id}:${oid}`) ?? 0);
      }
    }
    if (조합형 && 선택옵션ids.length > 0) {
      const key = [...new Set(선택옵션ids)].sort((a, b) => a - b).join('-');
      optionPrice += (comboPriceByKey.get(`${line_product_id}:${key}`) ?? 0);
    }
    const count = parseInt(lines[i]?.order_count);
    if (!Number.isInteger(count) || count <= 0) return null;

    const lineMerch = ((Number(p.product_sale_price) || 0) + optionPrice) * count;
    merchByIdx[i] = lineMerch;
    merchTotal += lineMerch;
  }

  // 2) 배송비 — 정책이 켜져 있으면 주문단위로 첫 라인에 1회
  const shipFee = shipActive
    ? ((shipFreeMin > 0 && merchTotal >= shipFreeMin) ? 0 : shipBase)
    : 0;

  let amount = 0;
  const expectedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const p = productById.get(parseInt(lines[i]?.id));
    const lineDelivery = shipActive
      ? (i === 0 ? shipFee : 0)
      : (Number(p.delivery_fee) || 0);
    const order_amount = merchByIdx[i] + lineDelivery;
    amount += order_amount;
    expectedLines.push({ id: parseInt(lines[i]?.id), order_amount, delivery_fee: lineDelivery });
  }

  const point = Math.max(0, parseInt(use_point) || 0);
  return { amount: amount - point, lines: expectedLines, merchTotal, usedPoint: point };
};

const payCtrl = {

  ready: async (req, res, next) => {
    //인증결제
    // ⚠ trans_id 를 try 밖에 둔다. catch 에서 재고를 놓아주려면 여기서 보여야 한다
    //   (try 안에 let 으로 두면 catch 에서 ReferenceError 가 난다).
    let trans_id = 0;
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
        pay_method,        // 포스페이: 구매자가 고른 결제수단 키(card/bank/kakaopay/…)
        receiver,          // 배송지 받는사람
        delivery_memo = null,  // 배송 요청사항(고객 입력) — 컬럼이 없으면 저장을 건너뛴다
        addr_phone,        // 배송지 연락처
        zonecode,          // 우편번호
        // 해외배송. 주소록 행은 나중에 수정·삭제될 수 있으므로
        // '그때 어디로 보내기로 했는지'는 주문 자체에 박아 둔다.
        country_code = 'KR',
        country_name = null,   // 고객이 직접 적은 나라 이름(코드 컬럼은 VARCHAR(2))
        city = null,
        state_region = null,
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

      // ── 주문 주체와 브랜드는 서버가 확정한다 ──────────────────────────────
      //
      // 예전엔 이 함수가 decode_user·decode_dns 를 선언만 하고 한 번도 쓰지 않았다.
      // brand_id 와 user_id 를 req.body 에서 그대로 받아 그대로 INSERT 했고,
      // 포인트 잔액 검사(SELECT SUM(point) FROM points WHERE user_id=?)와
      // 차감 원장(points 에 음수 행 insert)까지 전부 body 의 user_id 를 썼다.
      //
      // 그래서 남의 user_id 를 실어 보내면 **그 사람 포인트로 내 주문을 할인받고
      // 그 사람 잔액이 깎였다.** brand_id 도 마음대로 지정해 다른 가맹점 장부에
      // 주문을 꽂을 수 있었다.
      //
      // 프론트가 보내는 값은 원래 themeDnsData.id 와 로그인 유저 id 다
      // (views/shop/order/OrderSheet.js:105-106). 즉 서버가 스스로 아는 값과 같아서
      // 정상 주문에는 아무 영향이 없다.
      //
      // 비회원 주문은 user_id=0 이 정상이다(비회원은 포인트를 쓸 수 없게 아래에서 막는다).
      // dns 쿠키는 JWT 서명본이라 위조할 수 없고, 스토어프론트는 페이지 로드마다
      // /api/domain 으로 발급받는다(front: components/settings/SettingsContext.js:155).
      user_id = Number(decode_user?.id) > 0 ? Number(decode_user.id) : 0;
      if (!(Number(decode_dns?.id) > 0)) {
        return response(req, res, -100, "잘못된 접근입니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.", false);
      }
      brand_id = Number(decode_dns.id);
      // ⚠ 남은 것: 아래 상품 상태 검사(SELECT id, status FROM products WHERE id IN (...))와
      //   recalcOrderAmount 의 상품 조회에는 아직 브랜드 스코프가 없다. 다른 브랜드 상품 id 를
      //   섞어 보내면 이 브랜드 주문에 그 상품이 들어간다(금액은 실제 상품 행에서 재계산하므로
      //   금전 손실은 없다). 셀러·위탁 상품이 상위 브랜드 소속인 경우가 있어 스코프를 좁히면
      //   정상 주문을 막을 수 있어 확인 후 별도로 처리한다.

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
      } else if (trx_type == 'auth_forspay') {
        trx_method = 41;
      } else {
        //console.log(trx_type);
        return response(req, res, -100, "잘못된 결제타입 입니다.", false)
      }
      // 비회원 주문 비밀번호 길이 검증.
      // DB 컬럼이 varchar(8) 이던 시절 프론트 maxLength 가 20 이라
      // 9자 이상이면 INSERT 가 'Data too long' 으로 터져 결제가 500 으로 끝났다.
      // 컬럼을 넓혔지만(2026-08-07_widen_transactions_password.sql) 프론트만 믿을 수 없으므로
      // 서버에서도 같은 규칙(6~16자)을 강제한다. 회원 주문은 password 가 빈 값이라 검사 대상 아님.
      if (!(user_id > 0)) {
        const pw = String(password ?? '');
        if (pw.length < 6 || pw.length > 16) {
          return response(req, res, -100, "비회원 주문 비밀번호는 6~16자로 입력해 주세요.", false)
        }
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
      // ── 구매 가능 상태 하드블록(서버측) ─────────────────────────────
      // 주문 저장(persist) 전에, 주문에 포함된 상품들의 현재 status를 확인한다.
      // 구매가능 = products.status IN (0 판매중, 3 새상품). 그 외(1 중단, 2 품절, 5 비공개 등)는 차단.
      // 금액/PG 흐름은 건드리지 않고, 저장 전에 상태 가드만 추가한다.
      {
        let order_products = Array.isArray(products) ? products : [products];
        let ordered_product_ids = order_products
          .map((item) => parseInt(item?.id))
          .filter((v) => Number.isInteger(v) && v > 0);
        ordered_product_ids = [...new Set(ordered_product_ids)];
        if (ordered_product_ids.length > 0) {
          const statusPlaceholders = ordered_product_ids.map(() => '?').join(',');
          let status_rows = await readPool.query(
            `SELECT id, status FROM products WHERE id IN (${statusPlaceholders})`,
            ordered_product_ids
          );
          status_rows = status_rows[0];
          // 구매가능 상태(0 판매중, 3 새상품)가 아닌 상품이 하나라도 있으면 차단
          const is_purchasable = (s) => (s == 0 || s == 3);
          let has_blocked = status_rows.some((row) => !is_purchasable(row?.status));
          // 요청한 상품 id가 products 테이블에 없으면(삭제/부재) 역시 차단 — 조용히 통과시키지 않는다
          let existing_ids = new Set(status_rows.map((row) => parseInt(row?.id)));
          let has_missing = ordered_product_ids.some((id) => !existing_ids.has(id));
          if (has_blocked || has_missing) {
            return response(req, res, -100, "구매할 수 없는 상품이 포함되어 있습니다. (품절/판매중단)", false);
          }
        }
      }

      // ── 결제금액 검증(서버 재계산) ────────────────────────────────────
      // 여기까지는 '살 수 있는 상품인가'만 봤다. '얼마인가'를 서버가 직접 계산해 대조한다.
      {
        const expected = await recalcOrderAmount(brand_id, products, use_point);
        if (!expected) {
          return response(req, res, -100, "주문 상품 정보가 올바르지 않습니다.", false);
        }

        // 포인트는 서버에서 본다. 예전엔 프론트(OrderSheet)에서만 확인했다.
        //
        // 예전 검사는 잔액 하나뿐이었다. 그래서 가맹점이 설정해 둔 조건
        // ('일정 금액 이상 주문할 때만' / '일정 포인트 이상 모였을 때만' / '한 번에 최대 얼마')이
        // 서버에서는 전혀 지켜지지 않았다 — 화면을 거치지 않고 들어온 요청은 그냥 통과했다.
        // 판정은 화면과 같은 규칙(utils.js/point-policy.js)으로 한다.
        if (expected.usedPoint > 0) {
          if (!(user_id > 0)) {
            return response(req, res, -100, "비회원 주문은 포인트를 사용할 수 없습니다.", false);
          }
          // 잔액도 이 몰의 것만 센다 — 브랜드를 넘나들면 남의 몰 포인트로 결제된다
          // (auth.controller 의 같은 쿼리 주석 참고).
          let bal = await readPool.query(
            `SELECT SUM(point) AS point FROM points WHERE user_id=? AND brand_id=?`, [user_id, brand_id]);
          const balance = Number(bal[0][0]?.point) || 0;
          if (expected.usedPoint > balance) {
            return response(req, res, -100, "보유 포인트가 부족합니다.", false);
          }
          // 포인트를 빼기 전 주문금액으로 조건을 본다(빼고 나면 조건을 스스로 무너뜨린다).
          const 주문금액 = Number(expected.amount || 0) + Number(expected.usedPoint || 0);
          const { 상한, 사유 } = 포인트사용상한({
            dns: decode_dns, 보유: balance, 주문금액,
          });
          if (expected.usedPoint > 상한) {
            return response(req, res, -100, 사유 || "사용 가능한 포인트를 초과했습니다.", false);
          }
        }

        if (!(expected.amount >= 0)) {
          return response(req, res, -100, "결제금액이 올바르지 않습니다.", false);
        }

        const client_amount = parseInt(amount);
        if (!Number.isInteger(client_amount) || client_amount !== expected.amount) {
          // 불일치는 조작일 수도, 주문서를 띄워둔 사이 상품가가 바뀐 것일 수도 있다.
          // 어느 쪽이든 그대로 결제시키지 않는다. 원인 추적을 위해 양쪽 값을 남긴다.
          logger.error(`[pay.ready] 결제금액 불일치 brand=${brand_id} client=${amount} server=${expected.amount}`);
          return response(req, res, -100, "결제금액이 변경되었습니다. 주문서를 새로고침한 뒤 다시 시도해 주세요.", false);
        }

        // 저장과 PG 전송에는 서버 계산값을 쓴다.
        amount = expected.amount;
        products = Array.isArray(products) ? products : [products];
        for (let i = 0; i < products.length; i++) {
          products[i].order_amount = expected.lines[i]?.order_amount ?? 0;
          products[i].delivery_fee = expected.lines[i]?.delivery_fee ?? 0;
        }
      }

      // 배송 국가는 주문에도 남긴다 — 주소록 행은 나중에 수정·삭제될 수 있으므로
      // '그때 어디로 보내기로 했는지'는 주문 자체에 박혀 있어야 한다.
      // 컬럼이 없으면(마이그레이션 전) 건너뛴다 — 없는 컬럼을 넣으면 주문 저장이 통째로 실패한다.
      const overseasCountry = String(country_code || 'KR').toUpperCase().slice(0, 2);
      const hasCountryColumn = await hasColumn('transactions', 'country_code');
      // 주문번호 충돌 방지: 같은 ord_num 의 살아있는 주문이 이미 있으면 거절한다.
      // 프론트는 시각+난수로 만들어 정상 흐름에선 안 겹친다. 이 검사가 없으면 남의 ord_num 으로 새 주문을 만들어
      // PG 승인 통지(ord_num 기준 '최신 행' 매칭)를 가로챌 수 있다. (ord_num 인덱스가 있어 조회는 싸다)
      if (ord_num) {
        const dup = (await readPool.query(`SELECT id FROM transactions WHERE ord_num=? AND is_cancel=0 LIMIT 1`, [ord_num]))[0][0];
        if (dup) {
          return response(req, res, -100, "주문번호가 중복되었습니다. 다시 시도해 주세요.", false);
        }
      }
      let obj = {
        brand_id,
        user_id,
        // 비회원 주문조회 비밀번호는 평문으로 저장하지 않는다.
        // 주문번호에 비밀번호가 박히던 문제와 함께 정리(주문번호 형식도 변경됨).
        // 회원 주문은 password 가 빈 값이라 그대로 '' 로 저장된다.
        password: hashOrderPassword(password),
        ord_num,
        amount,
        item_name,
        addr,
        detail_addr,
        buyer_name,
        buyer_phone,
        receiver,
        receiver_phone: addr_phone,
        zonecode,
        // 배송 요청사항. 컬럼이 없으면(마이그레이션 전) 통째로 건너뛴다 —
        // 없는 컬럼을 넣으면 주문 저장이 실패한다(국가 컬럼과 같은 방식).
        ...(await hasColumn('transactions', 'delivery_memo')
            ? { delivery_memo: delivery_memo ? String(delivery_memo).slice(0, 255) : null }
            : {}),
        ...(hasCountryColumn ? {
            country_code: overseasCountry,
            // 나라 이름은 고객이 직접 적는다 — 저장하지 않으면 주문서에서 받은 국가가 버려진다.
            country_name: country_name ? String(country_name).slice(0, 60) : null,
            city,
            state_region,
        } : {}),
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

      if (pay_method) obj = { ...obj, pay_method }; // 포스페이 산하 결제수단(카드/카카오 등) 기록. transactions.pay_method 컬럼 필요(ALTER).

      //console.log(obj)

      // 결제로 넘어가기 전 서버가 다시 본다. 프론트 검사는 우회할 수 있다.
      //
      // 재고: 화면에 '남은 1개'가 떠 있어도 두 사람이 동시에 누르면 둘 다 통과한다.
      //       여기서 막지 않으면 없는 물건을 팔고 나서 전화로 취소를 돌려야 한다.
      // 입력항목: 행사날짜 없는 예약주문이 들어오면 업체가 고객에게 다시 물어야 한다.
      //
      // ⚠ 이 검사는 결제 **전**이라 막아도 안전하다. 결제 후에는 절대 막지 않는다
      //   (아래 차감·저장이 실패해도 주문은 그대로 만든다).
      {
        const 줄 = Array.isArray(products) ? products : [products];
        try {
          // 필수 옵션. 목록 카드의 '장바구니담기' 는 선택 정보 없이 담기므로
          // 프론트 검사가 '모르면 통과' 로 빠져나간다 — 여기가 마지막 관문이다.
          const 빠진옵션 = await findMissingRequiredOption(줄);
          if (빠진옵션) return response(req, res, -100, `${빠진옵션} 을(를) 선택해 주세요.`, false);
          // 한정판(1인당 구매수). 제한이 걸린 상품은 회원만 살 수 있다.
          const 한정 = await checkPurchaseLimit(user_id, 줄);
          if (!한정.ok) return response(req, res, -100, 한정.message, false);
          const 부족 = await checkStock(줄);
          if (!부족.ok) return response(req, res, -100, 부족.message, false);
          const 빠진항목 = await findMissingOrderFormField(줄);
          if (빠진항목) return response(req, res, -100, `${빠진항목}을(를) 입력해 주세요.`, false);
        } catch (e) {
          // 새 테이블이 아직 없으면(마이그레이션 전) 검사를 건너뛴다 — 결제를 막지 않는다.
          logger.error('주문 사전검사 실패(무시하고 진행): ' + (e?.sqlMessage || e?.message || e));
        }
      }

      obj = encForSave('transactions', obj); // PII(주문자명·전화·주소) 암호화 + blind-index(이름·전화)
      let result = await insertQuery(`${table_name}`, obj);

      //console.log(result)

      trans_id = result?.insertId;

      // 사용한 포인트를 원장에 차감으로 남긴다.
      //
      // 예전엔 transactions.use_point 컬럼에 '기록만' 하고 points 에 음수 행을 넣지 않았다.
      // 보유 포인트는 SUM(points.point) 로 계산되므로 잔액이 전혀 줄지 않았고,
      // 같은 포인트로 몇 번이든 할인받을 수 있었다(가맹점은 그만큼 매출 손실).
      // type 10 = '구매에 사용한 포인트 감소건'.
      if (use_point > 0 && user_id > 0 && trans_id > 0) {
        await insertQuery(`points`, {
          brand_id,
          user_id,
          sender_id: 0,
          point: -Math.abs(parseInt(use_point) || 0),
          type: 10,
          trans_id,
        });
      }

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
      // 주문 추가 입력항목(행사일·행사장소 등). 상품상세에서 받아 장바구니 줄에 실려 온다.
      // 줄 순서를 transaction_orders 와 맞추기 위해 같은 products 배열을 그대로 넘긴다.
      //
      // 실패해도 결제를 막지 않는다 — 여기서 던지면 카드는 승인됐는데 주문이 안 만들어지는
      // 상황이 된다. 값이 빠진 주문은 업체가 고객에게 물어보면 되지만, 결제 실패는 되돌리기 어렵다.
      try {
        await saveOrderFormValues(trans_id, products);
      } catch (e) {
        logger.error('order_form save failed: ' + (e?.message ?? e));
      }
      // 재고 차감. 원장(product_stock_moves)의 UNIQUE 가 중복 차감을 막으므로
      // 결제 콜백이 두 번 들어와도 재고는 한 번만 줄어든다.
      let stockOk = true;
      try {
        stockOk = await decreaseStock(trans_id, products);
      } catch (e) {
        logger.error('재고 차감 실패(주문은 그대로 진행): ' + (e?.sqlMessage || e?.message || e));
      }
      if (stockOk === false) {
        // 마지막 재고를 다른 주문이 먼저 가져간 경우(초과 판매). 아직 결제(PG) 전이라 여기서 멈추면 돈은 안 움직인다.
        // 예전엔 로그만 남기고 주문·결제를 그대로 진행해 재고가 음수/초과판매가 됐다.
        await 결제실패정리(trans_id);
        return response(req, res, -100, "재고가 부족하여 주문할 수 없습니다. 수량을 확인해 주세요.", false);
      }
      if (trx_method == 1) {
        let result = await axios.post(
          `${process.env.NOTI_URL}/api/v2/pay/hand`,
          { ...req.body, temp: trans_id }
        );
        if (result?.data?.result_cd != "0000") {
          return 결제실패응답(trans_id, req, res, -100, result?.data?.result_msg, false);
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
          return 결제실패응답(trans_id, req, res, -100, result?.data?.resultMsg, false);
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
          return 결제실패응답(trans_id, req, res, -100, result?.data?.resultMsg, false);
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
          return 결제실패응답(trans_id, req, res, -100, result?.data?.result_msg, false);
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
            logger.error(`[payletter] 결제모듈 설정 누락 — brand_id=${brand_id} (관리자 결제모듈에 MID=client_id, 결제키=API키 입력 필요)`);
            return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
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
            // 이 자리에는 원래 로그가 없었다. 사유가 손님 화면으로만 갔고 어디에도 안 남아서,
            // '결제가 안 된다'는 문의를 받아도 무엇 때문인지 확인할 방법이 없었다.
            // ⚠ 응답 본문에 협력사 내부 오류가 실려 오므로 로그에만 남긴다(포스페이와 같은 이유).
            logger.error(`[payletter] 결제요청 URL 없음 — trans_id=${trans_id} resp=${JSON.stringify(pl)}`);
            return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
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
          logger.error(errText(e));
          return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
        }
      }

      // ─────────────────────────────
      // 포스페이(Forspay External API, direct_pg_ui) 인증결제
      //  - 체크아웃 세션 생성 → PG 결제창 URL(launch_page_url) 반환
      //  - 확정은 return/callback 에서 거래조회(GET /transactions)로 재검증
      // ─────────────────────────────
      if (trx_method == 41) {
        // 실패했을 때 '무엇을 보냈는지' 를 남기려면 catch 에서도 값이 보여야 한다.
        // try 안의 const 는 catch 에서 안 보인다(블록 스코프) — 여기 담아 두고 catch 는 이것만 읽는다.
        const 진단 = { ord_num: '(미정)', method: '(미정)', pg_method_id: '-', route: '-', provider: '(자동)', app_key_len: 0 };
        try {
          const creds = await getForspayCreds(brand_id);
          진단.app_key_len = String(creds?.app_key ?? '').length;
          if (!creds?.app_key) {
            logger.error(`[forspay] 결제모듈 설정 누락 — brand_id=${brand_id} (결제모듈 '결제키'에 App key 입력 필요)`);
            return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
          }
          if (!FORSPAY_API_BASE || FORSPAY_API_BASE.includes('REPLACE')) {
            logger.error(`[forspay] Base URL 미설정 — brand_id=${brand_id} (서버 .env 의 FORSPAY_API_BASE 필요)`);
            return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
          }
          // 구매자가 고른 결제수단 → 포스페이 파라미터 매핑 (미지정 시 신용카드)
          const fsMethod = getForspayMethod(pay_method) || getForspayMethod('card');
          진단.method = fsMethod?.key ?? '(없음)';
          진단.pg_method_id = fsMethod?.pg_method_id ?? '-';
          진단.route = fsMethod?.route ?? '-';
          if (fsMethod?.pending) {
            logger.error(`[forspay] 준비 중인 결제수단 요청 — brand_id=${brand_id} method=${fsMethod.label}`);
            return 결제실패응답(trans_id, req, res, -100, '아직 준비 중인 결제수단입니다. 다른 방법으로 결제해 주세요.', false);
          }
          // PG(페이레터/나이스) 라우팅: 수단별 지정 → 모듈 기본(MID) → 미지정 시 포스페이 자동
          const routedProvider = creds?.method_provider?.[fsMethod.key];
          const fsProvider = (routedProvider !== undefined && routedProvider !== null && String(routedProvider).trim() !== '')
            ? routedProvider
            : creds.pg_provider_id;
          진단.provider = fsProvider ?? '(자동)';
          const front_url = (req.body.front_url || "").toString().trim();
          const backBase = `${req.protocol}://${req.get('host')}`;
          const order_no = String(ord_num || `FS${trans_id}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
          진단.ord_num = order_no;
          const return_url = `${backBase}/api/pays/forspay/return?front=${encodeURIComponent(front_url)}&trans=${trans_id}&ord=${encodeURIComponent(order_no)}`;

          // 결제창 방식: 'forspay_ui'(포스페이 자체 결제 팝업 + FORSPAY_READY/RESULT 메시징) 또는
          // 'direct_pg_ui'(PG 호스팅 페이지 URL). 결제 핵심이라 env 플래그로 켜고 끈다 —
          // 기본은 direct_pg_ui 라 배포만으로 동작이 바뀌지 않는다. 테스트 후 FORSPAY_CHECKOUT_MODE=forspay_ui 로 활성화.
          // 두 방식 모두 정산의 진실원은 noti_url 웹훅(forspayCallback) — 그건 공통으로 이미 처리된다.
          const requested_mode = (process.env.FORSPAY_CHECKOUT_MODE === 'forspay_ui') ? 'forspay_ui' : 'direct_pg_ui';

          const session = await forspayCreateSession({
            app_key: creds.app_key,
            amount,
            item_name: item_name || '상품',
            buyer_name,
            ord_num: order_no,
            pg_method_id: fsMethod.pg_method_id,
            route: fsMethod.route,
            foreign_method: fsMethod.foreign_method,
            pg_provider_id: fsProvider,    // 비어있으면 포스페이 자동 라우팅
            return_url,
            user_agent: req.body.user_agent || 'WP',
            buyer_phone,
            buyer_email: req.body.buyer_email,
            billaddrcity: req.body.billaddrcity,
            checkout_mode: requested_mode,
          });

          // return/webhook 매칭용 ord_num을 거래에 동기화(정규화 값). (두 방식 공통)
          await updateQuery(table_name, { ord_num: order_no }, trans_id);

          // ⚠ 포스페이가 '실제로 준' 방식으로 분기한다(요청 모드가 아니라).
          //   forspay_ui 를 요청해도 계정/수단이 미지원이면 포스페이가 direct_pg_ui(launch_page_url)로 강등해 준다
          //   (2026-09-01 실측: card/pg_method_id=0 은 forspay_ui 요청해도 direct_pg_ui 로 내려옴).
          //   그래서 embed.popup_url 이 오면 forspay_ui, 아니면 launch_page_url(direct_pg_ui)로 응답한다.
          if (session?.embed?.popup_url) {
            // 포스페이 자체 결제 팝업. 프론트가 embed.popup_url 을 window.open,
            // 팝업 FORSPAY_READY 수신 뒤 embed.init_payload 를 postMessage(문서 규격).
            return response(req, res, 100, "success", {
              id: trans_id,
              checkout_mode: 'forspay_ui',
              order_code: session?.order_code,
              popup_url: session.embed.popup_url,
              init_payload: session.embed.init_payload,
            });
          }

          // direct_pg_ui: PG 결제창 URL
          let launch_page_url = session?.launch_page_url;
          if (!launch_page_url && session?.order_code) {
            // create가 launch_page_url을 안 준 경우 /pay 로 조회
            const launched = await forspayGetLaunch({ app_key: creds.app_key, order_code: session.order_code, return_url, user_agent: req.body.user_agent || 'WP' });
            launch_page_url = launched?.launch_page_url;
          }
          if (!launch_page_url) {
            // 포스페이가 2xx 로 오류바디(예: {"error":"No payment module configured..."})를 줄 수 있다.
            // HTTP 상태만 보면 성공이라 여기서 걸러야 한다. 사유는 **로그에만** 남긴다 —
            // 손님에게는 결제시작실패문구 를 보낸다(그 이유는 정의부 주석 참고).
            logger.error(`[forspay] launch_page_url 없음 — resp=${JSON.stringify(session)}`);
            return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
          }

          return response(req, res, 100, "success", {
            id: trans_id,
            checkout_mode: 'direct_pg_ui',
            order_code: session?.order_code,
            launch_page_url,
          });
        } catch (e) {
          // 포스페이가 990 '시스템 에러입니다' 만 돌려주는 일이 있다(2026-08-21 mbc01).
          // 그 한 줄만 남기면 우리가 무엇을 보냈는지 알 수 없어 PG 에 문의할 근거가 없다.
          // 보낸 값을 함께 남긴다 — App key 는 절대 남기지 않는다(길이만).
          logger.error('[forspay] 세션 생성 실패'
            + ` brand_id=${brand_id} trans_id=${trans_id} ord_num=${진단.ord_num}`
            + ` amount=${amount} method=${진단.method} pg_method_id=${진단.pg_method_id}`
            + ` route=${진단.route} pg_provider_id=${진단.provider}`
            + ` app_key_len=${진단.app_key_len}`
            + ` ${errText(e)}`);
          return 결제실패응답(trans_id, req, res, -100, 결제시작실패문구, false);
        }
      }

      return response(req, res, 100, "success", {
        id: trans_id,
      });
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
      // 예외로 빠져나갈 때도 잡아둔 재고를 놓아준다.
      // 거래가 안 만들어졌으면 trans_id 가 없고, 그때는 원장에도 아무것도 없어 무해하다.
      try { if (trans_id) await 결제실패정리(trans_id); } catch (e) { /* 이미 로그를 남긴다 */ }
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
      if (!pay_data) {
        return response(req, res, -100, "거래를 찾을 수 없습니다.", false);
      }
      // ── 콜백 검증 ──────────────────────────────────────────────────────────────
      // 이 엔드포인트는 PG(페이베리/수기) 서버가 서버-서버로 부르는 결제완료·취소 통지라 인증 쿠키가 없다.
      // 예전엔 temp(거래 id)만 알면 누구나 '결제완료'로 바꾸고 body 의 amount 로 포인트까지 적립시킬 수 있었다.
      //  ① mid 가 그 브랜드·결제수단 결제모듈의 mid 와 일치해야 한다(PG 가 아니면 모르는 값).
      //  ② 승인 통지는 결제대기(trx_status=0) 인 PG 결제건에만 — 무통장(10/11)은 사람이 확정한다.
      //  ③ 금액은 body 가 아니라 DB 의 주문금액을 쓴다.
      // (최근 60일 거래가 전부 포스페이(41)라 이 경로는 사실상 레거시다 — 정상 통지가 막히면 로그로 드러난다)
      const pgModule = (await readPool.query(
        `SELECT mid FROM payment_modules WHERE brand_id=? AND trx_type=? ORDER BY id DESC LIMIT 1`,
        [pay_data?.brand_id, pay_data?.trx_method]))[0][0];
      if (!pgModule?.mid || String(mid ?? '') !== String(pgModule.mid)) {
        logger.error(`[pays/result] mid 불일치 — 거부 (trans=${pay_data?.id}, brand=${pay_data?.brand_id}, method=${pay_data?.trx_method})`);
        return response(req, res, -100, "잘못된 접근입니다.", false);
      }
      if (!is_cancel) {
        if (Number(pay_data?.trx_status) !== 0 || [10, 11].includes(Number(pay_data?.trx_method))) {
          return response(req, res, -100, "처리할 수 없는 거래 상태입니다.", false);
        }
        amount = pay_data?.amount; // 적립·기록 모두 DB 금액 기준
      } else if (Number(pay_data?.is_cancel_trans) === 1) {
        return response(req, res, 100, "success", {}); // 이미 취소 반영됨(멱등)
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
        // await 가 빠져 있었다 — 여기서 DB 오류가 나면 잡히지 않는 rejection 으로 프로세스가 죽는다.
        let update_pay_data = await updateQuery(table_name, {//이미 결제된건 취소로 판별
          is_cancel_trans: 1,
        }, pay_data?.id);
        // 재고 복구 · 적립 포인트 회수 · 사용 포인트 환불.
        //
        // 예전엔 이 자리에 포인트 처리가 손으로 두 덩어리 적혀 있었다(적립 회수 + 사용 복원).
        // 다른 PG 경로에는 그게 없어서, **같은 취소인데 결제사에 따라 포인트가 달리 움직였다**.
        // 이제 전부 applyCancelEffects 하나를 쓴다 — 여기 남겨두면 이중으로 들어간다.
        //
        // 회수 금액도 요율(point_rate)로 다시 계산하지 않고 **원장에 실제로 적립된 만큼**을 되돌린다.
        // 요율은 나중에 바뀔 수 있어서, 다시 계산하면 적립된 적 없는 금액을 회수하게 된다.
        await applyCancelEffects(pay_data?.id);
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
        // 원자적 확정: 결제대기(<>5) 인 행만 5 로 바꾸고, 실제로 바뀐 경우에만 적립한다(통지 중복·경합 시 이중 적립 방지).
        const [markRes] = await writePool.query(
          `UPDATE ${table_name} SET trx_id=?, appr_num=?, acquirer=?, issuer=?, card_num=?, trx_dt=?, trx_tm=?, trx_status=5
            WHERE id=? AND trx_status<>5`,
          [obj.trx_id ?? null, obj.appr_num ?? null, obj.acquirer ?? null, obj.issuer ?? null, obj.card_num ?? null, obj.trx_dt, obj.trx_tm, id]
        );
        if (!markRes?.affectedRows) {
          return response(req, res, 100, "success", {}); // 이미 확정됨(멱등)
        }
        // 적립은 정책 함수 한 곳에서 센다 — 여기서 직접 곱하면 적립률 상한(100%)이 안 걸린다.
        const 쌓을것 = 적립예정({ dns: dns_data, 결제금액: amount });
        if (쌓을것 > 0) {
          let result2 = await insertQuery(`points`, {
            brand_id: dns_data?.id,
            user_id: pay_data?.user_id,
            sender_id: 0,
            point: 쌓을것,
            type: 0,
            trans_id: id,
          });
        }
      }

      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
  cancel: async (req, res, next) => {
    //결제취소
    try {

      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      // 인가가 전혀 없어 주문 id 만 알면 로그인 없이 남의 결제를 취소할 수 있었다.
      // 결제 취소는 운영자 이상만, 자기 브랜드 주문에 대해서만 가능하다.
      if (!decode_user || decode_user?.level < 10) {
        return lowLevelException(req, res);
      }
      const { trx_id, pay_key, amount, mid, tid, canAmt, canMsg, partCanFlg, encData, ediDate, id } = req.body;
      // ⚠ id 는 필수다.
      //   예전 형태는 `if (id) { ...소유 확인... }` 이라, id 만 빼고 호출하면 소유 검증이
      //   통째로 건너뛰어졌다. 그런데 아래 기본 취소 흐름(fintree/weroute/payvery)은 id 없이도
      //   body 의 trx_id·tid·pay_key 만으로 PG 에 취소를 걸어버리므로, 검증만 사라지고 취소는 그대로
      //   나갔다 — 다른 브랜드 거래도 취소할 수 있었다.
      //   id 가 없으면 애초에 취소 대상을 특정할 수 없으니 여기서 끊고, 검증은 무조건 통과시킨다.
      //   (프론트 호출부 pages/manager/orders/trx/[type].js·trx-cancel/[type].js 는 항상 id 를 보낸다)
      if (!(parseInt(id) > 0)) {
        return response(req, res, -100, "취소할 주문을 특정할 수 없습니다.", false);
      }
      const trx_rows = await readPool.query(`SELECT id, brand_id, trx_method FROM transactions WHERE id=? LIMIT 1`, [id]);
      const trx_row = trx_rows[0][0];
      if (!trx_row || !canWriteBrand(decode_user, trx_row?.brand_id)) {
        return lowLevelException(req, res);
      }
      let { pg } = req.body;
      // 프론트가 pg를 안 실어보내도, 거래의 trx_method로 결제사를 판별해 안전하게 라우팅
      // (40=페이레터, 41=포스페이. 그 외는 기존 기본 취소 흐름 유지)
      if (!pg) {
        if (trx_row?.trx_method == 40) pg = 'payletter';
        else if (trx_row?.trx_method == 41) pg = 'forspay';
      }
      let files = settingFiles(req.files);
      let obj = {};
      const formData = qs.stringify({ trx_id, pay_key, amount, mid, tid, canAmt, canMsg, partCanFlg, encData, ediDate });

      // 포스페이 취소: 거래의 ord_num으로 취소 API 호출
      if (pg === 'forspay') {
        let trx = await readPool.query(`SELECT * FROM transactions WHERE id=?`, [id]);
        trx = trx[0][0];
        if (!trx) {
          return response(req, res, -100, "거래를 찾을 수 없습니다.", false);
        }
        const creds = await getForspayCreds(trx.brand_id);
        if (!creds?.app_key) {
          return response(req, res, -100, "포스페이 결제모듈 설정이 없습니다.", false);
        }
        try {
          await forspayCancelTransaction({ app_key: creds.app_key, ord_num: trx.ord_num, amount });
          await markCanceled(id);
          return response(req, res, 100, "success", {});
        } catch (e) {
          logger.error(errText(e));
          return response(req, res, -200, e?.response?.data?.message || "포스페이 취소 실패", false);
        }
      }

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
          await markCanceled(id);
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
          await markCanceled(id, { column: 'is_cancel' });
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
          await markCanceled(id);
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
          // 예전엔 PG 에만 취소를 걸고 DB 를 전혀 안 바꿨다 —
          // 화면에는 정상 주문으로 남고 매출 집계도 취소분을 그대로 안고 갔다.
          await markCanceled(id);
          return response(req, res, 100, "success", {});
        } else {
          return response(req, res, -200, payvery_cancel?.result_msg, false);
        }
      }
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
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
  // 부분취소 — 남은 수량 조회.
  // 관리자 화면이 '이 줄은 몇 개까지 취소 가능한지' 를 그리는 데 쓴다.
  cancelState: async (req, res, next) => {
    try {
      const decode_user = checkLevel(req.cookies.token, 0, res);
      if (!decode_user || decode_user?.level < 10) return lowLevelException(req, res);
      const id = parseInt(req.params?.id) || 0;
      if (!id) return response(req, res, -100, "주문을 특정할 수 없습니다.", false);
      const state = await getCancelState(id);
      if (!state) return response(req, res, -100, "주문을 찾을 수 없습니다.", false);
      // 남의 브랜드 주문을 들여다볼 수 없다.
      if (!canWriteBrand(decode_user, state.trx?.brand_id)) return lowLevelException(req, res);
      return response(req, res, 100, "success", {
        cancelable: state.cancelable,
        all_canceled: state.all_canceled,
        // 고객이 낸 취소요청 내역. 화면이 수량을 미리 채운다.
        has_request: state.has_request,
        request_reason: state.request_reason,
        // 부분취소를 지원하는 결제수단인지. 아니면 화면이 버튼을 감춘다.
        partial_supported: PARTIAL_CANCEL_METHODS.includes(Number(state.trx?.trx_method)),
        lines: state.lines.map((l) => ({
          order_id: l.id, product_id: l.product_id, order_name: l.order_name,
          order_count: l.order_count, cancel_count: l.cancel_count,
          remain_count: l.remain_count, unit_price: l.unit_price, remain_amount: l.remain_amount,
          requested_count: l.requested_count,
        })),
      });
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
      return response(req, res, -200, "서버 에러 발생", false);
    }
  },

  // 부분취소 실행.
  //
  // 화면은 **수량만** 보낸다. 금액은 서버가 transaction_orders 를 다시 읽어 계산한다 —
  // 화면이 보낸 금액을 믿으면 10만원 주문에 100만원 환불을 걸 수 있다.
  cancelPartial: async (req, res, next) => {
    try {
      const decode_user = checkLevel(req.cookies.token, 0, res);
      if (!decode_user || decode_user?.level < 10) return lowLevelException(req, res);
      const id = parseInt(req.params?.id) || 0;
      if (!id) return response(req, res, -100, "취소할 주문을 특정할 수 없습니다.", false);
      const { items, reason, idem_key } = req.body;

      const state = await getCancelState(id);
      if (!state) return response(req, res, -100, "주문을 찾을 수 없습니다.", false);
      if (!canWriteBrand(decode_user, state.trx?.brand_id)) return lowLevelException(req, res);

      const method = Number(state.trx?.trx_method);
      if (!PARTIAL_CANCEL_METHODS.includes(method)) {
        // 정직하게 막는다. 지원 안 하는 PG 로 부분취소를 시도하면 전액이 취소돼 버린다.
        return response(req, res, -100,
          "이 결제수단은 부분취소를 지원하지 않습니다. 전체 취소만 가능합니다.", false);
      }

      const result = await cancelLines(id, {
        items, reason, idem_key,
        user_id: decode_user?.id ?? null,
        // PG 호출은 여기서 주입한다. cancel.js 는 PG 를 모른다.
        pgCancel: async ({ trx, amount }) => {
          const creds = await getForspayCreds(trx.brand_id);
          if (!creds?.app_key) throw new Error("포스페이 결제모듈 설정이 없습니다.");
          return await forspayCancelTransaction({ app_key: creds.app_key, ord_num: trx.ord_num, amount });
        },
      });
      if (!result?.ok) return response(req, res, -100, result?.message ?? "취소에 실패했습니다.", false);
      return response(req, res, 100, "success", result);
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
      return response(req, res, -200, "서버 에러 발생", false);
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
      logger.error(errText(err));
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
      logger.error(errText(err));
      return res.redirect(302, `${resultBase}?result_cd=9999`);
    }
  },
  forspayReturn: async (req, res, next) => {
    // 포스페이 결제창 종료 후 브라우저 도달 URL. 거래조회로 재검증 후 프론트 결과페이지로 리다이렉트.
    const data = { ...req.query, ...req.body };
    let front = (data.front || "").toString().trim();
    if (front && !/^https?:\/\//.test(front)) front = `https://${front}`;
    const resultBase = `${front}/shop/auth/pay-result`;
    try {
      const transId = data.trans;
      const ord = data.ord || data.ord_num;
      const trx = transId
        ? (await readPool.query(`SELECT * FROM transactions WHERE id=?`, [transId]))[0][0]
        : (await readPool.query(`SELECT * FROM transactions WHERE ord_num=? ORDER BY id DESC LIMIT 1`, [ord]))[0][0];
      const creds = trx ? await getForspayCreds(trx.brand_id) : null;
      let txn = {};
      try { txn = await forspayGetTransaction({ app_key: creds?.app_key, ord_num: ord, cxl_seq: 0 }); } catch (e) { txn = {}; }
      if (txn?.status === 'approved') {
        await settleForspayTransaction(trx?.id, txn);
        const q = new URLSearchParams({
          result_cd: '0000',
          ord_num: (ord || '').toString(),
          buyer_name: (txn.buyer_name || '').toString(),
          trx_dttm: (txn.trx_dttm || '').toString(),
        }).toString();
        return res.redirect(302, `${resultBase}?${q}`);
      }
      return res.redirect(302, `${resultBase}?result_cd=9999`);
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
      return res.redirect(302, `${resultBase}?result_cd=9999`);
    }
  },
  forspayCallback: async (req, res, next) => {
    // 포스페이 웹훅(noti_url). 승인/취소 통지 — 공식 기록. 응답은 200.
    try {
      const body = { ...req.query, ...req.body };
      // [진단·임시] 포스페이 웹훅 payload 에 할부 필드가 실리는지 확인용 — 키 이름만 기록(값 없음). 확인 후 제거.
      try { logger.info('[forspay-diag] webhook body keys: ' + Object.keys(body || {}).join(',')); } catch (e) { /* 진단 로그는 결제를 절대 막지 않는다 */ }
      const ord = body.ord_num;
      const trx = (await readPool.query(`SELECT * FROM transactions WHERE ord_num=? ORDER BY id DESC LIMIT 1`, [ord]))[0][0];
      if (!trx) return res.status(200).send({ ok: true });
      const creds = await getForspayCreds(trx.brand_id);
      // sign_key 설정 시 서명 검증(불일치면 무시)
      if (creds?.sign_key && body.signature) {
        const ok = forspayVerifySig({ sign_key: creds.sign_key, timestamp: body.timestamp, mid: body.mid, signature: body.signature });
        if (!ok) { logger.error('forspay webhook signature mismatch'); return res.status(200).send({ ok: false }); }
      }
      if (String(body.is_cancel) === '1') {
        // 웹훅으로 들어온 취소도 관리자 취소와 똑같이 처리한다.
        // (부수처리는 멱등이라 관리자 취소와 웹훅이 겹쳐도 두 번 움직이지 않는다)
        await markCanceled(trx.id);
        return res.status(200).send({ ok: true });
      }
      // 승인: 거래조회로 재확인 후 확정(멱등)
      let txn = {};
      try { txn = await forspayGetTransaction({ app_key: creds?.app_key, ord_num: ord, cxl_seq: 0 }); } catch (e) { txn = {}; }
      if (txn?.status === 'approved' || String(body.result_cd) === '0000') {
        await settleForspayTransaction(trx.id, { ...body, ...txn });
      }
      return res.status(200).send({ ok: true });
    } catch (err) {
      console.log(err);
      logger.error(errText(err));
      return res.status(200).send({ ok: false });
    }
  },
  forspayConfirm: async (req, res, next) => {
    // 결제결과 페이지에서 호출하는 '거래조회 기반 서버 확정'.
    //
    // 왜 필요한가:
    //   문서상 브라우저 복귀(return_url·FORSPAY_RESULT)는 UX용이라 정산의 근거가 못 된다.
    //   특히 PC 팝업 흐름은 FORSPAY_RESULT 수신 후 프론트 결과페이지로 바로 가서
    //   backend /forspay/return(정산)을 건너뛴다 → 승인됐는데 결제대기로 남는다.
    //   결과페이지가 이 API 로 거래조회해 approved 면 정산(멱등·원자적)하여 그 구멍을 메운다.
    //   (모바일 리다이렉트는 이미 return 에서 정산되므로 여기선 멱등 no-op)
    //
    // 응답 규약: '확정 시도 자체'는 항상 성공(result>0)으로 돌려주고, 실제 정산 여부는
    //   data.settled 로 알린다. 그래야 프론트가 불필요한 에러 토스트를 안 띄우고, 실패해도
    //   결과페이지가 URL 파라미터 기준으로 정상 표시된다. 개인정보는 반환하지 않는다.
    try {
      const ord = (req.body?.ord_num ?? req.query?.ord_num ?? '').toString();
      const fail = (extra = {}) => response(req, res, 100, 'success', { settled: false, result_cd: '9999', ...extra });
      if (!ord) return fail();
      const trx = (await readPool.query(`SELECT * FROM transactions WHERE ord_num=? ORDER BY id DESC LIMIT 1`, [ord]))[0][0];
      if (!trx || Number(trx.trx_method) !== 41) return fail(); // 없거나 포스페이 아님 → 손대지 않음
      if (Number(trx.is_cancel_trans) === 1) return fail();      // 취소된 건은 정산 안 함
      if (Number(trx.trx_status) === 5) return response(req, res, 100, 'success', { settled: true, result_cd: '0000' }); // 이미 정산됨
      const creds = await getForspayCreds(trx.brand_id);
      let txn = {};
      try { txn = await forspayGetTransaction({ app_key: creds?.app_key, ord_num: ord, cxl_seq: 0, timeout: 8000 }); } catch (e) { txn = {}; }
      if (txn?.status === 'approved') {
        await settleForspayTransaction(trx.id, txn); // 멱등·원자적
        return response(req, res, 100, 'success', { settled: true, result_cd: '0000' });
      }
      return fail(); // 아직 승인 안 됨 / 조회 실패 → 정산 보류(웹훅·재방문·대사가 나중에)
    } catch (err) {
      logger.error(errText(err));
      return response(req, res, 100, 'success', { settled: false, result_cd: '9999' });
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
  // 적립은 정책 함수 한 곳에서 센다(적립률 상한·음수 방어가 거기 있다).
  let point = 적립예정({ dns: { setting_obj: setting }, 결제금액: trx.amount });
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

// 브랜드별 포스페이 인증정보를 payment_modules(trx_type=41)에서 조회
//  결제키(pay_key)=App key, MID=pg_provider_id(기본), TID=sign_key(선택)
//  forspay_config(JSON, 선택)=수단별 PG 라우팅. 컬럼이 없어도 안전하도록 SELECT *.
async function getForspayCreds(brand_id) {
  let rows = await readPool.query(
    `SELECT * FROM payment_modules WHERE brand_id=? AND trx_type=41 ORDER BY id DESC LIMIT 1`,
    [brand_id]
  );
  let m = rows[0][0];
  if (!m) return null;
  // 수단별 PG 지정값(provider) 파싱: { card:1, wechat:4, ... }
  let method_provider = {};
  try {
    const cfg = m.forspay_config ? JSON.parse(m.forspay_config) : {};
    const methods = cfg?.methods || {};
    for (const k of Object.keys(methods)) {
      const p = methods[k]?.provider;
      if (p !== undefined && p !== null && String(p).trim() !== '') method_provider[k] = p;
    }
  } catch (e) { method_provider = {}; }
  return { app_key: m.pay_key, pg_provider_id: m.mid, sign_key: m.tid, method_provider };
}

// 포스페이 거래 확정(멱등): 거래조회로 승인 확인된 건을 결제완료 처리 + 포인트 적립
async function settleForspayTransaction(transId, data = {}) {
  if (!transId) return false;
  let rows = await readPool.query(`SELECT * FROM transactions WHERE id=?`, [transId]);
  let trx = rows[0][0];
  if (!trx) return false;
  // [진단·임시] 포스페이 응답(거래조회 txn 또는 웹훅 body 병합)에 할부 필드가 오는지 확인용.
  // 값이 아니라 '키 이름'만 기록한다(개인정보 노출 없음). 필드명 확인 후 이 줄을 제거할 것.
  try { logger.info('[forspay-diag] settle data keys: ' + Object.keys(data || {}).join(',')); } catch (e) { /* 진단 로그는 결제를 절대 막지 않는다 */ }
  if (trx.trx_status == 5) {
    // 이미 확정됨(중복 return/webhook 방지). 단, 카드번호는 거래조회 응답엔 없고 웹훅에만 있으므로
    // 리턴 경로가 먼저 확정해 카드번호가 비어있으면, 뒤늦게 온 웹훅 데이터로 1회 보강한다.
    if (!trx.card_num && data.card_num) {
      await updateQuery('transactions', { card_num: String(data.card_num) }, transId);
    }
    return true;
  }

  let trx_dttm = (data.trx_dttm || '').toString();
  let trx_dt = trx_dttm.includes(' ') ? trx_dttm.split(' ')[0] : trx_dttm;
  let trx_tm = trx_dttm.includes(' ') ? trx_dttm.split(' ')[1] : '';

  // 원자적 정산: trx_status<>5 인 행만 5로 바꾼다. '실제로 우리가 바꾼 행'일 때만 적립한다.
  // 정산을 부르는 경로가 셋(브라우저 return · noti 웹훅 · 결과페이지 confirm)이라 동시에 와도
  // 딱 한 번만 정산·적립되게 하는 방어다. (위 fast-path 는 읽고-쓰기라 경합에 새므로 여기서 못박는다)
  const [settleRes] = await writePool.query(
    `UPDATE transactions
        SET trx_id=?, appr_num=?, card_num=?, trx_dt=?, trx_tm=?, trx_status=5
      WHERE id=? AND trx_status<>5`,
    [
      data.trx_id ?? trx.trx_id,
      (data.appr_num ?? '').toString(),
      (data.card_num ?? '').toString(),
      trx_dt,
      trx_tm,
      transId,
    ]
  );
  if (!settleRes?.affectedRows) {
    // 그 사이 다른 경로가 먼저 정산함 → 중복 적립을 막고 여기서 끝낸다.
    return true;
  }

  // 포인트 적립 (우리가 방금 정산을 확정한 경우에만 — 위 affectedRows 로 1회 보장)
  let brandRows = await readPool.query(`SELECT * FROM brands WHERE id=?`, [trx.brand_id]);
  let brand = brandRows[0][0];
  let setting = JSON.parse(brand?.setting_obj ?? '{}');
  // 적립은 정책 함수 한 곳에서 센다(적립률 상한·음수 방어가 거기 있다).
  let point = 적립예정({ dns: { setting_obj: setting }, 결제금액: trx.amount });
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