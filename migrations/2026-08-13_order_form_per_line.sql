-- ============================================================================
-- 주문서 추가 입력항목을 '주문 1건당' → '주문 줄(상품)당' 으로 바꾼다
-- 날짜: 2026-08-13
--
-- 왜 바꾸나:
--   처음에는 주문서에서 한 번만 입력받게 만들었다(공용 주문서 한 곳만 고치면 돼서).
--   그런데 참고한 네이버 화면은 **상품상세에서 상품마다** 받는다.
--   실제로 갈리는 지점:
--     · 예약 아닌 상품만 산 고객에게도 행사일을 묻는다
--     · 날짜가 다른 두 상품을 한 번에 담으면 날짜를 하나밖에 못 받는다
--     · 장바구니에 담기 전에 물어야 하는데 결제 직전에 물었다
--   그래서 입력 위치를 상품상세로 옮기고, 값도 주문 줄에 붙인다.
--
-- ⚠ 실행 전 DB 백업. 다만 이 테이블은 2026-08-13 에 만든 신규 테이블이고
--   아직 값이 없으므로(주문이 들어온 적 없음) 사실상 무해하다.
--
-- 선행: 2026-08-13_order_form_fields.sql 이 먼저 실행돼 있어야 한다.
-- ============================================================================

ALTER TABLE transaction_order_forms
  ADD COLUMN product_id INT NULL     COMMENT '어느 상품 줄의 입력인지 (transaction_orders.product_id)',
  ADD COLUMN line_index INT NOT NULL DEFAULT 0 COMMENT '한 주문에 같은 상품이 옵션만 달리 두 줄 담길 수 있다 — 그 순번';

-- 주문 상세를 열 때 줄별로 묶어 보여주려면 이 순서로 읽는다.
ALTER TABLE transaction_order_forms
  ADD INDEX idx_trx_order_form_line (trans_id, line_index, sort);

-- 확인 -----------------------------------------------------------------------
--   SHOW COLUMNS FROM transaction_order_forms;

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- ALTER TABLE transaction_order_forms
--   DROP INDEX idx_trx_order_form_line,
--   DROP COLUMN line_index,
--   DROP COLUMN product_id;
