'use strict';
import { readPool } from "../config/db-pool.js";

// 셀러 공급가(agent_price) — 본사 판매가에 영업자·셀러 수수료를 얹은 값. 셀러는 이 값 이상으로만 판다.
//
//   본사 판매가 → 영업자 수수료(oper_trx_fee) → 셀러 수수료(seller_trx_fee) → 천원 단위 반올림
//   · 수수료 type 0 = 비율(0.1 = 10%), type 1 = 고정금액(원)
//   · 원 단위 밑을 버린 뒤 천원 단위로 반올림한다(500원 이상 올림) — 예전 계산 그대로.
//
// 예전엔 이 계산이 프론트·일괄등록·수수료 변경 3곳에 따로 있었고, 수수료를 **로그인 토큰**에서 읽었다.
//   · 영업자가 셀러 대신 일괄등록하면 영업자 본인의 수수료로 계산됐다.
//   · 토큰은 로그인할 때 찍혀서, 그 뒤에 바뀐 수수료가 반영되지 않았다.
//   · 단건 등록은 화면이 계산해 보낸 값을 서버가 그대로 저장했다(낮춰 보내면 본사 몫이 깎인다).
//   실제로 thegrazia seller3 의 2,964건이 옛 수수료(20%)로 남아 있었다(2026-10-12 점검, 지금 5%).
// → 수수료는 늘 DB 의 셀러 행과 그 영업자(oper_id) 행에서 읽고, 계산은 여기 하나로 한다.
export const calcAgentPrice = (basePrice, fees) => {
    const base = Number(basePrice) || 0;
    if (!(base > 0)) return 0;
    const operFee = Number(fees?.oper_trx_fee) || 0;
    const sellerFee = Number(fees?.seller_trx_fee) || 0;
    const afterOper = Number(fees?.oper_trx_fee_type) == 1 ? base + operFee : base * (1 + operFee);
    const afterSeller = Number(fees?.seller_trx_fee_type) == 1 ? afterOper + sellerFee : afterOper * (1 + sellerFee);
    return Math.round(Math.floor(Number(afterSeller.toFixed(6))) / 1000) * 1000;
};

// 셀러(level 10)와 그 영업자의 현재 수수료. 셀러가 아니면 null.
export const loadSellerFees = async (seller_id) => {
    if (!(Number(seller_id) > 0)) return null;
    const [[row]] = await readPool.query(
        `SELECT s.id, s.brand_id, s.seller_trx_fee, s.seller_trx_fee_type,
                o.oper_trx_fee, o.oper_trx_fee_type
           FROM users s LEFT JOIN users o ON o.id = s.oper_id
          WHERE s.id=? AND s.level=10 AND s.is_delete=0`, [Number(seller_id)]);
    return row ?? null;
};
