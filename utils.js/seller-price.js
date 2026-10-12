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

// ── 셀러상품 공급가 다시 계산(마진 유지) ──────────────────────────────────────────
// 공급가가 바뀌면 셀러 판매가 = 새 공급가 + 기존 마진(판매가 − 옛 공급가). 공급가 밑으로는 내려가지 않는다.
// 셀러 수수료를 바꿀 때 쓰던 규칙(seller.controller)과 같다 — 셀러가 정한 마진은 그대로, 원가가 따라 움직인다.
//
// 예전엔 셀러·영업자 '수수료' 를 바꿀 때만 다시 계산했다. 그래서
//   · 본사가 상품 판매가를 올리면 셀러 판매가가 그대로라 원가 아래로 팔 수 있었고(정산 셀러 몫 마이너스),
//   · 셀러를 수수료가 다른 영업자 밑으로 옮기면 공급가가 옛 값으로 남았다(thegrazia seller3 와 같은 상태).
const 새가격 = (row, base, fees) => {
    const agent = calcAgentPrice(base, fees);
    const margin = Number(row.seller_price) - Number(row.agent_price);
    return { agent_price: agent, seller_price: Math.max(agent, agent + margin) };
};

const 일괄갱신 = async (writePool, updates) => {
    if (updates.length === 0) return 0;
    const ids = updates.map((u) => u.id);
    const params = [];
    for (const u of updates) params.push(u.id, u.agent_price);
    for (const u of updates) params.push(u.id, u.seller_price);
    params.push(...ids);
    await writePool.query(
        `UPDATE seller_products
            SET agent_price = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END,
                seller_price = CASE id ${updates.map(() => 'WHEN ? THEN ?').join(' ')} END
          WHERE id IN (${ids.map(() => '?').join(',')})`, params);
    return updates.length;
};

// 한 상품을 파는 셀러들의 변경안. base 를 주면 그 가격으로 '미리보기', 안 주면 DB 의 현재 가격.
export const planForProduct = async (product_id, base = null) => {
    const [rows] = await readPool.query(
        `SELECT sp.id, sp.seller_id, sp.seller_price, sp.agent_price, p.product_sale_price, u.user_name, u.seller_name
           FROM seller_products sp
           JOIN products p ON p.id = sp.product_id
           JOIN users u ON u.id = sp.seller_id
          WHERE sp.product_id=? AND sp.is_delete=0`, [Number(product_id) || 0]);
    const plan = [];
    for (const r of rows) {
        const fees = await loadSellerFees(r.seller_id);
        if (!fees) continue;
        const 기준가 = base === null ? Number(r.product_sale_price) : Number(base);
        if (!(기준가 > 0)) continue;
        plan.push({ ...r, ...{ from: { agent_price: Number(r.agent_price), seller_price: Number(r.seller_price) } }, to: 새가격(r, 기준가, fees) });
    }
    return plan;
};

// 한 셀러의 상품 전부 변경안. fees 를 주면 그 수수료로 '미리보기'(영업자 변경 전 확인용).
export const planForSeller = async (seller_id, fees = null) => {
    const f = fees ?? await loadSellerFees(seller_id);
    if (!f) return [];
    const [rows] = await readPool.query(
        `SELECT sp.id, sp.seller_price, sp.agent_price, p.product_sale_price, p.product_name
           FROM seller_products sp JOIN products p ON p.id = sp.product_id
          WHERE sp.seller_id=? AND sp.is_delete=0`, [Number(seller_id) || 0]);
    return rows
        .filter((r) => Number(r.product_sale_price) > 0)
        .map((r) => ({ ...r, from: { agent_price: Number(r.agent_price), seller_price: Number(r.seller_price) }, to: 새가격(r, Number(r.product_sale_price), f) }));
};

// 변경안 중 실제로 값이 바뀌는 것만 저장한다.
export const applyPlan = async (writePool, plan) => 일괄갱신(writePool, plan
    .filter((p) => p.to.agent_price !== p.from.agent_price || p.to.seller_price !== p.from.seller_price)
    .map((p) => ({ id: p.id, ...p.to })));

// 확인창용 요약: 바뀌는 건수와 예시 몇 개.
export const summarizePlan = (plan, label) => {
    const changed = plan.filter((p) => p.to.agent_price !== p.from.agent_price || p.to.seller_price !== p.from.seller_price);
    return {
        total: plan.length,
        changed: changed.length,
        sellers: new Set(changed.map((p) => p.seller_id).filter(Boolean)).size,
        samples: changed.slice(0, 3).map((p) => ({ name: label(p), from: p.from, to: p.to })),
    };
};
