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
--   try_count 로 상한을 두고, 상한을 넘거나 처리할 수 없는 행은 is_confirm=2 로
--   격리한다. 격리는 삭제가 아니라 원인 추적을 위해 남겨 두는 것이다.
--
--   is_confirm  0 = 대기(처리 대상)
--               1 = (기존 정의 유지, 현재 코드는 성공 시 행을 삭제한다)
--               2 = 격리 — 더 시도하지 않음
--
-- ▶ 안전성: 두 컬럼 모두 '추가'이고 기본값이 있어 기존 행/코드에 영향이 없다.
--
-- ⚠ 실행 순서: 이 SQL → 백엔드 배포. 반대로 하면 스케줄러가 매분 에러를 남긴다.
--
-- ⚠ MySQL 은 ALTER TABLE ... ADD COLUMN IF NOT EXISTS 를 지원하지 않는다
--   (MariaDB 전용 문법이다. 쓰면 ERROR 1064 가 난다).
--   그래서 information_schema 로 존재를 확인한 뒤 PREPARE 로 실행한다.
--   아래 블록은 여러 번 돌려도 안전하다.
-- ============================================================================

-- (1) try_count — 재시도 횟수 -------------------------------------------------
SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE lang_processes ADD COLUMN try_count INT NOT NULL DEFAULT 0',
    'SELECT ''try_count 이미 존재 — 건너뜀'' AS msg')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'lang_processes'
    AND COLUMN_NAME  = 'try_count'
);
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- (2) last_error — 마지막 실패 사유(240자 절단 저장) ---------------------------
SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE lang_processes ADD COLUMN last_error VARCHAR(255) NULL',
    'SELECT ''last_error 이미 존재 — 건너뜀'' AS msg')
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'lang_processes'
    AND COLUMN_NAME  = 'last_error'
);
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- (3) 대기 행 조회용 인덱스 ---------------------------------------------------
--     소비자 쿼리: WHERE is_confirm=0 AND try_count < N ORDER BY id LIMIT M
SET @ddl = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE lang_processes ADD INDEX idx_lang_proc_pending (is_confirm, try_count, id)',
    'SELECT ''idx_lang_proc_pending 이미 존재 — 건너뜀'' AS msg')
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'lang_processes'
    AND INDEX_NAME   = 'idx_lang_proc_pending'
);
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;


-- ── 확인 쿼리 (실행 후 눈으로 볼 것) ────────────────────────────────────────
-- 1) 컬럼이 생겼는지 — try_count, last_error 가 보여야 한다
-- SHOW COLUMNS FROM lang_processes;
--
-- 2) 현재 대기 물량 — 배포 후 이 숫자가 줄어들어야 한다
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
