-- ============================================================================
-- 언어팩(다국어) 기능 스키마 보강
-- 날짜: 2026-07-31
--
-- ▶ 증상: 관리자 설정에서 "언어팩 사용"(setting_obj.is_use_lang=1) 을 켜면 "서버 에러 발생"(500).
--     또한 is_use_lang=1 상태에서는 상품/카테고리/게시글 "저장" 시에도 에러가 날 수 있음.
--
-- ▶ 원인: 언어팩 코드가 참조하는 스키마가 DB에 없음(코드만 배포되고 마이그레이션 누락).
--     (1) lang_processes 테이블이 생성된 적 없음 — INSERT/SELECT만 존재
--         utils.js/schedules/lang-process.js:161  INSERT INTO lang_processes ...
--         utils.js/schedules/lang-process.js:36   SELECT * FROM lang_processes WHERE is_confirm=0
--     (2) 번역 결과를 저장할 lang_obj 컬럼이 콘텐츠 테이블에 없음
--         settingLangs() 가 updateQuery(table, { lang_obj }, id) 실행 (utils.js/util.js:187~)
--
-- ▶ 조치: 아래 (1) 테이블 생성 + (2) lang_obj 컬럼 추가. 둘 다 '추가'라 기존 데이터 안전.
--
-- ⚠ 실행 전 백업(공유 DB). products/posts 등은 대용량일 수 있어 트래픽 적은 시간 권장.
-- ⚠ 이 SQL만으로는 부족 — 아래 두 가지가 추가로 필요(코드/설정, SQL 아님):
--     (A) product_options / product_option_groups 를 brand_id 로 조회하는 부분
--         (lang-process.js) → 이 두 테이블엔 brand_id 가 없음.
--         부모(products) 조인으로 바꾸거나 해당 루프에서 제외해야 함.
--     (B) 구글 번역 키(gtrans) 설정 확인 — 없으면 번역본이 비어서 저장됨.
--     (C) 위 전부 정상화 후에만 "신규 쇼핑몰 기본 언어팩 ON" 을 켤 것.
-- ============================================================================

-- (1) 번역 대기열 테이블 -----------------------------------------------------
CREATE TABLE IF NOT EXISTS lang_processes (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(64) NOT NULL,
    item_id    INT         NOT NULL,
    brand_id   INT         NOT NULL DEFAULT 0,
    obj        LONGTEXT    NULL,
    is_confirm TINYINT(1)  NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_lang_proc_confirm (is_confirm),
    INDEX idx_lang_proc_brand (brand_id),
    INDEX idx_lang_proc_item (table_name, item_id)
);

-- (2) 각 콘텐츠 테이블에 번역본 저장 컬럼(lang_obj) 추가 -----------------------
--   ※ MySQL 은 "ADD COLUMN IF NOT EXISTS" 를 지원하지 않음.
--     이미 컬럼이 있는 테이블은 "Duplicate column name 'lang_obj'" 오류가 나므로 그 줄만 건너뛰세요.
--   ▶ 먼저 어떤 테이블에 이미 있는지 확인:
--       SELECT TABLE_NAME FROM information_schema.COLUMNS
--        WHERE COLUMN_NAME='lang_obj' AND TABLE_SCHEMA = DATABASE();
ALTER TABLE post_categories         ADD COLUMN lang_obj LONGTEXT NULL;
ALTER TABLE posts                   ADD COLUMN lang_obj LONGTEXT NULL;
ALTER TABLE product_category_groups ADD COLUMN lang_obj LONGTEXT NULL;
ALTER TABLE product_categories      ADD COLUMN lang_obj LONGTEXT NULL;
ALTER TABLE products                ADD COLUMN lang_obj LONGTEXT NULL;
ALTER TABLE product_options         ADD COLUMN lang_obj LONGTEXT NULL;
ALTER TABLE product_option_groups   ADD COLUMN lang_obj LONGTEXT NULL;

-- 확인용(실행 후):
--   SHOW TABLES LIKE 'lang_processes';
--   SHOW COLUMNS FROM products LIKE 'lang_obj';
-- ============================================================================
