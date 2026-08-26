-- ============================================================================
-- 게시글(posts) 번역본 컬럼 확장  varchar(3000) → MEDIUMTEXT
-- 날짜: 2026-08-27
--
-- 왜 필요한가:
--   번역 대기열에 이런 행이 3회 실패한 채 남아 있었다.
--     posts / 198 · last_error: Data too long for column 'lang_obj' at row 1
--
--   원인은 **컬럼이 varchar(3000)** 이라는 것이다.
--   lang_obj 는 원문 + 4개 언어를 함께 담으므로 대략 원문의 5배가 된다.
--   즉 원문이 600바이트만 넘어도 3000 을 넘긴다 — 본문이 있는 게시글은 사실상 전부다.
--   posts #198 은 본문 2,099자(3,693바이트)라 번역본이 약 18KB 였다.
--
--   실측(2026-08-27):
--     · 전체 게시글 172건 중 43건이 varchar(3000) 을 넘긴다
--     · SHOPGO 계열 18건 중 1건 (그게 #198 이다)
--     · 가장 긴 게시글은 원문 13,095바이트 → 번역본 약 64KB
--       ⇒ TEXT(64KB) 로는 그 글이 다시 걸린다. MEDIUMTEXT(16MB) 로 간다.
--
--   같은 값을 담는 products.lang_obj 가 이미 MEDIUMTEXT 다 — 타입을 그쪽에 맞춘다.
--   (post_categories·product_categories 등은 이름만 담아 varchar(3000) 로 충분하다)
--
-- 안전성:
--   · 폭을 넓히기만 한다. 기존 값은 그대로 있고 잘리지 않는다.
--   · varchar → MEDIUMTEXT 는 테이블을 다시 쓴다. 172행뿐이라 순식간에 끝난다.
--   · 게시글 조회는 SELECT * 라 타입이 바뀌어도 코드 수정이 필요 없다.
--
-- 실행 전 백업(공유 DB 이므로 권장):
--   mysqldump -u <user> -p <db> posts > posts_backup_20260827.sql
-- ============================================================================

-- ── 0) 현재 타입 확인 (먼저 이것만 돌려볼 것) ─────────────────────────────
-- SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'lang_obj';
--   → varchar(3000) 이면 아래를 실행한다.

-- ── 1) 확장 ────────────────────────────────────────────────────────────────
ALTER TABLE posts
  MODIFY COLUMN lang_obj MEDIUMTEXT NULL DEFAULT NULL COMMENT '언어별 번역 {컬럼:{언어:값}}';

-- ── 2) 실행 후 확인 — mediumtext 가 나와야 한다 ────────────────────────────
-- SELECT COLUMN_TYPE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'lang_obj';

-- ── 3) 막혀 있던 행 다시 시도 ──────────────────────────────────────────────
--    #198 은 대기열에 try_count=3 으로 남아 있어 스케줄러가 더 시도하지 않는다.
--    횟수를 0 으로 되돌리면 다음 틱(1분)에 다시 시도한다.
--      UPDATE lang_processes SET try_count = 0, last_error = NULL
--       WHERE table_name = 'posts' AND item_id = 198;
--
--    나머지 게시글은 백필로 채운다:
--      node scripts/lang-backfill.js --shopgo --only=posts --dry
--      node scripts/lang-backfill.js --shopgo --only=posts

-- ============================================================================
-- 롤백:
--   ⚠ 되돌리면 3000바이트를 넘는 번역본이 **잘린다**. 먼저 확인할 것:
--     SELECT id, LENGTH(lang_obj) FROM posts WHERE LENGTH(lang_obj) > 3000;
--   ALTER TABLE posts MODIFY COLUMN lang_obj VARCHAR(3000) NULL DEFAULT NULL;
-- ============================================================================
