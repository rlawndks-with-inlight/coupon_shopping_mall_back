'use strict';
import { readPool } from "../config/db-pool.js";
import { statusText } from "./trx-log.js";

// 회원 탈퇴를 막아야 하는가 — 진행 중인 주문이 있으면 막는다(2026-09-17 결정).
//
// [왜 막나]
//  탈퇴하면 로그인이 막힌다. 그런데 **회원 주문은 주문비밀번호가 빈 값**이라
//  (pay.controller: "회원 주문은 password 가 빈 값이라 그대로 '' 로 저장된다")
//  비회원 주문조회로도 그 주문을 찾을 수 없다 — 탈퇴하는 순간 손님이 자기 주문을
//  확인할 길이 아예 사라진다. 배송 중에 탈퇴하면 교환·반품도 손님 스스로 못 한다.
//  홈앤쇼핑·무신사 등도 '주문/배송/취소/교환/반품 진행중'이면 즉시 탈퇴를 막는다.
//
// [어디까지 막나]
//  배송완료(25)는 **막지 않는다.** 교환·반품 기간까지 막으면 마지막 주문 뒤 일주일은
//  무조건 탈퇴가 안 되는데, 그건 개정 전자상거래법 제21조의2 의 '취소·탈퇴 등의 방해'
//  쪽으로 읽힐 수 있다. 결제실패/미완료(-1)는 애초에 주문이 아니라 제외된다.
export const 진행중상태 = [0, 1, 5, 10, 15, 20];

// [영영 못 나가는 일은 없어야 한다]
//  작은 몰은 배송이 끝나도 상태를 안 바꾸고 「결제완료」로 놔두는 곳이 많다.
//  그런 주문 하나가 남아 있으면 손님은 몇 년이 지나도 탈퇴할 수 없게 된다 —
//  그 자체가 '탈퇴 방해'다. 그래서 **최근 주문만** 막는다.
//  오래된 건은 진행 중이 아니라 가맹점의 장부가 안 닫힌 것으로 본다.
export const 막는기간일 = 90;

// '버려진 결제대기' — 결제창만 열고 승인이 안 난 건. 손님 화면에서도 주문으로 치지 않으므로
// 탈퇴도 막지 않는다. transaction.controller 의 HIDE_ABANDONED_PENDING 과 같은 규칙이다.
const 버려진결제대기 = ` AND NOT (t.trx_status=0 AND (t.appr_num IS NULL OR t.appr_num='')
    AND (t.virtual_acct_num IS NULL OR t.virtual_acct_num='') AND t.trx_method IN (2,4,21,30,31,40,41)) `;

/**
 * 탈퇴를 막는 주문들. 없으면 빈 배열.
 * 주문번호·상태만 돌려준다 — 이름·연락처 같은 개인정보는 담지 않는다.
 */
export const 탈퇴막는주문 = async (user_id, brand_id) => {
    const uid = Number(user_id) || 0;
    const bid = Number(brand_id) || 0;
    if (!uid) return [];
    try {
        const [rows] = await readPool.query(
            `SELECT t.id, t.ord_num, t.trx_status, t.created_at
               FROM transactions t
              WHERE t.user_id=? ${bid ? 'AND t.brand_id=?' : ''}
                AND t.is_cancel=0 AND t.is_cancel_trans=0
                AND t.trx_status IN (${진행중상태.join(',')})
                AND t.created_at >= DATE_SUB(NOW(), INTERVAL ${막는기간일} DAY)
                ${버려진결제대기}
              ORDER BY t.id DESC LIMIT 20`,
            bid ? [uid, bid] : [uid]);
        return rows.map((r) => ({
            id: r.id,
            ord_num: r.ord_num,
            trx_status: Number(r.trx_status),
            status_text: statusText(Number(r.trx_status)),
            created_at: r.created_at,
        }));
    } catch (e) {
        // 조회가 깨졌다고 탈퇴를 막아 버리면 손님이 영영 못 나간다 — 그건 '탈퇴 방해'다.
        // 못 세면 막지 않는다.
        return [];
    }
};

/** 남은 적립금. 탈퇴하면 사라지므로 미리 알려 주기 위한 값(막지는 않는다). */
export const 남은적립금 = async (user_id, brand_id) => {
    const uid = Number(user_id) || 0;
    const bid = Number(brand_id) || 0;
    if (!uid) return 0;
    try {
        const [[row]] = await readPool.query(
            `SELECT COALESCE(SUM(point), 0) AS point FROM points WHERE user_id=? ${bid ? 'AND brand_id=?' : ''}`,
            bid ? [uid, bid] : [uid]);
        return Math.max(0, Number(row?.point) || 0);
    } catch (e) {
        return 0;
    }
};

/** 화면과 서버가 같은 문구를 쓴다. 왜 막혔는지 알려 주고, 푸는 길도 같이 말한다. */
export const 막힘안내 = (orders = []) => {
    const n = orders.length;
    if (!n) return '';
    const 첫 = orders[0];
    const 꼬리 = n > 1 ? ` 외 ${n - 1}건` : '';
    return `진행 중인 주문이 있어 지금은 탈퇴하실 수 없습니다. (${첫?.ord_num || ''} ${첫?.status_text || ''}${꼬리})`
        + ' 배송이 끝난 뒤에 다시 시도하시거나, 주문을 취소한 뒤 탈퇴해 주세요.';
};
