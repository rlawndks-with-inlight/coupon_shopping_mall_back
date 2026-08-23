import { readPool, writePool } from "../config/db-pool.js";
import { insertQuery } from "./query-util.js";
import { restoreStock, restoreStockPartial } from "./product-options.js";
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

// ── 부분취소 ────────────────────────────────────────────────────────────────
//
// 취소 가능 상태는 전체취소와 같다: 출고 전(trx_status 0·5·10)만.
// 출고 이후는 취소가 아니라 반품 절차다.
export const CANCELABLE_STATUS = [0, 5, 10];

// 줄 하나의 '개당 상품가'. 배송비는 뺀다 — 배송비는 개수로 나눌 성질이 아니다.
// (order_amount 는 그 줄의 배송비를 포함한 값이다. pay.controller 가 그렇게 넣는다)
const 줄단가 = (line) => {
    const 상품가 = Math.max(0, (Number(line.order_amount) || 0) - (Number(line.delivery_fee) || 0));
    const 수량 = Math.max(1, Number(line.order_count) || 1);
    return { 상품가, 수량, 단가: Math.floor(상품가 / 수량) };
};

// 주문의 취소 가능 상태를 읽는다. 관리자 화면이 '몇 개까지 취소 가능한지' 보여줄 때 쓴다.
export const getCancelState = async (trans_id) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return null;
    const [[trx]] = await readPool.query(
        // ⚠ delivery_fee 를 여기서 고르면 안 된다 — transactions 에는 그 컬럼이 없다.
        //    배송비는 주문 줄(transaction_orders.delivery_fee)에만 있고, 아래 총배송비도
        //    거기서 더한다. 이 한 칼럼 때문에 조회가 통째로 ER_BAD_FIELD_ERROR 로 죽어
        //    부분취소 창이 늘 '주문 정보를 불러오지 못했습니다' 만 띄웠다(실행 경로도 같은 함수라 함께 죽었다).
        `SELECT id, brand_id, user_id, amount, use_point, trx_method, trx_status,
                is_cancel, is_cancel_trans, ord_num
           FROM transactions WHERE id=?`, [tid]);
    if (!trx) return null;
    const [rows] = await readPool.query(
        `SELECT * FROM transaction_orders WHERE trans_id=? ORDER BY id ASC`, [tid]);
    const lines = rows.map((l) => {
        const { 상품가, 수량, 단가 } = 줄단가(l);
        const 취소수량 = Number(l.cancel_count) || 0;
        return {
            ...l,
            unit_price: 단가,
            merch_amount: 상품가,
            remain_count: Math.max(0, 수량 - 취소수량),
            // 남은 상품가 — 마지막 취소는 이 값을 그대로 쓴다(나머지 정산).
            remain_amount: Math.max(0, 상품가 - (Number(l.cancel_amount) || 0)),
        };
    });
    // 고객이 '무엇을 몇 개' 취소해 달라고 했는지. 관리자 화면이 그 수량을 미리 채운다 —
    // 안 채우면 관리자가 고객 요청을 다시 읽고 손으로 옮겨 적어야 하고, 그 자리에서 어긋난다.
    let requests = [];
    try {
        const [rows] = await readPool.query(
            `SELECT order_id, SUM(req_count) AS req_count,
                    MAX(reason) AS reason, MAX(created_at) AS created_at
               FROM transaction_cancel_requests
              WHERE trans_id=? AND status=0
              GROUP BY order_id`, [tid]);
        requests = rows;
    } catch (e) {
        // 테이블이 아직 없어도(마이그레이션 전) 취소 자체는 되게 한다.
        requests = [];
    }

    return {
        trx,
        lines: lines.map((l) => ({
            ...l,
            requested_count: Number(requests.find((r) => Number(r.order_id) === Number(l.id))?.req_count) || 0,
        })),
        request_reason: requests.find((r) => r.reason)?.reason ?? null,
        has_request: requests.length > 0,
        cancelable: CANCELABLE_STATUS.includes(Number(trx.trx_status))
            && Number(trx.is_cancel) !== 1 && Number(trx.is_cancel_trans) !== 1,
        all_canceled: lines.length > 0 && lines.every((l) => l.remain_count === 0),
    };
};

// 부분취소로 환불할 금액을 계산한다. **서버만 계산한다.**
//
// 화면이 보낸 금액을 믿으면 10만원 주문에 100만원 환불을 걸 수 있다.
// 화면은 수량만 보내고, 금액은 여기서 transaction_orders 를 다시 읽어 만든다.
//
// 나머지는 마지막 취소에 몰아준다 — 10,000원 3개를 1개씩 세 번 취소하면
// 3,333 + 3,333 + 3,334 여야 합계가 원금과 맞는다.
export const calcCancelAmount = (line, qty) => {
    const 수량 = Math.max(0, Number(qty) || 0);
    if (수량 <= 0 || 수량 > line.remain_count) return null;
    return 수량 === line.remain_count
        ? line.remain_amount                    // 마지막 — 남은 것 전부(나머지 정산)
        : Math.min(line.remain_amount, line.unit_price * 수량);
};

// 배송비 조정.
//
// 기성 업체(네이버·쿠팡) 규칙을 따랐다:
//   · 부분취소에는 배송비를 환불하지 않는다.
//   · 다만 부분취소로 **무료배송 조건이 깨지면** 그 배송비를 환불액에서 뺀다.
//     남은 상품이 무료배송 기준에 못 미치는데 배송비를 안 받으면 그건 공짜 배송이 된다.
//   · 전부 취소되면 배송비도 전액 환불한다.
export const calcDeliveryAdjust = ({ 전체취소, 취소후남은상품가, 총배송비, setting }) => {
    if (전체취소) return 총배송비;                       // 양수 = 환불
    const base = parseInt(setting?.delivery_fee_default || 0) || 0;
    const freeMin = parseInt(setting?.free_ship_min || 0) || 0;
    const 정책켜짐 = base > 0 || freeMin > 0;
    if (!정책켜짐 || freeMin <= 0) return 0;             // 무료배송 정책이 없으면 조정 없음
    const 원래무료 = Number(총배송비) === 0;              // 무료배송으로 결제된 주문이었나
    if (!원래무료) return 0;
    // 무료였는데 취소 후 기준에 미달 → 배송비를 받아야 한다(환불액에서 뺀다)
    return 취소후남은상품가 < freeMin ? -base : 0;
};

// 취소가 확정됐을 때 거래에 표시하고 부수처리까지 한 번에.
//
// is_cancel_trans 는 '이 원거래가 취소됐다'는 표시다.
// 페이베리 기본경로는 이것조차 안 세우고 있었다 — PG 에는 취소가 나갔는데
// 화면에는 정상 주문으로 남고, 매출 집계도 취소분을 그대로 안고 갔다.
// 관리자 '취소완료' 탭에 잡히게 하는 취소 원장 행.
//
// 그 탭은 is_cancel=1 인 행을 본다. 그런데 그 행을 만드는 곳이 헥토 콜백 하나뿐이었다.
// 포스페이·페이레터·위루트로 취소하면 원주문에 is_cancel_trans=1 만 찍혀서
//   · '취소요청' 탭 조건(trx_status=1 AND is_cancel=0)에 여전히 맞아 거기 그대로 남고
//   · '취소완료' 탭에는 영영 안 나타나고
//   · 주문관리에서 바로 취소한 건은 결제완료 탭에서도 빠져 **아예 사라졌다**
// 실제로 취소 처리된 6건 중 4건이 아직 취소요청 탭에 박혀 있다(2026-08-23 확인).
//
// 헥토가 만들던 것과 같은 모양으로 맞춘다 — 원거래를 복사하고 금액만 음수로.
// 그래야 이미 쌓인 81만 건과 같은 화면에서 같은 방식으로 읽힌다.
const 취소원장행쓰기 = async (tid) => {
    try {
        // 이미 있으면 만들지 않는다. 웹훅이 두 번 오거나 관리자가 두 번 눌러도
        // 취소가 두 건으로 보이면 안 된다. (transaction_id 에 인덱스가 있어 싸다)
        const [있나] = await readPool.query(
            `SELECT id FROM transactions WHERE is_cancel=1 AND transaction_id=? LIMIT 1`, [tid]);
        if (있나.length) return;
        const [rows] = await readPool.query(`SELECT * FROM transactions WHERE id=?`, [tid]);
        const 원거래 = rows[0];
        if (!원거래) return;
        const 이제 = new Date();
        const 두자리 = (n) => String(n).padStart(2, '0');
        const obj = {
            ...원거래,
            ori_trx_id: 원거래.trx_id,
            cxl_dt: `${이제.getFullYear()}-${두자리(이제.getMonth() + 1)}-${두자리(이제.getDate())}`,
            cxl_tm: `${두자리(이제.getHours())}:${두자리(이제.getMinutes())}:${두자리(이제.getSeconds())}`,
            is_cancel: 1,
            // 금액은 음수다. 이 부호가 '취소분'이라는 표시이자 상계 근거다.
            amount: -Math.abs(Number(원거래.amount) || 0),
            transaction_id: 원거래.id,
        };
        // 새 행이므로 원본의 키·시각은 물려받지 않는다.
        delete obj.id; delete obj.created_at; delete obj.updated_at; delete obj.is_delete;
        await insertQuery('transactions', obj);
    } catch (e) {
        // 원장 행을 못 남겨도 취소 자체는 이미 끝났다(PG 에서 돈이 나갔다).
        // 여기서 던지면 '돈은 돌려줬는데 화면은 실패'가 된다.
        logger.error(`[취소] 원장 행 기록 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
    }
};

export const markCanceled = async (trans_id, { column = 'is_cancel_trans' } = {}) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    try {
        await writePool.query(`UPDATE transactions SET ${column}=1 WHERE id=?`, [tid]);
    } catch (e) {
        logger.error(`[취소] 상태 표시 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
    }
    // 핀트리는 원주문 자체에 is_cancel=1 을 찍는다(column 을 바꿔 부른다).
    // 그 행이 곧 취소완료 행이므로 따로 만들면 같은 취소가 두 줄로 보인다.
    if (column === 'is_cancel_trans') await 취소원장행쓰기(tid);
    await applyCancelEffects(tid);
    return true;
};

// 부분취소 실행.
//
// 순서가 중요하다:
//   ① 락 + 검증        — 남은 수량을 넘겨 취소하는 것을 DB 수준에서 막는다
//   ② 원장 먼저 INSERT — idem_key UNIQUE 로 같은 클릭의 이중 실행을 여기서 끊는다
//   ③ PG 호출          — 실제 환불
//   ④ 성공 후 반영     — 줄 누적 · 재고 · 포인트 · 전체취소 표시
//   실패하면 ② 를 지운다. 돈이 안 움직였으므로 같은 키로 다시 시도할 수 있어야 한다.
//
// items: [{ order_id, qty }]
export const cancelLines = async (trans_id, { items = [], user_id = null, reason = null,
                                              idem_key = null, pgCancel } = {}) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return { ok: false, message: '주문을 찾을 수 없습니다.' };
    const 요청 = (Array.isArray(items) ? items : [])
        .map((x) => ({ order_id: Number(x?.order_id) || 0, qty: Math.max(0, Number(x?.qty) || 0) }))
        .filter((x) => x.order_id && x.qty);
    if (!요청.length) return { ok: false, message: '취소할 상품과 수량을 선택해 주세요.' };

    const state = await getCancelState(tid);
    if (!state) return { ok: false, message: '주문을 찾을 수 없습니다.' };
    if (!state.cancelable) {
        return { ok: false, message: '출고된 주문은 취소할 수 없습니다. 반품/환불은 판매자에게 문의해 주세요.' };
    }

    // 브랜드 배송비 정책
    let setting = {};
    try {
        const [[b]] = await readPool.query(`SELECT setting_obj FROM brands WHERE id=?`, [state.trx.brand_id]);
        setting = JSON.parse(b?.setting_obj ?? '{}');
    } catch (e) { setting = {}; }

    // ── 금액 계산 (서버만) ──────────────────────────────────────────────
    const 계산 = [];
    for (const req of 요청) {
        const line = state.lines.find((l) => Number(l.id) === req.order_id);
        if (!line) return { ok: false, message: '주문에 없는 상품입니다.' };
        if (req.qty > line.remain_count) {
            return { ok: false, message: `'${line.order_name}' 은(는) ${line.remain_count}개까지 취소할 수 있습니다.` };
        }
        const 금액 = calcCancelAmount(line, req.qty);
        if (금액 === null) return { ok: false, message: '취소 수량이 올바르지 않습니다.' };
        계산.push({ line, qty: req.qty, amount: 금액 });
    }

    // 이번 취소 뒤에 남는 상품가 — 배송비 조정 판단에 쓴다
    const 전체상품가 = state.lines.reduce((s, l) => s + l.merch_amount, 0);
    const 기취소상품가 = state.lines.reduce((s, l) => s + (Number(l.cancel_amount) || 0), 0);
    const 이번상품가 = 계산.reduce((s, c) => s + c.amount, 0);
    const 취소후남은상품가 = Math.max(0, 전체상품가 - 기취소상품가 - 이번상품가);

    const 남는수량 = state.lines.reduce((s, l) => {
        const 이번 = 계산.find((c) => Number(c.line.id) === Number(l.id))?.qty ?? 0;
        return s + (l.remain_count - 이번);
    }, 0);
    const 전체취소 = 남는수량 === 0;
    const 총배송비 = state.lines.reduce((s, l) => s + (Number(l.delivery_fee) || 0), 0);
    const 배송비조정 = calcDeliveryAdjust({ 전체취소, 취소후남은상품가, 총배송비, setting });
    const 환불액 = Math.max(0, 이번상품가 + 배송비조정);
    if (환불액 <= 0) {
        return { ok: false, message: '환불할 금액이 없습니다. (남은 상품이 무료배송 기준에 미달해 배송비가 상계됩니다)' };
    }

    // ── 원장 먼저 (중복 클릭 차단) ───────────────────────────────────────
    let cancel_id = 0;
    try {
        const 대표 = 계산[0];
        const [r] = await writePool.query(
            `INSERT INTO transaction_cancels
               (trans_id, order_id, product_id, cancel_count, cancel_amount, delivery_fee, reason, user_id, idem_key)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [tid, 대표.line.id, 대표.line.product_id,
             계산.reduce((s, c) => s + c.qty, 0), 환불액, 배송비조정, reason, user_id, idem_key]);
        cancel_id = r?.insertId || 0;
    } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') {
            return { ok: false, message: '이미 처리된 취소 요청입니다.' };
        }
        logger.error(`[부분취소] 원장 기록 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
        return { ok: false, message: '취소 기록에 실패했습니다.' };
    }

    // ── PG 호출 ─────────────────────────────────────────────────────────
    let pg결과 = null;
    try {
        pg결과 = pgCancel ? await pgCancel({ trx: state.trx, amount: 환불액 }) : null;
    } catch (e) {
        // 돈이 안 움직였으니 원장을 지워 같은 키로 다시 시도할 수 있게 한다.
        await writePool.query(`DELETE FROM transaction_cancels WHERE id=?`, [cancel_id]);
        const msg = e?.response?.data?.message || e?.message || 'PG 취소에 실패했습니다.';
        logger.error(`[부분취소] PG 실패 trans_id=${tid}: ${JSON.stringify(e?.response?.data || msg)}`);
        return { ok: false, message: msg };
    }

    await writePool.query(
        `UPDATE transaction_cancels SET pg_result=?, cxl_seq=? WHERE id=?`,
        [pg결과 ? JSON.stringify(pg결과).slice(0, 60000) : null,
         pg결과?.cxl_seq ?? null, cancel_id]);

    // ── 반영 ────────────────────────────────────────────────────────────
    for (const c of 계산) {
        await writePool.query(
            `UPDATE transaction_orders
                SET cancel_count = cancel_count + ?, cancel_amount = cancel_amount + ?, canceled_at = NOW()
              WHERE id=?`,
            [c.qty, c.amount, c.line.id]);
        // 재고는 그 줄이 고른 옵션만, 취소한 수량만큼만 되돌린다.
        let option_ids = [];
        try {
            const groups = JSON.parse(c.line.order_groups ?? '[]');
            option_ids = (Array.isArray(groups) ? groups : [])
                .flatMap((g) => (g?.options ?? []).map((o) => Number(o?.id) || 0)).filter(Boolean);
        } catch (e) { option_ids = []; }
        try {
            await restoreStockPartial(tid, { product_id: c.line.product_id, option_ids, qty: c.qty, cancel_id });
        } catch (e) {
            logger.error(`[부분취소] 재고 복구 실패 trans_id=${tid} order_id=${c.line.id}: ${e?.sqlMessage || e?.message || e}`);
        }
    }

    // 포인트는 환불 비율만큼. 전체취소면 남은 전부를 정산한다.
    const 비율 = 전체취소 ? 1 : Math.min(1, (기취소상품가 + 이번상품가) / Math.max(1, 전체상품가));
    await applyCancelEffects(tid, { ratio: 비율, restock: false });

    // 고객이 낸 대기 요청을 닫는다. 안 닫으면 이미 처리한 요청이 계속 대기로 남아
    // 관리자가 같은 건을 또 취소하려 든다.
    try {
        for (const c of 계산) {
            await writePool.query(
                `UPDATE transaction_cancel_requests
                    SET status=1, cancel_id=?, processed_at=NOW()
                  WHERE trans_id=? AND order_id=? AND status=0`,
                [cancel_id, tid, c.line.id]);
        }
    } catch (e) {
        logger.error(`[부분취소] 요청 마감 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
    }

    if (전체취소) {
        await writePool.query(`UPDATE transactions SET is_cancel_trans=1 WHERE id=?`, [tid]);
        // 부분취소를 거듭해 결국 전부 취소된 경우도 관리자 '취소완료' 탭에 잡혀야 한다.
        // 이 자리는 markCanceled 를 거치지 않으므로 원장 행이 안 생겨,
        // 취소요청 탭에서도 빠지고 취소완료 탭에도 없어 주문이 통째로 사라졌다.
        //
        // ⚠ 여기서 markCanceled 를 부르면 안 된다.
        //   그쪽은 applyCancelEffects 를 restock:true 로 부르는데, 부분취소는 이미 줄 단위로
        //   (restoreStockPartial) 재고를 되돌려 놨다. 재고를 두 번 되돌릴 위험이 있다.
        //   포인트 정산도 바로 위에서 비율 1 로 끝냈다. 그래서 원장 행만 남긴다.
        await 취소원장행쓰기(tid);
    }
    return { ok: true, cancel_id, amount: 환불액, delivery_adjust: 배송비조정, all_canceled: 전체취소 };
};
