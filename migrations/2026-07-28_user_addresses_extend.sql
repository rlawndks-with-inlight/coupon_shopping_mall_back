-- ============================================================================
-- 주소록(user_addresses) 확장 — 주문서(체크아웃) 백본용
-- 목적: 받는사람·연락처·우편번호·배송지구분·기본배송지 저장
-- 날짜: 2026-07-28
--
-- ⚠ 실행 전 반드시 DB 백업 (공유 DB 이므로 필수):
--     mysqldump -u inuk -p comagain_shop user_addresses > user_addresses_backup_20260728.sql
--
-- 안전성: 모두 NULL 허용 / DEFAULT 있는 "추가 컬럼"이라 기존 행·다른 프로젝트에 무해.
--         (컬럼을 추가만 하므로 기존 INSERT/SELECT 는 그대로 동작)
-- 기존 컬럼: id, brand_id, user_id, addr, detail_addr (+ 공통 메타)
-- ============================================================================

ALTER TABLE user_addresses
  ADD COLUMN receiver     VARCHAR(50)  NULL COMMENT '받는사람',
  ADD COLUMN phone        VARCHAR(30)  NULL COMMENT '연락처',
  ADD COLUMN zonecode     VARCHAR(10)  NULL COMMENT '우편번호',
  ADD COLUMN address_type VARCHAR(30)  NULL COMMENT '배송지 구분(집/회사 등)',
  ADD COLUMN is_default   TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '기본배송지 여부';

-- 확인용:
--   SHOW COLUMNS FROM user_addresses;

-- ============================================================================
-- 롤백 (필요 시에만):
-- ALTER TABLE user_addresses
--   DROP COLUMN receiver,
--   DROP COLUMN phone,
--   DROP COLUMN zonecode,
--   DROP COLUMN address_type,
--   DROP COLUMN is_default;
-- ============================================================================
