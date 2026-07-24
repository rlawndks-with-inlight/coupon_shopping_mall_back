# 개인정보(PII) DB 암호화 설계 (확정 · 구현 보류)

> 2026-07-24 확정. 실 운영 다중 브랜드 DB(jjpay·glamup·babypop·minbeautym 등 실제 고객 데이터 공존)라 신중 진행. **설계만 확정, 구현·마이그레이션은 보류.**

## 1. 암호화 방식 (기반 구현 완료)

`utils.js/crypto-util.js` — 라운드트립/블라인드인덱스 12개 테스트 통과. 아무 데서도 아직 import 안 함(미사용, 무해).

- **`encField(v)`**: AES-256-GCM + 랜덤 IV → `enc:v1:<iv>:<tag>:<ct>`(base64). 프리픽스로 암호화 여부 식별. 빈값/이미 암호문/키없음은 그대로(멱등·안전).
- **`decField(v)`**: 평문(프리픽스 없음)은 그대로 통과, 암호문만 복호화 → **롤아웃 중 평문/암호문 혼재 안전**.
- **`encFields/decFields(obj, keys)`**: 객체 지정 키 일괄 처리.
- **`blindIndex(v)`**: 정확일치 조회/JOIN용 HMAC-SHA256(숫자/영문만 정규화). **부분(LIKE) 검색 불가, 정확일치만**.
- **env(백엔드 .env, 사장님 관리)**: `DB_ENCRYPTION_KEY`(32바이트, `openssl rand -base64 32`) 필수, `DB_INDEX_KEY`(선택). 키 없으면 encField가 평문 유지 → 서비스 중단 없음.
- ⚠️ 기존 `ENCRYPTION_KEY`(hecto PG 전송용, 고정 IV)는 재사용 금지 — 별도 키.

## 2. 검색 영향 요약

- **계좌번호**: 코드 어디서도 검색·조회·JOIN·JWT에 안 씀 → 암호화해도 **영향 0**.
- **전화번호**: 정확일치(로그인·비번찾기·JOIN)는 **블라인드 인덱스로 유지**, **부분검색(관리자 LIKE)만 불가**. → 뒤 §4 결정 필요.

## 3. Phase 1a — 계좌번호 (저위험, 우선)

대상: `users.acct_num`, `users.acct_name`, `seller.acct_num/acct_name`, `transactions.acct_num`(환불계좌).

- **쓰기(암호화)**: user.controller create(obj ~146-153)/update(~200-207), auth.controller signUp(insert ~186-201), seller.controller create/update, pay.controller ready(insert ~106-131) → 해당 키에 `encField`.
- **읽기(복호화)**: 위 행을 반환/표시하는 곳 — user.controller get/list, seller get/list, (sign-in 응답에 계좌 포함 시) → `decField`. 관리자 회원/셀러 편집 화면이 get으로 조회해 표시.
- **검색/조회/블라인드인덱스**: 불필요.
- **마이그레이션**: users·sellers·transactions 순회하며 `encField`(멱등) 후 UPDATE.

## 4. Phase 1b — 전화번호 (고위험)

대상: `users.phone_num` (+ `phone_registration.phone_number`는 JOIN 때문에 함께).

- **스키마 변경(additive)**: `users.phone_num_idx VARCHAR(64)`, `phone_registration.phone_number_idx VARCHAR(64)` 추가.
- **쓰기**: phone_num `encField` + `phone_num_idx = blindIndex(phone_num)`. (user/auth/seller 쓰기 지점 전부)
- **정확일치 조회 → 인덱스로 교체**:
  - auth.controller:382/387/425 `WHERE phone_num=?` → `WHERE phone_num_idx = blindIndex(?)`.
  - phone_registration JOIN(:28) `phone_number = registered_user.phone_num` → `phone_number_idx = registered_user.phone_num_idx`.
  - phone_registration 자체 조회(:40/61/86/119 `WHERE phone_number=?`) → `phone_number_idx`.
  - phone_check_tokens는 단명(短命) 토큰이라 평문 유지 → 거기서 꺼낸 번호로 `blindIndex` 계산해 users 조회.
- **JWT**(auth.controller:67 `phone_num: user.phone_num`): 토큰 넣기 전에 `decField`로 평문화(프론트 표시용).
- **읽기(복호화)**: user get/list 및 전화 표시 지점 `decField`.
- **관리자 검색(search-columns.js users의 phone_num)**: §아래 결정에 따름.
- **알림톡/발송**: users.phone_num 사용 지점은 발송 직전 `decField`.
- **마이그레이션**: users.phone_num 암호화 + idx 채움, phone_registration.phone_number 암호화 + idx 채움. 멱등.

### 결정 보류(전화 부분검색) — 구현 시 확정
- **A. 정확일치만**: blindIndex로 전체번호 정확검색만. 부분검색 포기. (가장 깔끔)
- **B. 뒤 4자리 평문 컬럼**: `phone_last4`로 뒷자리 부분검색 유지 + 나머지 암호화. (절충)
- **C. 전화 검색 제거**: 이름/아이디로만.

## 5. Phase 2 — 주소·주문자정보 (후순위)

대상: `transactions.buyer_name/buyer_phone/addr/detail_addr/card_num`, `user_addresses.addr/detail_addr`(+ **Redis 평문 캐시**).

- buyer_name/buyer_phone는 search-columns.js에서 관리자 주문검색 LIKE 대상 → §4와 동일 트레이드오프.
- 알림톡(transaction.controller)이 buyer_name/buyer_phone/addr 사용 → 발송 직전 복호화.
- user_address.controller의 Redis 캐시가 주소 평문 저장 → 암호화 또는 캐시 중단.
- 주문내역/주문서 표시 지점 다수(공용 백본 재구축과 함께 정리하면 효율적).

## 6. 무중단 적용 순서 (구현 재개 시)

1. `.env`에 `DB_ENCRYPTION_KEY`(+`DB_INDEX_KEY`) 추가 — 사장님.
2. (1b/2) 스키마 컬럼 추가(additive, 안전).
3. 백엔드 코드 배포(암호화 쓰기 + 복호화 읽기 + idx 쓰기 + 조회 idx화). **읽기가 평문도 통과**하므로 기존 평문 행 정상 동작.
4. **DB 백업**(mysqldump) — 사장님, 필수.
5. 마이그레이션 스크립트 실행(멱등) — 서버에서 1회.
6. 검증: 로그인·비번찾기·검색·표시 스팟체크.

## 7. 선행조건(사장님)
- `.env` 키 추가, DB 백업, 마이그레이션 실행(스크립트는 구현 단계에서 제공).
