-- ============================================================================
-- 제주·도서산간 추가배송비 — 주문에 판정과 금액을 남기는 칸 두 개
-- 날짜: 2026-11-12  (사장님 결정: 몰마다 제주/제주 외 도서산간 「추가비 없음·받기·배송 안 함」)
--
-- island_region : 주문할 때의 판정('jeju' | 'island', 일반·해외는 NULL)
-- island_fee    : 그 주문에 붙은 추가배송비(원). 줄 배송비(transaction_orders.delivery_fee)에도 들어 있다 —
--                 이 칸은 「그중 얼마가 추가비였나」를 남겨 관리자 표시·부분취소 판정(cancel.js)에 쓴다.
--
-- 안전성: MySQL 8 의 ALGORITHM=INSTANT 로 칸만 덧붙인다(테이블 복사·잠금 없음, 400만 행이어도 즉시 끝).
--         INSTANT 가 안 되면 ALTER 가 바로 실패하고 아무것도 바뀌지 않는다(복사 방식으로 넘어가지 않는다).
-- 코드는 이 칸이 없어도 동작한다(pay.controller·cancel.js 가 hasColumn 으로 확인).
-- ▶ 여러 번 돌려도 안전하다(이미 있으면 건너뜀).
-- ============================================================================
SET @있음 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'island_fee');
SET @sql := IF(@있음 = 0,
  'ALTER TABLE transactions ADD COLUMN island_region VARCHAR(10) NULL COMMENT ''제주·도서산간 판정(jeju/island)'', ADD COLUMN island_fee INT NOT NULL DEFAULT 0 COMMENT ''제주·도서산간 추가배송비(원)'', ALGORITHM=INSTANT',
  'SELECT ''island_fee 이미 있음'' AS 결과');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;

SELECT IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'island_fee'),'O','X') AS `island_fee 칸`;
