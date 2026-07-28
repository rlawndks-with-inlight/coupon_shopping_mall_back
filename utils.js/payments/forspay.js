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
 * ★ Base URL: 협력사(포스페이)가 발급하는 공개 API 호스트({oms-host})로 교체하세요.
 *   테스트/운영 호스트가 다릅니다. 값을 받으면 아래 상수(또는 env FORSPAY_API_BASE)만 바꾸면 됩니다.
 */
export const FORSPAY_API_BASE = process.env.FORSPAY_API_BASE || 'https://REPLACE_WITH_OMS_HOST';

const authHeaders = (app_key) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${app_key}`,
});

// 체크아웃 세션 생성 (POST /api/v1/samw/checkout/sessions) — direct_pg_ui
export const createSession = async ({
    app_key, base = FORSPAY_API_BASE,
    amount, item_name, buyer_name, ord_num,
    pg_method_id = 0, pg_provider_id, return_url,
    user_agent = 'WP', buyer_phone, payment_currency = 'KRW',
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
    if (buyer_phone) body.buyer_phone = String(buyer_phone).slice(0, 20);
    const { data } = await axios.post(`${base}/api/v1/samw/checkout/sessions`, body, { headers: authHeaders(app_key) });
    return data;
};

// launch payload 조회 (POST /checkout/sessions/{order_code}/pay) — create가 launch_page_url을 안 주면 사용
export const getLaunch = async ({ app_key, base = FORSPAY_API_BASE, order_code, return_url, user_agent = 'WP' } = {}) => {
    const body = {};
    if (return_url) body.return_url = return_url;
    if (user_agent) body.user_agent = user_agent;
    const { data } = await axios.post(`${base}/api/v1/samw/checkout/sessions/${order_code}/pay`, body, { headers: authHeaders(app_key) });
    return data;
};

// 거래 조회 (GET /api/v1/samw/transactions/{ord_num}?cxl_seq=0) — status: approved / cancelled
export const getTransaction = async ({ app_key, base = FORSPAY_API_BASE, ord_num, cxl_seq = 0 } = {}) => {
    const { data } = await axios.get(
        `${base}/api/v1/samw/transactions/${encodeURIComponent(ord_num)}?cxl_seq=${cxl_seq}`,
        { headers: authHeaders(app_key) }
    );
    return data;
};

// 거래 취소 (POST /api/v1/samw/transactions/{ord_num}/cancel). amount 생략 시 전액취소.
export const cancelTransaction = async ({ app_key, base = FORSPAY_API_BASE, ord_num, amount } = {}) => {
    const body = {};
    if (amount !== undefined && amount !== null && String(amount).trim() !== '') body.amount = parseInt(amount, 10);
    const { data } = await axios.post(
        `${base}/api/v1/samw/transactions/${encodeURIComponent(ord_num)}/cancel`,
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
