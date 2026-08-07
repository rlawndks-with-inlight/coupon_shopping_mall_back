-- ============================================================================
-- 브랜드 5 (demo4.asapmall.kr 그랑파리 = 프레임3) 전용 백필
--
-- ※ 쿼리 하나씩 실행할 것. B3 · B7 은 '영향 행 0' 이 될 때까지 반복 실행.
-- ※ 실행 전 백업: products_categories, product_properties, product_property_groups,
--                 products_and_properties, product_categories, brands
--
-- ── 왜 74 용 파일을 그대로 못 쓰는가 ────────────────────────────────────────
-- 브랜드 5 는 상품이 55,649 개다(74 는 3,094 개). 규모가 다르다.
--
-- 그래서 이 화면이 떴다:
--     경고: (1062) Duplicate entry '1000393891-1049' for key 'products_categories.uq_prodcat'
--     ... 같은 줄이 수만 개
-- 이건 에러가 아니라 INSERT IGNORE 가 중복을 건너뛰며 내는 정상 경고다.
-- 트리 백필은 앞서 실패한 backfill_one_brand.sql 실행 때 이미 끝나 있었고,
-- 그래서 재실행분이 전부 '이미 있음' 으로 걸러지며 경고가 폭주했다.
-- HeidiSQL 이 그 경고를 전부 화면에 쌓다가 메모리를 못 버티고 튕긴 것이다.
--
-- 고치는 방향:
--   ① INSERT IGNORE 를 쓰지 않는다. LEFT JOIN 으로 '없는 것만' 넣는다 → 경고 0건.
--      (MySQL 문서상 INSERT ... SELECT 의 FROM 절에 대상 테이블이 와도 된다.
--       내부 임시테이블로 버퍼링한다.)
--   ② 큰 INSERT 는 LIMIT 으로 잘라 여러 번 돌린다 → 한 번에 10만 행을 밀지 않는다.
--   ③ B1 로 '이미 된 것' 을 먼저 확인한다. 트리 백필이 끝나 있으면 B3 은 즉시 0행이다.
--
-- 롤백(이 브랜드만): 2026-08-07_backfill_property_brand.sql 머리의 롤백 절차와 동일.
-- ============================================================================


SET @brand := 5;


-- ═════════════════════════════════════════════════════════════════════════════
-- B1. 현재 상태 — 무엇이 이미 됐는지 (읽기 전용)
-- ═════════════════════════════════════════════════════════════════════════════

-- B1-1. 안전 게이트 (0 이어야 진행)
SELECT COUNT(*) AS 미검토그룹
FROM _mig_group_role WHERE brand_id = @brand AND is_reviewed = 0;

-- B1-2. 그룹 역할 — property 가 '브랜드' 축이어야 한다
SELECT gr.group_id, gr.group_name, gr.role, gr.is_reviewed, gr.num_categories
FROM _mig_group_role gr WHERE gr.brand_id = @brand ORDER BY gr.group_id;

-- B1-3. 진행 상황 한눈에
--   트리대상쌍 == 연결테이블행  이면 B3(트리 백필)은 건너뛰어도 된다.
SELECT
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT p.id AS pid, c.id AS cid
     FROM products p
     JOIN product_categories c ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
     JOIN _mig_group_role r ON r.group_id = c.product_category_group_id
     WHERE r.role='tree' AND r.brand_id=@brand AND c.is_delete=0
       AND p.is_delete=0 AND p.brand_id=@brand
   ) t)                                                                     AS 트리대상쌍,
  (SELECT COUNT(*) FROM products_categories
    WHERE brand_id=@brand AND is_delete=0)                                  AS 연결테이블행,
  (SELECT COUNT(*) FROM product_categories c
    JOIN _mig_group_role gr ON gr.group_id=c.product_category_group_id
   WHERE gr.role='property' AND gr.brand_id=@brand AND c.is_delete=0)       AS facet카테고리,
  (SELECT COUNT(*) FROM _mig_cat_to_prop WHERE brand_id=@brand)             AS 매핑,
  (SELECT COUNT(*) FROM _mig_group_to_propgroup WHERE brand_id=@brand)      AS 속성그룹,
  (SELECT is_category_migrated FROM brands WHERE id=@brand)                 AS 전환여부;

-- B1-4. ★ 중복 브랜드명 — 1062 에러의 원인. 행이 나오는 것이 정상이다.
--   어떤 이름이 겹쳤는지 보이니 나중에 데이터 정리 참고가 된다.
SELECT c.category_name                       AS 이름,
       COUNT(*)                              AS 카테고리수,
       GROUP_CONCAT(c.id ORDER BY c.id)      AS 카테고리ids
FROM product_categories c
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
WHERE gr.role = 'property' AND gr.brand_id = @brand AND c.is_delete = 0
GROUP BY c.category_name
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, c.category_name;

-- B1-5. 실패한 실행이 남긴 고아 속성 — B2 가 지울 대상
SELECT COUNT(*) AS 고아속성수
FROM product_properties pp
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.property_id = pp.id);


-- ═════════════════════════════════════════════════════════════════════════════
-- B2. 고아 속성 정리 (멱등 — 매핑에 기록된 정상분은 건드리지 않는다)
-- ═════════════════════════════════════════════════════════════════════════════
DELETE pap FROM products_and_properties pap
JOIN product_properties pp ON pp.id = pap.property_id
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.property_id = pp.id);

DELETE pp FROM product_properties pp
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
  AND NOT EXISTS (SELECT 1 FROM _mig_cat_to_prop cp WHERE cp.property_id = pp.id);


-- ═════════════════════════════════════════════════════════════════════════════
-- B3. 트리 백필 — 경고 0건, 배치.
--
--   ★ '영향받은 행' 이 0 이 될 때까지 이 문장 하나만 반복 실행할 것.
--     B1-3 에서 트리대상쌍 == 연결테이블행 이었으면 첫 실행부터 0행이다.
--
--   INSERT IGNORE 를 쓰지 않는다. LEFT JOIN 으로 '아직 없는 쌍' 만 고르므로
--   중복키 경고가 아예 발생하지 않는다(= HeidiSQL 이 안 튕긴다).
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO products_categories (brand_id, product_id, category_id, sort_idx)
SELECT DISTINCT p.brand_id, p.id, c.id, 0
FROM products p
JOIN product_categories c
  ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_role gr
  ON gr.group_id = c.product_category_group_id
LEFT JOIN products_categories pc
  ON pc.product_id = p.id AND pc.category_id = c.id
WHERE gr.role = 'tree' AND gr.brand_id = @brand
  AND c.is_delete = 0 AND p.is_delete = 0 AND p.brand_id = @brand
  AND pc.id IS NULL
LIMIT 20000;


-- ═════════════════════════════════════════════════════════════════════════════
-- B4. 속성그룹 생성 (이미 있으면 no-op)
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
-- B5. 속성값 생성 — 이름당 하나만 (GROUP BY). 1062 를 막는 핵심.
--     ※ B2 를 먼저 돌렸다는 전제 — 그래야 이 그룹에 고아 속성이 없다.
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
-- B6. 매핑 기록 — 이름당 속성이 하나뿐이라 PK 가 충돌하지 않는다.
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

-- 확인: facet카테고리수 == 매핑수. 속성수는 중복 이름만큼 적다.
SELECT
  (SELECT COUNT(*) FROM product_categories c
    JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
   WHERE gr.role='property' AND gr.brand_id=@brand AND c.is_delete=0)       AS facet카테고리수,
  (SELECT COUNT(*) FROM _mig_cat_to_prop WHERE brand_id=@brand)             AS 매핑수,
  (SELECT COUNT(DISTINCT property_id) FROM _mig_cat_to_prop
    WHERE brand_id=@brand)                                                  AS 속성수;


-- ═════════════════════════════════════════════════════════════════════════════
-- B7. 상품 → 속성 링크 — 배치.
--     ★ '영향받은 행' 이 0 이 될 때까지 이 문장 하나만 반복 실행할 것.
--     상품이 55,649 개라 한 번에 밀지 않는다.
-- ═════════════════════════════════════════════════════════════════════════════
INSERT INTO products_and_properties (product_id, property_group_id, property_id)
SELECT DISTINCT p.id, cp.property_group_id, cp.property_id
FROM products p
JOIN _mig_cat_to_prop cp
  ON cp.category_id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_to_propgroup m
  ON m.property_group_id = cp.property_group_id AND m.brand_id = @brand
LEFT JOIN products_and_properties pap
  ON pap.product_id = p.id AND pap.property_id = cp.property_id
WHERE p.brand_id = @brand AND p.is_delete = 0
  AND pap.product_id IS NULL
LIMIT 20000;


-- B7-확인. 아직 안 넣은 링크가 몇 개 남았는지 (0 이 될 때까지 B7 을 더 돌린다)
--   B8 이 facet 카테고리를 숨긴 뒤에도 이 쿼리와 B7 은 정상 동작한다 —
--   둘 다 product_categories 가 아니라 _mig_cat_to_prop 을 참조하기 때문이다.
SELECT COUNT(*) AS 남은링크
FROM products p
JOIN _mig_cat_to_prop cp
  ON cp.category_id IN (p.category_id0, p.category_id1, p.category_id2)
JOIN _mig_group_to_propgroup m
  ON m.property_group_id = cp.property_group_id AND m.brand_id = @brand
LEFT JOIN products_and_properties pap
  ON pap.product_id = p.id AND pap.property_id = cp.property_id
WHERE p.brand_id = @brand AND p.is_delete = 0
  AND pap.product_id IS NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- B8. facet 카테고리를 트리에서 숨김 (soft-delete, 되돌릴 수 있음)
--     ★ 새 코드가 배포돼 있어야 한다.
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE product_categories c
JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
SET c.is_delete = 1
WHERE gr.role = 'property' AND gr.brand_id = @brand AND c.is_delete = 0;


-- ═════════════════════════════════════════════════════════════════════════════
-- B9. 전환
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE brands SET is_category_migrated = 1 WHERE id = @brand;


-- ═════════════════════════════════════════════════════════════════════════════
-- 검증
-- ═════════════════════════════════════════════════════════════════════════════

-- V1 보존성 (일치 기대)
SELECT
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT p.id AS pid, c.id AS cid FROM products p
     JOIN product_categories c ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
     JOIN _mig_group_role r ON r.group_id = c.product_category_group_id
     WHERE r.role='tree' AND r.brand_id=@brand AND c.is_delete=0
       AND p.is_delete=0 AND p.brand_id=@brand
   ) t)                                                                     AS tree_pairs,
  (SELECT COUNT(*) FROM products_categories
    WHERE is_delete=0 AND brand_id=@brand)                                  AS pc_rows;

-- V2 고아 연결행 (0 기대)
SELECT COUNT(*) AS orphan_rows FROM products_categories pc
LEFT JOIN product_categories c ON c.id = pc.category_id
WHERE pc.brand_id=@brand AND pc.is_delete=0 AND (c.id IS NULL OR c.is_delete=1);

-- V3 속성 커버리지
SELECT m.property_group_id                                                  AS 속성그룹id,
       (SELECT COUNT(DISTINCT cp.property_id) FROM _mig_cat_to_prop cp
         WHERE cp.property_group_id = m.property_group_id)                  AS 속성수,
       (SELECT COUNT(*) FROM products_and_properties pp
         WHERE pp.property_group_id = m.property_group_id)                  AS 상품링크수
FROM _mig_group_to_propgroup m WHERE m.brand_id = @brand;

-- V4 속성 이름 중복 (0행 기대)
SELECT pp.product_property_group_id AS 속성그룹id, pp.property_name AS 이름, COUNT(*) AS 개수
FROM product_properties pp
JOIN _mig_group_to_propgroup m ON m.property_group_id = pp.product_property_group_id
WHERE m.brand_id = @brand
GROUP BY pp.product_property_group_id, pp.property_name
HAVING COUNT(*) > 1;

-- V5 남은 미전환 브랜드 (빈 결과 기대 = 93개 전부 완료)
SELECT b.id, b.dns, b.name
FROM brands b
WHERE b.is_delete = 0 AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id;
