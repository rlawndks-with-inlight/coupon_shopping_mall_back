// 쿠키 없이 온 조회(GET)는 앞단이 알려 준 몰 주소(X-Shop-Dns)로 몰을 정한다(2026-11-23).
//
// 왜: API 는 「어느 몰 요청인가」를 dns 쿠키로 정한다(/api/domain 이 발급). 네이버 검색 로봇(Yeti)은
//   화면의 자바스크립트까지 돌리지만 받은 쿠키를 다음 요청에 싣지 않는다 — 그래서 몰 첫 화면의
//   /api/shop 이 매번 500 이었고, 로봇에게는 몰이 기본 배너·메뉴 없음·상품 없음으로, 상품 목록은
//   「검색결과가 없습니다」로 보였다(11/18 서버 기록, 같은 조건으로 화면 재현). 구글 로봇·손님은 쿠키를 실어 정상.
//
// 어떻게: 쿠키가 없거나 못 쓰는 GET 요청에 X-Shop-Dns 머리말이 있으면 /api/domain 과 같은 방법(몰찾기)으로
//   몰을 찾아 그 몰 dns 토큰을 req.cookies.dns 에 넣어 준다. 응답 쿠키는 만들지 않는다(이번 요청에만 쓴다).
//   머리말은 프론트 src/utils/axios.js 가 접속한 주소로 모든 요청에 붙인다(src/utils/visit-dns.js).
//
// 안전: 몰 정보는 누구나 /api/domain?dns=… 로 받을 수 있는 공개 정보라, 머리말로 몰을 고르는 것은
//   쿠키를 받는 것과 같은 일이다. 조회(GET·HEAD)에만 쓰고, index.js 에서 「몰 불일치」 검사보다 앞에 둬서
//   로그인한 관리자가 머리말로 남의 몰을 고르면 그 검사에 그대로 걸린다.
import { checkDns, makeDnsToken, 공개용브랜드 } from "./util.js";
import { 몰찾기 } from "../controllers/domain.controller.js";
import { redisClient } from "../config/redis-client.js";

export const 몰주소머리말 = 'x-shop-dns';
const 주소모양 = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

// /api/domain 과 같은 캐시(domain:<dns>, 5분)를 같이 쓴다.
const 몰읽기 = async (dns) => {
  const 키 = `domain:${dns}`;
  if (redisClient?.isOpen) {
    try {
      const c = await redisClient.get(키);
      if (c) return 공개용브랜드(JSON.parse(c));
    } catch (e) { /* 캐시 문제면 DB 로 */ }
  }
  const brand = await 몰찾기(dns);
  if (!brand) return null;
  brand.ssr_content = {};
  if (redisClient?.isOpen) {
    try { await redisClient.set(키, JSON.stringify(brand), { EX: 300 }); } catch (e) { /* 무시 */ }
  }
  return 공개용브랜드(brand);
};

export const 쿠키없는조회 = async (req, res, next) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (checkDns(req.cookies?.dns)) return next();
    const dns = String(req.get(몰주소머리말) || '').trim().toLowerCase();
    if (dns.length > 253 || !주소모양.test(dns)) return next();
    const brand = await 몰읽기(dns);
    if (brand?.id > 0) req.cookies = { ...(req.cookies || {}), dns: makeDnsToken(brand) };
  } catch (e) {
    // 못 찾으면 예전처럼(쿠키 없음) 흘려보낸다 — 이 단계 때문에 요청이 실패하면 안 된다.
  }
  return next();
};
