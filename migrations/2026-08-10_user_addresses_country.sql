-- ============================================================================
-- 배송지 국가 구분 — 국내배송 / 해외배송 토글용
-- 날짜: 2026-08-10
--
-- 목적: 주소 입력 방식을 국가로 가른다.
--   국내(KR) → 지금 그대로 다음 우편번호 팝업(행정안전부 도로명주소 DB, 무료·무제한)
--   해외      → 팝업 대신 자유입력(국가·주소·도시·주/지역·우편번호)
--
-- 왜 다음 우편번호를 국내에 계속 쓰나:
--   택배 송장 출력과 통관 신고에 쓰는 것은 행안부 표준 도로명주소 + 5자리 우편번호다.
--   다음 우편번호 서비스는 그 DB 를 직접 받아 갱신한다. 해외 주소 자동완성 API 는
--   자체 DB 라 표기가 다르고 한국 우편번호가 없거나 구 번호가 오는 경우가 있어,
--   국내 주문 주소를 그쪽으로 바꾸면 택배사 시스템이 못 읽는다.
--
-- ⚠ 실행 전 반드시 DB 백업 (공유 DB 이므로 필수):
--     mysqldump -u <user> -p <db> user_addresses > user_addresses_backup_20260810.sql
--
-- 안전성: NULL 허용 + DEFAULT 있는 "추가 컬럼"이라 기존 행·다른 프로젝트에 무해하다.
--         기존 주소는 전부 국내이므로 DEFAULT 'KR' 로 그대로 국내 취급된다.
-- ============================================================================

ALTER TABLE user_addresses
  ADD COLUMN country_code  VARCHAR(2)   NOT NULL DEFAULT 'KR' COMMENT '배송 국가 ISO 코드(KR=국내)',
  ADD COLUMN country_name  VARCHAR(60)  NULL     COMMENT '국가명 표시용(해외배송)',
  ADD COLUMN city          VARCHAR(100) NULL     COMMENT '도시(해외배송)',
  ADD COLUMN state_region  VARCHAR(100) NULL     COMMENT '주/지역(해외배송)';

-- 주문에도 같은 정보를 남긴다. 주소록은 나중에 수정·삭제될 수 있으므로
-- '그때 어디로 보내기로 했는지'는 주문 자체에 박혀 있어야 한다.
ALTER TABLE transactions
  ADD COLUMN country_code  VARCHAR(2)   NOT NULL DEFAULT 'KR' COMMENT '배송 국가 ISO 코드(KR=국내)',
  ADD COLUMN country_name  VARCHAR(60)  NULL     COMMENT '국가명 표시용(해외배송)',
  ADD COLUMN city          VARCHAR(100) NULL     COMMENT '도시(해외배송)',
  ADD COLUMN state_region  VARCHAR(100) NULL     COMMENT '주/지역(해외배송)';

-- 확인용:
--   SHOW COLUMNS FROM user_addresses LIKE 'country%';
--   SHOW COLUMNS FROM transactions LIKE 'country%';
--   SELECT country_code, COUNT(*) FROM user_addresses GROUP BY country_code;

-- ============================================================================
-- 롤백 (필요 시에만):
-- ALTER TABLE user_addresses
--   DROP COLUMN country_code, DROP COLUMN country_name,
--   DROP COLUMN city, DROP COLUMN state_region;
-- ALTER TABLE transactions
--   DROP COLUMN country_code, DROP COLUMN country_name,
--   DROP COLUMN city, DROP COLUMN state_region;
-- ============================================================================
