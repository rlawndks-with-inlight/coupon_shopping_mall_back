-- ============================================================================
-- 3차 D · id 54 · 71 판정 (읽기 전용 — 아무것도 바꾸지 않는다)
--
-- ※ 쿼리 하나씩 실행할 것.
--
-- [배경]
-- A 파일 진단 결과 남은 브랜드가 6개가 아니라 4개였다(5·54·71·74).
-- id 50 · 104 는 이미 전환돼 있다 — 앞서 크래시한 통합 스크립트가 튕기기 전에
-- [2] UPDATE 를 실행한 것으로 보인다. 규칙 자체는 의도한 것과 같지만
-- 쓰기가 일어났으므로 D-1 로 사후 검증한다.
--
-- [문제]
-- id 54 · 71 은 그룹 두 개에 카테고리가 '양쪽 다' 있다. 빈 껍데기가 아니다.
--     id 54  그룹129 '카테고리'  9개 (전부 최상위)   그룹158 'category'  9개 (전부 최상위)
--     id 71  그룹160 '카테고리'  9개 (전부 최상위)   그룹161 'category'  8개 (전부 최상위)
--
-- 그런데 그룹 이름이 '카테고리' 와 'category' — 같은 말의 한/영 표기다.
-- 이건 진짜 대분류가 아니라 기본 이름이므로, C 파일처럼 승격시키면
-- 고객 화면에 "카테고리" "category" 라는 무의미한 최상위가 생긴다. 승격은 답이 아니다.
--
-- 남은 선택은 둘이고, 어느 쪽인지는 아래 D-2·D-3 이 정한다.
--   (ㄱ) 두 그룹의 카테고리 이름이 겹친다  → 복제본이다.
--        그냥 합치면 고객에게 같은 이름이 두 번 보인다.
--        → 상품이 붙어 있는 쪽만 남기고 다른 쪽을 숨겨야 한다.
--   (ㄴ) 이름이 안 겹친다                 → 서로 다른 카테고리다.
--        그냥 합치면 된다(최상위 18개 / 17개). 그룹 이름만 사라진다.
-- ============================================================================


-- ── D-1. id 50 · 104 사후 검증 ──────────────────────────────────────────────
--   '카테고리있는그룹수' 가 0 또는 1이면 규칙대로 전환된 것이다(정상).
--   2 이상인데 전환돼 있으면 잘못 전환된 것이니 알려줄 것 → 롤백:
--     UPDATE brands SET is_category_migrated = 0 WHERE id IN (50, 104);
SELECT b.id, b.dns, b.name,
       b.is_category_migrated                                            AS 전환여부,
       (SELECT COUNT(*) FROM product_category_groups g
         WHERE g.brand_id = b.id AND g.is_delete = 0)                    AS 그룹수,
       (SELECT COUNT(*) FROM product_categories c
         WHERE c.brand_id = b.id AND c.is_delete = 0)                    AS 카테고리수,
       (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
         WHERE c.brand_id = b.id AND c.is_delete = 0)                    AS 카테고리있는그룹수,
       (SELECT COUNT(*) FROM products p
         WHERE p.brand_id = b.id AND p.is_delete = 0)                    AS 상품수
FROM brands b
WHERE b.id IN (50, 104);


-- ── D-2. 이름이 두 그룹에 겹치는지 ──────────────────────────────────────────
--   행이 나오면 (ㄱ) 복제본. 아무 행도 안 나오면 (ㄴ) 서로 다른 카테고리.
SELECT c.brand_id                                         AS 브랜드id,
       c.category_name                                    AS 카테고리명,
       COUNT(DISTINCT c.product_category_group_id)        AS 걸쳐있는그룹수,
       GROUP_CONCAT(DISTINCT c.product_category_group_id) AS 그룹들,
       COUNT(*)                                           AS 행수
FROM product_categories c
WHERE c.brand_id IN (54, 71) AND c.is_delete = 0
GROUP BY c.brand_id, c.category_name
HAVING COUNT(DISTINCT c.product_category_group_id) > 1
ORDER BY c.brand_id, c.category_name;


-- ── D-3. 카테고리별 상품 연결 수 ────────────────────────────────────────────
--   (ㄱ) 인 경우 어느 쪽을 남길지 정하는 근거다.
--   상품이 하나도 안 붙은 그룹은 안 쓰는 쪽이므로 그쪽을 숨기면 된다.
--   상품 필터는 두 경로를 모두 읽으므로(dual-read) 둘 다 센다.
SELECT c.brand_id                                                        AS 브랜드id,
       c.product_category_group_id                                       AS 그룹id,
       (SELECT g.category_group_name FROM product_category_groups g
         WHERE g.id = c.product_category_group_id)                       AS 그룹명,
       c.id                                                              AS 카테고리id,
       c.category_name                                                   AS 카테고리명,
       c.parent_id, c.sort_idx, c.status,
       (SELECT COUNT(*) FROM products p
         WHERE p.brand_id = c.brand_id AND p.is_delete = 0
           AND (p.category_id0 = c.id OR p.category_id1 = c.id OR p.category_id2 = c.id))
                                                                         AS 상품수_기존컬럼,
       (SELECT COUNT(*) FROM products_categories pc
         WHERE pc.category_id = c.id AND pc.is_delete = 0)               AS 상품수_연결테이블
FROM product_categories c
WHERE c.brand_id IN (54, 71) AND c.is_delete = 0
ORDER BY c.brand_id, c.product_category_group_id, c.sort_idx DESC, c.id;


-- ── D-4. 그룹 단위 요약 ─────────────────────────────────────────────────────
--   D-3 이 길면 이걸로 먼저 큰 그림을 본다.
--   한쪽 그룹의 '상품붙은카테고리수' 가 0 이면 그 그룹은 안 쓰는 쪽이다.
SELECT c.brand_id                                                        AS 브랜드id,
       c.product_category_group_id                                       AS 그룹id,
       (SELECT g.category_group_name FROM product_category_groups g
         WHERE g.id = c.product_category_group_id)                       AS 그룹명,
       COUNT(*)                                                          AS 카테고리수,
       SUM(CASE WHEN (SELECT COUNT(*) FROM products p
                       WHERE p.brand_id = c.brand_id AND p.is_delete = 0
                         AND (p.category_id0 = c.id OR p.category_id1 = c.id OR p.category_id2 = c.id)) > 0
                THEN 1 ELSE 0 END)                                       AS 상품붙은카테고리수,
       SUM((SELECT COUNT(*) FROM products p
             WHERE p.brand_id = c.brand_id AND p.is_delete = 0
               AND (p.category_id0 = c.id OR p.category_id1 = c.id OR p.category_id2 = c.id)))
                                                                         AS 상품연결총수
FROM product_categories c
WHERE c.brand_id IN (54, 71) AND c.is_delete = 0
GROUP BY c.brand_id, c.product_category_group_id
ORDER BY c.brand_id, c.product_category_group_id;
