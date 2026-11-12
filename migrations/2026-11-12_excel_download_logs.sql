-- ============================================================================
-- 엑셀 내려받기 기록
-- 날짜: 2026-11-12  (사장님 요청: "엑셀 내려받기 기록 만들어줘, 최상위 관리자만 볼 수 있도록")
--
-- 주문 엑셀에는 손님 이름·연락처·주소가 평문으로 들어간다. 누가·언제·어떤 조건으로·몇 건 받았는지 남긴다.
-- 보는 것은 최상위 관리자(level 50)만(서버 excel_log.controller 가 막는다).
--
-- 안전성: 새 테이블 하나를 만든다. 기존 테이블·데이터는 건드리지 않는다.
-- 코드는 이 테이블이 없어도 내려받기가 막히지 않는다(기록만 남지 않고 서버 로그에 한 줄 남는다).
-- ▶ 여러 번 돌려도 안전하다(이미 있으면 건너뜀).
-- ============================================================================
CREATE TABLE IF NOT EXISTS excel_download_logs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_id    INT NOT NULL DEFAULT 0            COMMENT '받은 몰',
  user_id     INT NOT NULL DEFAULT 0            COMMENT '받은 사람(로그인 토큰 기준)',
  user_name   VARCHAR(100) NULL                 COMMENT '받은 사람 아이디(그때 값)',
  user_level  INT NULL                          COMMENT '받은 사람 등급(그때 값)',
  kind        VARCHAR(30) NOT NULL              COMMENT '무엇을 받았나(orders = 주문내역)',
  scope       VARCHAR(20) NOT NULL              COMMENT 'condition = 조건으로, selected = 체크한 주문만',
  conditions  VARCHAR(1000) NULL                COMMENT '기간·상태(JSON). 검색어는 내용 대신 썼는지만',
  row_count   INT NOT NULL DEFAULT 0            COMMENT '파일에 담긴 건수',
  ip          VARCHAR(64) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_brand_created (brand_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='엑셀 내려받기 기록(최상위 관리자만 조회)';

SELECT IF(EXISTS(SELECT 1 FROM INFORMATION_SCHEMA.TABLES
                  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'excel_download_logs'),'O','X') AS `excel_download_logs 테이블`;
