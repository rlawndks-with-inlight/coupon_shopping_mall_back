-- ============================================================================
-- 3차 A · 진단 (읽기 전용 — 아무것도 바꾸지 않는다)
--
-- ※ 한 번에 다 돌리지 말고 쿼리 하나씩 실행할 것.
--    (앞서 A~C 를 한 파일로 묶었더니 HeidiSQL 이 결과창을 8개 넘게 만들면서 튕겼다)
--    HeidiSQL: 실행할 쿼리를 마우스로 드래그해 선택하고 Ctrl+F9 → 선택 부분만 실행된다.
--
-- 2차(2026-08-07_category_preview_brands.sql) 실행 결과: 87 전환 / 6 미전환.
-- 이 파일은 그 6개를 어떻게 처리할지 판정한다.
-- ============================================================================


-- ── A-1. 스키마 확인 ────────────────────────────────────────────────────────
--   C 파일의 INSERT 가 쓰는 컬럼이 실제로 있는지 먼저 본다.
--   기대: brand_id, product_category_group_id, category_name, parent_id,
--         category_type, sort_idx, status  ← 7개가 다 보여야 한다
--   ※ depth 가 없는 것이 정상이다. 깊이는 저장하지 않고 parent_id 를 거슬러 계산한다.
SELECT COLUMN_NAME AS 컬럼, COLUMN_TYPE AS 타입, IS_NULLABLE AS NULL허용, COLUMN_DEFAULT AS 기본값
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_categories'
ORDER BY ORDINAL_POSITION;


-- ── A-2. 남은 브랜드 판정 ───────────────────────────────────────────────────
--   '카테고리있는그룹수' 가 0 또는 1  → B 파일이 자동 전환
--                        2 이상       → C 파일로 승격
SELECT
  b.id, b.dns, b.name,
  (SELECT COUNT(*) FROM product_category_groups g
    WHERE g.brand_id = b.id AND g.is_delete = 0)                    AS 그룹수,
  (SELECT COUNT(*) FROM product_categories c
    WHERE c.brand_id = b.id AND c.is_delete = 0)                    AS 카테고리수,
  (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
    WHERE c.brand_id = b.id AND c.is_delete = 0)                    AS 카테고리있는그룹수,
  CASE
    WHEN b.id IN (5, 74) THEN 'backfill_one_brand.sql (배포 후)'
    WHEN (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
           WHERE c.brand_id = b.id AND c.is_delete = 0) <= 1
                         THEN 'B 파일 — 자동 전환'
    ELSE                      'C 파일 — 승격'
  END                                                                AS 처리
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id;


-- ── A-3. 그룹별 카테고리 분포 ───────────────────────────────────────────────
--   A-2 에서 'C 파일 — 승격' 이 나온 브랜드가 실제로 어떻게 생겼는지 본다.
--   카테고리수 0 인 그룹은 이름만 있고 비어 있는 껍데기다.
SELECT
  b.id AS 브랜드id, b.dns,
  g.id AS 그룹id, g.category_group_name AS 그룹명,
  (SELECT COUNT(*) FROM product_categories c
    WHERE c.product_category_group_id = g.id AND c.is_delete = 0)                      AS 카테고리수,
  (SELECT COUNT(*) FROM product_categories c
    WHERE c.product_category_group_id = g.id AND c.is_delete = 0 AND c.parent_id = -1) AS 최상위수
FROM brands b
JOIN product_category_groups g ON g.brand_id = b.id AND g.is_delete = 0
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id, g.id;
