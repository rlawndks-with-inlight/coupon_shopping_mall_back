-- ============================================================================
-- 카테고리 구조 전면 정규화 — 스키마/시드/검증 (Phase 0~2, 6)
-- 날짜: 2026-08-03
-- 설계서: coupon_shopping_mall_front-master/CATEGORY-RESTRUCTURE-SPEC.md
--
-- 목표: 그룹 facet × 위치컬럼(category_id0/1/2) → 단일 카테고리 트리
--       + 상품↔카테고리 연결테이블(products_categories) + 브랜드=상품속성.
--
-- 이 파일이 하는 일 (전량 additive · 멱등 · 롤백가능):
--   Phase 0 : 원본 스냅샷(롤백 안전판)
--   Phase 1 : 신규 연결테이블 + 마이그레이션 매핑 테이블 DDL
--   Phase 2 : 그룹 역할(tree/property) 분류 시드 + 육안검토 쿼리
--   Phase 6 : 검증 쿼리 V1~V6 (백필 후 실행)
--   (Phase 3 트리백필 / Phase 4 브랜드→속성 이전은 Node 스크립트에서:
--     scripts/category-restructure-backfill.js — 역할검토 게이트가 필요하기 때문)
--
-- ⚠ 실행 순서 / 안전:
--   - 공유 프로덕션 DB(타 프로젝트 실고객 공존) → 실행 전 전체 백업 필수.
--   - 본 DDL은 신규 테이블 + NULL허용 컬럼뿐 → 기존 행·타 프로젝트에 무해.
--   - Phase 2 시드 후 반드시 육안검토(아래 REVIEW 쿼리)로 role 확정 → is_reviewed=1.
--   - 이후 scripts/category-restructure-backfill.js 실행(리뷰 게이트 통과해야 진행).
--   - '1681 Integer display width deprecated' 경고는 기존 정수컬럼 때문 → 무시.
--
-- ※ 타입 주의: products.id / product_categories.id 실제 타입(대부분 int)에 맞춰
--   product_id / category_id 를 INT 로 둠. 실 스키마가 BIGINT면 아래 INT→BIGINT 수정.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 0. 원본 스냅샷 (IF NOT EXISTS = 최초 1회만 캡처, 재실행해도 덮어쓰지 않음)
-- ─────────────────────────────────────────────────────────────────────────────

-- 상품의 위치컬럼 원본 (트리 백필 롤백/검증 기준)
CREATE TABLE IF NOT EXISTS _mig_products_snapshot AS
SELECT id, brand_id, category_id0, category_id1, category_id2
FROM products;

-- 그룹레벨 헤더노출 원본 (Phase 5 헤더정규화 롤백 기준)
CREATE TABLE IF NOT EXISTS _mig_group_header_snapshot AS
SELECT id, brand_id, is_show_header_menu
FROM product_category_groups;

-- 카테고리레벨 헤더노출/상태 원본 (Phase 5 롤백 기준)
CREATE TABLE IF NOT EXISTS _mig_category_header_snapshot AS
SELECT id, brand_id, product_category_group_id, is_show_header_menu, status
FROM product_categories;


-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1. 신규 테이블 DDL
-- ─────────────────────────────────────────────────────────────────────────────

-- 상품↔카테고리 연결테이블 (1상품 N카테고리). 리프-only 저장.
--   UNIQUE(product_id, category_id) = 멱등성 핵심(INSERT IGNORE 안전).
CREATE TABLE IF NOT EXISTS products_categories (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  brand_id    INT NOT NULL,
  product_id  INT NOT NULL,
  category_id INT NOT NULL,
  sort_idx    INT      DEFAULT 0,
  is_delete   TINYINT  DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_prodcat (product_id, category_id),
  KEY idx_pc_cat   (category_id, product_id),
  KEY idx_pc_brand (brand_id, is_delete)
);

-- 그룹 역할 분류/검토 테이블 (Phase 2에서 시드, 운영자가 검토·확정).
CREATE TABLE IF NOT EXISTS _mig_group_role (
  group_id              INT PRIMARY KEY,
  brand_id              INT,
  group_name            VARCHAR(255),
  num_categories        INT DEFAULT 0,   -- 그룹 내 카테고리 수
  num_parent_categories INT DEFAULT 0,   -- 자식을 가진 카테고리 수(>0 이면 트리 신호)
  num_products_linked   INT DEFAULT 0,   -- 이 그룹 카테고리를 cat0/1/2로 참조하는 상품 수
  suggested_role        VARCHAR(16),     -- 휴리스틱 제안값(참고용)
  role                  VARCHAR(16) DEFAULT 'property',  -- ★운영자 결정(백필이 읽는 진실값)
  is_reviewed           TINYINT DEFAULT 0,               -- ★검토 완료 표시(1이어야 백필 진행)
  note                  VARCHAR(255)
);

-- 브랜드→속성 이전 영속 매핑(재실행 멱등 기준). 백필 스크립트가 채움.
CREATE TABLE IF NOT EXISTS _mig_group_to_propgroup (
  group_id          INT PRIMARY KEY,   -- 원본 카테고리그룹
  brand_id          INT,
  property_group_id INT,               -- 생성된 product_property_groups.id
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS _mig_cat_to_prop (
  category_id       INT PRIMARY KEY,   -- 원본 카테고리(facet)
  brand_id          INT,
  property_id       INT,               -- 생성된 product_properties.id
  property_group_id INT,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);


-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2. 그룹 역할 분류 시드 (기본 property, 신호 계산 후 tree 제안)
--   재실행 안전: ON DUPLICATE 로 신호만 갱신, is_reviewed=1 로 확정한 role 은 보존.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2-1. 그룹 목록 + 카테고리 수 시드
INSERT INTO _mig_group_role (group_id, brand_id, group_name, num_categories)
SELECT g.id, g.brand_id, g.category_group_name,
       (SELECT COUNT(*) FROM product_categories c
         WHERE c.product_category_group_id = g.id AND c.is_delete = 0)
FROM product_category_groups g
WHERE g.is_delete = 0
ON DUPLICATE KEY UPDATE
  brand_id = VALUES(brand_id),
  group_name = VALUES(group_name),
  num_categories = VALUES(num_categories);

-- 2-2. 트리 신호: 자식을 가진 카테고리 수
UPDATE _mig_group_role r
SET num_parent_categories = (
  SELECT COUNT(DISTINCT c.id) FROM product_categories c
  WHERE c.product_category_group_id = r.group_id AND c.is_delete = 0
    AND EXISTS (SELECT 1 FROM product_categories ch
                 WHERE ch.parent_id = c.id AND ch.is_delete = 0)
);

-- 2-3. 상품 연결 수: 이 그룹의 카테고리를 cat0/1/2 로 참조하는 상품 수
UPDATE _mig_group_role r
SET num_products_linked = (
  SELECT COUNT(DISTINCT p.id) FROM products p
  JOIN product_categories c
    ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
  WHERE c.product_category_group_id = r.group_id
    AND c.is_delete = 0 AND p.is_delete = 0
);

-- 2-4. 휴리스틱 제안(참고용). 실제 확정은 운영자 육안검토.
UPDATE _mig_group_role SET suggested_role = CASE
  WHEN num_parent_categories > 0 THEN 'tree'                  -- 계층 있으면 트리
  WHEN group_name LIKE '%브랜드%' OR LOWER(group_name) LIKE '%brand%' THEN 'property'
  WHEN group_name LIKE '%카테고리%' OR group_name LIKE '%분류%'
    OR LOWER(group_name) LIKE '%categor%' THEN 'tree'
  ELSE 'property' END;

-- 미검토 행에 한해 제안값을 role 기본값으로 채움(검토완료 행은 건드리지 않음)
UPDATE _mig_group_role SET role = suggested_role
WHERE is_reviewed = 0 AND suggested_role IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- ★ REVIEW (필수): 아래를 실행해 육안 검토 후, 각 그룹의 role 을 확정하고 is_reviewed=1.
--   판단 가이드:
--     - 실제 분류축(상의>티셔츠, 계층/큐레이션) → 'tree'
--     - 제조사/상표 등 평면 facet(나이키/아디다스) → 'property'
--   role 수정 예:
--     UPDATE _mig_group_role SET role='tree',     is_reviewed=1 WHERE group_id=?;
--     UPDATE _mig_group_role SET role='property', is_reviewed=1 WHERE group_id=?;
--   전부 제안값대로 확정할 경우:
--     UPDATE _mig_group_role SET is_reviewed=1;   -- (신중히: 제안이 100% 정답은 아님)
-- ─────────────────────────────────────────────────────────────────────────────
--   SELECT group_id, brand_id, group_name, num_categories, num_parent_categories,
--          num_products_linked, suggested_role, role, is_reviewed
--   FROM _mig_group_role ORDER BY brand_id, suggested_role DESC, num_products_linked DESC;


-- ============================================================================
-- Phase 6. 검증 쿼리 V1~V6 (백필 스크립트 실행 후 수동 실행 — 결과 0 또는 일치 기대)
-- ============================================================================

-- V1 보존성: '트리 역할' 위치참조쌍 수 == 연결테이블 유효행 수 (누락 없음 확인)
--   기대: distinct_pairs == pc_rows
-- SELECT
--   (SELECT COUNT(*) FROM (
--      SELECT DISTINCT p.id AS pid, c.id AS cid
--      FROM products p
--      JOIN product_categories c ON c.id IN (p.category_id0,p.category_id1,p.category_id2)
--      JOIN _mig_group_role r ON r.group_id=c.product_category_group_id
--      WHERE r.role='tree' AND c.is_delete=0 AND p.is_delete=0
--    ) t) AS distinct_pairs,
--   (SELECT COUNT(*) FROM products_categories WHERE is_delete=0) AS pc_rows;

-- V2 고아: 존재하지 않거나 삭제된 카테고리를 가리키는 연결행 (기대: 0)
-- SELECT COUNT(*) AS orphan_rows FROM products_categories pc
-- LEFT JOIN product_categories c ON c.id=pc.category_id
-- WHERE pc.is_delete=0 AND (c.id IS NULL OR c.is_delete=1);

-- V3 분류 유실: 활성 상품인데 연결테이블에 트리 카테고리가 하나도 없는 상품 목록
--   (원래 dangling/삭제 카테고리만 참조했거나, property 전용 상품 — 육안 확인용)
-- SELECT p.id, p.brand_id, p.product_name, p.category_id0, p.category_id1, p.category_id2
-- FROM products p
-- WHERE p.is_delete=0
--   AND NOT EXISTS (SELECT 1 FROM products_categories pc
--                    WHERE pc.product_id=p.id AND pc.is_delete=0)
-- ORDER BY p.brand_id, p.id;

-- V4 브랜드(속성) 커버리지: role=property 그룹의 이전 결과 요약
-- SELECT r.group_id, r.group_name, m.property_group_id,
--        (SELECT COUNT(*) FROM _mig_cat_to_prop cp WHERE cp.property_group_id=m.property_group_id) AS props,
--        (SELECT COUNT(*) FROM products_and_properties pp
--          WHERE pp.property_group_id=m.property_group_id AND pp.is_delete=0) AS links
-- FROM _mig_group_role r
-- LEFT JOIN _mig_group_to_propgroup m ON m.group_id=r.group_id
-- WHERE r.role='property' ORDER BY r.brand_id, r.group_id;

-- V5 사전 중복: 연결테이블 (product_id, category_id) 중복 (UNIQUE 로 0 보장 — 확인용)
-- SELECT product_id, category_id, COUNT(*) c FROM products_categories
-- WHERE is_delete=0 GROUP BY product_id, category_id HAVING c>1;

-- V6 스냅샷 대비: 위치컬럼에 값이 있었으나(스냅샷) 트리·속성 어느 쪽으로도
--   이전되지 않은 (product, slot) 조사 — dangling ref 후보 목록
-- SELECT s.id AS product_id, s.brand_id, v.slot, v.cat_id
-- FROM _mig_products_snapshot s
-- JOIN (
--   SELECT id, 'cat0' slot, category_id0 cat_id FROM _mig_products_snapshot WHERE category_id0>0
--   UNION ALL SELECT id, 'cat1', category_id1 FROM _mig_products_snapshot WHERE category_id1>0
--   UNION ALL SELECT id, 'cat2', category_id2 FROM _mig_products_snapshot WHERE category_id2>0
-- ) v ON v.id=s.id
-- LEFT JOIN products_categories pc ON pc.product_id=s.id AND pc.category_id=v.cat_id AND pc.is_delete=0
-- LEFT JOIN _mig_cat_to_prop cp ON cp.category_id=v.cat_id
-- WHERE pc.id IS NULL AND cp.category_id IS NULL
-- ORDER BY s.brand_id, s.id;


-- ============================================================================
-- 롤백 (컷오버 문제 시 — 구코드 재배포로 즉시 복귀 후, 산출물만 정밀 제거)
-- ============================================================================
-- 주의: 기존 category_id0/1/2 · product_category_group_id 는 무손상이므로
--       구 백엔드/프론트 재배포만으로 즉시 원복. 아래는 산출물 정리용.
--
--   -- 트리 백필 산출물 제거
--   DROP TABLE IF EXISTS products_categories;
--
--   -- 속성 이전 산출물 제거(이번 마이그레이션이 생성한 것만; 기존 속성행 보존)
--   DELETE pp FROM products_and_properties pp
--     JOIN _mig_cat_to_prop cp ON cp.property_id=pp.property_id;
--   DELETE FROM product_properties      WHERE id IN (SELECT property_id       FROM _mig_cat_to_prop);
--   DELETE FROM product_property_groups WHERE id IN (SELECT property_group_id FROM _mig_group_to_propgroup);
--
--   -- 트리에서 숨겼던 facet 카테고리 복원(백필이 soft-delete 한 것 되돌리기)
--   UPDATE product_categories SET is_delete=0 WHERE id IN (SELECT category_id FROM _mig_cat_to_prop);
--
--   -- Phase 5 헤더노출 정규화 원복(스냅샷에서 복원)
--   UPDATE product_categories c
--     JOIN _mig_category_header_snapshot s ON s.id=c.id
--     SET c.is_show_header_menu=s.is_show_header_menu, c.status=s.status;
--
--   -- 매핑/스냅샷 정리(원복 검증 후 최종 단계에서만)
--   -- DROP TABLE IF EXISTS _mig_cat_to_prop, _mig_group_to_propgroup, _mig_group_role,
--   --   _mig_products_snapshot, _mig_group_header_snapshot, _mig_category_header_snapshot;
-- ============================================================================
