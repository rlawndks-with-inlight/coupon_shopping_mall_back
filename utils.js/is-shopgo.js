'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// SHOPGO 본사 브랜드 판별 (백엔드용).
// ⚠ 프론트 src/utils/is-shopgo.js 와 반드시 동일하게 유지할 것.
//   한쪽만 바뀌면 프론트에 노출된 화면을 백엔드가 거부(또는 그 반대)하는 사고가 난다.
//
// dns = checkDns(req.cookies.dns) 의 반환값(brands 행이 그대로 서명된 JWT payload).
//   dns.id        = brands.id
//   dns.parent_id = brands.parent_id (본사면 0/null)
// ─────────────────────────────────────────────────────────────────────────────

export const SHOPGO_MASTER_ID = 98; // shopgo 본사 브랜드 id

// shopgo 본사(98) 또는 그 산하 가맹점(parent_id=98)
export const isShopgoBrand = (dns) =>
    Number(dns?.id) === SHOPGO_MASTER_ID || Number(dns?.parent_id) === SHOPGO_MASTER_ID;

// shopgo 산하 '가맹점'만 (본사 제외) — 가맹점 전용 기능(보안질문 기반 아이디찾기/비밀번호 재설정 등)에 사용
export const isShopgoMerchant = (dns) => Number(dns?.parent_id) === SHOPGO_MASTER_ID;
