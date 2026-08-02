-- ============================================================================
-- 카테고리 정규화 — 브랜드별 백필 (HeidiSQL용, 파라미터화). 멱등·재실행 안전.
-- 사용: 맨 아래 @brand 값만 바꿔 브랜드 하나씩 실행. (선행: 역할 검토 is_reviewed=1)
--
-- 하는 일:
--   Phase 3  트리 백필     : tree 역할 카테고리를 참조한 상품 → products_categories
--   Phase 4a 속성그룹 생성 : property 역할 그룹 → product_property_groups (+매핑)
--   Phase 4b 속성값 생성   : 그 그룹의 facet 카테고리 → product_properties (+매핑)
--   Phase 4c 상품 링크     : 상품 → products_and_properties
--   Phase 4d facet 숨김    : facet 카테고리 soft-delete(트리에서 제외)
--   Flag                   : brands.is_category_migrated=1 → 그 브랜드만 단일트리 전환
--
-- 롤백(이 브랜드만): UPDATE brands SET is_category_migrated=0 WHERE id=@brand;
--   + (원하면) 산출물 정리는 2026-08-03_category_restructure.sql 하단 롤백 블록 참조.
-- ============================================================================

SET @brand := 74;   -- ★★★ 대상 브랜드만 여기서 바꿔 실행 ★★★

-- ── 안전 게이트: 이 브랜드 그룹이 전부 검토됐는지 (0이어야 정상; 아니면 멈추고 role 확정)
SELECT COUNT(*) AS unreviewed_groups
FROM _mig_group_role WHERE brand_id=@brand AND is_reviewed=0;

-- ── Phase 3. 트리 백필 (멱등: UNIQUE + INSERT IGNORE)
INSERT IGNORE INTO products_categories (brand_id, product_id, category_id, sort_idx)
SELECT p.brand_id, p.id, c.id, 0
FROM products p
JOIN product_categories c ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
WHERE gr.role='tree' AND gr.brand_id=@brand
  AND c.is_delete=0 AND p.is_delete=0 AND p.brand_id=@brand;

-- ── Phase 4a. property 그룹 → 속성그룹 생성 (property 역할 없으면 전부 no-op)
INSERT INTO product_property_groups (property_group_name, is_can_select_multiple, brand_id)
SELECT gr.group_name, 0, gr.brand_id
FROM _mig_group_role gr
WHERE gr.role='property' AND gr.brand_id=@brand
  AND NOT EXISTS (SELECT 1 FROM _mig_group_to_propgroup m WHERE m.group_id=gr.group_id);

-- 매핑 기록 (방금 생성분; 브랜드당 property 그룹 0~1개라 LAST_INSERT_ID 안전)
INSERT INTO _mig_group_to_propgroup (group_id, brand_id, property_group_id)
SELECT gr.group_id, gr.brand_id, LAST_INSERT_ID()
FROM _mig_group_role gr
WHERE gr.role='property' AND gr.brand_id=@brand
  AND NOT EXISTS (SELECT 1 FROM _mig_group_to_propgroup m WHERE m.group_id=gr.group_id);

-- ── Phase 4b. facet 카테고리 → 속성값 생성 (멱등)
INSERT INTO product_properties
  (property_img, property_type, property_name, property_description, product_property_group_id, brand_id)
SELECT c.category_img, 0, c.category_name, c.category_description, m.property_group_id, c.brand_id
FROM product_categories c
JOIN _mig_group_role gr ON gr.group_id=c.product_category_group_id
JOIN _mig_group_to_propgroup m ON m.group_id=gr.group_id
WHERE gr.role='property' AND gr.brand_id=@brand AND c.is_delete=0
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.category_id=c.id);

-- 매핑 기록: 생성된 속성 ↔ 원본 카테고리 (그룹 내 이름 유일 가정 — 브랜드명은 유일)
INSERT INTO _mig_cat_to_prop (category_id, brand_id, property_id, property_group_id)
SELECT c.id, c.brand_id, pp.id, m.property_group_id
FROM product_categories c
JOIN _mig_group_role gr ON gr.group_id=c.product_category_group_id
JOIN _mig_group_to_propgroup m ON m.group_id=gr.group_id
JOIN product_properties pp
  ON pp.product_property_group_id=m.property_group_id AND pp.property_name=c.category_name
WHERE gr.role='property' AND gr.brand_id=@brand AND c.is_delete=0
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.category_id=c.id);

-- ── Phase 4c. 상품 → 속성 링크 (멱등: 존재검사)
INSERT INTO products_and_properties (product_id, property_group_id, property_id)
SELECT DISTINCT p.id, cp.property_group_id, cp.property_id
FROM products p
JOIN _mig_cat_to_prop cp ON cp.category_id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_to_propgroup m ON m.property_group_id=cp.property_group_id AND m.brand_id=@brand
WHERE p.brand_id=@brand AND p.is_delete=0
  AND NOT EXISTS (SELECT 1 FROM products_and_properties pp2
                   WHERE pp2.product_id=p.id AND pp2.property_id=cp.property_id);

-- ── Phase 4d. facet 카테고리 트리에서 제거 (soft-delete). 가역: 롤백 시 is_delete=0 복원.
UPDATE product_categories c
JOIN _mig_group_role gr ON gr.group_id=c.product_category_group_id
SET c.is_delete=1
WHERE gr.role='property' AND gr.brand_id=@brand AND c.is_delete=0;

-- ── Flag. 이 브랜드만 단일트리 전환 (shop.controller 가 읽음)
UPDATE brands SET is_category_migrated=1 WHERE id=@brand;

-- ── 검증 (이 브랜드 범위)
-- V1 보존성: tree 참조쌍 수 == 연결테이블 행 수 (일치 기대)
SELECT
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT p.id AS pid, c.id AS cid FROM products p
     JOIN product_categories c ON c.id IN (p.category_id0,p.category_id1,p.category_id2)
     JOIN _mig_group_role r ON r.group_id=c.product_category_group_id
     WHERE r.role='tree' AND r.brand_id=@brand AND c.is_delete=0 AND p.is_delete=0 AND p.brand_id=@brand
   ) t) AS tree_pairs,
  (SELECT COUNT(*) FROM products_categories WHERE is_delete=0 AND brand_id=@brand) AS pc_rows;

-- V2 고아: 없는/삭제 카테고리를 가리키는 연결행 (0 기대)
SELECT COUNT(*) AS orphan_rows FROM products_categories pc
LEFT JOIN product_categories c ON c.id=pc.category_id
WHERE pc.brand_id=@brand AND pc.is_delete=0 AND (c.id IS NULL OR c.is_delete=1);

-- V4 속성 커버리지: 이 브랜드 property 이전 결과
SELECT m.property_group_id,
       (SELECT COUNT(*) FROM _mig_cat_to_prop cp WHERE cp.property_group_id=m.property_group_id) AS props,
       (SELECT COUNT(*) FROM products_and_properties pp
         WHERE pp.property_group_id=m.property_group_id AND pp.is_delete=0) AS links
FROM _mig_group_to_propgroup m WHERE m.brand_id=@brand;
