'use strict';
import axios from 'axios';
import crypto from 'crypto';

/**
 * 페이레터(PayLetter) 결제 연동 헬퍼 (테스트 모듈)
 * 문서: https://www.payletter.com/ko/technical/index
 *
 * 인증정보는 .env 가 아니라 payment_modules 테이블에 저장한다.
 *   - MID   컬럼 = client_id      (예: 테스트 가맹점 "pay_test")
 *   - 결제키 컬럼 = 결제(PAYMENT) API 키
 *   - TID   컬럼 = 조회(SEARCH)  API 키
 * (pay.controller 에서 브랜드별 모듈을 읽어 아래 함수에 client_id/payment_key 로 넘긴다.)
 *
 * 인증 헤더:  Authorization: PLKEY <api_key>
 */

// 결제 API 엔드포인트
//  - 테스트: https://testpgapi.payletter.com
//  - 운영  : https://pgapi.payletter.com   ← 운영 전환 시 이 값으로 변경
export const PAYLETTER_API_URL = 'https://testpgapi.payletter.com';

const jsonHeaders = (api_key) => ({
    'Content-Type': 'application/json',
    Authorization: `PLKEY ${api_key}`,
});

/**
 * 결제요청 (POST /v1.0/payments/request)
 * @returns {Promise<{token:number, online_url:string, mobile_url:string}>}
 */
export const requestPayment = async ({
    client_id, payment_key, pgcode = 'creditcard',
    user_id, user_name, order_no, amount, product_name,
    return_url, callback_url, custom_parameter,
} = {}) => {
    const body = {
        pgcode,
        client_id,
        user_id: String(user_id ?? ''),
        user_name: user_name ?? '',
        order_no: String(order_no ?? ''),
        amount: parseInt(amount, 10) || 0,
        product_name: (product_name ?? '상품').toString().slice(0, 100),
        email_flag: 'N',
        return_url,
        callback_url,
        custom_parameter: String(custom_parameter ?? ''),
    };
    const { data } = await axios.post(
        `${PAYLETTER_API_URL}/v1.0/payments/request`,
        body,
        { headers: jsonHeaders(payment_key) }
    );
    return data;
};

/**
 * 거래상태 조회 (POST /v1.0/payments/status)
 * status_code: 1:생성 2:진입 3:인증 4:실패 5:완료
 */
export const getStatusByOrderNo = async ({ client_id, payment_key, order_no } = {}) => {
    const body = { client_id, order_no: String(order_no ?? '') };
    const { data } = await axios.post(
        `${PAYLETTER_API_URL}/v1.0/payments/status`,
        body,
        { headers: jsonHeaders(payment_key) }
    );
    return data;
};

/**
 * 전체취소 (POST /v1.0/payments/cancel)
 */
export const cancelPayment = async ({ client_id, payment_key, user_id, tid, ip_addr, pgcode = 'creditcard' } = {}) => {
    const body = {
        client_id,
        user_id: String(user_id ?? ''),
        tid: String(tid ?? ''),
        ip_addr: (ip_addr || '127.0.0.1').toString(),
        pgcode,
    };
    const { data } = await axios.post(
        `${PAYLETTER_API_URL}/v1.0/payments/cancel`,
        body,
        { headers: jsonHeaders(payment_key) }
    );
    return data;
};

/**
 * 콜백/리턴 위변조 검증용 해시.
 * 페이레터 규격: Sha256(user_id + amount + tid + payment_api_key)
 * (본 구현은 상태조회 API를 1차 검증 수단으로 사용한다.)
 */
export const makeCallbackHash = ({ user_id, amount, tid, payment_key } = {}) => {
    const raw = `${user_id}${amount}${tid}${payment_key}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
};

export default {
    PAYLETTER_API_URL,
    requestPayment,
    getStatusByOrderNo,
    cancelPayment,
    makeCallbackHash,
};
