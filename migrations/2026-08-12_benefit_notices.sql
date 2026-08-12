-- ============================================================================
-- 상품상세 '혜택 안내' — 본사에서 한 번 넣으면 전 가맹점에 일괄 노출
-- 날짜: 2026-08-12
--
-- 목적: 네이버 상품상세의 '혜택 · 최대 12개월 무이자 할부 …' 줄과 같은 구조.
--   상품상세 가격 아래에 한 줄이 뜨고, 누르면 팝업이 열려 탭별 안내를 보여준다.
--
-- 왜 본사 한 곳에서 관리하나:
--   무이자 할부 같은 행사는 결제사(PG) 계약에 딸린 것이라 가맹점마다 다르지 않다.
--   가맹점이 각자 적어 두면 실제 행사와 어긋난 문구가 몰마다 흩어진다.
--   그래서 brand_id = 본사(98) 행만 두고, 가맹점 화면은 부모(parent_id) 것을 읽는다.
--   가맹점은 켜고 끌 수 없다 — 고지 내용이 몰마다 달라지면 안 되기 때문이다.
--
-- 왜 탭 본문이 HTML(LONGTEXT) 인가:
--   카드사 로고 이미지·표·불릿이 섞인 안내라 리치텍스트가 맞다.
--   관리자 화면이 이미 Quill 을 쓰고 있고, HTML 컬럼 자동번역도 검증돼 있다
--   (products.product_description 이 HTML_LANG_COLUMNS 에 등록돼 태그를 보존한 채 번역된다).
--
-- ⚠ 실행 전 반드시 DB 백업 (다른 프로젝트와 공유하는 DB):
--     mysqldump -u <user> -p <db> > backup_before_benefit_notices_20260812.sql
--
-- 안전성: 신규 테이블 2개만 만든다. 기존 테이블·데이터를 건드리지 않는다.
--
-- ▶ 이 SQL 만으로는 화면에 아무것도 안 뜬다. 다음이 함께 배포돼야 한다:
--     (A) 백엔드  controllers/benefit_notice.controller.js + routes 등록
--     (B) 백엔드  lang_obj_columns / HTML_LANG_COLUMNS 등록 (번역)
--     (C) 프론트  본사 관리화면 + 상품상세 6개 프레임 배선
-- ============================================================================

-- (1) 혜택 줄 — 상품상세 가격 아래에 보이는 한 줄 -----------------------------
CREATE TABLE IF NOT EXISTS benefit_notices (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    brand_id    INT          NOT NULL                COMMENT '본사 브랜드 id. 가맹점은 이 행을 부모로 삼아 읽는다',
    label       VARCHAR(50)  NOT NULL DEFAULT '혜택' COMMENT '왼쪽 라벨 (예: 혜택)',
    summary     VARCHAR(255) NOT NULL                COMMENT '한 줄 요약 (예: 최대 12개월 무이자 할부)',
    icon_img    VARCHAR(255) NULL                    COMMENT '요약 앞에 붙는 작은 아이콘/뱃지 이미지(선택)',
    popup_title VARCHAR(100) NULL                    COMMENT '팝업 제목 (예: 카드 혜택 안내)',
    sort        INT          NOT NULL DEFAULT 0      COMMENT '여러 줄일 때 표시 순서(작을수록 위)',
    is_show     TINYINT(1)   NOT NULL DEFAULT 1      COMMENT '0이면 전 가맹점에서 숨김',
    lang_obj    LONGTEXT     NULL                    COMMENT '자동번역 결과(5개 언어)',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_delete   TINYINT(1)   NOT NULL DEFAULT 0,
    INDEX idx_benefit_notices_brand (brand_id, is_delete, is_show, sort)
);

-- (2) 팝업 탭 — 줄 하나에 탭 N개 ---------------------------------------------
--   탭이 하나뿐이면 화면에서 탭 막대를 감춘다(프론트 처리).
CREATE TABLE IF NOT EXISTS benefit_notice_tabs (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    notice_id   INT          NOT NULL           COMMENT 'benefit_notices.id',
    tab_title   VARCHAR(50)  NOT NULL           COMMENT '탭 이름 (예: 무이자 할부)',
    tab_content LONGTEXT     NULL               COMMENT '탭 본문 HTML(Quill). 카드사 로고 이미지·불릿 포함',
    sort        INT          NOT NULL DEFAULT 0,
    lang_obj    LONGTEXT     NULL               COMMENT '자동번역 결과(5개 언어)',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_delete   TINYINT(1)   NOT NULL DEFAULT 0,
    INDEX idx_benefit_tabs_notice (notice_id, is_delete, sort)
);

-- 확인 -----------------------------------------------------------------------
--   SHOW TABLES LIKE 'benefit_notice%';
--   SHOW COLUMNS FROM benefit_notices;

-- 되돌리기 (필요할 때만) -------------------------------------------------------
--   신규 테이블이라 그냥 지우면 된다. 기존 데이터에 영향 없음.
-- DROP TABLE IF EXISTS benefit_notice_tabs;
-- DROP TABLE IF EXISTS benefit_notices;
