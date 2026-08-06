-- ============================================================================
-- 3차 B · 자동 전환 (A 파일 진단 확인 후 실행)
--
-- ※ 쿼리 하나씩 실행할 것. 한 번에 다 돌리지 말 것.
-- ※ 실행 전 백업: brands
--
-- 전환 규칙 — '합쳐도 화면이 안 바뀐다' 가 보장될 때만 전환한다.
--   [A] 카테고리가 0개                → 합칠 대상이 없다
--   [B] 카테고리가 한 그룹에만 몰려 있음 → 빈 그룹의 이름만 사라진다. 트리는 그대로다.
--   두 경우 모두 '카테고리있는그룹수 <= 1' 이라는 한 조건으로 걸린다.
--
-- id 5(프레임3) · 74 는 제외한다.
--   '브랜드' 그룹을 트리에 합치면 안 되고 속성으로 이관해야 하며,
--   그 절차는 migrations/backfill_one_brand.sql 이 담당한다(배포 후 실행).
--
-- 롤백: UPDATE brands SET is_category_migrated = 0 WHERE id IN (<B-1 에서 나온 id>);
-- ============================================================================


-- ── B-1. 이번에 바뀔 브랜드 미리보기 (아직 변경 없음) ───────────────────────
--   여기 나온 id 를 메모해 둘 것. 롤백할 때 필요하다.
SELECT b.id, b.dns, b.name,
       (SELECT COUNT(*) FROM product_category_groups g
         WHERE g.brand_id = b.id AND g.is_delete = 0)  AS 그룹수,
       (SELECT COUNT(*) FROM product_categories c
         WHERE c.brand_id = b.id AND c.is_delete = 0)  AS 카테고리수
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND b.id NOT IN (5, 74)
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
        WHERE c.brand_id = b.id AND c.is_delete = 0) <= 1
ORDER BY b.id;


-- ── B-2. 전환 실행 ──────────────────────────────────────────────────────────
--   B-1 결과가 예상과 같을 때만 실행할 것.
UPDATE brands b
SET b.is_category_migrated = 1
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND b.id NOT IN (5, 74)
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
        WHERE c.brand_id = b.id AND c.is_delete = 0) <= 1;


-- ── B-3. 남은 브랜드 확인 ───────────────────────────────────────────────────
--   기대: id 5 · 74 (backfill 대기) + C 파일 승격 대상만 남는다.
SELECT b.id, b.dns, b.name,
       (SELECT GROUP_CONCAT(g.category_group_name ORDER BY g.id SEPARATOR ' | ')
         FROM product_category_groups g
        WHERE g.brand_id = b.id AND g.is_delete = 0)   AS 그룹명,
       (SELECT COUNT(*) FROM product_categories c
         WHERE c.brand_id = b.id AND c.is_delete = 0)  AS 카테고리수,
       CASE WHEN b.id IN (5, 74) THEN 'backfill_one_brand.sql (배포 후)'
            ELSE 'C 파일 — 승격' END                    AS 처리
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id;
