-- ============================================================================
-- transactions.password 컬럼 확장 (HeidiSQL용). 멱등·재실행 안전.
--
-- 배경:
--   현재 컬럼: varchar(8)
--   주문서 입력창: maxLength 20
--   → 비회원이 9자 이상을 입력하면 주문 INSERT 가
--     "Data too long for column 'password' at row 1" 로 실패해 결제가 500 으로 끝났다.
--     (사장님이 백엔드 로그에서 발견하신 그 에러)
--
-- 조치:
--   컬럼을 varchar(255) 로 넓힌다.
--   · 프론트 입력 제한은 6~16자로 별도 적용(OrderSheet.js GUEST_PW_MIN/MAX)
--   · 255 로 잡는 이유: 지금은 평문 비교라 16자면 충분하지만,
--     추후 해시(PBKDF2 등) 저장으로 전환할 때 컬럼을 또 바꾸지 않기 위함.
--
-- 데이터 손실 없음: varchar 확장은 기존 값을 그대로 보존한다.
--   (축소가 아니라 확장이므로 잘림이 발생하지 않음)
--
-- 롤백은 권장하지 않는다. 되돌리면 9자 이상 비밀번호가 잘려 주문조회가 불가능해진다.
--   되돌려야 한다면 먼저 SELECT MAX(CHAR_LENGTH(password)) FROM transactions; 로 확인할 것.
--
-- ※ 실행 전 백업:
--   mysqldump -u<user> -p <db> transactions > transactions_backup_20260807.sql
-- ============================================================================

-- ── 0) 현재 상태 확인 (변경 없음) ────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'transactions'
  AND COLUMN_NAME = 'password';

-- 기존 데이터의 최대 길이 (확장 전 참고용)
SELECT COUNT(*) AS 전체주문수,
       SUM(CASE WHEN password IS NULL OR password = '' THEN 1 ELSE 0 END) AS 회원주문_빈값,
       MAX(CHAR_LENGTH(password)) AS 현재최대길이
FROM transactions;

-- ── 1) 컬럼 확장 (이미 255 이상이면 건너뜀) ─────────────────────────────────
SET @cur_len := (
  SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'password'
);
SET @ddl := IF(@cur_len IS NULL OR @cur_len < 255,
  'ALTER TABLE transactions MODIFY COLUMN password VARCHAR(255) NULL DEFAULT NULL',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- ── 2) 사후 확인 ─────────────────────────────────────────────────────────────
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'transactions'
  AND COLUMN_NAME = 'password';
