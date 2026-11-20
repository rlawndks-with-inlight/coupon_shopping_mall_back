-- ============================================================================
-- 결제 묶음 — 결제 한 번에 주문 여러 건(「여러 곳으로 보내기」)
-- 날짜: 2026-11-20  (사장님: 최대 10곳, 무료배송은 배송지별, 비회원도)
--
-- pay_group : 같은 결제로 만든 주문들의 결제 주문번호(G). 첫 배송지 주문은 ord_num=G, 나머지는 G-2 … G-10.
--             예전 주문·한 곳 주문은 NULL — 지금과 똑같이 「주문 한 건 = 결제 한 건」.
--             묶음은 주문번호 목록으로 찾으므로(utils.js/pay-group.js) 이 칸에 인덱스를 걸지 않는다.
--
-- 안전성: MySQL 8 의 ALGORITHM=INSTANT 로 칸만 덧붙인다(테이블 복사·잠금 없음, 445만 행이어도 즉시).
-- 코드는 이 칸이 없으면 「여러 곳으로 보내기」만 막고 나머지는 그대로 동작한다(hasColumn).
-- ⚠ hasColumn 은 「없음」을 프로세스 내내 기억한다 — 이 마이그레이션을 백엔드 재시작보다 먼저 돌릴 것.
-- ▶ 여러 번 돌려도 안전하다(이미 있으면 건너뜀).
-- ============================================================================
SET @있음 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'pay_group');
-- ⚠ 글자 정렬 방식을 ord_num 과 같게 만든다 — 표 기본값(general_ci)으로 두면 ord_num(unicode_ci)과 비교할 때
--   Illegal mix of collations 오류가 난다(처음엔 빠뜨려서 2026-11-20_pay_group_collation.sql 로 바로잡았다).
SET @주문번호정렬 := (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'ord_num');
SET @sql := IF(@있음 = 0,
  CONCAT('ALTER TABLE transactions ADD COLUMN pay_group VARCHAR(64) CHARACTER SET utf8mb4 COLLATE ', @주문번호정렬,
         ' NULL COMMENT ''결제 묶음 주문번호(여러 곳으로 보내기)'', ALGORITHM=INSTANT'),
  'SELECT ''pay_group 이미 있음'' AS 결과');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;

SELECT IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'pay_group'),'O','X') AS `pay_group 칸`;
