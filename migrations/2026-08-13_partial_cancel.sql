-- ============================================================================
-- 부분취소 — 주문 '줄' 단위로 취소할 수 있게 한다
-- 날짜: 2026-08-13
--
-- 왜 필요한가:
--   지금 취소는 주문 전체뿐이다. 상품 a 1개 + 상품 b 2개를 담아 주문했을 때
--   'a 만 취소' 나 'b 1개만 취소' 가 불가능하다.
--   전체 주문 240만 건 중 28%(67만 건)가 상품 2줄 이상이라 드문 상황이 아니다.
--
--   막고 있던 건 PG 가 아니라 우리 데이터 모델이다.
--   포스페이는 부분취소를 지원한다 — cancel API 의 amount 가 선택 파라미터이고
--   (생략 시 전액), 조회의 cxl_seq 가 "취소 순번(0=원승인, 부분취소는 1,2,…)" 이다.
--   즉 여러 번 나눠 취소하는 것까지 된다.
--
--   반면 transaction_orders(주문 한 줄)에는 **취소를 적을 칸이 하나도 없었다**.
--   취소 상태는 주문(transactions)에만 있어서, 줄 하나가 취소됐다는 사실을 남길 수 없다.
--   네이버가 '주문번호' 아래 '상품주문번호'를 따로 두는 이유가 이것이다.
--
-- 설계 요지:
--   · 줄에 취소 수량·금액을 쌓고, 주문 상태는 **줄들을 합쳐 계산**한다.
--     (주문에 '부분취소' 상태를 따로 저장하면 줄 합계와 어긋날 수 있다)
--   · 취소 한 건마다 원장(transaction_cancels)을 남긴다.
--     줄의 누적값만 있으면 '두 번 눌러 두 번 취소' 와 '한 번에 2개 취소' 를 구분할 수 없고,
--     PG 취소 순번(cxl_seq)과 우리 취소를 짝지을 수도 없다.
--   · 기존 is_cancel_trans 는 그대로 둔다. **전체가 다 취소됐을 때만** 세운다.
--     지금 돌아가는 목록·매출 집계 쿼리를 건드리지 않기 위해서다.
--
-- ⚠ 실행 전 DB 백업 (다른 프로젝트와 공유하는 DB):
--     mysqldump -u <user> -p <db> > backup_before_partial_cancel_20260813.sql
--
-- 안전성: 전부 '더하기'다. 기본값이 0/NULL 이라 SQL 만 돌려도 지금 동작이 그대로다.
-- ▶ 여러 번 돌려도 안전하다.
-- ============================================================================

-- (1) 주문 줄에 취소 누적값 ------------------------------------------------------
SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='transaction_orders' AND COLUMN_NAME='cancel_count'),
  'SELECT ''transaction_orders.cancel_count 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE transaction_orders ADD COLUMN cancel_count INT NOT NULL DEFAULT 0 COMMENT ''취소된 수량(누적). order_count 를 넘을 수 없다''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='transaction_orders' AND COLUMN_NAME='cancel_amount'),
  'SELECT ''transaction_orders.cancel_amount 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE transaction_orders ADD COLUMN cancel_amount INT NOT NULL DEFAULT 0 COMMENT ''취소된 금액(누적, 원)''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='transaction_orders' AND COLUMN_NAME='canceled_at'),
  'SELECT ''transaction_orders.canceled_at 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE transaction_orders ADD COLUMN canceled_at DATETIME NULL DEFAULT NULL COMMENT ''마지막 취소 시각''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- (2) 취소 원장 -----------------------------------------------------------------
--   취소 한 번 = 한 행. 누가·언제·어느 줄을·몇 개·얼마에 취소했는지.
--
--   idem_key: 관리자 화면이 클릭마다 만들어 보내는 값. UNIQUE 라 같은 클릭이
--   두 번 도착해도 두 번째는 DB 가 막는다. 취소는 실제 환불이라 이중 실행이
--   곧 이중 환불이다 — 화면 단의 버튼 잠금만 믿을 수 없다.
--   (MySQL UNIQUE 는 NULL 중복을 막지 않으므로, 키 없이 들어온 옛 호출은 걸리지 않는다)
CREATE TABLE IF NOT EXISTS transaction_cancels (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trans_id      INT          NOT NULL          COMMENT 'transactions.id (원주문)',
    order_id      BIGINT       NOT NULL          COMMENT 'transaction_orders.id (어느 줄)',
    product_id    BIGINT       NULL              COMMENT '조회 편의용 사본',
    cancel_count  INT          NOT NULL          COMMENT '이번에 취소한 수량',
    cancel_amount INT          NOT NULL          COMMENT '이번에 취소한 금액(서버가 계산한 값)',
    delivery_fee  INT          NOT NULL DEFAULT 0 COMMENT '이번 취소에 포함된 배송비',
    cxl_seq       INT          NULL              COMMENT 'PG 취소 순번 (포스페이 cxl_seq)',
    pg_result     TEXT         NULL              COMMENT 'PG 응답 원문 — 분쟁 때 이것만 남는다',
    reason        VARCHAR(255) NULL,
    user_id       INT          NULL              COMMENT '실행한 관리자',
    idem_key      VARCHAR(64)  NULL              COMMENT '중복 실행 방지 키',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cancel_idem (idem_key),
    INDEX idx_cancel_trans (trans_id),
    INDEX idx_cancel_order (order_id)
);

-- (3) 재고 원장에 '어느 취소 건인지' ---------------------------------------------
--   지금 UNIQUE 는 (trans_id, kind, product_id, option_id, combo_id) 다.
--   전체취소는 주문당 한 번이라 이걸로 충분했지만, 부분취소는 **한 주문에서 여러 번**
--   복구가 일어난다. cancel_id 를 UNIQUE 에 넣지 않으면 첫 부분취소가 'in' 자리를
--   차지해 **두 번째부터 재고가 안 돌아온다**.
--   전체취소는 cancel_id=0 을 쓰므로 기존 행·기존 동작이 그대로다.
SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_stock_moves' AND COLUMN_NAME='cancel_id'),
  'SELECT ''product_stock_moves.cancel_id 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE product_stock_moves ADD COLUMN cancel_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''transaction_cancels.id. 전체취소·차감은 0''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- UNIQUE 를 갈아끼운다. 기존 키를 먼저 지우고 cancel_id 를 포함해 다시 만든다.
SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_stock_moves'
                         AND INDEX_NAME='uq_stock_move_v2'),
  'SELECT ''uq_stock_move_v2 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE product_stock_moves
     DROP INDEX uq_stock_move,
     ADD UNIQUE KEY uq_stock_move_v2 (trans_id, kind, product_id, option_id, combo_id, cancel_id)');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- (4) 포인트 원장에 '어느 취소 건인지' -------------------------------------------
--   포인트도 같은 이유다. 지금 멱등성은 '원장 역산'(적립총액 − 이미회수)으로 만드는데,
--   부분취소를 여러 번 하면 각 회차가 별개 행이어야 추적이 된다.
--   note 로 구분하고 있었지만 문자열이라 조회가 약하다.
SET @sql := IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS
                       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='points' AND COLUMN_NAME='cancel_id'),
  'SELECT ''points.cancel_id 이미 있음 — 건너뜀'' AS 안내',
  'ALTER TABLE points ADD COLUMN cancel_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''transaction_cancels.id. 전체취소·적립은 0''');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 확인 -----------------------------------------------------------------------
SELECT 'transaction_orders.cancel_count' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='transaction_orders' AND COLUMN_NAME='cancel_count'),'O','X') AS 결과
UNION ALL SELECT 'transaction_orders.cancel_amount',
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='transaction_orders' AND COLUMN_NAME='cancel_amount'),'O','X')
UNION ALL SELECT 'transaction_cancels 테이블',
       IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='transaction_cancels'),'O','X')
UNION ALL SELECT 'product_stock_moves.cancel_id',
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='product_stock_moves' AND COLUMN_NAME='cancel_id'),'O','X')
UNION ALL SELECT 'uq_stock_move_v2 (cancel_id 포함)',
       IF(EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='product_stock_moves' AND INDEX_NAME='uq_stock_move_v2'),'O','X')
UNION ALL SELECT 'points.cancel_id',
       IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='points' AND COLUMN_NAME='cancel_id'),'O','X');

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- ALTER TABLE points DROP COLUMN cancel_id;
-- ALTER TABLE product_stock_moves
--   DROP INDEX uq_stock_move_v2,
--   ADD UNIQUE KEY uq_stock_move (trans_id, kind, product_id, option_id, combo_id),
--   DROP COLUMN cancel_id;
-- DROP TABLE IF EXISTS transaction_cancels;
-- ALTER TABLE transaction_orders
--   DROP COLUMN canceled_at, DROP COLUMN cancel_amount, DROP COLUMN cancel_count;
