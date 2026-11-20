-- ============================================================================
-- 주문할 때의 배송비 규칙 — 주문에 남기는 칸 하나
-- 날짜: 2026-11-20  (사장님: 부분취소 배송비를 주문 당시 기준으로)
--
-- ship_policy : 주문할 때 몰의 배송비 규칙 {"base":3000,"free_min":30000} (JSON 글자)
--               부분취소로 무료배송 기준이 깨졌는지 이 값으로 판단한다(cancel.js 배송비규칙).
--               비어 있으면(이 칸이 생기기 전 주문) 지금 몰 설정을 쓴다 — 예전과 같은 동작.
--
-- 안전성: MySQL 8 의 ALGORITHM=INSTANT 로 칸만 덧붙인다(테이블 복사·잠금 없음).
--         INSTANT 가 안 되면 ALTER 가 바로 실패하고 아무것도 바뀌지 않는다.
-- 코드는 이 칸이 없어도 동작한다(pay.controller·cancel.js 가 hasColumn 으로 확인).
-- ⚠ hasColumn 은 「없음」을 프로세스 내내 기억한다 — 이 마이그레이션을 백엔드 재시작보다 먼저 돌릴 것.
-- ▶ 여러 번 돌려도 안전하다(이미 있으면 건너뜀).
-- ============================================================================
SET @있음 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'ship_policy');
SET @sql := IF(@있음 = 0,
  'ALTER TABLE transactions ADD COLUMN ship_policy VARCHAR(100) NULL COMMENT ''주문 당시 배송비 규칙 {base,free_min}'', ALGORITHM=INSTANT',
  'SELECT ''ship_policy 이미 있음'' AS 결과');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;

SELECT IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'ship_policy'),'O','X') AS `ship_policy 칸`;
