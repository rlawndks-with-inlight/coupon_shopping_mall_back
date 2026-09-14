-- ============================================================================
-- 주문 상태 변경 이력 — 누가 언제 무엇을 바꿨는지 남긴다
-- 날짜: 2026-09-14  (가맹점 요청서 2026-09-11 「결제 상태변경 히스토리」)
--
-- 지금은 관리자가 상태 드롭다운을 바꾸거나 취소를 실행해도 transactions 의 현재 값만 바뀐다.
-- "누가 배송완료로 바꿨나", "언제 취소됐나" 를 되짚을 길이 없어 분쟁 때 근거가 없다.
-- 카페24·네이버 스마트스토어의 주문 「처리 이력」과 같은 꼴 — 일시 · 내용(전→후) · 처리자 · 비고.
--
-- 남기는 일(kind):
--   status          관리자 상태 드롭다운 (from → to)
--   approve         PG 승인 확정(결제대기 → 결제완료, 시스템)
--   cancel_request  손님(회원·비회원)의 취소요청 (→ 취소요청)
--   cancel          취소 실행(부분/전체, 환불액·수량을 note 에)
--   failed          결제창만 열고 승인 안 난 건을 「결제실패/미완료」로 정리(시스템)
--
-- 안전성: 새 테이블 하나만 만든다. 기존 테이블·데이터를 건드리지 않는다.
-- 코드는 이 테이블이 없어도 동작한다(기록만 건너뛰고 경고 로그) — 마이그레이션 전에 배포돼도 주문은 그대로 된다.
-- ▶ 여러 번 돌려도 안전하다.
-- ============================================================================

CREATE TABLE IF NOT EXISTS transaction_status_logs (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trans_id     INT          NOT NULL          COMMENT 'transactions.id',
    brand_id     INT          NOT NULL DEFAULT 0,
    kind         VARCHAR(20)  NOT NULL          COMMENT 'status/approve/cancel_request/cancel/failed',
    from_status  INT          NULL              COMMENT '바꾸기 전 trx_status (모르면 NULL)',
    to_status    INT          NULL              COMMENT '바꾼 뒤 trx_status (상태가 안 바뀌는 일이면 NULL)',
    -- admin=관리자 화면, customer=손님, system=PG 통지·자동 정리
    actor_type   VARCHAR(10)  NOT NULL DEFAULT 'system',
    actor_id     INT          NULL,
    actor_name   VARCHAR(100) NULL,
    note         VARCHAR(500) NULL              COMMENT '환불액·수량·사유 등 사람이 읽을 설명',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_trx_status_logs_trans (trans_id, id),
    INDEX idx_trx_status_logs_brand (brand_id, created_at)
);

-- 확인 -----------------------------------------------------------------------
SELECT 'transaction_status_logs 테이블' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='transaction_status_logs'),'O','X') AS 결과;

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- DROP TABLE IF EXISTS transaction_status_logs;
