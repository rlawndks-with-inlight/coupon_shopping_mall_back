-- ============================================================================
-- 상품 옵션 전면 개편 — 선택옵션 · 추가상품 · 조합형 · 재고 · 상품별 입력항목
-- 날짜: 2026-08-13
--
-- 왜 하는가 (실제 운영 데이터에서 확인한 것):
--   1) 특성(product_characters)이 프레임에 따라 뜻이 달라진다.
--      프레임2 는 '눌러야만 구매되는 필수 버튼'으로, 프레임3·5·6 은 '읽기 전용 정보표'로
--      같은 데이터를 그린다. 관리자 안내문구는 정보표 쪽('원산지 / 국내산')이다.
--      → 가맹점 특성 6건 중 5건이 오용이었다(키·값 뒤집기, 특성값에 가격 기입).
--
--   2) 추가상품 개념이 없다. 옵션그룹은 '그룹마다 반드시 1개'가 강제된다(assertOptionsSelected).
--      첫돌공방 상품 444 는 한복 +10,000 / 영상 +45,000 / 스냅 +300,000 이 각각
--      선택지 1개짜리 그룹이라 **355,000원을 붙이지 않으면 살 수 없었다**.
--      가맹점이 원한 건 옵션이 아니라 '골라도 되고 안 골라도 되는 추가상품'이다.
--
--   3) 재고 개념이 아예 없다. 품절을 표시할 방법도, 막을 방법도 없었다.
--
-- 설계 (네이버 스마트스토어 / 카페24 구조를 따랐다):
--   · 선택옵션(group_type=0)  골라야 산다. 그룹마다 1개.        색상 · 사이즈
--   · 추가상품(group_type=1)  안 골라도 산다. 여러 개 가능.      한복 +10,000
--   · 조합형(option_mode=1)   옵션 조합마다 가격·재고를 따로.    분홍/M +5,000
--   · 입력항목                손님이 적는다. 상품 단위.          행사날짜 · 각인
--   · 특성은 '상품정보'(보여주기 전용)로 뜻을 하나로 고정한다 — 스키마 변경 없음.
--
-- ⚠ 실행 전 반드시 DB 백업 (다른 프로젝트와 공유하는 DB):
--     mysqldump -u <user> -p <db> > backup_before_option_renewal_20260813.sql
--
-- 안전성:
--   · 기존 컬럼을 지우거나 뜻을 바꾸지 않는다. 전부 '더하기'다.
--   · 새 컬럼 기본값이 지금 동작과 같다(group_type=0 선택옵션, option_mode=0 단독형,
--     stock_qty=NULL 무제한). 즉 이 SQL 만 돌리고 코드를 안 올려도 화면이 그대로다.
--   · 재고는 NULL = 무제한이다. 0 이 아니다 — 0 으로 뒀다면 전 상품이 즉시 품절된다.
--
-- ▶ 이 SQL 만으로는 화면이 안 바뀐다. 백엔드/프론트 코드가 함께 배포돼야 한다.
-- ============================================================================

-- (1) 상품: 옵션 방식과 상품 자체 재고 -----------------------------------------
ALTER TABLE products
  ADD COLUMN option_mode TINYINT(1) NOT NULL DEFAULT 0
      COMMENT '0=단독형(그룹마다 따로 고름) 1=조합형(옵션 조합마다 가격·재고)',
  ADD COLUMN stock_qty INT NULL DEFAULT NULL
      COMMENT '옵션이 없는 상품의 재고. NULL=무제한(지금까지의 동작)';

-- (2) 옵션그룹: 선택옵션이냐 추가상품이냐 ----------------------------------------
--   is_able_duplicate_select 는 컬럼만 있고 화면이 늘 0 을 넣어 죽은 값이었다.
--   이제 추가상품(group_type=1)에서 '여러 개 고르기'로 실제 의미를 갖는다.
ALTER TABLE product_option_groups
  ADD COLUMN group_type TINYINT(1) NOT NULL DEFAULT 0
      COMMENT '0=선택옵션(필수, 그룹당 1개) 1=추가상품(선택, 여러 개 가능)',
  ADD COLUMN sort INT NOT NULL DEFAULT 0
      COMMENT '표시 순서. 지금은 id 순이라 순서를 못 바꿨다';

-- (3) 옵션: 재고와 품절 ---------------------------------------------------------
ALTER TABLE product_options
  ADD COLUMN stock_qty INT NULL DEFAULT NULL
      COMMENT '이 옵션의 재고. NULL=무제한',
  ADD COLUMN is_soldout TINYINT(1) NOT NULL DEFAULT 0
      COMMENT '재고와 무관하게 수동으로 내리는 스위치',
  ADD COLUMN sort INT NOT NULL DEFAULT 0
      COMMENT '표시 순서';

-- (4) 조합형 옵션 ---------------------------------------------------------------
--   색상×사이즈처럼 조합마다 가격·재고가 다른 경우.
--   combo_key 는 고른 옵션 id 를 **오름차순 정렬해 하이픈으로 이은 것**이다.
--   정렬하지 않으면 '101-205' 와 '205-101' 이 다른 조합으로 갈려 재고가 두 벌이 된다.
CREATE TABLE IF NOT EXISTS product_option_combinations (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    product_id BIGINT       NOT NULL,
    combo_key  VARCHAR(190) NOT NULL           COMMENT '옵션 id 오름차순 하이픈 결합 (예: 101-205)',
    add_price  INT          NOT NULL DEFAULT 0 COMMENT '이 조합의 추가금',
    stock_qty  INT          NULL DEFAULT NULL  COMMENT 'NULL=무제한',
    is_soldout TINYINT(1)   NOT NULL DEFAULT 0,
    is_delete  TINYINT(1)   NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_product_combo (product_id, combo_key),
    INDEX idx_combo_product (product_id, is_delete)
);

-- (5) 상품별 입력항목 -----------------------------------------------------------
--   order_form_fields 와 컬럼이 같다. 다른 건 소속뿐이다(서식 → 상품).
--   왜 테이블을 나누나: order_form_fields 는 마스터가 만드는 '템플릿'으로 남는다.
--   가맹점이 상품에서 템플릿을 불러오면 그 내용이 이 테이블로 **복사**된다.
--   참조가 아니라 복사여야 한다 — 마스터가 템플릿을 고쳤다고 해서
--   이미 판매 중인 상품의 입력칸이 말없이 바뀌면 안 된다.
CREATE TABLE IF NOT EXISTS product_order_form_fields (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    product_id   BIGINT       NOT NULL,
    label        VARCHAR(60)  NOT NULL           COMMENT '고객에게 보이는 항목 이름 (예: 행사일)',
    field_type   VARCHAR(20)  NOT NULL DEFAULT 'text',
    placeholder  VARCHAR(255) NULL,
    is_required  TINYINT(1)   NOT NULL DEFAULT 0,
    sort         INT          NOT NULL DEFAULT 0,
    option_list  TEXT         NULL               COMMENT 'select/multiselect 보기 목록(줄바꿈 구분)',
    max_length   INT          NULL,
    min_number   INT          NULL,
    max_number   INT          NULL,
    lead_days    INT          NULL               COMMENT '오늘+N일 이후만 선택 가능(준비 기간)',
    max_days     INT          NULL               COMMENT '오늘+N일 이내만 선택 가능',
    lang_obj     LONGTEXT     NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_delete    TINYINT(1)   NOT NULL DEFAULT 0,
    INDEX idx_pof_product (product_id, is_delete, sort)
);

-- (6) 재고 이동 원장 -------------------------------------------------------------
--   차감/복구를 원장으로 남긴다. 왜 원장인가:
--     · 취소가 두 번 들어와도 재고가 두 번 늘면 안 된다.
--     · 옵션이 지워진 뒤 취소가 들어와도 무엇을 얼마나 되돌릴지 알아야 한다.
--   UNIQUE 로 같은 (주문, 방향, 대상) 조합이 두 번 쌓이는 것을 **DB 가** 막는다.
--   ⚠ option_id/combo_id 는 NULL 대신 0 을 쓴다. MySQL UNIQUE 는 NULL 중복을 막지 못한다.
CREATE TABLE IF NOT EXISTS product_stock_moves (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    trans_id   INT             NOT NULL          COMMENT 'transactions.id',
    product_id BIGINT          NOT NULL,
    option_id  BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '단독형 옵션 재고. 없으면 0',
    combo_id   BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '조합형 재고. 없으면 0',
    qty        INT             NOT NULL          COMMENT '움직인 수량(양수)',
    kind       VARCHAR(4)      NOT NULL          COMMENT 'out=주문으로 차감, in=취소로 복구',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_stock_move (trans_id, kind, product_id, option_id, combo_id),
    INDEX idx_stock_move_trans (trans_id)
);

-- 확인 -----------------------------------------------------------------------
--   SHOW COLUMNS FROM products LIKE 'option_mode';
--   SHOW COLUMNS FROM product_option_groups LIKE 'group_type';
--   SHOW COLUMNS FROM product_options LIKE 'stock_qty';
--   SHOW TABLES LIKE 'product_option_combinations';
--   SHOW TABLES LIKE 'product_order_form_fields';
--   SHOW TABLES LIKE 'product_stock_moves';

-- 되돌리기 (필요할 때만) -------------------------------------------------------
-- DROP TABLE IF EXISTS product_stock_moves;
-- DROP TABLE IF EXISTS product_order_form_fields;
-- DROP TABLE IF EXISTS product_option_combinations;
-- ALTER TABLE product_options       DROP COLUMN stock_qty, DROP COLUMN is_soldout, DROP COLUMN sort;
-- ALTER TABLE product_option_groups DROP COLUMN group_type, DROP COLUMN sort;
-- ALTER TABLE products              DROP COLUMN option_mode, DROP COLUMN stock_qty;
