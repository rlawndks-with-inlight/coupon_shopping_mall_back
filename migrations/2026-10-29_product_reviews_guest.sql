-- ============================================================================
-- 상품후기 ④ 비회원 구매자 후기 — 가린 주문자 이름 칸
-- 날짜: 2026-10-29  (사장님 결정: 비회원 구매자도 비회원 주문조회로 본인 확인 후 후기 작성, 기본 켜짐)
--
-- 비회원 후기는 user_id=0 으로 저장되고, 작성자 표시는 주문자 이름을 가린 모양(김**)으로 이 칸에 적는다.
-- 주문자 이름은 transactions 에 암호화돼 있어 목록을 띄울 때마다 풀지 않으려고 작성 때 한 번만 적어 둔다.
--
-- 코드 배포 전에 돌려도 안전하다(칸만 추가, 기존 행은 NULL). 두 번 돌려도 안전하다.
-- 이 칸이 없으면 서버는 비회원 후기 쓰기를 '준비 중'으로 막는다(회원 후기는 영향 없음).
-- ============================================================================

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_reviews' AND COLUMN_NAME='guest_name');
SET @sql := IF(@has = 0,
  'ALTER TABLE product_reviews ADD COLUMN guest_name VARCHAR(30) NULL DEFAULT NULL COMMENT ''비회원 후기 작성자 표시(가린 주문자 이름)''',
  'SELECT ''guest_name 이미 있음 — 건너뜀'' AS 안내');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 확인 -----------------------------------------------------------------------
SELECT '비회원 작성자 칸(guest_name)' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_reviews' AND COLUMN_NAME='guest_name'), 'O', 'X') AS 결과;

-- 되돌리기(필요할 때만) ---------------------------------------------------------
-- ALTER TABLE product_reviews DROP COLUMN guest_name;
