'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PII(개인정보) 암호화 중앙 설정 + 헬퍼.
// - crypto-util은 키 없으면 평문 그대로 통과(무해) → 이 코드를 배포해도 키 설정 전엔 아무 일 없음.
// - 저장(encForSave): 대상 필드 암호화 + 원문 기준 blind-index 컬럼 세팅.
// - 읽기(decRow/decRows): 대상 필드 복호화(평문/암호문 자동판별).
// - blindIndex: 정확일치/조회/JOIN용 결정적 인덱스.
// 롤아웃: 이중기록(저장 암호화+idx) & 읽기 복호화 → 백필 → 검색/조회를 idx로 전환.
// ─────────────────────────────────────────────────────────────────────────────
import { encField, decField, blindIndex } from './crypto-util.js';

// 테이블별: enc=암호화 대상 필드, idx=원문의 blind-index를 담을 컬럼 매핑
export const PII_FIELDS = {
    users: {
        enc: ['name', 'phone_num'],
        idx: { name: 'name_idx', phone_num: 'phone_idx' },
    },
    transactions: {
        enc: ['buyer_name', 'buyer_phone', 'addr', 'detail_addr', 'receiver', 'receiver_phone'],
        idx: { buyer_name: 'buyer_name_idx', buyer_phone: 'buyer_phone_idx' },
    },
    user_addresses: {
        enc: ['addr', 'detail_addr', 'receiver', 'phone'],
        idx: {},
    },
    phone_registration: {
        enc: ['phone_number'],
        idx: { phone_number: 'phone_idx' },
    },
};

// 저장 직전 obj의 PII를 암호화 + blind-index 컬럼 세팅(원문 기준). 새 obj 반환(얕은 복사).
// 부분 업데이트 지원: obj에 있는 필드만 처리.
export const encForSave = (table, obj) => {
    const conf = PII_FIELDS[table];
    if (!conf || !obj) return obj;
    const out = { ...obj };
    for (const f of conf.enc) {
        if (!(f in out)) continue;
        const v = out[f];
        if (v === undefined || v === null || v === '') continue;
        // 들어온 값은 원문(사용자 입력) 기준. 이미 암호문이면 idx는 백필이 처리하므로 건너뜀.
        if (conf.idx[f] && !String(v).startsWith('enc:')) out[conf.idx[f]] = blindIndex(v);
        out[f] = encField(v);
    }
    return out;
};

// 읽은 행의 PII 복호화(in-place). null-safe.
export const decRow = (table, row) => {
    const conf = PII_FIELDS[table];
    if (!conf || !row) return row;
    for (const f of conf.enc) if (f in row) row[f] = decField(row[f]);
    return row;
};
export const decRows = (table, rows) => {
    if (Array.isArray(rows)) rows.forEach((r) => decRow(table, r));
    return rows;
};

// getSelectQueryList 결과({ content: [...] }) 편의 복호화.
export const decListContent = (table, data) => {
    if (data && Array.isArray(data.content)) decRows(table, data.content);
    return data;
};

export { blindIndex, encField, decField };
export default { PII_FIELDS, encForSave, decRow, decRows, decListContent, blindIndex, encField, decField };
