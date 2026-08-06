-- ============================================================================
-- 카테고리 단일트리 전환 — 3차: 2차 실행 후 남은 6개 브랜드
-- HeidiSQL용. 멱등.
--
-- 2차(2026-08-07_category_preview_brands.sql) 결과: 87 전환 / 6 미전환.
-- 남은 6개는 성격이 셋으로 갈린다.
--
--   ┌ id 5  demo4.asapmall.kr  그랑파리   그룹 '카테고리|브랜드'  cat 222  상품 55,649  ← 프레임3
--   └ id 74 thegrazia.com      The grazia 그룹 '브랜드|카테고리'  cat 212  상품  3,094
--       → 이 스크립트가 다루지 않는다. migrations/backfill_one_brand.sql 이 담당한다.
--         '브랜드' 그룹은 트리에 합치는 게 아니라 속성(product_properties)으로 이관해야 하고,
--         그 스크립트가 속성그룹 생성·속성값 생성·상품 링크·facet soft-delete·검증까지 한다.
--         ※ Phase 4d 가 facet 카테고리를 soft-delete 하므로 반드시 '새 코드 배포 후' 실행할 것.
--           구 코드에서 돌리면 그 카테고리들이 화면에서 그냥 사라진다.
--         사용: SET @brand := 5;  (또는 74) 로 바꿔 한 브랜드씩.
--
--   ┌ id 104 test10.shopgo.co.kr  그룹 3개  카테고리 0개   ← 합칠 것이 없음
--   ├ id 54  creammom.shop        그룹 '카테고리|category'
--   └ id 71  giftmall555.com      그룹 '카테고리|category'
--       → [규칙 A/B] 로 자동 처리. 아래 참조.
--
--   └ id 50 demo11.asapmall.kr22  그룹 '자동차|여행|스포츠/레저|유아동/주니어' cat 24 상품 0
--       → 진짜 대분류를 그룹으로 쓴 경우. [3] 승격 블록으로 처리(이름을 살린다).
--
-- 자동 처리 규칙 — 둘 다 '합쳐도 화면이 안 바뀐다'가 보장될 때만 전환한다:
--   [규칙 A] 카테고리가 0개        → 그룹이 몇 개든 합칠 대상이 없다
--   [규칙 B] 카테고리가 한 그룹에만 몰려 있고 나머지 그룹은 전부 비어 있다
--            → 빈 그룹의 이름만 사라진다. 트리는 그대로다.
--
-- 롤백: UPDATE brands SET is_category_migrated=0 WHERE id IN (...);
-- ※ 실행 전 백업: brands, product_category_groups, product_categories
-- ============================================================================


-- ═════════════════════════════════════════════════════════════════════════════
-- [1] 진단 — 남은 브랜드의 그룹별 카테고리 분포 (변경 없음)
--     '카테고리있는그룹수'가 0 또는 1이면 아래 [2]가 자동 전환한다.
--     2 이상이면 [3] 승격 대상이다.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT
  b.id, b.dns, b.name,
  g.id                                AS 그룹id,
  g.category_group_name               AS 그룹명,
  (SELECT COUNT(*) FROM product_categories c
    WHERE c.product_category_group_id = g.id AND c.is_delete = 0)                       AS 카테고리수,
  (SELECT COUNT(*) FROM product_categories c
    WHERE c.product_category_group_id = g.id AND c.is_delete = 0 AND c.parent_id = -1)  AS 최상위수,
  (SELECT MAX(c.depth) FROM product_categories c
    WHERE c.product_category_group_id = g.id AND c.is_delete = 0)                       AS 최대깊이
FROM brands b
JOIN product_category_groups g ON g.brand_id = b.id AND g.is_delete = 0
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id, g.id;


-- ── 판정 요약 ───────────────────────────────────────────────────────────────
SELECT
  b.id, b.dns, b.name,
  (SELECT COUNT(*) FROM product_category_groups g
    WHERE g.brand_id=b.id AND g.is_delete=0)                                            AS 그룹수,
  (SELECT COUNT(*) FROM product_categories c
    WHERE c.brand_id=b.id AND c.is_delete=0)                                            AS 카테고리수,
  (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
    WHERE c.brand_id=b.id AND c.is_delete=0)                                            AS 카테고리있는그룹수,
  CASE
    WHEN b.id IN (5, 74)                                                THEN '→ backfill_one_brand.sql (배포 후)'
    WHEN (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
           WHERE c.brand_id=b.id AND c.is_delete=0) <= 1                THEN '[2] 자동 전환'
    ELSE                                                                     '[3] 승격 필요'
  END                                                                                    AS 처리
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY 처리, b.id;


-- ═════════════════════════════════════════════════════════════════════════════
-- [2] 자동 전환 — 규칙 A/B. [1] 결과 확인 후 실행.
--     id 5·74 는 명시적으로 제외한다(속성 이관이 선행돼야 한다).
-- ═════════════════════════════════════════════════════════════════════════════
UPDATE brands b
SET b.is_category_migrated = 1
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND b.id NOT IN (5, 74)
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND (SELECT COUNT(DISTINCT c.product_category_group_id)
         FROM product_categories c
        WHERE c.brand_id = b.id AND c.is_delete = 0) <= 1;


-- ═════════════════════════════════════════════════════════════════════════════
-- [3] 그룹명을 최상위 카테고리로 승격 — 한 브랜드씩. @brand 만 바꿔 실행.
--
--     대상: [1] 판정이 '[3] 승격 필요' 인 브랜드 (현재 id 50)
--
--     하는 일: 그룹마다 그 이름의 최상위 카테고리를 하나 만들고,
--              그 그룹의 기존 최상위들을 그 아래로 옮긴다. 그룹 이름이 트리에 남는다.
--
--     예) '자동차' 그룹의 [세단, SUV]  →  자동차 ─┬ 세단
--                                                └ SUV
--
--     ※ 이미 그 이름의 최상위 카테고리가 있으면 만들지 않는다(멱등).
--     ※ depth 는 그룹 전체에 한 번씩만 +1 된다(행마다 정확히 1회) — 중복 가산 없음.
-- ═════════════════════════════════════════════════════════════════════════════

SET @brand := 50;   -- ★★★ 대상 브랜드 ★★★

-- 3-1) 그룹 이름과 같은 최상위 카테고리 생성 (그룹당 1개, 없을 때만)
--      status=0 이어야 고객 화면에 보인다(shop.controller 가 status=0 만 가져간다).
INSERT INTO product_categories
  (brand_id, product_category_group_id, category_name, parent_id, depth, sort_idx, status)
SELECT g.brand_id, g.id, g.category_group_name, -1, 0, g.sort_idx, 0
FROM product_category_groups g
WHERE g.brand_id = @brand
  AND g.is_delete = 0
  AND EXISTS (SELECT 1 FROM product_categories c
               WHERE c.product_category_group_id = g.id AND c.is_delete = 0)
  AND NOT EXISTS (SELECT 1 FROM product_categories c
                   WHERE c.product_category_group_id = g.id AND c.is_delete = 0
                     AND c.parent_id = -1 AND c.category_name = g.category_group_name);

-- 3-2) 방금 만든 승격 노드를 기억해 둔다 (아래 두 UPDATE 에서 자기 자신을 건드리지 않도록)
DROP TEMPORARY TABLE IF EXISTS _promoted;
CREATE TEMPORARY TABLE _promoted (category_id BIGINT PRIMARY KEY, group_id BIGINT);

INSERT INTO _promoted (category_id, group_id)
SELECT c.id, c.product_category_group_id
FROM product_categories c
JOIN product_category_groups g
  ON g.id = c.product_category_group_id AND g.category_group_name = c.category_name
WHERE c.brand_id = @brand AND c.is_delete = 0 AND c.parent_id = -1 AND g.is_delete = 0;

SELECT * FROM _promoted;   -- 확인: 그룹 수만큼 나와야 한다

-- 3-3) 기존 최상위들을 승격 노드의 자식으로 (승격 노드 자신은 제외)
UPDATE product_categories c
JOIN _promoted p ON p.group_id = c.product_category_group_id
SET c.parent_id = p.category_id
WHERE c.brand_id = @brand
  AND c.is_delete = 0
  AND c.parent_id = -1
  AND c.id <> p.category_id;

-- 3-4) 그 그룹의 나머지 전부 depth +1 (승격 노드만 0 으로 남는다)
UPDATE product_categories c
JOIN _promoted p ON p.group_id = c.product_category_group_id
SET c.depth = c.depth + 1
WHERE c.brand_id = @brand
  AND c.is_delete = 0
  AND c.id <> p.category_id;

DROP TEMPORARY TABLE IF EXISTS _promoted;

-- 3-5) 트리 확인 — parent_id=-1 인 것이 '그룹명'들뿐인지, depth 가 부모+1 인지 본다
SELECT c.id, c.parent_id, c.depth, c.product_category_group_id AS 그룹id,
       c.category_name, c.sort_idx, c.status
FROM product_categories c
WHERE c.brand_id = @brand AND c.is_delete = 0
ORDER BY c.product_category_group_id, c.depth, c.sort_idx, c.id;

-- 3-6) 이상 없으면 전환
UPDATE brands SET is_category_migrated = 1 WHERE id = @brand;


-- ═════════════════════════════════════════════════════════════════════════════
-- [4] 최종 확인 — 남는 것은 id 5 와 74 뿐이어야 한다
-- ═════════════════════════════════════════════════════════════════════════════
SELECT COALESCE(b.is_category_migrated,0) AS 전환여부, COUNT(*) AS 브랜드수
FROM brands b WHERE b.is_delete = 0 AND b.is_main_dns <> 1
GROUP BY COALESCE(b.is_category_migrated,0);

SELECT b.id, b.dns, b.name,
       (SELECT COUNT(*) FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹수,
       (SELECT GROUP_CONCAT(g.category_group_name ORDER BY g.id SEPARATOR ' | ')
                          FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹명,
       (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=b.id AND c.is_delete=0) AS 카테고리수,
       CASE WHEN b.id IN (5,74) THEN '정상 — backfill_one_brand.sql 대기(배포 후)'
            ELSE '확인 필요' END AS 상태
FROM brands b
WHERE b.is_delete = 0 AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY b.id;
