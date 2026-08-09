-- ============================================================================
-- 이미 저장된 '빈 옵션그룹 · 빈 특성' 정리
-- 날짜: 2026-08-10
--
-- 왜 필요한가:
--   상품 저장 시 이름이 빈 옵션그룹·옵션·특성을 걸러내도록 고쳤지만(product.controller
--   cleanOptionGroups / cleanCharacters), 그 전에 저장된 데이터는 그대로 남아 있다.
--
--   ⚠ 특히 '고를 옵션이 하나도 없는 옵션그룹' 은 단순히 보기 싫은 정도가 아니다.
--     고객 화면은 '옵션그룹이 있으면 그룹마다 하나 이상 골라야' 구매가 되는데
--     (front shop-util assertOptionsSelected), 고를 게 없으면 그 상품은
--     **장바구니·바로구매가 통째로 막힌다 — 팔 수 없는 상품이 된다.**
--
-- 실측(2026-08-10):
--   · 이름이 빈 옵션그룹            5건
--   · 이름이 빈 옵션                0건
--   · 이름/값이 빈 특성           261건
--   · 그로 인해 구매 불가인 상품    6건 (브랜드 74·92·104·111·119, 전부 status=0 판매중)
--
-- ⚠ 실행 전 반드시 DB 백업 (공유 DB 이므로 필수):
--     mysqldump -u <user> -p <db> product_option_groups product_characters > options_backup_20260810.sql
--
-- 안전성:
--   · 옵션그룹은 소프트 삭제(is_delete=1)라 되돌릴 수 있다.
--   · 특성 테이블에는 is_delete 컬럼이 없어 실삭제다 — 이름 또는 값이 비어
--     화면에 아무것도 못 그리는 행만 지운다(정상 특성은 건드리지 않는다).
-- ============================================================================

-- ── 0) 실행 전 확인 (먼저 이것만 돌려서 건수를 눈으로 볼 것) ──────────────
-- SELECT COUNT(*) AS 빈이름_옵션그룹 FROM product_option_groups g
--   JOIN products p ON p.id=g.product_id AND p.is_delete=0
--  WHERE g.is_delete=0 AND (g.group_name IS NULL OR TRIM(g.group_name)='');
--
-- SELECT COUNT(*) AS 옵션없는_그룹 FROM product_option_groups g
--   JOIN products p ON p.id=g.product_id AND p.is_delete=0
--  WHERE g.is_delete=0
--    AND NOT EXISTS (SELECT 1 FROM product_options o
--                     WHERE o.group_id=g.id AND o.is_delete=0
--                       AND o.option_name IS NOT NULL AND TRIM(o.option_name)<>'');
--
-- SELECT COUNT(*) AS 빈특성 FROM product_characters
--  WHERE (character_name IS NULL OR TRIM(character_name)='')
--     OR (character_value IS NULL OR TRIM(character_value)='');

-- ── 1) 이름이 빈 옵션그룹 → 소프트 삭제 ──────────────────────────────────
UPDATE product_option_groups g
   JOIN products p ON p.id = g.product_id AND p.is_delete = 0
    SET g.is_delete = 1
  WHERE g.is_delete = 0
    AND (g.group_name IS NULL OR TRIM(g.group_name) = '');

-- ── 2) 고를 옵션이 하나도 없는 옵션그룹 → 소프트 삭제 ───────────────────
--     (이게 상품을 '구매 불가' 로 만드는 원인이다)
UPDATE product_option_groups g
   JOIN products p ON p.id = g.product_id AND p.is_delete = 0
    SET g.is_delete = 1
  WHERE g.is_delete = 0
    AND NOT EXISTS (
      SELECT 1 FROM product_options o
       WHERE o.group_id = g.id
         AND o.is_delete = 0
         AND o.option_name IS NOT NULL
         AND TRIM(o.option_name) <> '');

-- ── 3) 이름이 빈 옵션 → 소프트 삭제 (현재 0건이지만 안전망) ─────────────
UPDATE product_options o
   JOIN product_option_groups g ON g.id = o.group_id
    SET o.is_delete = 1
  WHERE o.is_delete = 0
    AND (o.option_name IS NULL OR TRIM(o.option_name) = '');

-- ── 4) 이름 또는 값이 빈 특성 → 삭제 (is_delete 컬럼 없음) ──────────────
DELETE FROM product_characters
 WHERE (character_name IS NULL OR TRIM(character_name) = '')
    OR (character_value IS NULL OR TRIM(character_value) = '');

-- ── 5) 실행 후 확인 — 모두 0 이어야 한다 ────────────────────────────────
-- SELECT COUNT(DISTINCT p.id) AS 아직_구매불가인_상품
--   FROM products p
--   JOIN product_option_groups g ON g.product_id=p.id AND g.is_delete=0
--  WHERE p.is_delete=0 AND p.status<>5
--    AND NOT EXISTS (SELECT 1 FROM product_options o
--                     WHERE o.group_id=g.id AND o.is_delete=0
--                       AND o.option_name IS NOT NULL AND TRIM(o.option_name)<>'');

-- ============================================================================
-- 롤백:
--   옵션그룹·옵션은 is_delete=1 로만 바꿨으므로 백업본에서 id 를 비교해 되돌릴 수 있다.
--   특성은 실삭제이므로 반드시 백업본(product_characters)에서 복원해야 한다.
-- ============================================================================
