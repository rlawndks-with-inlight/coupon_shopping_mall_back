-- ============================================================================
-- 팝업(popups) 다국어 컬럼
-- 날짜: 2026-08-26
--
-- 왜 필요한가:
--   팝업관리에서 만든 팝업의 제목·내용이 고객 화면에 그대로 뜨는데
--   **번역이 아예 없다.** 세 군데가 동시에 비어 있었다.
--     · popups 테이블에 lang_obj 컬럼이 없다        ← 이 파일이 고치는 것
--     · lang_obj_columns 에 popups 가 없다          (코드)
--     · 고객 화면이 formatLang 을 안 거치고 원문을 그대로 그린다 (코드)
--   상품명·옵션·특성은 번역되는데 팝업만 한국어로 남아 외국어 화면에서 눈에 띈다.
--
--   구조는 다른 테이블과 동일하게 맞춘다. popups 에는 brand_id 가 있으므로
--   백필의 일반 분기(WHERE brand_id=?)가 그대로 쓰인다 — 조인 분기를 새로 만들 필요가 없다.
--
-- 안전성:
--   · 컬럼 추가만 한다. 기존 행은 NULL(=번역 없음)이고 화면은 원문으로 폴백한다.
--   · 지금 언어팩을 켠 몰의 팝업은 3건(281자)뿐이다. 번역 물량 부담이 없다.
--
-- ⚠ 순서가 중요하다 — 이 마이그레이션을 **백엔드 배포보다 먼저** 돌릴 것.
--   코드가 먼저 올라가면 스케줄러가 popups 에 lang_obj 를 쓰려다 실패한다.
--   (백필 스크립트에는 '컬럼이 없으면 그 표를 건너뛴다' 는 보호를 넣어 뒀지만,
--    스케줄러까지 막아 두지는 않았다. 순서를 지키는 편이 확실하다.)
--
-- 실행 전 백업(공유 DB 이므로 권장):
--   mysqldump -u <user> -p <db> popups > popups_backup_20260826.sql
-- ============================================================================

-- ── 0) 이미 있는지 확인 (먼저 이것만 돌려볼 것) ───────────────────────────
-- SELECT COLUMN_NAME FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'popups'
--    AND COLUMN_NAME = 'lang_obj';

-- ── 1) 컬럼 추가 ────────────────────────────────────────────────────────────
--    다른 테이블의 lang_obj 와 같은 타입(TEXT)으로 맞춘다.
ALTER TABLE popups
  ADD COLUMN lang_obj TEXT NULL DEFAULT NULL COMMENT '언어별 번역 {컬럼:{언어:값}}';

-- ── 2) 실행 후 확인 — 1행이 나와야 한다 ─────────────────────────────────────
-- SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'popups'
--    AND COLUMN_NAME = 'lang_obj';

-- ── 3) 번역 채우기 ──────────────────────────────────────────────────────────
--    컬럼만 추가해서는 기존 팝업이 번역되지 않는다. 백엔드 배포·재시작 후 실행:
--      node scripts/lang-backfill.js --shopgo --only=popups --dry   (건수 확인)
--      node scripts/lang-backfill.js --shopgo --only=popups         (실행)
--    ⚠ --shopgo 없이 돌리지 말 것. 언어팩 켠 브랜드 전체는 분량이 수십만 자다.

-- ============================================================================
-- 롤백:
--   ALTER TABLE popups DROP COLUMN lang_obj;
-- ============================================================================
