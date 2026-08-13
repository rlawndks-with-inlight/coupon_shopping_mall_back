-- ============================================================================
-- 주문서 추가 입력항목 — 예약·출장 업체가 행사일·장소 등을 주문 시 받는다
-- 날짜: 2026-08-13
--
-- 왜 필요한가:
--   지금은 고객에게 자유 입력을 받을 방법이 하나도 없다.
--   옵션(product_options)은 드롭다운 + 가격이고, 특성(product_characters)은 표시용이며,
--   주문서에는 '요청사항' 칸조차 없다. 그래서 돌상 대여 같은 예약형 업체는
--   주문을 받고 나서 따로 전화해 행사날짜를 물어야 한다.
--
-- 설계 요지 (카페24 '주문서 추가 항목 관리' 방식을 따랐다):
--   · 서식(템플릿)을 **본사 마스터만** 만든다. 가맹점은 만들지도 고르지도 않는다.
--   · 입력은 **주문서에서 한 번**. 주문서 화면은 공용 파일 하나라 프레임 6개를 안 건드린다.
--     (상품별로 받으려면 상품상세 6곳 + 장바구니까지 손대야 해서 작업이 두 배가 된다)
--   · 적용 대상은 **가맹점 단위**. category_ids 를 비워 두면 그 몰 전체에 적용된다.
--     지금은 화면에서 카테고리를 고르게 하지 않지만 컬럼은 미리 둔다 —
--     예약형과 일반 배송품이 섞인 몰이 나오면 DB 를 안 고치고 화면만 열면 된다.
--
-- ⚠ 실행 전 반드시 DB 백업 (다른 프로젝트와 공유하는 DB):
--     mysqldump -u <user> -p <db> > backup_before_order_form_20260813.sql
--
-- 안전성: 신규 테이블 4개만 만든다. 기존 테이블·데이터를 건드리지 않는다.
--
-- ▶ 이 SQL 만으로는 화면에 아무것도 안 뜬다. 백엔드/프론트 코드가 함께 배포돼야 한다.
-- ============================================================================

-- (1) 서식 — 예: '예약·출장형', '맞춤제작형' -----------------------------------
CREATE TABLE IF NOT EXISTS order_form_templates (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    brand_id   INT          NOT NULL           COMMENT '서식을 만든 본사 브랜드 id',
    name       VARCHAR(60)  NOT NULL           COMMENT '서식 이름(관리용). 고객에게는 안 보인다',
    guide      VARCHAR(255) NULL               COMMENT '주문서 입력칸 위에 띄울 안내 한 줄(선택)',
    is_use     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0이면 적용 가맹점이 있어도 안 뜬다',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_delete  TINYINT(1)   NOT NULL DEFAULT 0,
    INDEX idx_order_form_tpl_brand (brand_id, is_delete, is_use)
);

-- (2) 항목 — 서식 안의 입력칸 하나 ---------------------------------------------
--   field_type: text | textarea | number | date | time | datetime
--               select | multiselect | tel | address | agree | file
--   ⚠ tel·address 값은 개인정보다. 저장할 때 암호화한다(백엔드 처리).
CREATE TABLE IF NOT EXISTS order_form_fields (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    template_id  INT          NOT NULL,
    label        VARCHAR(60)  NOT NULL           COMMENT '고객에게 보이는 항목 이름 (예: 행사일)',
    field_type   VARCHAR(20)  NOT NULL DEFAULT 'text',
    placeholder  VARCHAR(255) NULL               COMMENT '입력칸 아래 도움말',
    is_required  TINYINT(1)   NOT NULL DEFAULT 0,
    sort         INT          NOT NULL DEFAULT 0,
    -- 유형별 제한. 안 쓰는 유형에서는 NULL 이다.
    option_list  TEXT         NULL               COMMENT 'select/multiselect 보기 목록(줄바꿈 구분)',
    max_length   INT          NULL               COMMENT 'text/textarea 최대 글자수',
    min_number   INT          NULL               COMMENT 'number 최소값',
    max_number   INT          NULL               COMMENT 'number 최대값',
    -- 예약 리드타임. date/datetime 에서 '오늘부터 N일 이후만' 고를 수 있게 한다.
    -- 출장·제작은 준비 기간이 필요한데, 네이버·카페24 는 이 항목이 텍스트라 막지 못한다.
    lead_days    INT          NULL               COMMENT '오늘+N일 이후만 선택 가능(예약 준비 기간)',
    max_days     INT          NULL               COMMENT '오늘+N일 이내만 선택 가능(너무 먼 예약 차단)',
    lang_obj     LONGTEXT     NULL               COMMENT '라벨·도움말 자동번역',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_delete    TINYINT(1)   NOT NULL DEFAULT 0,
    INDEX idx_order_form_field_tpl (template_id, is_delete, sort)
);

-- (3) 적용 대상 — 이 서식을 쓰는 가맹점 ----------------------------------------
--   한 서식을 여러 가맹점에 붙일 수 있다(돌상 업체가 여럿이면 서식 하나를 공유).
CREATE TABLE IF NOT EXISTS order_form_targets (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    template_id  INT      NOT NULL,
    brand_id     INT      NOT NULL           COMMENT '이 서식을 적용받을 가맹점 브랜드 id',
    category_ids TEXT     NULL               COMMENT '적용할 카테고리 id 목록(JSON). 비우면 그 몰 전체',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_delete    TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_order_form_target_brand (brand_id, is_delete),
    INDEX idx_order_form_target_tpl (template_id, is_delete)
);

-- (4) 고객이 실제로 입력한 값 ---------------------------------------------------
--   ⚠ label/field_type 을 여기에 다시 적어 둔다(스냅샷).
--     본사가 나중에 서식의 라벨을 고치면, 이미 접수된 주문의 뜻이 바뀌어 버린다.
--     주문 당시 무엇을 물었는지가 남아야 분쟁 때 확인이 된다.
--     (transaction_orders 가 order_name 을 따로 저장해 두는 것과 같은 이유다)
CREATE TABLE IF NOT EXISTS transaction_order_forms (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    trans_id    INT          NOT NULL          COMMENT 'transactions.id',
    field_id    INT          NULL              COMMENT 'order_form_fields.id (서식이 지워져도 값은 남는다)',
    label       VARCHAR(60)  NOT NULL          COMMENT '주문 당시의 항목 이름(스냅샷)',
    field_type  VARCHAR(20)  NOT NULL          COMMENT '주문 당시의 입력 유형(스냅샷)',
    value       TEXT         NULL              COMMENT '입력값. tel/address 는 암호화되어 들어간다',
    sort        INT          NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_trx_order_form_trans (trans_id, sort)
);

-- 확인 -----------------------------------------------------------------------
--   SHOW TABLES LIKE 'order_form%';
--   SHOW TABLES LIKE 'transaction_order_forms';

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- DROP TABLE IF EXISTS transaction_order_forms;
-- DROP TABLE IF EXISTS order_form_targets;
-- DROP TABLE IF EXISTS order_form_fields;
-- DROP TABLE IF EXISTS order_form_templates;
