-- ============================================================================
-- 고객 부분 취소요청 — 어느 상품을 몇 개 취소하고 싶은지 남긴다
-- 날짜: 2026-08-14
--
-- 지금 고객 취소요청은 transactions.trx_status 를 1(취소요청)로 바꾸는 게 전부다.
-- 무엇을 취소하고 싶은지 적을 자리가 없어서, 관리자는 주문 전체를 취소하거나
-- 고객에게 따로 물어봐야 했다.
--
-- 취소(transaction_cancels)와 요청(이 테이블)은 다른 것이다:
--   요청 — 고객의 의사. 돈이 안 움직인다. 관리자가 확인하고 승인하거나 거절한다.
--   취소 — 실제 환불. PG 가 움직이고 재고·포인트가 따라 움직인다.
-- 한 테이블에 섞으면 '요청만 하고 아직 환불 안 된 건'을 매출에서 빼야 할지 알 수 없다.
--
-- 비회원 주문은 취소요청을 할 수 없다(지금도 그렇다 — 본인 확인이 안 된다).
-- 비회원은 고객센터로 연락하는 경로가 남아 있다.
--
-- 안전성: 새 테이블 하나만 만든다. 기존 테이블·데이터를 건드리지 않는다.
-- ▶ 여러 번 돌려도 안전하다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS transaction_cancel_requests (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trans_id     INT          NOT NULL          COMMENT 'transactions.id',
    order_id     BIGINT       NOT NULL          COMMENT 'transaction_orders.id (어느 줄)',
    req_count    INT          NOT NULL          COMMENT '고객이 취소해 달라고 한 수량',
    reason       VARCHAR(255) NULL              COMMENT '고객이 적은 사유',
    -- 0=요청(대기) 1=처리완료 2=거절
    -- 거절도 남긴다. 지우면 '요청한 적 없다'와 구분이 안 돼 분쟁 때 근거가 없다.
    status       TINYINT      NOT NULL DEFAULT 0,
    user_id      INT          NULL              COMMENT '요청한 고객',
    cancel_id    BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '처리됐다면 transaction_cancels.id',
    admin_note   VARCHAR(255) NULL              COMMENT '거절 사유 등 관리자 메모',
    processed_at DATETIME     NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cancel_req_trans (trans_id, status),
    INDEX idx_cancel_req_order (order_id)
);

-- 확인 -----------------------------------------------------------------------
SELECT 'transaction_cancel_requests 테이블' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='transaction_cancel_requests'),'O','X') AS 결과;

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- DROP TABLE IF EXISTS transaction_cancel_requests;
