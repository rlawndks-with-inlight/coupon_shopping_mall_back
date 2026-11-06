-- ============================================================================
-- 주문 이력 메모 — 수정 시각 칸
-- 날짜: 2026-11-06  (가맹점 요청: "이력에서 수정 및 추가도 가능해야 한다")
--
-- 결정: 자동 기록(상태 변경·승인·취소·송장)은 아무도 못 고친다. 가맹점은 메모(kind='memo')만 추가하고,
--       자기가 쓴 메모만 고치거나 지운다. 취소 줄은 사유 부분만 고친다(금액·수량 그대로). 고친 줄에 「수정됨」을 붙이려고 수정 시각을 남긴다.
--
-- 안전성: 기존 테이블에 비어 있는(NULL) 칸 하나만 더한다. 기존 데이터는 그대로다.
-- 코드는 이 칸이 없어도 동작한다(이력 조회는 SELECT *, 메모 수정은 칸이 없으면 내용만 고친다).
-- ▶ 여러 번 돌려도 안전하다(이미 있으면 건너뜀).
-- ============================================================================
SET @있음 := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_status_logs' AND COLUMN_NAME = 'edited_at');
SET @sql := IF(@있음 = 0,
  'ALTER TABLE transaction_status_logs ADD COLUMN edited_at DATETIME NULL COMMENT ''메모·취소 사유를 고친 시각(kind=memo·cancel)'' AFTER note',
  'SELECT ''edited_at 이미 있음'' AS 결과');
PREPARE 문 FROM @sql; EXECUTE 문; DEALLOCATE PREPARE 문;

SELECT IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transaction_status_logs' AND COLUMN_NAME = 'edited_at'),'O','X') AS `edited_at 칸`;
