-- ============================================================================
-- pay_group 칸의 글자 정렬 방식을 주문번호(ord_num)와 맞춘다
-- 날짜: 2026-11-20  (2026-11-20_pay_group.sql 바로 뒤에 돌린다)
--
-- 왜: transactions 표의 기본 정렬 방식은 utf8mb4_general_ci 인데 ord_num 칸만 utf8mb4_unicode_ci 다.
--     처음 만든 pay_group 은 표 기본값(general_ci)을 받아서, 「묶음의 첫 주문」 조건(ord_num = pay_group)이
--     Illegal mix of collations 오류를 냈다(배포 중 백엔드 재시작 전에 조회 시간을 재다가 발견).
-- 어떻게: 칸이 비어 있을 때만 지우고(INSTANT) ord_num 과 같은 정렬 방식으로 다시 만든다(INSTANT).
--     값이 하나라도 있으면 손대지 않고 알리기만 한다 — 그때는 사람이 판단한다.
-- ▶ 여러 번 돌려도 안전하다(이미 맞으면 건너뜀). 표 복사·잠금 없음.
-- ============================================================================
SET @주문번호정렬 := (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
                       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'ord_num');
SET @묶음정렬 := (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'pay_group');
SET @다름 := (@묶음정렬 IS NOT NULL AND @주문번호정렬 IS NOT NULL AND @묶음정렬 <> @주문번호정렬);

-- 값이 있는지(다를 때만 센다)
SET @sql := IF(@다름, 'SELECT COUNT(*) INTO @값있음 FROM transactions WHERE pay_group IS NOT NULL', 'SELECT 0 INTO @값있음');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;
SET @고칠것 := (@다름 AND @값있음 = 0);

SET @sql := IF(@고칠것, 'ALTER TABLE transactions DROP COLUMN pay_group, ALGORITHM=INSTANT', 'SELECT ''지우기 건너뜀'' AS 결과');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;

SET @sql := IF(@고칠것,
  CONCAT('ALTER TABLE transactions ADD COLUMN pay_group VARCHAR(64) CHARACTER SET utf8mb4 COLLATE ', @주문번호정렬,
         ' NULL COMMENT ''결제 묶음 주문번호(여러 곳으로 보내기)'', ALGORITHM=INSTANT'),
  'SELECT ''다시 만들기 건너뜀'' AS 결과');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;

SELECT
  (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'ord_num') AS `ord_num 정렬`,
  (SELECT COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'pay_group') AS `pay_group 정렬`,
  IF(@다름 AND @값있음 > 0, '값이 있어 손대지 않음 — 확인 필요', '확인') AS 상태;
