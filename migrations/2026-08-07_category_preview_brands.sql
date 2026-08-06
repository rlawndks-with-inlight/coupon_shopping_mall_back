-- ============================================================================
-- 카테고리 단일트리 전환 — 2차: 미리보기 브랜드 11개 + 그룹명 중복 브랜드
-- HeidiSQL용. 멱등(여러 번 실행해도 결과 같음).
--
-- 1차(2026-08-06_category_batch_migrate.sql)에서 '안전한 것만' 전환하고
-- 아래 셋을 남겨 뒀다. 이 스크립트는 그중 판단이 끝난 둘을 처리한다.
--
--   [남은 것 1] 미리보기 브랜드 11개  ← 이 스크립트가 처리
--       /frames 미리보기가 이 브랜드들의 실데이터를 그대로 보여주기 때문에
--       화면이 바뀌는 것을 확인한 뒤 전환하기로 했다.
--       판단 결과: 전환한다. 카테고리 그룹을 표시하던 디자인은 이제
--       카테고리를 표시하는 것이 맞다(= 정규화 이후의 의도된 화면).
--
--   [남은 것 2] 그룹이 2개 이상인 브랜드  ← 이름이 중복인 경우만 이 스크립트가 처리
--       그룹을 '대분류'로 써 온 브랜드가 섞여 있어 일괄 전환하면 그룹 이름이 사라진다.
--       단, 그룹 이름이 서로 같은(중복 생성된) 브랜드는 합쳐도 잃는 정보가 없다.
--
--   [남은 것 3] id 74 (The grazia)  ← 이 스크립트가 건드리지 않음
--       코드 12곳에 themeDnsData?.id == 74 하드코딩. 별도 판단.
--
-- 전환이 무엇을 바꾸는가 (shop.controller.js:356-385):
--   미전환: [{ id:<그룹id>, category_group_name:'...', product_categories: 그 그룹의 트리 }, ...]
--   전환후: [{ id:0,       product_categories: 브랜드 전체 카테고리의 단일 트리 }]
--   → 그룹이 1개면 결과가 사실상 동일. 2개 이상이면 트리가 하나로 합쳐진다.
--
-- 상품 필터는 dual-read(products_categories OR category_id0/1/2)라
-- 연결테이블 백필 없이 그대로 동작한다 → product.controller.js:161-165
--
-- 롤백: UPDATE brands SET is_category_migrated=0 WHERE id IN (<아래 6번에서 나온 id>);
--       (5번에서 생성된 그룹까지 되돌리려면 그 group id 를 is_delete=1)
--
-- ※ 실행 전 백업 필수:
--   mysqldump -u<user> -p <db> brands product_category_groups product_categories > backup_20260807.sql
-- ============================================================================


-- ── 미리보기 브랜드 목록 (front src/components/main-site/frameList.js 의
--    DEMO_PREVIEW_BRAND 와 일치. 값이 바뀌면 여기도 함께 고칠 것) ─────────────
DROP TEMPORARY TABLE IF EXISTS _preview_brand;
CREATE TEMPORARY TABLE _preview_brand (brand_id BIGINT PRIMARY KEY, frame_no INT);

INSERT IGNORE INTO _preview_brand (brand_id, frame_no)
SELECT b.id, x.no FROM brands b
JOIN (
  SELECT 1  AS no, 'jjpay.co.kr'          AS dns UNION ALL
  SELECT 2,        'shop.minbeautym.com'  UNION ALL
  SELECT 3,        'demo4.asapmall.kr'    UNION ALL
  SELECT 4,        'bs-company.co.kr'     UNION ALL
  SELECT 5,        'hynet777.com'         UNION ALL
  SELECT 6,        'glamup.co.kr'         UNION ALL
  SELECT 7,        'babypop.co.kr'        UNION ALL
  SELECT 8,        'dokdoland.com'        UNION ALL
  SELECT 9,        'buddymall.co.kr'      UNION ALL
  SELECT 10,       'malu-79.com'          UNION ALL
  SELECT 11,       'msbtmall.com'
) x ON x.dns = b.dns
WHERE b.is_delete = 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1) 사전 확인 — 미리보기 11개의 현재 상태 (변경 없음)
--    '그룹수'가 2 이상인 브랜드는 5)에서 자동 전환되지 않는다. 화면 확인 후 개별 판단.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  p.frame_no                                                      AS 프레임,
  b.id, b.dns, b.name,
  b.is_category_migrated                                          AS 전환여부,
  (SELECT COUNT(*)              FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹수,
  (SELECT GROUP_CONCAT(g.category_group_name ORDER BY g.id SEPARATOR ' | ')
                                FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹명,
  (SELECT COUNT(*)              FROM product_categories       c WHERE c.brand_id=b.id AND c.is_delete=0) AS 카테고리수,
  (SELECT COUNT(*)              FROM products                 pr WHERE pr.brand_id=b.id AND pr.is_delete=0) AS 상품수
FROM _preview_brand p
JOIN brands b ON b.id = p.brand_id
ORDER BY p.frame_no;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) 사전 확인 — 그룹이 2개 이상인 전체 브랜드의 '이름 중복' 여부 (변경 없음)
--    이름이 전부 같으면(=중복생성) 합쳐도 잃는 정보가 없어 6)에서 자동 전환한다.
--    이름이 다르면 그룹을 대분류로 쓴 것이므로 수동 판단 대상으로 남긴다.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  b.id, b.dns, b.name,
  g.cnt                                                            AS 그룹수,
  g.distinct_cnt                                                   AS 서로다른이름수,
  g.names                                                          AS 그룹명,
  CASE WHEN g.distinct_cnt = 1 THEN '자동전환 대상 (이름 중복)'
       ELSE '수동 판단 (그룹을 대분류로 사용)' END                  AS 판정,
  (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=b.id AND c.is_delete=0) AS 카테고리수,
  (SELECT COUNT(*) FROM products          pr WHERE pr.brand_id=b.id AND pr.is_delete=0) AS 상품수
FROM brands b
JOIN (
  SELECT brand_id,
         COUNT(*)                                    AS cnt,
         COUNT(DISTINCT category_group_name)         AS distinct_cnt,
         GROUP_CONCAT(category_group_name ORDER BY id SEPARATOR ' | ') AS names
  FROM product_category_groups WHERE is_delete=0 GROUP BY brand_id
) g ON g.brand_id = b.id
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND g.cnt >= 2
ORDER BY g.distinct_cnt, g.cnt DESC, b.id;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) 사전 확인 — 카테고리는 있는데 그룹이 없는 브랜드 (변경 없음)
--    1차 스크립트의 [A]는 '그룹0 AND 카테고리0'만 처리했으므로 이 조합이 남아 있을 수 있다.
--    관리자 카테고리 화면이 category_group_list[0]을 컨테이너로 쓰기 때문에
--    그룹이 없으면 카테고리를 추가할 수 없다 → 5)에서 기본 그룹을 만들어 준다.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT b.id, b.dns, b.name,
       (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=b.id AND c.is_delete=0) AS 카테고리수
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND NOT EXISTS (SELECT 1 FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0)
  AND     EXISTS (SELECT 1 FROM product_categories       c WHERE c.brand_id=b.id AND c.is_delete=0)
ORDER BY b.id;


-- ═════════════════════════════════════════════════════════════════════════════
--  여기서부터 변경. 위 1~3 결과를 확인한 뒤 실행할 것.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 4) 그룹이 하나도 없는 브랜드에 기본 '카테고리' 그룹 생성 ────────────────
--     (미리보기 브랜드 포함. 카테고리 유무와 무관 — 3)의 조합까지 함께 해소)
INSERT INTO product_category_groups
  (category_group_name, brand_id, max_depth, sort_type, is_show_header_menu, is_use_en_name)
SELECT '카테고리', b.id, 10, 0, 1, 0
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND b.id <> 74
  AND NOT EXISTS (SELECT 1 FROM product_category_groups g WHERE g.brand_id = b.id AND g.is_delete = 0);


-- ── 5) 미리보기 브랜드 전환 — 그룹이 1개인 것만 ─────────────────────────────
--     4) 실행 후이므로 '그룹 0개'였던 곳도 이제 1개다.
--     그룹 2개 이상(예: 프레임3 = 카테고리+브랜드)은 여기서 제외되고 7)에 보고된다.
UPDATE brands b
JOIN _preview_brand p ON p.brand_id = b.id
SET b.is_category_migrated = 1
WHERE b.is_delete = 0
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND (SELECT COUNT(*) FROM product_category_groups g WHERE g.brand_id = b.id AND g.is_delete = 0) = 1;


-- ── 6) 그룹명이 전부 같은(중복 생성된) 브랜드 전환 ──────────────────────────
--     그룹이 2개 이상이어도 이름이 하나뿐이면 합쳐도 사라지는 이름이 없다.
--     미리보기 브랜드도 이 조건에 맞으면 함께 전환된다.
UPDATE brands b
JOIN (
  SELECT brand_id
  FROM product_category_groups WHERE is_delete=0
  GROUP BY brand_id
  HAVING COUNT(*) >= 2 AND COUNT(DISTINCT category_group_name) = 1
) d ON d.brand_id = b.id
SET b.is_category_migrated = 1
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND b.id <> 74
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0);


-- ─────────────────────────────────────────────────────────────────────────────
-- 7) 사후 확인 — 전환 결과 요약
-- ─────────────────────────────────────────────────────────────────────────────
SELECT COALESCE(b.is_category_migrated,0) AS 전환여부, COUNT(*) AS 브랜드수
FROM brands b WHERE b.is_delete = 0 AND b.is_main_dns <> 1
GROUP BY COALESCE(b.is_category_migrated,0);


-- ── 8) 사후 확인 — 아직 미전환으로 남은 브랜드 (= 수동 판단 대상) ───────────
--     여기 남는 것은 '그룹을 대분류로 써 온 브랜드' 와 id 74 뿐이어야 한다.
--     각각 그룹을 어떻게 접을지(최상위 카테고리로 승격 / 속성으로 이동 / 폐기)
--     화면을 보고 결정한 뒤 개별 처리한다.
SELECT b.id, b.dns, b.name,
       (SELECT COUNT(*) FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹수,
       (SELECT GROUP_CONCAT(g.category_group_name ORDER BY g.id SEPARATOR ' | ')
                          FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹명,
       (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=b.id AND c.is_delete=0) AS 카테고리수,
       (SELECT COUNT(*) FROM products          pr WHERE pr.brand_id=b.id AND pr.is_delete=0) AS 상품수,
       (SELECT p.frame_no FROM _preview_brand p WHERE p.brand_id=b.id)                       AS 미리보기프레임,
       CASE WHEN b.id = 74 THEN 'id 74 — 코드 하드코딩 12곳, 별도 판단'
            ELSE '그룹을 대분류로 사용 — 접는 방식 결정 필요' END                             AS 사유
FROM brands b
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY 미리보기프레임 IS NULL, 미리보기프레임, 그룹수 DESC, b.id;


DROP TEMPORARY TABLE IF EXISTS _preview_brand;


-- ============================================================================
-- 부록) 그룹을 '최상위 카테고리'로 접는 방법 — 8)에 남은 브랜드용 템플릿
--
-- 예) 프레임3(demo4.asapmall.kr)은 그룹이 '카테고리' + '브랜드' 2개다.
--     설계상 브랜드는 카테고리가 아니라 '속성(product_properties)'이므로,
--     '브랜드' 그룹의 항목들은 카테고리 트리에 합치지 말고 속성으로 옮기는 것이 맞다.
--     다만 그 이관은 상품-속성 연결까지 따라가야 해서 화면 확인 후 개별로 진행한다.
--
-- 그룹을 최상위 카테고리로 승격시키는(=이름을 살리는) 일반적인 절차:
--   ※ 최상위는 parent_id = 0 이 아니라 -1 이다(utils.js/util.js makeTree 가 '-1' 을 루트로 본다).
--   ※ 컬럼명은 category_group_id 가 아니라 product_category_group_id 다.
--   ※ status 는 0 이 노출. 비회원 조회 SQL 이 status=0 만 가져간다(shop.controller.js:150).
--
--   ① 그룹 이름과 같은 최상위 카테고리를 만든다
--        INSERT INTO product_categories
--          (brand_id, product_category_group_id, category_name, parent_id, depth, sort_idx, status)
--        VALUES (<brand_id>, <group_id>, '<그룹명>', -1, 0, 0, 0);
--   ② 그 그룹에 속한 기존 최상위 카테고리들을 ①의 자식으로 옮긴다
--        UPDATE product_categories SET parent_id = <①의 id>, depth = depth + 1
--        WHERE brand_id = <brand_id> AND product_category_group_id = <group_id>
--          AND parent_id = -1 AND id <> <①의 id> AND is_delete = 0;
--        ※ depth 를 쓰는 화면이 있으므로 그 아래 하위 카테고리도 전부 +1 해야 한다.
--          깊이별로 나눠 실행할 것(한 번에 하면 방금 옮긴 것을 또 세게 된다).
--   ③ 브랜드 전환
--        UPDATE brands SET is_category_migrated = 1 WHERE id = <brand_id>;
--
-- 실행 전 해당 브랜드의 트리를 먼저 눈으로 확인할 것:
--   SELECT id, parent_id, depth, product_category_group_id, category_name, sort_idx, status
--   FROM product_categories WHERE brand_id = <brand_id> AND is_delete = 0
--   ORDER BY product_category_group_id, depth, sort_idx, id;
-- ============================================================================
