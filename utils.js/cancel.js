import { readPool, writePool } from "../config/db-pool.js";
import { insertQuery } from "./query-util.js";
import { restoreStock } from "./product-options.js";
import logger from "./winston/index.js";

// 취소 부수처리 — 재고 복구 · 적립 포인트 회수 · 사용 포인트 환불.
//
// 왜 한 곳으로 모았나:
//   같은 '취소'인데 PG 경로마다 하는 일이 달랐다. 코드를 따라가 보니 이랬다.
//
//     경로              취소표시  재고  적립회수  사용환불
//     헥토·페이베리        O       O      O        O
//     포스페이             O       O      ✕        ✕
//     페이레터             O       O      ✕        ✕
//     핀트리               O       O      ✕        ✕
//     위루트               O       ✕      ✕        ✕
//     페이베리 기본경로    ✕       ✕      ✕        ✕     ← DB 를 아예 안 건드렸다
//     포스페이 웹훅        O       ✕      ✕        ✕
//
//   경로가 늘 때마다 빠뜨릴 자리가 늘어난다. 이제 전부 이 함수 하나를 부른다.
//
// ── 멱등성 ──────────────────────────────────────────────────────────────────
// 별도 표시 컬럼을 두지 않는다. **원장에서 역산**한다:
//   회수해야 할 적립 = Σ(type 0)          이미 회수한 것 = |Σ(음수 type 5)|
//   돌려줄 사용분   = transactions.use_point  이미 돌려준 것 = Σ(양수 type 5)
// 남은 것이 0 이면 아무것도 넣지 않는다. 그래서 콜백이 두 번 와도, 관리자가 두 번 눌러도
// 포인트가 두 번 움직이지 않는다. (재고는 product_stock_moves 의 UNIQUE 가 같은 일을 한다)
//
// ── 비율 ────────────────────────────────────────────────────────────────────
// ratio 는 부분취소용이다(0~1). 지금은 전체취소뿐이라 늘 1 이 들어온다.
// ⚠ 비율로 계산할 때는 **버림**하고, 마지막(전체) 취소에서 남은 잔액을 전부 정산한다.
//   반올림으로 나눠 붙이면 조각들의 합이 원금과 1원씩 어긋난다.
//   네이버·카페24도 부분취소 시 사용 포인트·쿠폰을 취소 금액에 비례해 환원하는 방식이다.

const 원장합 = async (trans_id, where) => {
    const [rows] = await readPool.query(
        `SELECT COALESCE(SUM(point), 0) AS p FROM points WHERE trans_id=? AND ${where}`, [trans_id]);
    return Number(rows[0]?.p) || 0;
};

// 취소 부수처리를 한다. 실패해도 던지지 않는다 —
// 취소는 이미 PG 에서 끝난 뒤라, 여기서 던지면 '돈은 돌려줬는데 화면은 실패'가 된다.
export const applyCancelEffects = async (trans_id, { ratio = 1, restock = true } = {}) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    const 전체 = !(ratio > 0 && ratio < 1);

    if (restock) {
        try {
            await restoreStock(tid);
        } catch (e) {
            logger.error(`[취소] 재고 복구 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
        }
    }

    try {
        const [rows] = await readPool.query(
            `SELECT id, brand_id, user_id, use_point FROM transactions WHERE id=?`, [tid]);
        const trx = rows[0];
        if (!trx?.user_id) return true; // 비회원 주문은 포인트가 없다

        // ① 적립됐던 포인트 회수 (음수로 넣는다)
        const 적립총액 = await 원장합(tid, 'type=0');
        const 이미회수 = Math.abs(await 원장합(tid, 'type=5 AND point<0'));
        const 남은회수 = Math.max(0, 적립총액 - 이미회수);
        const 이번회수 = 전체 ? 남은회수 : Math.min(남은회수, Math.floor(적립총액 * ratio));
        if (이번회수 > 0) {
            await insertQuery('points', {
                brand_id: trx.brand_id, user_id: trx.user_id, sender_id: 0,
                point: -이번회수, type: 5, trans_id: tid,
                note: 전체 ? '주문취소 - 적립 회수' : '부분취소 - 적립 회수',
            });
        }

        // ② 주문에 썼던 포인트 환불 (양수로 넣는다)
        //    ready 에서 use_point 만큼 음수 행(type 10)을 넣으므로 취소 때 반드시 돌려줘야 한다.
        //    이걸 빠뜨리면 취소할 때마다 고객 포인트가 증발한다.
        const 사용총액 = Math.abs(Number(trx.use_point) || 0);
        const 이미환불 = await 원장합(tid, 'type=5 AND point>0');
        const 남은환불 = Math.max(0, 사용총액 - 이미환불);
        const 이번환불 = 전체 ? 남은환불 : Math.min(남은환불, Math.floor(사용총액 * ratio));
        if (이번환불 > 0) {
            await insertQuery('points', {
                brand_id: trx.brand_id, user_id: trx.user_id, sender_id: 0,
                point: 이번환불, type: 5, trans_id: tid,
                note: 전체 ? '주문취소 - 사용 포인트 반환' : '부분취소 - 사용 포인트 반환',
            });
        }
    } catch (e) {
        logger.error(`[취소] 포인트 처리 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
    }
    return true;
};

// 취소가 확정됐을 때 거래에 표시하고 부수처리까지 한 번에.
//
// is_cancel_trans 는 '이 원거래가 취소됐다'는 표시다.
// 페이베리 기본경로는 이것조차 안 세우고 있었다 — PG 에는 취소가 나갔는데
// 화면에는 정상 주문으로 남고, 매출 집계도 취소분을 그대로 안고 갔다.
export const markCanceled = async (trans_id, { column = 'is_cancel_trans' } = {}) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    try {
        await writePool.query(`UPDATE transactions SET ${column}=1 WHERE id=?`, [tid]);
    } catch (e) {
        logger.error(`[취소] 상태 표시 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
    }
    await applyCancelEffects(tid);
    return true;
};
