-- ============================================================================
-- PII 암호화 컬럼 폭 확장 (Phase 4 긴급 후속)
-- 날짜: 2026-07-29
--
-- ▶ 증상: DB_ENCRYPTION_KEY 설정(암호화 ON) 이후 회원가입/주문/주소저장 실패
--     Error: ER_DATA_TOO_LONG (1406) "Data too long for column 'name' at row 1"
--     INSERT INTO users(... name ...) VALUES('enc:v1:2zCtM...')  ← 암호문이 들어감
--
-- ▶ 원인: AES-256-GCM 암호문은 `enc:v1:<iv>:<tag>:<ct>` 형식이라 원문보다 길다.
--     2026-07-28_pii_blind_index.sql 은 *_idx 컬럼만 추가했고,
--     "실제 암호화되는 원본 컬럼"(pii.js PII_FIELDS)은 넓히지 않아 폭이 부족했다.
--     짧은 이름조차 암호문은 ~60자, 넉넉히 잡아 255. 주소는 더 길어 1024.
--
-- ▶ 조치: PII 암호화 대상 컬럼을 암호문 크기로 확장. widening(확장)이라 기존 데이터는
--     잘리지 않는다(안전). 코드 변경/재배포 불필요 — 이 SQL만 실행하면 즉시 복구.
--
-- ⚠ 실행 전 백업(공유 DB). transactions 는 전 프로젝트 공용이라 대용량일 수 있고,
--   VARCHAR을 255 초과로 바꾸면 테이블 재작성(COPY)이 필요 → 트래픽 적은 시간에 실행 권장.
--   ※ 만약 transactions/user_addresses 확장에서 "Row size too large" 가 나오면
--     해당 addr/detail_addr 두 컬럼만 VARCHAR(1024) 대신 TEXT 로 바꿔 실행(파일 하단 대안 참고).
--
-- ▶ 선행: PII 컬럼에 걸린 FULLTEXT 인덱스 먼저 제거해야 MODIFY 가능(에러 1283 방지).
--   ft_user_search(users: name,phone_num), ft_transaction_search(transactions: buyer_name,buyer_phone)
--   → 암호화된 컬럼 위 fulltext는 무의미(암호문 검색 불가). 정확검색은 *_idx(블라인드 인덱스)로 대체됨.
--   (buyer_name / phone_number 의 BTREE 인덱스는 MODIFY를 막지 않으므로 유지 — 무해, 추후 정리)
-- ============================================================================

-- 0) 암호화로 무의미해진 FULLTEXT 인덱스 제거 (MODIFY 차단 원인)
ALTER TABLE users        DROP INDEX ft_user_search;
ALTER TABLE transactions DROP INDEX ft_transaction_search;

-- 회원: 실명 + 전화번호
ALTER TABLE users
  MODIFY COLUMN name      VARCHAR(255) NULL,
  MODIFY COLUMN phone_num VARCHAR(255) NULL;

-- 주문(주문자/배송지) — 전 프로젝트 공용, 대용량 가능(재작성 주의)
ALTER TABLE transactions
  MODIFY COLUMN buyer_name     VARCHAR(255)  NULL,
  MODIFY COLUMN buyer_phone    VARCHAR(255)  NULL,
  MODIFY COLUMN addr           VARCHAR(1024) NULL,
  MODIFY COLUMN detail_addr    VARCHAR(1024) NULL,
  MODIFY COLUMN receiver       VARCHAR(255)  NULL COMMENT '배송지 받는사람',
  MODIFY COLUMN receiver_phone VARCHAR(255)  NULL COMMENT '배송지 연락처';

-- 주소록
ALTER TABLE user_addresses
  MODIFY COLUMN addr        VARCHAR(1024) NULL,
  MODIFY COLUMN detail_addr VARCHAR(1024) NULL,
  MODIFY COLUMN receiver    VARCHAR(255)  NULL COMMENT '받는사람',
  MODIFY COLUMN phone       VARCHAR(255)  NULL COMMENT '연락처';

-- 전화 허용목록(가입 허락 전화번호)
ALTER TABLE phone_registration
  MODIFY COLUMN phone_number VARCHAR(255) NULL;

-- 확인용(실행 후):
--   SHOW COLUMNS FROM users LIKE 'name';        -- Type 이 varchar(255) 인지
--   SHOW COLUMNS FROM users LIKE 'phone_num';
--   그리고 실제로 회원가입/주문 재시도

-- ============================================================================
-- 대안: "Row size too large" 발생 시 주소 컬럼만 TEXT 로 (VARCHAR 대신):
--   ALTER TABLE transactions   MODIFY COLUMN addr TEXT NULL, MODIFY COLUMN detail_addr TEXT NULL;
--   ALTER TABLE user_addresses MODIFY COLUMN addr TEXT NULL, MODIFY COLUMN detail_addr TEXT NULL;
--
-- 롤백은 별도 불필요(확장은 안전). 원복이 꼭 필요하면 원래 폭으로 MODIFY 하되,
--   이미 암호문이 저장된 뒤라면 축소 시 잘림 위험 → 축소 전 반드시 확인.
-- ============================================================================
