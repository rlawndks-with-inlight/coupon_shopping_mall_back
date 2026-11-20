// 결제 묶음 — 결제 한 번에 주문 여러 건(「여러 곳으로 배송」, 2026-11-20).
//
// 한 번 결제하고 배송지마다 주문을 따로 만든다. 가맹점 화면의 송장·상태·취소가 지금처럼 주문 한 줄씩 돌게 하려고.
// 포스페이에는 결제 하나(주문번호 G)만 있다. 그래서 PG 를 부르거나 PG 가 알려 온 금액을 비교할 때는
// 주문 한 건이 아니라 「묶음 전체」를 봐야 한다 — 이 파일이 그 기준을 한 곳에 모은다.
//
// 저장 모양:
//   첫 배송지 주문 : ord_num = G,      pay_group = G
//   나머지 주문    : ord_num = G-2 … G-10, pay_group = G
//   예전 주문(묶음 아님): pay_group = NULL — 지금과 똑같이 「주문 한 건 = 결제 한 건」.
// 묶음 주문은 주문번호 목록(G, G-2 … G-10)으로 찾는다 — 445만 행 테이블에 새 인덱스를 걸지 않고 주문번호 인덱스를 탄다.
import { readPool } from '../config/db-pool.js';

export const 묶음최대 = 10;

// 묶음 안 주문번호 — k 는 1부터(1 = 첫 배송지)
export const 묶음주문번호 = (G, k) => (k <= 1 ? String(G) : `${G}-${k}`);
const 묶음번호목록 = (G) => Array.from({ length: 묶음최대 }, (_, i) => 묶음주문번호(G, i + 1));

// PG(포스페이)에 쓰는 주문번호 — 묶음이면 묶음 번호, 아니면 자기 주문번호
export const 결제주문번호 = (trx) => String(trx?.pay_group || trx?.ord_num || '');

// 같은 결제의 주문들(취소 원장 줄 제외). 묶음이 아니면 [trx] 그대로.
export const 묶음주문들 = async (trx) => {
    if (!trx?.pay_group) return trx ? [trx] : [];
    const 번호 = 묶음번호목록(trx.pay_group);
    const [rows] = await readPool.query(
        `SELECT * FROM transactions WHERE ord_num IN (${번호.map(() => '?').join(',')}) AND pay_group=? AND IFNULL(is_cancel,0)=0 ORDER BY id ASC`,
        [...번호, trx.pay_group]);
    return rows;
};

// 묶음에서 지금까지 우리가 돌려준 현금. 묶음 주문은 포인트를 못 쓰게 했으므로(pay.controller 여러곳주문) 환불 = 현금이다.
//   · 부분취소·마지막 취소 : transaction_cancels.cancel_amount 합
//   · 「전체 취소」 단추로 한 번에 취소(원장 기록 없음) : 그 주문 금액 전부
export const 묶음현금환불 = async (rows) => {
    const 목록 = (rows ?? []).filter(Boolean);
    if (!목록.length) return 0;
    const ids = 목록.map((r) => Number(r.id));
    const [합] = await readPool.query(
        `SELECT trans_id, SUM(cancel_amount) AS s, COUNT(*) AS n FROM transaction_cancels WHERE trans_id IN (${ids.map(() => '?').join(',')}) GROUP BY trans_id`, ids);
    let 현금 = 0;
    for (const r of 목록) {
        const h = 합.find((x) => Number(x.trans_id) === Number(r.id));
        if (h && Number(h.n) > 0) 현금 += Number(h.s) || 0;
        else if (Number(r.is_cancel_trans) === 1) 현금 += Math.max(0, Number(r.amount) || 0);
    }
    return 현금;
};

// 묶음 결제 금액(취소 원장 줄 제외, 처음 결제한 금액 그대로)
export const 묶음금액 = (rows) => (rows ?? []).reduce((s, r) => s + Math.max(0, Number(r?.amount) || 0), 0);

// 결제실패/미완료 목록은 묶음을 첫 주문 한 줄로 접는다(2026-11-20) — 결제 한 번이 실패했는데 배송지 수만큼 줄이 쌓이면 읽기 어렵다.
//   SQL 조각: 묶음이 아니거나 묶음의 첫 주문(ord_num = pay_group)만. AND 로 붙는 걸러내기라 인덱스 선택을 바꾸지 않는다.
export const 묶음첫줄식 = (t = 'transactions') => `(${t}.pay_group IS NULL OR ${t}.ord_num = ${t}.pay_group)`;

// 접힌 줄에 「몇 곳 · 합계 얼마」를 붙인다 — group_count, group_amount. 실패해도 목록은 그대로 낸다.
export const 묶음요약붙이기 = async (rows) => {
    const 묶음줄 = (rows ?? []).filter((r) => r?.pay_group && String(r.ord_num) === String(r.pay_group));
    if (!묶음줄.length) return rows;
    try {
        const 번호 = 묶음줄.flatMap((r) => 묶음번호목록(r.pay_group));
        const [합] = await readPool.query(
            `SELECT pay_group, COUNT(*) AS n, SUM(amount) AS s FROM transactions
              WHERE ord_num IN (${번호.map(() => '?').join(',')}) AND pay_group IS NOT NULL AND IFNULL(is_cancel,0)=0 GROUP BY pay_group`, 번호);
        for (const r of 묶음줄) {
            const h = 합.find((x) => String(x.pay_group) === String(r.pay_group));
            if (h) { r.group_count = Number(h.n) || 0; r.group_amount = Number(h.s) || 0; }
        }
    } catch (e) { /* 요약 없이 낸다 */ }
    return rows;
};
