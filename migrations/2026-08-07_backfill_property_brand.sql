-- ============================================================================
-- 브랜드=속성 이관 (id 5 · 74 전용) — backfill_one_brand.sql 의 Phase 4 교체판
--
-- ※ 쿼리 하나씩 실행할 것.
-- ※ 새 코드 배포 후에 실행할 것 (P6 이 facet 카테고리를 soft-delete 한다).
-- ※ 실행 전 백업: product_properties, product_property_groups,
--                 products_and_properties, product_categories, brands
--
-- ── 왜 이 파일이 필요한가 ───────────────────────────────────────────────────
-- backfill_one_brand.sql 을 돌리면 이 에러가 난다:
--     SQL 오류 (1062): Duplicate entry '589' for key '_mig_cat_to_prop.PRIMARY'
--
-- 원인: 원본의 매핑 INSERT 가 카테고리와 속성을 '이름' 으로 조인한다.
--     JOIN product_properties pp
--       ON pp.product_property_group_id = m.property_group_id
--      AND pp.property_name = c.category_name
--   주석에 "그룹 내 이름 유일 가정 — 브랜드명은 유일" 이라고 적혀 있는데
--   그 가정이 틀렸다. '브랜드' 그룹에 같은 이름이 두 번 이상 들어가 있다.
--   → Phase 4b 가 같은 이름의 속성을 여러 개 만들고
--   → 매핑에서 카테고리 하나가 속성 여러 개에 붙어 PK(category_id) 가 충돌한다.
--
-- 고치는 방향: 속성을 '이름당 하나' 만 만든다.
--   같은 이름의 카테고리 둘은 같은 브랜드를 가리키므로 속성 하나로 합치는 것이 맞다.
--   두 카테고리 모두 그 속성 하나에 매핑된다(PK 는 category_id 라 문제없다).
--
-- ── 실패한 실행이 남긴 것 ───────────────────────────────────────────────────
-- INSERT...SELECT 는 실패하면 그 문장이 통째로 롤백된다. 그래서:
--     product_property_groups   Phase 4a 가 만든 것   → 남아 있음(_mig 에 기록됨)
--     product_properties        Phase 4b 가 만든 것   → 남아 있음, 매핑 안 됨(고아)
--     _mig_cat_to_prop          비어 있음
--     상품 링크 · facet 숨김 · 플래그 → 실행 안 됨
-- 그냥 다시 돌리면 고아 속성이 계속 쌓인다. P1 이 먼저 치운다.
--
-- 롤백(이 브랜드만):
--   UPDATE brands SET is_category_migrated = 0 WHERE id = @brand;
--   UPDATE product_categories SET is_delete = 0
--     WHERE id IN (SELECT category_id FROM _mig_cat_to_prop WHERE brand_id = @brand);
--   DELETE FROM products_and_properties WHERE property_id IN
--     (SELECT property_id FROM _mig_cat_to_prop WHERE brand_id = @brand);
--   DELETE FROM product_properties WHERE id IN
--     (SELECT property_id FROM _mig_cat_to_prop WHERE brand_id = @brand);
--   DELETE FROM _mig_cat_to_prop WHERE brand_id = @brand;
-- ============================================================================


-- ── P0. 대상 브랜드 지정 ★★★ ──────────────────────────────────────────────
SET @brand := 74;   -- 5(그랑파리=프레임3) 또는 74(The grazia)


-- ═════════════════════════════════════════════════════════════════════════════
-- 진단 (읽기 전용). P1 로 넘어가기 전에 다 확인할 것.
-- ═════════════════════════════════════════════════════════════════════════════

-- P0-1. 안전 게이트 — 0 이어야 한다. 아니면 멈추고 그룹 역할부터 확정할 것.
SELECT COUNT(*) AS 미검토그룹
FROM _mig_group_role WHERE brand_id = @brand AND is_reviewed = 0;

-- P0-2. 이 브랜드의 그룹 역할 (property 가 '브랜드' 축이어야 한다)
SELECT gr.group_id, gr.group_name, gr.role, gr.is_reviewed, gr.num_categories
FROM _mig_group_role gr WHERE gr.brand_id = @brand ORDER BY gr.group_id;

-- P0-3. ★ 중복 이름 확인 — 이번 에러의 원인. 행이 나오는 것이 정상(그래서 터진 것).
SELECT c.category_name                       AS 이름,
       COUNT(*)                              AS 카테고리수,
       GROUP_CONCAT(c.id ORDER BY c.id)      AS 카테고리ids
FROM product_categories c
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
WHERE gr.role = 'property' AND gr.brand_id = @brand AND c.is_delete = 0
GROUP BY c.category_name
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, c.category_name;

-- P0-4. 실패한 실행이 남긴 고아 속성 — P1 이 지울 대상
SELECT pp.id, pp.property_name, pp.product_property_group_id AS 속성그룹id
FROM product_properties pp
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.property_id = pp.id)
ORDER BY pp.property_name, pp.id;


-- ═════════════════════════════════════════════════════════════════════════════
-- P1. 실패한 실행이 남긴 고아 속성 정리
--     매핑(_mig_cat_to_prop)에 기록되지 않은 것만 지운다.
--     = 정상 이관된 것은 절대 건드리지 않는다. 재실행해도 안전하다.
-- ═════════════════════════════════════════════════════════════════════════════

-- P1-1. 그 속성에 걸린 상품 링크 먼저 (Phase 4c 가 안 돌았으면 0건)
DELETE pap FROM products_and_properties pap
JOIN product_properties pp ON pp.id = pap.property_id
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.property_id = pp.id);

-- P1-2. 고아 속성 삭제
DELETE pp FROM product_properties pp
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.property_id = pp.id);


-- ═════════════════════════════════════════════════════════════════════════════
-- P2. 트리 백필 (멱등 — 이미 돌았으면 0건)
--     tree 역할 카테고리를 참조하는 상품 → products_categories
-- ═════════════════════════════════════════════════════════════════════════════
INSERT IGNORE INTO products_categories (brand_id, product_id, category_id, sort_idx)
SELECT p.brand_id, p.id, c.id, 0
FROM products p
JOIN product_categories c ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
WHERE gr.role = 'tree' AND gr.brand_id = @brand
  AND c.is_delete = 0 AND p.is_delete = 0 AND p.brand_id = @brand;


-- ═════════════════════════════════════════════════════════════════════════════
-- P3. 속성그룹 생성 (이미 있으면 no-op — 앞선 실행이 만들어 뒀을 것이다)
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO product_property_groups (property_group_name, is_can_select_multiple, brand_id)
SELECT gr.group_name, 0, gr.brand_id
FROM _mig_group_role gr
WHERE gr.role = 'property' AND gr.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_group_to_propgroup m WHERE m.group_id = gr.group_id);

INSERT INTO _mig_group_to_propgroup (group_id, brand_id, property_group_id)
SELECT gr.group_id, gr.brand_id, LAST_INSERT_ID()
FROM _mig_group_role gr
WHERE gr.role = 'property' AND gr.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_group_to_propgroup m WHERE m.group_id = gr.group_id);


-- ═════════════════════════════════════════════════════════════════════════════
-- P4. ★ 속성값 생성 — 이름당 하나만 (원본과 다른 부분)
--     GROUP BY 로 같은 이름을 합친다. 이미지·설명은 그중 하나를 쓴다
--     (같은 브랜드를 가리키는 중복 행이라 어느 쪽을 써도 같다).
--     ※ P1 을 먼저 돌렸다는 전제 — 그래야 이 그룹에 고아 속성이 없다.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO product_properties
  (property_img, property_type, property_name, property_description, product_property_group_id, brand_id)
SELECT MIN(c.category_img), 0, c.category_name, MIN(c.category_description),
       m.property_group_id, c.brand_id
FROM product_categories c
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
JOIN _mig_group_to_propgroup m ON m.group_id = gr.group_id
WHERE gr.role = 'property' AND gr.brand_id = @brand AND c.is_delete = 0
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.category_id = c.id)
GROUP BY m.property_group_id, c.brand_id, c.category_name;


-- ═════════════════════════════════════════════════════════════════════════════
-- P5. 매핑 기록 — 이제 이름당 속성이 하나뿐이라 PK 가 충돌하지 않는다.
--     같은 이름의 카테고리 둘은 같은 속성 하나를 함께 가리킨다(정상).
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO _mig_cat_to_prop (category_id, brand_id, property_id, property_group_id)
SELECT c.id, c.brand_id, pp.id, m.property_group_id
FROM product_categories c
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
JOIN _mig_group_to_propgroup m ON m.group_id = gr.group_id
JOIN product_properties pp
  ON pp.product_property_group_id = m.property_group_id
 AND pp.property_name = c.category_name
WHERE gr.role = 'property' AND gr.brand_id = @brand AND c.is_delete = 0
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.category_id = c.id);

-- 확인: 카테고리수 == 매핑수 여야 한다. 속성수는 그보다 작거나 같다(중복 이름만큼 적다).
SELECT
  (SELECT COUNT(*) FROM product_categories c
    JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
   WHERE gr.role='property' AND gr.brand_id=@brand AND c.is_delete=0)      AS facet카테고리수,
  (SELECT COUNT(*) FROM _mig_cat_to_prop WHERE brand_id=@brand)            AS 매핑수,
  (SELECT COUNT(DISTINCT property_id) FROM _mig_cat_to_prop
    WHERE brand_id=@brand)                                                 AS 속성수;


-- ═════════════════════════════════════════════════════════════════════════════
-- P6. 상품 → 속성 링크
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO products_and_properties (product_id, property_group_id, property_id)
SELECT DISTINCT p.id, cp.property_group_id, cp.property_id
FROM products p
JOIN _mig_cat_to_prop cp ON cp.category_id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_to_propgroup m
  ON m.property_group_id = cp.property_group_id AND m.brand_id = @brand
WHERE p.brand_id = @brand AND p.is_delete = 0
  AND NOT EXISTS (SELECT 1 FROM products_and_properties pp2
                   WHERE pp2.product_id = p.id AND pp2.property_id = cp.property_id);


-- ═════════════════════════════════════════════════════════════════════════════
-- P7. facet 카테고리를 트리에서 숨김 (soft-delete, 되돌릴 수 있음)
--     ★ 새 코드가 배포돼 있어야 한다. 구 코드에서 돌리면 그냥 사라진다.
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE product_categories c
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
SET c.is_delete = 1
WHERE gr.role = 'property' AND gr.brand_id = @brand AND c.is_delete = 0;


-- ═════════════════════════════════════════════════════════════════════════════
-- P8. 전환
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE brands SET is_category_migrated = 1 WHERE id = @brand;


-- ═════════════════════════════════════════════════════════════════════════════
-- 검증
-- ═════════════════════════════════════════════════════════════════════════════

-- V1 보존성: tree 참조쌍 수 == 연결테이블 행 수 (일치 기대)
SELECT
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT p.id AS pid, c.id AS cid FROM products p
     JOIN product_categories c ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
     JOIN _mig_group_role r ON r.group_id = c.product_category_group_id
     WHERE r.role='tree' AND r.brand_id=@brand AND c.is_delete=0
       AND p.is_delete=0 AND p.brand_id=@brand
   ) t)                                                                    AS tree_pairs,
  (SELECT COUNT(*) FROM products_categories
    WHERE is_delete=0 AND brand_id=@brand)                                 AS pc_rows;

-- V2 고아 연결행 (0 기대)
SELECT COUNT(*) AS orphan_rows FROM products_categories pc
LEFT JOIN product_categories c ON c.id = pc.category_id
WHERE pc.brand_id=@brand AND pc.is_delete=0 AND (c.id IS NULL OR c.is_delete=1);

-- V3 속성 커버리지
SELECT m.property_group_id                                                 AS 속성그룹id,
       (SELECT COUNT(DISTINCT cp.property_id) FROM _mig_cat_to_prop cp
         WHERE cp.property_group_id = m.property_group_id)                 AS 속성수,
       (SELECT COUNT(*) FROM products_and_properties pp
         WHERE pp.property_group_id = m.property_group_id)                 AS 상품링크수
FROM _mig_group_to_propgroup m WHERE m.brand_id = @brand;

-- V4 이름 중복이 정말 합쳐졌는지 (0 기대 — 같은 그룹에 같은 이름의 속성이 둘 이상이면 안 된다)
SELECT pp.product_property_group_id AS 속성그룹id, pp.property_name AS 이름, COUNT(*) AS 개수
FROM product_properties pp
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
GROUP BY pp.product_property_group_id, pp.property_name
HAVING COUNT(*) > 1;

-- V5 남은 미전환 브랜드
SELECT b.id, b.dns, b.name
FROM brands b
WHERE b.is_delete = 0 AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id;
