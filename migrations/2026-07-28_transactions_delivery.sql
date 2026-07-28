-- ============================================================================
-- 주문(transactions) 확장 — 배송지 받는사람·연락처·우편번호 저장
-- 날짜: 2026-07-28
--
-- ⚠⚠ 실행 순서 중요 ⚠⚠
--   이 ALTER를 "백엔드 배포보다 먼저" 실행해야 합니다.
--   컬럼이 없는 상태로 새 pay.controller(receiver 등 포함)가 배포되면
--   insertQuery가 'Unknown column' 에러 → 전 브랜드 주문 생성 실패 위험.
--   순서: (1) 이 SQL 실행  →  (2) 백엔드 배포.
--
-- ⚠ 공유 DB(transactions는 전 프로젝트 공용). 다만 NULL 허용 추가 컬럼이라
--   기존 행·다른 프로젝트 insert에는 무해(안 보내면 NULL).
-- 실행 전 백업 권장:
--   mysqldump -h 211.45.163.83 -u inuk -p comagain_shop transactions > transactions_backup_20260728.sql
-- ============================================================================

ALTER TABLE transactions
  ADD COLUMN receiver       VARCHAR(50) NULL COMMENT '배송지 받는사람',
  ADD COLUMN receiver_phone VARCHAR(30) NULL COMMENT '배송지 연락처',
  ADD COLUMN zonecode       VARCHAR(10) NULL COMMENT '우편번호';

-- 확인용:
--   SHOW COLUMNS FROM transactions LIKE 'receiver%';
--   SHOW COLUMNS FROM transactions LIKE 'zonecode';

-- ============================================================================
-- 롤백 (필요 시에만):
-- ALTER TABLE transactions
--   DROP COLUMN receiver,
--   DROP COLUMN receiver_phone,
--   DROP COLUMN zonecode;
-- ============================================================================
