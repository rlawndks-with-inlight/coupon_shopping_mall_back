-- ============================================================================
-- 3차 C · 그룹명을 최상위 카테고리로 승격 — 브랜드 하나씩
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ ⚠ 2026-08-07 현재 이 파일의 실행 대상은 없다. 그냥 돌리지 말 것.          │
-- │                                                                          │
-- │ 원래 대상이던 id 50 은 이미 전환됐다(크래시한 통합 스크립트가 튕기기 전   │
-- │ [2] UPDATE 를 실행함). 카테고리가 한 그룹에만 있어 규칙대로 걸린 것이라   │
-- │ 결과는 맞지만, 그래서 승격은 더 이상 필요 없다.                          │
-- │                                                                          │
-- │ 이미 전환된 브랜드에 이 파일을 돌리면 C-2 가 없던 최상위 카테고리를       │
-- │ 새로 만들고 C-4 가 기존 카테고리를 그 밑으로 넣는다. 정상 동작 중인       │
-- │ 몰의 트리가 한 단계 깊어질 뿐 얻는 것이 없다.                            │
-- │                                                                          │
-- │ 그래서 C-0 의 기본값을 0(대상 없음)으로 두고 C-00 안전검사를 넣었다.      │
-- │ 남은 id 54·71 은 그룹명이 '카테고리'/'category' 라 승격하면 무의미한      │
-- │ 최상위가 생긴다 — 승격 대상이 아니다. D 파일 진단으로 처리 방법을 정한다. │
-- │                                                                          │
-- │ 나중에 '그룹을 진짜 대분류로 써 온' 브랜드가 나오면 그때 쓰는 파일이다.   │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- ※ 쿼리 하나씩 실행할 것. 한 번에 다 돌리지 말 것.
-- ※ 실행 전 백업: brands, product_categories
-- ※ @brand 는 접속(세션)마다 살아 있다. HeidiSQL 을 닫았다 열거나 재접속하면
--   C-0 을 다시 실행할 것. 안 그러면 @brand 가 NULL 이라 아무것도 안 바뀐다.
--
-- 대상: A 파일 진단에서 'C 파일 — 승격' 이 나온 브랜드
--       (= 그룹 이름이 진짜 대분류라서 트리에 남겨야 하는 경우)
--
-- 하는 일: 그룹마다 그 이름의 최상위 카테고리를 하나 만들고,
--          그 그룹의 기존 최상위들을 그 아래로 옮긴다. 그룹 이름이 트리에 남는다.
--
--   예) '자동차' 그룹의 [세단, SUV]  →  자동차 ─┬ 세단
--                                              └ SUV
--
-- 알아둘 것:
--   · 최상위는 parent_id = -1 이다. 0 으로 넣으면 트리에 안 잡혀 화면에서 사라진다
--     (utils.js/util.js makeTree 가 '-1' 을 시작점으로 쓴다).
--   · depth 는 저장하지 않는다. parent_id 사슬로 계산하므로 여기서 맞출 것은 parent_id 뿐이다.
--   · status = 0 이어야 고객 화면에 보인다(shop.controller 가 status=0 만 가져간다).
--   · 멱등: 이미 그 이름의 최상위 카테고리가 있으면 새로 만들지 않는다.
--
-- 롤백: UPDATE brands SET is_category_migrated = 0 WHERE id = @brand;
--       + C-2 에서 새로 만든 카테고리를 is_delete=1 로 (C-4 결과에서 id 확인)
--       + 옮긴 것들을 parent_id = -1 로 되돌리기
-- ============================================================================


-- ── C-0. 대상 브랜드 지정 ★★★ ─────────────────────────────────────────────
--   기본값 0 = 대상 없음. 0 인 채로 아래를 다 돌려도 아무것도 바뀌지 않는다.
--   승격이 필요한 브랜드가 확정됐을 때만 그 id 로 바꿀 것.
SET @brand := 0;


-- ── C-00. 안전검사 ★ C-2 로 넘어가기 전 반드시 확인 ────────────────────────
--   '판정' 이 '진행 가능' 일 때만 C-2 부터 실행할 것.
--   이미 전환된 브랜드에 돌리면 없던 최상위 카테고리가 생긴다.
SELECT b.id, b.dns, b.name,
       b.is_category_migrated                                            AS 전환여부,
       (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
         WHERE c.brand_id = b.id AND c.is_delete = 0)                    AS 카테고리있는그룹수,
       CASE
         WHEN b.is_category_migrated = 1
              THEN '중단 — 이미 전환된 브랜드다. 승격하면 트리만 깊어진다'
         WHEN (SELECT COUNT(DISTINCT c.product_category_group_id) FROM product_categories c
                WHERE c.brand_id = b.id AND c.is_delete = 0) < 2
              THEN '중단 — 그룹이 실질 1개다. 승격 없이 전환하면 된다(B 파일)'
         ELSE '진행 가능'
       END                                                                AS 판정
FROM brands b
WHERE b.id = @brand;


-- ── C-1. 현재 트리 확인 (변경 없음) ─────────────────────────────────────────
--   부모이름이 NULL 인 행 = 최상위. 지금은 그룹마다 여러 개일 것이다.
SELECT c.id, c.parent_id, c.product_category_group_id AS 그룹id,
       (SELECT g.category_group_name FROM product_category_groups g
         WHERE g.id = c.product_category_group_id)                  AS 그룹명,
       c.category_name                                              AS 카테고리명,
       (SELECT p.category_name FROM product_categories p
         WHERE p.id = c.parent_id)                                  AS 부모이름,
       c.sort_idx, c.status
FROM product_categories c
WHERE c.brand_id = @brand AND c.is_delete = 0
ORDER BY c.product_category_group_id, c.parent_id, c.sort_idx DESC, c.id;


-- ── C-2. 그룹 이름과 같은 최상위 카테고리 생성 (그룹당 1개, 없을 때만) ──────
--   비어 있는 그룹(카테고리 0개)은 만들지 않는다 — 승격할 자식이 없다.
INSERT INTO product_categories
  (brand_id, product_category_group_id, category_name, parent_id, category_type, sort_idx, status)
SELECT g.brand_id, g.id, g.category_group_name, -1, 0, g.sort_idx, 0
FROM product_category_groups g
WHERE g.brand_id = @brand
  AND g.is_delete = 0
  -- 안전장치: 이미 전환된 브랜드에는 아무것도 만들지 않는다(C-00 을 건너뛰어도 막힌다)
  AND EXISTS (SELECT 1 FROM brands b
               WHERE b.id = @brand
                 AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0))
  AND EXISTS (SELECT 1 FROM product_categories c
               WHERE c.product_category_group_id = g.id AND c.is_delete = 0)
  AND NOT EXISTS (SELECT 1 FROM product_categories c
                   WHERE c.product_category_group_id = g.id AND c.is_delete = 0
                     AND c.parent_id = -1 AND c.category_name = g.category_group_name);


-- ── C-3. 승격 노드 기록용 보조 테이블 ───────────────────────────────────────
--   임시테이블(TEMPORARY)을 쓰지 않는다 — HeidiSQL 이 결과 그리드를 만들 때 불안정하고,
--   MySQL 은 UPDATE 대상 테이블을 같은 문의 서브쿼리에서 참조하지 못하게 막는다(에러 1093).
--   일반 테이블로 만들어 두고 마지막에 지운다.
--   group_id 를 PK 로 둬서 그룹당 반드시 하나만 잡히게 한다.
DROP TABLE IF EXISTS _mig_promote_root;

CREATE TABLE _mig_promote_root (
  group_id BIGINT PRIMARY KEY,
  root_id  BIGINT NOT NULL
);

INSERT INTO _mig_promote_root (group_id, root_id)
SELECT c.product_category_group_id, MIN(c.id)
FROM product_categories c
JOIN product_category_groups g
  ON g.id = c.product_category_group_id
 AND g.category_group_name = c.category_name
 AND g.is_delete = 0
WHERE c.brand_id = @brand AND c.is_delete = 0 AND c.parent_id = -1
GROUP BY c.product_category_group_id;

-- 확인: 카테고리가 있는 그룹 수만큼 나와야 한다
SELECT r.group_id AS 그룹id, r.root_id AS 승격노드id, c.category_name AS 이름
FROM _mig_promote_root r
JOIN product_categories c ON c.id = r.root_id;


-- ── C-4. 기존 최상위들을 승격 노드의 자식으로 ───────────────────────────────
UPDATE product_categories c
JOIN _mig_promote_root r ON r.group_id = c.product_category_group_id
SET c.parent_id = r.root_id
WHERE c.brand_id = @brand
  AND c.is_delete = 0
  AND c.parent_id = -1
  AND c.id <> r.root_id
  -- 안전장치: 이미 전환된 브랜드의 트리는 건드리지 않는다
  AND EXISTS (SELECT 1 FROM brands b
               WHERE b.id = @brand
                 AND (b.is_category_migrated IS NULL OR b.is_category_migrated = 0));


-- ── C-5. 결과 확인 ──────────────────────────────────────────────────────────
--   부모이름이 NULL 인 행(=최상위)이 '그룹명' 들뿐이어야 한다.
SELECT c.id, c.parent_id, c.product_category_group_id AS 그룹id,
       c.category_name                                              AS 카테고리명,
       (SELECT p.category_name FROM product_categories p
         WHERE p.id = c.parent_id)                                  AS 부모이름,
       c.sort_idx, c.status
FROM product_categories c
WHERE c.brand_id = @brand AND c.is_delete = 0
ORDER BY c.product_category_group_id, c.parent_id, c.sort_idx DESC, c.id;


-- ── C-6. 고아 확인 (0 이어야 정상) ──────────────────────────────────────────
SELECT COUNT(*) AS 고아
FROM product_categories c
LEFT JOIN product_categories p ON p.id = c.parent_id
WHERE c.brand_id = @brand AND c.is_delete = 0
  AND c.parent_id <> -1
  AND (p.id IS NULL OR p.is_delete = 1);


-- ── C-7. 이상 없으면 전환 ───────────────────────────────────────────────────
UPDATE brands SET is_category_migrated = 1 WHERE id = @brand;


-- ── C-8. 보조 테이블 정리 ───────────────────────────────────────────────────
--   승격할 브랜드가 더 있으면 C-0 으로 돌아가 @brand 만 바꿔 다시 진행할 것.
DROP TABLE IF EXISTS _mig_promote_root;


-- ── C-9. 최종 확인 — 남는 것은 id 5 와 74 뿐이어야 한다 ────────────────────
SELECT COALESCE(b.is_category_migrated, 0) AS 전환여부, COUNT(*) AS 브랜드수
FROM brands b
WHERE b.is_delete = 0 AND b.is_main_dns <> 1
GROUP BY COALESCE(b.is_category_migrated, 0);
