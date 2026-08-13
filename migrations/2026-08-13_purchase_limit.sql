-- ============================================================================
-- 한정판 — 1인당 구매 개수 제한
-- 날짜: 2026-08-13
--
-- 재고 제한은 2026-08-13_option_renewal.sql 로 이미 된다(상품·옵션·조합 재고).
-- 여기서 더하는 것은 '한 사람이 몇 개까지 살 수 있는가' 다.
--
-- ⚠ 제한을 걸면 그 상품은 **회원만** 살 수 있다.
--   비회원은 같은 사람인지 확인할 방법이 없어서, 제한을 걸어도 지켜지지 않는다.
--   (전화번호로 세는 방법도 있지만 번호만 바꾸면 그만이다)
--   네이버 스마트스토어가 이 문제를 회피하는 방식과 같다 — 거기는 비회원 구매 자체가 없다.
--   제한을 안 건 상품은 지금처럼 비회원도 그대로 산다.
--
-- 세는 기준: 취소되지 않은 그 회원의 주문에 실린 이 상품의 수량 합.
--   결제대기도 센다 — 한정 상품은 '덜 세서 초과 판매' 보다 '더 세서 막는' 쪽이 안전하다.
--   (버려진 결제대기는 cleanup-abandoned 스케줄러가 지운다)
--
-- ▶ 여러 번 돌려도 안전하다.
-- ============================================================================

SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='purchase_limit'),
  'SELECT ''products.purchase_limit 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE products ADD COLUMN purchase_limit INT NULL DEFAULT NULL COMMENT ''1인당 최대 구매 수량. NULL=제한 없음. 값이 있으면 회원만 구매 가능''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 회원별 구매 수량을 셀 때 쓰는 조회 경로.
-- transaction_orders(product_id) 인덱스는 sql/indexes_for_scale.sql 에 이미 있고,
-- transactions 쪽은 user_id 로 좁혀야 한다.
SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='transactions'
                         AND INDEX_NAME='idx_trx_user_cancel'),
  'SELECT ''idx_trx_user_cancel 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE transactions ADD INDEX idx_trx_user_cancel (user_id, is_cancel, is_delete)');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 확인 -----------------------------------------------------------------------
SELECT 'products.purchase_limit' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='products' AND COLUMN_NAME='purchase_limit'),'O','X') AS 결과
UNION ALL SELECT 'idx_trx_user_cancel',
       IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='transactions' AND INDEX_NAME='idx_trx_user_cancel'),'O','X');

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- ALTER TABLE transactions DROP INDEX idx_trx_user_cancel;
-- ALTER TABLE products     DROP COLUMN purchase_limit;
