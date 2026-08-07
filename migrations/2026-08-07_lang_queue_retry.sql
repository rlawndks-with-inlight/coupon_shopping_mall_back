-- ============================================================================
-- 번역 대기열(lang_processes) 재시도/격리 컬럼 추가
--
-- ▶ 배경
--   대기열 소비자 langProcess() 가 utils.js/schedules/index.js 에서 주석 처리되어
--   2025-08-04 이후 한 건도 처리되지 않았다. 상품은 저장 시점에 즉시 번역되어
--   동작했지만, 카테고리·게시판·옵션은 이 큐에만 쌓이고 영원히 미처리로 남았다.
--
-- ▶ 소비자를 되살리면서 필요한 것
--   기존 테이블에는 재시도 횟수가 없어, 영원히 실패하는 행이 매분 다시 시도된다.
--   (예: 원본 행이 이미 삭제된 항목, 번역기가 계속 거부하는 내용)
--   try_count 로 상한을 두고, 상한을 넘거나 처리할 수 없는 행은 is_confirm=2 로
--   격리한다. 격리는 삭제가 아니라 원인 추적을 위해 남겨 두는 것이다.
--
--   is_confirm  0 = 대기(처리 대상)
--               1 = (기존 정의 유지, 현재 코드는 성공 시 행을 삭제한다)
--               2 = 격리 — 더 시도하지 않음
--
-- ▶ 안전성: 두 컬럼 모두 '추가'이고 기본값이 있어 기존 행/코드에 영향이 없다.
--   추가 전 상태에서도 소비자는 COALESCE(try_count,0) 로 동작하지만,
--   컬럼이 없으면 SQL 이 실패하므로 코드 배포 전에 이 SQL 을 먼저 실행할 것.
--
-- ⚠ 실행 순서: 이 SQL → 백엔드 배포. 반대로 하면 스케줄러가 매분 에러를 남긴다.
-- ============================================================================

-- 재시도 횟수 (LANG_MAX_TRIES, 기본 3회를 넘으면 조회 대상에서 빠진다)
ALTER TABLE lang_processes
    ADD COLUMN IF NOT EXISTS try_count INT NOT NULL DEFAULT 0;

-- 마지막 실패 사유 (원인 추적용, 240자 절단 저장)
ALTER TABLE lang_processes
    ADD COLUMN IF NOT EXISTS last_error VARCHAR(255) NULL;

-- 대기 행 조회용 인덱스 (is_confirm=0 AND try_count < N ORDER BY id)
ALTER TABLE lang_processes
    ADD INDEX idx_lang_proc_pending (is_confirm, try_count, id);


-- ── 확인 쿼리 (실행 후 눈으로 볼 것) ────────────────────────────────────────
-- 1) 컬럼이 생겼는지
-- SHOW COLUMNS FROM lang_processes;
--
-- 2) 현재 대기 물량 — 이 숫자가 배포 후 줄어들어야 한다
-- SELECT is_confirm, COUNT(*) AS cnt, MIN(created_at) AS oldest
--   FROM lang_processes GROUP BY is_confirm;
--
-- 3) 테이블별 대기 물량 (카테고리·게시글이 얼마나 밀려 있는지)
-- SELECT table_name, COUNT(*) AS cnt
--   FROM lang_processes WHERE is_confirm=0 GROUP BY table_name ORDER BY cnt DESC;
--
-- 4) 배포 후 격리된 행이 있으면 사유 확인
-- SELECT id, table_name, item_id, try_count, last_error
--   FROM lang_processes WHERE is_confirm=2 ORDER BY id DESC LIMIT 50;
--
-- 5) 실제로 번역이 채워지는지 (카테고리 기준)
-- SELECT COUNT(*) AS total,
--        SUM(CASE WHEN lang_obj IS NOT NULL AND lang_obj <> '{}' AND lang_obj <> '' THEN 1 ELSE 0 END) AS translated
--   FROM product_categories WHERE is_delete=0;


-- ── 롤백 ────────────────────────────────────────────────────────────────────
-- 스케줄러를 다시 끄려면 코드에서 langProcess 작업을 주석 처리하면 된다.
-- 컬럼은 남겨도 무해하다. 굳이 되돌리려면:
-- ALTER TABLE lang_processes DROP INDEX idx_lang_proc_pending;
-- ALTER TABLE lang_processes DROP COLUMN last_error;
-- ALTER TABLE lang_processes DROP COLUMN try_count;
--
-- 격리된 행을 다시 시도하게 하려면:
-- UPDATE lang_processes SET is_confirm=0, try_count=0, last_error=NULL WHERE is_confirm=2;
