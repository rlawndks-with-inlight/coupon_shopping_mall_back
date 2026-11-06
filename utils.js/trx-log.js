'use strict';
import { readPool, writePool } from "../config/db-pool.js";
import logger from "./winston/index.js";

// 주문 상태 변경 이력(transaction_status_logs) 한 줄 쓰기.
//
// 부르는 곳: 관리자 상태 드롭다운(util.controller changeStatus) · PG 승인 확정(pay.controller) ·
//           손님 취소요청(transaction.controller) · 취소 실행(cancel.js) · 버려진 결제대기 정리(cleanup-abandoned).
//
// ⚠ 절대 던지지 않는다. 이력은 곁가지다 — 이력 때문에 상태 변경·취소·승인이 실패하면 안 된다.
//   테이블이 아직 없어도(마이그레이션 전 배포) 경고만 남기고 지나간다.
//
// actor: { type: 'admin'|'customer'|'system', id, name }  — 토큰(decode_user)을 그대로 넘겨도 된다(아래 actorOf).

// 상태 코드 → 사람이 읽는 이름. 화면(function.js getTrxStatusByNumber)과 같은 뜻으로 맞춘다.
export const STATUS_TEXT = { '-1': '결제실패/미완료', 0: '결제대기', 1: '취소요청', 5: '결제완료', 10: '입고완료', 15: '출고완료', 20: '배송중', 25: '배송완료' };
export const statusText = (n) => (n === null || n === undefined) ? '' : (STATUS_TEXT[String(n)] ?? String(n));

// 토큰에서 처리자 정보 뽑기. 관리자(level>=10)면 admin, 그 밖은 customer.
export const actorOf = (decode_user, fallbackType = 'customer') => {
    if (!decode_user || !(Number(decode_user?.id) > 0)) return { type: fallbackType, id: null, name: null };
    return {
        type: Number(decode_user?.level) >= 10 ? 'admin' : 'customer',
        id: Number(decode_user.id),
        name: String(decode_user?.nickname || decode_user?.name || decode_user?.user_name || '').slice(0, 100) || null,
    };
};

let 테이블없음경고 = false;

export const logTrx = async ({ trans_id, brand_id, kind, from_status = null, to_status = null, actor = {}, note = null }) => {
    const tid = Number(trans_id) || 0;
    if (!tid || !kind) return false;
    try {
        let bid = Number(brand_id) || 0;
        if (!bid) {
            const [[row]] = await readPool.query(`SELECT brand_id FROM transactions WHERE id=?`, [tid]);
            bid = Number(row?.brand_id) || 0;
        }
        await writePool.query(
            `INSERT INTO transaction_status_logs (trans_id, brand_id, kind, from_status, to_status, actor_type, actor_id, actor_name, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [tid, bid, String(kind).slice(0, 20),
             from_status === null || from_status === undefined ? null : Number(from_status),
             to_status === null || to_status === undefined ? null : Number(to_status),
             String(actor?.type || 'system').slice(0, 10), actor?.id ? Number(actor.id) : null,
             actor?.name ? String(actor.name).slice(0, 100) : null,
             note ? String(note).slice(0, 500) : null]);
        return true;
    } catch (e) {
        if (e?.code === 'ER_NO_SUCH_TABLE') {
            if (!테이블없음경고) { logger.warn('[trx-log] transaction_status_logs 테이블이 없다 — migrations/2026-09-14_transaction_status_logs.sql 을 실행할 것. 이력만 건너뛴다.'); 테이블없음경고 = true; }
            return false;
        }
        logger.error(`[trx-log] 기록 실패 trans_id=${tid} kind=${kind}: ${e?.sqlMessage || e?.message || e}`);
        return false;
    }
};

// 한 주문의 이력(오래된 것부터).
export const listTrxLogs = async (trans_id) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return [];
    try {
        // SELECT * — 메모 수정 시각(edited_at, 2026-11-06 마이그레이션)이 아직 없는 DB 에서도 그대로 돈다.
        const [rows] = await readPool.query(
            `SELECT * FROM transaction_status_logs WHERE trans_id=? ORDER BY id ASC`, [tid]);
        return rows.map((r) => ({ ...r, from_text: statusText(r.from_status), to_text: statusText(r.to_status) }));
    } catch (e) {
        if (e?.code === 'ER_NO_SUCH_TABLE') return [];
        logger.error(`[trx-log] 조회 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
        return [];
    }
};

// ── 취소 사유 ─────────────────────────────────────────────────────────────
// 취소 이력(kind=cancel)의 note 는 `<금액·수량 설명>[ / 사유: <사유>][ / 출고 후 취소(회수 확인)]` 꼴이다(cancel.js).
// 가맹점이 사유만 고칠 수 있게(2026-11-06 요청) 사유 부분만 떼고 붙인다 — 금액·수량 설명은 절대 바꾸지 않는다.
const 사유머리 = ' / 사유: ';
const 출고후꼬리 = ' / 출고 후 취소(회수 확인)';
export const 취소사유나누기 = (note) => {
    const s = String(note ?? '');
    const 뒤 = s.endsWith(출고후꼬리) ? 출고후꼬리 : '';
    const 몸 = 뒤 ? s.slice(0, -뒤.length) : s;
    const i = 몸.indexOf(사유머리);
    return i >= 0 ? { 앞: 몸.slice(0, i), 사유: 몸.slice(i + 사유머리.length), 뒤 } : { 앞: 몸, 사유: '', 뒤 };
};
export const 취소사유바꾸기 = (note, 새사유) => {
    const { 앞, 뒤 } = 취소사유나누기(note);
    return `${앞}${새사유 ? `${사유머리}${새사유}` : ''}${뒤}`;
};
