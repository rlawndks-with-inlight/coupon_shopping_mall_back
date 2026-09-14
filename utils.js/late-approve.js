'use strict';
import { readPool } from "../config/db-pool.js";
import { insertQuery } from "./query-util.js";
import { decreaseStock } from "./product-options.js";
import { logTrx } from "./trx-log.js";
import logger from "./winston/index.js";

// 「결제실패/미완료」(-1)로 정리된 뒤에 PG 승인이 도착한 경우의 뒷정리.
//
// cleanup-abandoned 는 결제창만 열고 한 시간 넘게 승인이 없는 주문을 -1 로 표시하면서
// 잡아둔 재고를 풀고 사용 포인트를 돌려준다(applyCancelEffects). 그런데 승인 확정 쿼리는
// `WHERE trx_status<>5` 라 -1 도 5 로 올린다 — 돈은 실제로 빠졌으니 주문을 살리는 게 맞다.
// 그 대신 풀어 둔 재고를 다시 잡고, 돌려준 사용 포인트를 다시 뺀다. 안 하면
//   · 재고가 실제보다 주문 수량만큼 많아 보여 초과 판매가 나고
//   · 손님은 포인트 할인도 받고 포인트도 돌려받는다.
// (2026-09-14 전에는 행이 아예 지워져 돈만 빠지고 주문이 사라졌다 — 그보다는 낫다.)
//
// 절대 던지지 않는다 — 승인 확정 자체를 막으면 안 된다. 결과는 이력(note)에 남긴다.
export const 늦은승인정리 = async (trx, { note = '' } = {}) => {
    const tid = Number(trx?.id) || 0;
    if (!tid || Number(trx?.trx_status) !== -1) return null;
    const 결과 = [];
    try {
        const [rows] = await readPool.query(`SELECT product_id, order_count, order_groups FROM transaction_orders WHERE trans_id=?`, [tid]);
        const lines = rows.map((r) => {
            let groups = [];
            try { groups = JSON.parse(r.order_groups ?? '[]'); } catch (e) { groups = []; }
            return { id: r.product_id, order_count: r.order_count, groups: Array.isArray(groups) ? groups : [] };
        });
        // 정리 때 원장(product_stock_moves)을 지웠으므로 UNIQUE 에 안 걸리고 다시 잡힌다.
        const ok = await decreaseStock(tid, lines);
        결과.push(ok ? '재고 다시 차감' : '재고 부족 — 다시 차감 못 함(확인 필요)');
    } catch (e) {
        logger.error(`[늦은승인] 재고 재차감 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
        결과.push('재고 재차감 오류(확인 필요)');
    }
    try {
        const 사용 = Math.abs(Number(trx?.use_point) || 0);
        if (사용 > 0 && Number(trx?.user_id) > 0) {
            await insertQuery('points', { brand_id: trx.brand_id, user_id: trx.user_id, sender_id: 0, point: -사용, type: 10, trans_id: tid });
            결과.push(`사용 포인트 ${사용}P 다시 차감`);
        }
    } catch (e) {
        logger.error(`[늦은승인] 포인트 재차감 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
        결과.push('포인트 재차감 오류(확인 필요)');
    }
    await logTrx({ trans_id: tid, brand_id: trx?.brand_id, kind: 'status', from_status: -1, to_status: 5, actor: { type: 'system' },
        note: `결제실패/미완료로 정리된 뒤 늦게 승인됨${note ? ` (${note})` : ''} — ${결과.join(', ')}` });
    return 결과;
};
