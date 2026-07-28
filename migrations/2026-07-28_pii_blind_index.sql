-- ============================================================================
-- PII 암호화용 blind-index 컬럼 추가 (Phase 4)
-- 날짜: 2026-07-28
--
-- 목적: 이름·전화번호를 암호화(AES-256-GCM, 랜덤 IV)하면 그 컬럼으로는
--       정확검색/JOIN/로그인 조회가 불가능해진다. 이를 대체할 결정적(HMAC) 인덱스.
--   blindIndex(값) = HMAC-SHA256 hex(64자). 정확일치·JOIN·로그인용.
--
-- ⚠ 실행 순서 / 안전:
--   - 이 DDL은 NULL 허용 추가 컬럼 + 인덱스 → 기존 행·다른 프로젝트에 무해.
--   - 실행 전 DB 전체 백업 필수(공유 DB 실고객 데이터).
--   - 이 컬럼들은 백필 전까지 비어 있음(NULL). 검색을 여기로 전환하는 건 백필 완료 후.
--   - '1681 Integer display width deprecated' 경고는 기존 정수컬럼 때문 → 무시(에러 아님).
--
-- 백필: 앱의 백필 스크립트가 기존 행을 읽어 enc + idx를 채운다(멱등).
-- ============================================================================

-- 회원: 실명 + 전화번호
ALTER TABLE users
  ADD COLUMN name_idx  CHAR(64) NULL,
  ADD COLUMN phone_idx CHAR(64) NULL,
  ADD INDEX idx_users_name_idx (name_idx),
  ADD INDEX idx_users_phone_idx (phone_idx);

-- 주문자: 이름 + 전화번호
ALTER TABLE transactions
  ADD COLUMN buyer_name_idx  CHAR(64) NULL,
  ADD COLUMN buyer_phone_idx CHAR(64) NULL,
  ADD INDEX idx_trx_buyer_name_idx (buyer_name_idx),
  ADD INDEX idx_trx_buyer_phone_idx (buyer_phone_idx);

-- 전화 허용목록/JOIN: users.phone_num 과 동일 스킴으로 매칭되어야 JOIN 유지
ALTER TABLE phone_registration
  ADD COLUMN phone_idx CHAR(64) NULL,
  ADD INDEX idx_phonereg_phone_idx (phone_idx);

-- 확인용:
--   SHOW COLUMNS FROM users LIKE '%_idx';
--   SHOW COLUMNS FROM transactions LIKE 'buyer_%_idx';
--   SHOW COLUMNS FROM phone_registration LIKE 'phone_idx';

-- ============================================================================
-- 롤백 (필요 시에만):
-- ALTER TABLE users DROP INDEX idx_users_name_idx, DROP INDEX idx_users_phone_idx,
--   DROP COLUMN name_idx, DROP COLUMN phone_idx;
-- ALTER TABLE transactions DROP INDEX idx_trx_buyer_name_idx, DROP INDEX idx_trx_buyer_phone_idx,
--   DROP COLUMN buyer_name_idx, DROP COLUMN buyer_phone_idx;
-- ALTER TABLE phone_registration DROP INDEX idx_phonereg_phone_idx, DROP COLUMN phone_idx;
-- ============================================================================
