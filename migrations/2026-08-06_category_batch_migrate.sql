-- ============================================================================
-- 카테고리 단일트리 일괄 전환 — 안전 대상만 (HeidiSQL용). 멱등·재실행 안전.
--
-- 배경:
--   브랜드 생성 경로가 둘인데 카테고리 모델이 달랐다.
--     · 설정관리>브랜드설정(개발자) : is_category_migrated=1 + 기본 '카테고리' 그룹 생성
--     · 신청>승인(실제 가맹점)      : 둘 다 없음 → DEFAULT 0 → 옛 그룹 모델
--   그 결과 가맹점은 카테고리를 만들려면 '그룹'부터 만들어야 했고,
--   버튼에 "대분류 OO 추가"라고 쓰여 있어 그룹을 대분류로 쓰게 됐다.
--   반면 관리자 카테고리 화면은 이미 단일 트리로 동작해 서로 어긋났다.
--   (2026-08-06 부로 신청>승인 경로도 1 + 기본 그룹 생성으로 수정 → 신규는 이 문제 없음)
--
-- 이 스크립트가 다루는 대상 (안전한 것만):
--   [A] 빈 브랜드 : 그룹0 AND 카테고리0 → 기본 '카테고리' 그룹 생성 + 플래그 1
--   [B] 그룹1 브랜드 : 그룹이 정확히 1개 → 플래그 1 (데이터 변경 없음)
--
-- 제외 대상 (건드리지 않음. WHERE 로 명시 제외):
--   · 미리보기 브랜드 11개 — /frames 미리보기가 이 브랜드들의 실데이터를 그대로 보여준다.
--                            화면이 바뀌면 안 되므로 개별 확인 후 수동 전환.
--   · id 74 (The grazia)   — 코드 12곳에 themeDnsData?.id == 74 하드코딩. 별도 판단.
--   · 그룹 2개 이상        — 그룹을 대분류로 쓴 브랜드가 섞여 있어 트리 합치기 판단 필요.
--                            (그냥 전환하면 그룹 이름이 사라진다)
--   · is_main_dns=1 (본사) — 판매 안 함.
--
-- 왜 [B]가 안전한가:
--   그룹이 1개면 shop.controller 의 두 분기 결과가 사실상 같다.
--     미전환: [{ id:<실그룹id>, product_categories: makeTree(그 그룹의 카테고리) }]
--     전환후: [{ id:0,          product_categories: makeTree(브랜드 전체 카테고리) }]
--   그룹이 하나뿐이라 '그 그룹의 카테고리' == '브랜드 전체 카테고리' 다.
--   상품 필터도 dual-read(products_categories OR category_id0/1/2)라 연결테이블 백필 없이 동작한다.
--     → product.controller.js:161-165
--
-- 롤백: UPDATE brands SET is_category_migrated=0 WHERE id IN (...);
--       (그룹 생성분까지 되돌리려면 아래 8번 결과의 group id 로 is_delete=1)
--
-- ※ 실행 전 백업 필수:
--   mysqldump -u<user> -p <db> brands product_category_groups product_categories products > backup_20260806.sql
-- ============================================================================

-- 제외할 미리보기 브랜드 dns (front src/components/main-site/frameList.js DEMO_PREVIEW_BRAND 와 일치)
-- 값이 바뀌면 여기도 함께 고칠 것.
DROP TEMPORARY TABLE IF EXISTS _excl_brand;
CREATE TEMPORARY TABLE _excl_brand (brand_id BIGINT PRIMARY KEY);

INSERT IGNORE INTO _excl_brand (brand_id)
SELECT id FROM brands WHERE dns IN (
  'jjpay.co.kr',           -- 프레임1
  'shop.minbeautym.com',   -- 프레임2
  'demo4.asapmall.kr',     -- 프레임3 (그룹2: 카테고리+브랜드, 카테고리 222)
  'bs-company.co.kr',      -- 프레임4
  'hynet777.com',          -- 프레임5
  'glamup.co.kr',          -- 프레임6
  'babypop.co.kr',         -- 프레임7
  'dokdoland.com',         -- 프레임8
  'buddymall.co.kr',       -- 프레임9
  'malu-79.com',           -- 프레임10
  'msbtmall.com'           -- 프레임11
);
INSERT IGNORE INTO _excl_brand (brand_id) VALUES (74);   -- The grazia: 코드 하드코딩 12곳

-- ── 0) 사전 확인: 대상/제외 집계 (변경 없음) ─────────────────────────────────
SELECT
  CASE
    WHEN b.is_category_migrated = 1                       THEN '이미 전환됨'
    WHEN b.is_main_dns = 1                                THEN '제외: 본사'
    WHEN e.brand_id IS NOT NULL                           THEN '제외: 미리보기/하드코딩'
    WHEN g.cnt >= 2                                       THEN '제외: 그룹 2개 이상(수동)'
    WHEN g.cnt = 0 AND c.cnt = 0                          THEN '[A] 빈 브랜드'
    WHEN g.cnt = 1                                        THEN '[B] 그룹1'
    ELSE '기타(확인 필요)'
  END AS 구분,
  COUNT(*) AS 브랜드수
FROM brands b
LEFT JOIN _excl_brand e ON e.brand_id = b.id
LEFT JOIN (SELECT brand_id, COUNT(*) cnt FROM product_category_groups WHERE is_delete=0 GROUP BY brand_id) g ON g.brand_id = b.id
LEFT JOIN (SELECT brand_id, COUNT(*) cnt FROM product_categories       WHERE is_delete=0 GROUP BY brand_id) c ON c.brand_id = b.id
WHERE b.is_delete = 0
GROUP BY 구분
ORDER BY 구분;

-- ── 1) [A] 빈 브랜드에 기본 '카테고리' 그룹 생성 ────────────────────────────
--    그룹이 하나도 없으면 관리자 화면에서 카테고리를 만들 컨테이너가 없다.
--    (categories/[id].js 가 category_group_list[0] 를 컨테이너로 쓰는데 배열이 비면 undefined)
INSERT INTO product_category_groups
  (category_group_name, brand_id, max_depth, sort_type, is_show_header_menu, is_use_en_name)
SELECT '카테고리', b.id, 10, 0, 1, 0
FROM brands b
LEFT JOIN _excl_brand e ON e.brand_id = b.id
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND e.brand_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM product_category_groups g WHERE g.brand_id = b.id AND g.is_delete = 0)
  AND NOT EXISTS (SELECT 1 FROM product_categories       c WHERE c.brand_id = b.id AND c.is_delete = 0);

-- ── 2) [A]+[B] 플래그 전환 ───────────────────────────────────────────────────
--    1) 실행 후이므로 [A] 도 이제 그룹 1개다 → 아래 한 조건으로 함께 처리된다.
UPDATE brands b
LEFT JOIN _excl_brand e ON e.brand_id = b.id
SET b.is_category_migrated = 1
WHERE b.is_delete = 0
  AND b.is_main_dns <> 1
  AND e.brand_id IS NULL
  AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
  AND (SELECT COUNT(*) FROM product_category_groups g WHERE g.brand_id = b.id AND g.is_delete = 0) = 1;

-- ── 3) 사후 확인: 전환 결과 ──────────────────────────────────────────────────
SELECT b.is_category_migrated AS 전환여부, COUNT(*) AS 브랜드수
FROM brands b WHERE b.is_delete = 0
GROUP BY b.is_category_migrated;

-- ── 4) 사후 확인: 아직 미전환으로 남은 브랜드 (수동 처리 대상) ──────────────
SELECT b.id, b.dns, b.name,
       (SELECT COUNT(*) FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹수,
       (SELECT GROUP_CONCAT(g.category_group_name) FROM product_category_groups g WHERE g.brand_id=b.id AND g.is_delete=0) AS 그룹명,
       (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=b.id AND c.is_delete=0) AS 카테고리수,
       CASE WHEN b.is_main_dns=1 THEN '본사'
            WHEN e.brand_id IS NOT NULL THEN '미리보기/하드코딩'
            ELSE '그룹2개이상 — 수동' END AS 사유
FROM brands b
LEFT JOIN _excl_brand e ON e.brand_id = b.id
WHERE b.is_delete = 0 AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0)
ORDER BY 그룹수 DESC, b.id;

DROP TEMPORARY TABLE IF EXISTS _excl_brand;
