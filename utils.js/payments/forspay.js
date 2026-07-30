'use strict';
import axios from 'axios';
import crypto from 'crypto';

/**
 * 포스페이(Forspay) External API (SAMW) 연동 헬퍼 — 인증결제(direct_pg_ui)
 * 문서: 협력사 제공 external-api (checkout session → PG 결제창 → return/webhook)
 *
 * 인증정보는 payment_modules 테이블(trx_type=41)에 저장:
 *   - 결제키(pay_key) = Forspay App key  (Authorization: Bearer {app_key})
 *   - MID            = pg_provider_id (선택, 특정 PG 고정용. 비우면 포스페이 자동 라우팅)
 *   - TID            = sign_key (선택, 웹훅 서명 검증용)
 *
 * ★ Base URL: 테스트 호스트 = https://api.forspay.net (2026-07-30 협력사 제공, ping 200 확인).
 *   운영 호스트가 다를 수 있으니 전환 시 이 상수(또는 env FORSPAY_API_BASE) 교체.
 *   ※ 경로 주의: 문서에는 /api/v1/samw/... 로 돼 있으나 실제 서버는 samw 없이 /api/v1/... 로 동작함(실측 확인).
 */
export const FORSPAY_API_BASE = process.env.FORSPAY_API_BASE || 'https://api.forspay.net';

const authHeaders = (app_key) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${app_key}`,
});

// ─────────────────────────────────────────────────────────────
// 포스페이 결제수단 카탈로그 — 프론트 노출 + 백엔드 파라미터 매핑의 공용 단일 소스
//   pg_method_id: 0=신용카드 1=실시간계좌이체 3=간편결제(+route) 5=해외결제(+foreign_method)
//   route(간편결제): 0=카카오 1=네이버 3=라인   /   foreign_method(해외): card/alipay/wechat
//   pending=true 는 협력사 확인 전이라 기본 비활성 (삼성페이: route 값 미정)
// ─────────────────────────────────────────────────────────────
export const FORSPAY_METHODS = [
    { key: 'card',         label: '신용카드',        pg_method_id: 0 },
    { key: 'bank',         label: '실시간계좌이체',  pg_method_id: 1 },
    { key: 'kakaopay',     label: '카카오페이',      pg_method_id: 3, route: 0 },
    { key: 'naverpay',     label: '네이버페이',      pg_method_id: 3, route: 1 },
    { key: 'linepay',      label: '라인페이',        pg_method_id: 3, route: 3 },
    { key: 'foreign_card', label: '해외발행카드',    pg_method_id: 5, foreign_method: 'card' },
    { key: 'wechat',       label: '위챗페이',        pg_method_id: 5, foreign_method: 'wechat' },
    { key: 'alipay',       label: '알리페이',        pg_method_id: 5, foreign_method: 'alipay' },
    { key: 'samsungpay',   label: '삼성페이',        pg_method_id: 3, route: null, pending: true },
];
export const getForspayMethod = (key) => FORSPAY_METHODS.find((m) => m.key === String(key || '')) || null;

// 체크아웃 세션 생성 (POST /api/v1/checkout/sessions) — direct_pg_ui
export const createSession = async ({
    app_key, base = FORSPAY_API_BASE,
    amount, item_name, buyer_name, ord_num,
    pg_method_id = 0, pg_provider_id, route, foreign_method, return_url,
    user_agent = 'WP', buyer_phone, buyer_email, billaddrcity,
    payment_currency = 'KRW', currency, order_currency,
} = {}) => {
    const body = {
        checkout_mode: 'direct_pg_ui',
        amount: parseInt(amount, 10) || 0,
        item_name: (item_name ?? '상품').toString().slice(0, 100),
        buyer_name: (buyer_name ?? '').toString().slice(0, 50),
        ord_num: String(ord_num ?? ''),
        pg_method_id,
        return_url,
        user_agent,
        payment_currency,
    };
    if (pg_provider_id !== undefined && pg_provider_id !== null && String(pg_provider_id).trim() !== '') {
        body.pg_provider_id = parseInt(pg_provider_id, 10);
    }
    // 간편결제(pg_method_id=3) 하위 서비스: route (0=카카오 1=네이버 3=라인 …)
    if (route !== undefined && route !== null && String(route).trim() !== '') {
        body.route = parseInt(route, 10);
    }
    // 해외결제(pg_method_id=5) 하위 수단 및 통화/청구지
    if (foreign_method) body.foreign_method = String(foreign_method);
    if (currency) body.currency = String(currency).slice(0, 4);
    if (order_currency) body.order_currency = String(order_currency).slice(0, 4);
    if (buyer_email) body.buyer_email = String(buyer_email).slice(0, 100);   // 해외 카드 권장
    if (billaddrcity) body.billaddrcity = String(billaddrcity).slice(0, 100); // 해외 카드 청구지
    if (buyer_phone) body.buyer_phone = String(buyer_phone).slice(0, 20);
    const { data } = await axios.post(`${base}/api/v1/checkout/sessions`, body, { headers: authHeaders(app_key) });
    return data;
};

// launch payload 조회 (POST /checkout/sessions/{order_code}/pay) — create가 launch_page_url을 안 주면 사용
export const getLaunch = async ({ app_key, base = FORSPAY_API_BASE, order_code, return_url, user_agent = 'WP' } = {}) => {
    const body = {};
    if (return_url) body.return_url = return_url;
    if (user_agent) body.user_agent = user_agent;
    const { data } = await axios.post(`${base}/api/v1/checkout/sessions/${order_code}/pay`, body, { headers: authHeaders(app_key) });
    return data;
};

// 거래 조회 (GET /api/v1/transactions/{ord_num}?cxl_seq=0) — status: approved / cancelled
export const getTransaction = async ({ app_key, base = FORSPAY_API_BASE, ord_num, cxl_seq = 0 } = {}) => {
    const { data } = await axios.get(
        `${base}/api/v1/transactions/${encodeURIComponent(ord_num)}?cxl_seq=${cxl_seq}`,
        { headers: authHeaders(app_key) }
    );
    return data;
};

// 거래 취소 (POST /api/v1/transactions/{ord_num}/cancel). amount 생략 시 전액취소.
export const cancelTransaction = async ({ app_key, base = FORSPAY_API_BASE, ord_num, amount } = {}) => {
    const body = {};
    if (amount !== undefined && amount !== null && String(amount).trim() !== '') body.amount = parseInt(amount, 10);
    const { data } = await axios.post(
        `${base}/api/v1/transactions/${encodeURIComponent(ord_num)}/cancel`,
        body,
        { headers: authHeaders(app_key) }
    );
    return data;
};

// 웹훅 서명 검증 (선택) — sign_key 설정 시.
//   signature = SHA256("sign_key=" + sign_key + "&timestamp=" + timestamp + "&mid=" + mid)
export const verifyWebhookSignature = ({ sign_key, timestamp, mid, signature } = {}) => {
    if (!sign_key || !signature) return false;
    const raw = `sign_key=${sign_key}&timestamp=${timestamp}&mid=${mid}`;
    const expected = crypto.createHash('sha256').update(raw).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false; // 길이 불일치 시 timingSafeEqual 예외 방지
    return crypto.timingSafeEqual(a, b);
};

export default {
    FORSPAY_API_BASE,
    createSession,
    getLaunch,
    getTransaction,
    cancelTransaction,
    verifyWebhookSignature,
};
