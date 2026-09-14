-- ============================================================================
-- 상품후기 다시 켜기 ① 저장 구조 — 구매 확인·숨김·답글·사진 여러 장
-- 날짜: 2026-09-14  (설계: ShopGo 후기·별점 설계 §5)
--
-- 2026-08-07 에 후기를 감춘 이유가 「구매 확인 없음·설정 스위치 없음·누구나 작성」이었다.
-- 이 파일은 그중 저장 구조를 채운다. 컬럼을 더하기만 하므로 **코드 배포 전에 먼저 돌려도 안전**하다
-- (예전 코드는 새 컬럼을 모르고, 새 코드는 컬럼이 없으면 쓰기를 막고 읽기는 옛 모양으로 돈다).
--   order_id      주문 줄(transaction_orders.id) — 후기는 '산 상품 한 줄'에 붙는다. 줄당 1건(UNIQUE).
--   option_text   작성 시점의 옵션 문구 복사(나중에 옵션이 바뀌어도 후기는 그대로)
--   images        사진 URL 배열(JSON 문자열, 최대 5장). 예전 한 장짜리 content_img 는 그대로 둔다.
--   is_hidden     관리자 숨김·신고 누적·주문 취소로 내려간 후기(집계 제외). 삭제(is_delete)와 다르다.
--   reply_*       판매자 답글 1개
--   helpful_count / report_count / is_best  — 2단계(도움돼요·신고·BEST)용 자리. 지금은 0.
--   rewrite_count 삭제 뒤 같은 주문 줄에 다시 쓴 횟수(1회만 허용)
--
-- 별점 눈금 변환(2~10 → 1~5)은 ② 2026-09-14_product_reviews_scope.sql 에 따로 있다 —
-- 그건 집계(AVG(scope)/2 → AVG(scope)) 코드 배포와 **같은 자리에서** 돌려야 한다.
-- ▶ 여러 번 돌려도 안전하다.
-- ============================================================================

SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_reviews' AND COLUMN_NAME='order_id'),
  'SELECT ''product_reviews.order_id 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE product_reviews
     ADD COLUMN order_id      BIGINT NULL COMMENT ''transaction_orders.id — 산 상품 한 줄'',
     ADD COLUMN option_text   VARCHAR(200) NULL COMMENT ''작성 시점 옵션 문구'',
     ADD COLUMN images        TEXT NULL COMMENT ''사진 URL 배열(JSON), 최대 5장'',
     ADD COLUMN is_hidden     TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''1=손님 화면·집계에서 제외'',
     ADD COLUMN hidden_reason VARCHAR(100) NULL,
     ADD COLUMN reply_content TEXT NULL COMMENT ''판매자 답글'',
     ADD COLUMN reply_user_id INT NULL,
     ADD COLUMN replied_at    DATETIME NULL,
     ADD COLUMN helpful_count INT NOT NULL DEFAULT 0,
     ADD COLUMN report_count  INT NOT NULL DEFAULT 0,
     ADD COLUMN is_best       TINYINT(1) NOT NULL DEFAULT 0,
     ADD COLUMN rewrite_count TINYINT NOT NULL DEFAULT 0 COMMENT ''삭제 뒤 다시 쓴 횟수'',
     ADD UNIQUE KEY uk_product_reviews_order (order_id),
     ADD INDEX idx_product_reviews_visible (product_id, is_delete, is_hidden, is_best)');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 확인 -----------------------------------------------------------------------
SELECT 'product_reviews.order_id' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='product_reviews' AND COLUMN_NAME='order_id'),'O','X') AS 결과
UNION ALL SELECT 'product_reviews.is_hidden',
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='product_reviews' AND COLUMN_NAME='is_hidden'),'O','X')
UNION ALL SELECT 'uk_product_reviews_order',
       IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='product_reviews' AND INDEX_NAME='uk_product_reviews_order'),'O','X');

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- ALTER TABLE product_reviews DROP INDEX uk_product_reviews_order, DROP INDEX idx_product_reviews_visible,
--   DROP COLUMN order_id, DROP COLUMN option_text, DROP COLUMN images, DROP COLUMN is_hidden, DROP COLUMN hidden_reason,
--   DROP COLUMN reply_content, DROP COLUMN reply_user_id, DROP COLUMN replied_at, DROP COLUMN helpful_count,
--   DROP COLUMN report_count, DROP COLUMN is_best, DROP COLUMN rewrite_count;
