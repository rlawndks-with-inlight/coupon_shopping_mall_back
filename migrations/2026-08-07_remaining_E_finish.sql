-- ============================================================================
-- 3차 E · 마무리 — id 50 사후 확인 + id 54 · 71 처리
--
-- ※ 쿼리 하나씩 실행할 것.
-- ※ 실행 전 백업: brands, product_category_groups, product_categories
--
-- ── D 진단으로 밝혀진 것 ────────────────────────────────────────────────────
--
-- [id 50] 크래시한 통합 스크립트가 [2] 가 아니라 [3] 승격 블록을 실행했다.
--   (그 파일에 SET @brand := 50 이 박혀 있었다)
--   증거: 2차 시점 카테고리 24개 → 지금 26개. 승격 노드 2개가 생겼고,
--         카테고리있는그룹수가 4인데도 전환돼 있다([2] 규칙 <=1 로는 불가능).
--   결과적으로 id 50 이 받았어야 할 처리와 같지만 확인 없이 나갔으므로
--   E-0 · E-1 로 트리가 온전한지 본다. 상품 0개인 데모 브랜드라 위험은 낮다.
--
-- [id 104] 카테고리 0개 → [2] 규칙대로 전환됨. 정상. 할 일 없다.
--
-- [id 54 · 71] 그룹 두 개에 카테고리가 양쪽 다 있지만, 한쪽은 상품이 0건이다.
--     54  그룹129 '카테고리'  9개 · 상품 0      ← 브랜드 생성 시 딸려온 기본 세트
--         그룹158 'category'  9개 · 상품 1,189  ← 실제로 쓰는 것
--     71  그룹160 '카테고리'  9개 · 상품 0      ← 기본 세트(54 와 이름까지 동일)
--         그룹161 'category'  8개 · 상품 964    ← 실제로 쓰는 것
--   기본 세트: 식품·생활용품·뷰티·문구·가전/디지털·악세서리·의류·아기용품·주방용품
--
--   그냥 병합하면 고객 화면에 빈 카테고리 9개가 더 생기고,
--   두 그룹에 겹치는 이름(뷰티·식품)은 두 번씩 보인다. → 안 쓰는 쪽을 숨기고 병합한다.
--
-- ── 안전 규칙 ───────────────────────────────────────────────────────────────
-- 브랜드 id 를 박아 넣지 않는다. 아래 두 조건을 동시에 만족하는 그룹만 숨긴다.
--   ① 그 그룹의 카테고리에 상품이 하나도 안 붙어 있다 (기존 컬럼·연결테이블 양쪽 확인)
--   ② 같은 브랜드에 상품이 붙은 다른 그룹이 반드시 있다 ← 전부 지우는 사고 방지
-- soft-delete(is_delete=1) 이므로 되돌릴 수 있다.
--
-- 롤백:
--   UPDATE product_categories   SET is_delete=0 WHERE product_category_group_id IN (<E-2 목록>);
--   UPDATE product_category_groups SET is_delete=0 WHERE id IN (<E-2 목록>);
--   UPDATE brands SET is_category_migrated=0 WHERE id IN (54, 71);
-- ============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- E-0. id 50 트리 확인 (읽기 전용)
--   기대: 부모이름이 NULL 인 행(=최상위)이 그룹명들뿐이다.
--         (자동차 · 여행 · 스포츠/레저 · 유아동/주니어 — 4개)
--         나머지 22개는 그 밑에 붙어 있어야 한다.
--   최상위가 이것 말고 더 있으면 승격이 중간에 끊긴 것이니 알려줄 것.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT c.id, c.parent_id,
       c.product_category_group_id                                       AS 그룹id,
       (SELECT g.category_group_name FROM product_category_groups g
         WHERE g.id = c.product_category_group_id)                       AS 그룹명,
       c.category_name                                                   AS 카테고리명,
       (SELECT p.category_name FROM product_categories p
         WHERE p.id = c.parent_id)                                       AS 부모이름,
       c.sort_idx, c.status
FROM product_categories c
WHERE c.brand_id = 50 AND c.is_delete = 0
ORDER BY c.product_category_group_id, c.parent_id, c.sort_idx DESC, c.id;


-- ── E-1. id 50 고아 확인 (0 이어야 정상) ────────────────────────────────────
SELECT COUNT(*) AS 고아
FROM product_categories c
LEFT JOIN product_categories p ON p.id = c.parent_id
WHERE c.brand_id = 50 AND c.is_delete = 0
  AND c.parent_id <> -1
  AND (p.id IS NULL OR p.is_delete = 1);


-- ═════════════════════════════════════════════════════════════════════════════
-- E-2. 숨길 그룹 선별 → 보조 테이블 (아직 아무것도 안 바뀐다)
--   결과에 나온 그룹id 를 메모해 둘 것. 롤백할 때 필요하다.
--   기대: 그룹 129(브랜드54) · 160(브랜드71) 두 줄.
--   임시테이블(TEMPORARY)을 쓰지 않는다 — MySQL 이 UPDATE 대상 테이블을 같은 문의
--   서브쿼리에서 참조하지 못하게 막고(에러 1093), HeidiSQL 그리드도 불안정하다.
-- ═════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _mig_dead_group;

CREATE TABLE _mig_dead_group (
  group_id BIGINT PRIMARY KEY,
  brand_id BIGINT NOT NULL
);

INSERT INTO _mig_dead_group (group_id, brand_id)
SELECT g.id, g.brand_id
FROM product_category_groups g
JOIN brands b
  ON b.id = g.brand_id
 AND b.is_delete = 0
 AND b.is_main_dns <> 1
 AND b.id NOT IN (5, 74)
 AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
WHERE g.is_delete = 0
  -- 이 그룹에 카테고리가 있기는 하다(빈 그룹은 대상이 아니다 — 숨길 필요도 없다)
  AND EXISTS (SELECT 1 FROM product_categories c
               WHERE c.product_category_group_id = g.id AND c.is_delete = 0)
  -- ① 그 카테고리 중 상품이 붙은 것이 하나도 없다
  AND NOT EXISTS (
        SELECT 1 FROM product_categories c
        WHERE c.product_category_group_id = g.id AND c.is_delete = 0
          AND ( EXISTS (SELECT 1 FROM products p
                         WHERE p.brand_id = g.brand_id AND p.is_delete = 0
                           AND (p.category_id0 = c.id OR p.category_id1 = c.id OR p.category_id2 = c.id))
             OR EXISTS (SELECT 1 FROM products_categories pc
                         WHERE pc.category_id = c.id AND pc.is_delete = 0) ))
  -- ② 같은 브랜드에 상품이 붙은 다른 그룹이 반드시 있다 (전부 지우는 사고 방지)
  AND EXISTS (
        SELECT 1 FROM product_category_groups g2
        JOIN product_categories c2
          ON c2.product_category_group_id = g2.id AND c2.is_delete = 0
        WHERE g2.brand_id = g.brand_id AND g2.is_delete = 0 AND g2.id <> g.id
          AND ( EXISTS (SELECT 1 FROM products p
                         WHERE p.brand_id = g.brand_id AND p.is_delete = 0
                           AND (p.category_id0 = c2.id OR p.category_id1 = c2.id OR p.category_id2 = c2.id))
             OR EXISTS (SELECT 1 FROM products_categories pc
                         WHERE pc.category_id = c2.id AND pc.is_delete = 0) ));

-- 확인: 무엇을 숨기게 되는지 눈으로 본다
SELECT d.brand_id                                   AS 브랜드id,
       d.group_id                                   AS 그룹id,
       g.category_group_name                        AS 그룹명,
       (SELECT COUNT(*) FROM product_categories c
         WHERE c.product_category_group_id = d.group_id AND c.is_delete = 0) AS 숨길카테고리수,
       (SELECT GROUP_CONCAT(c.category_name ORDER BY c.sort_idx DESC SEPARATOR ', ')
         FROM product_categories c
        WHERE c.product_category_group_id = d.group_id AND c.is_delete = 0)  AS 숨길카테고리
FROM _mig_dead_group d
JOIN product_category_groups g ON g.id = d.group_id;


-- ═════════════════════════════════════════════════════════════════════════════
-- E-3. 실행 — 안 쓰는 그룹의 카테고리 숨기기
--   E-2 결과가 예상과 같을 때만 실행할 것.
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE product_categories c
JOIN _mig_dead_group d ON d.group_id = c.product_category_group_id
SET c.is_delete = 1
WHERE c.is_delete = 0;


-- ── E-4. 빈 껍데기가 된 그룹도 숨긴다 ───────────────────────────────────────
UPDATE product_category_groups g
JOIN _mig_dead_group d ON d.group_id = g.id
SET g.is_delete = 1
WHERE g.is_delete = 0;


-- ── E-5. 결과 확인 — 브랜드마다 그룹 하나, 실제 쓰는 카테고리만 남아야 한다 ──
SELECT c.brand_id                                                        AS 브랜드id,
       c.product_category_group_id                                       AS 그룹id,
       (SELECT g.category_group_name FROM product_category_groups g
         WHERE g.id = c.product_category_group_id)                       AS 그룹명,
       COUNT(*)                                                          AS 카테고리수
FROM product_categories c
WHERE c.brand_id IN (SELECT brand_id FROM _mig_dead_group) AND c.is_delete = 0
GROUP BY c.brand_id, c.product_category_group_id
ORDER BY c.brand_id;


-- ═════════════════════════════════════════════════════════════════════════════
-- E-6. 전환 — B 파일과 같은 규칙.
--   E-3·E-4 로 그룹이 하나만 남았으니 이제 규칙에 걸린다.
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE brands b
SET b.is_category_migrated = 1
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND b.id NOT IN (5, 74)
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
        WHERE c.brand_id = b.id AND c.is_delete = 0) <= 1;


-- ── E-7. 보조 테이블 정리 ───────────────────────────────────────────────────
DROP TABLE IF EXISTS _mig_dead_group;


-- ═════════════════════════════════════════════════════════════════════════════
-- E-8. 최종 확인 — 미전환으로 남는 것은 id 5 와 74 뿐이어야 한다
--   그 둘은 배포 후 migrations/backfill_one_brand.sql 로 처리한다
--   (SET @brand := 5;  /  SET @brand := 74;)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT COALESCE(b.is_category_migrated, 0) AS 전환여부, COUNT(*) AS 브랜드수
FROM brands b
WHERE b.is_delete = 0 AND b.is_main_dns <> 1
GROUP BY COALESCE(b.is_category_migrated, 0);

SELECT b.id, b.dns, b.name,
       (SELECT GROUP_CONCAT(g.category_group_name ORDER BY g.id SEPARATOR ' | ')
         FROM product_category_groups g
        WHERE g.brand_id = b.id AND g.is_delete = 0)                     AS 그룹명,
       (SELECT COUNT(*) FROM product_categories c
         WHERE c.brand_id = b.id AND c.is_delete = 0)                    AS 카테고리수
FROM brands b
WHERE b.is_delete = 0 AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id;
