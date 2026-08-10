-- ============================================================================
-- 상품 특성(product_characters) 다국어 컬럼
-- 날짜: 2026-08-10
--
-- 왜 필요한가:
--   상품의 '특성'(예: 색상 / 블랙,화이트)은 고객 상품상세에 그대로 노출되는데
--   **번역 대상에 아예 들어 있지 않았다** — product_characters 에 lang_obj 컬럼 자체가 없어
--   번역된 적이 한 번도 없다.
--   상품명·옵션은 번역되는데 특성만 한국어로 남아, 일본어/중국어 화면에서 눈에 띈다.
--
--   같은 계층인 product_options / product_option_groups 는 이미 lang_obj 를 갖고 있다.
--   구조를 그 둘과 똑같이 맞춘다(부모 products 로 조인해 브랜드를 판정하는 방식까지 동일).
--
-- 안전성:
--   · 컬럼 추가만 한다. 기존 행은 NULL(=번역 없음)이고, 화면은 원문으로 폴백한다.
--   · 코드에 hasColumn 류 가드는 없지만 SELECT * 로 읽으므로 컬럼이 없어도 조회는 정상이고,
--     번역 대기열에 특성이 들어가기 시작하는 것은 이 마이그레이션 이후다.
--   ⚠ 실행 후 백엔드 재시작 권장(스케줄러가 새 대상 테이블을 인식하도록).
--
-- 실행 전 백업(공유 DB 이므로 권장):
--   mysqldump -u <user> -p <db> product_characters > characters_backup_20260810.sql
-- ============================================================================

-- ── 0) 이미 있는지 확인 (먼저 이것만 돌려볼 것) ───────────────────────────
-- SELECT COLUMN_NAME FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_characters'
--    AND COLUMN_NAME = 'lang_obj';

-- ── 1) 컬럼 추가 ────────────────────────────────────────────────────────────
--    다른 테이블의 lang_obj 와 같은 타입(TEXT)으로 맞춘다.
ALTER TABLE product_characters
  ADD COLUMN lang_obj TEXT NULL DEFAULT NULL COMMENT '언어별 번역 {컬럼:{언어:값}}';

-- ── 2) 실행 후 확인 — 1행이 나와야 한다 ─────────────────────────────────────
-- SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_characters'
--    AND COLUMN_NAME = 'lang_obj';

-- ── 3) 번역 채우기 ──────────────────────────────────────────────────────────
--    컬럼만 추가해서는 기존 특성이 번역되지 않는다. 백엔드 재시작 후 실행:
--      node scripts/lang-backfill.js --shopgo --only=product_characters --dry   (건수 확인)
--      node scripts/lang-backfill.js --shopgo --only=product_characters         (실행)
--    ⚠ --shopgo 없이 돌리지 말 것. 언어팩을 켠 브랜드 전체를 돌리면 분량이 수십만 자다.

-- ============================================================================
-- 롤백:
--   ALTER TABLE product_characters DROP COLUMN lang_obj;
-- ============================================================================
