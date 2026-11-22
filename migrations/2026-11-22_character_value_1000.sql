-- ============================================================================
-- 상품 정보(특성) 내용 칸 100자 → 1000자
-- 날짜: 2026-11-22
--
-- 왜 필요한가:
--   product_characters.character_value 가 VARCHAR(100) 이라 식품 정보고시
--   「원재료명 및 함량」처럼 100자가 넘는 내용을 넣으면 ER_DATA_TOO_LONG 으로
--   상품 저장 전체가 실패했다(해담수산 141, 2026-11-22 저장 7번·수정 3번 실패).
--   그때까지 15만 4천 줄 중 가장 긴 값이 86자라 아무도 걸리지 않았다.
--
-- 안전성:
--   · 길이만 늘린다. 문자셋·콜레이션·NULL 허용은 그대로라 기존 값은 바뀌지 않는다.
--   · utf8mb4 100자(400바이트)와 1000자(4000바이트)는 둘 다 길이 2바이트 접두라
--     MySQL 8 은 표를 복사하지 않고 정의만 바꾼다(ALGORITHM=INPLACE, LOCK=NONE).
--     허용되지 않는 변경이면 아무것도 바꾸지 않고 오류로 끝난다.
--   · 이 칸에는 색인·트리거·외래키가 없다.
--   · 운영 DB 의 lock_wait_timeout 이 1년(기본값)이다. 다른 작업이 표를 잡고 있으면
--     ALTER 가 메타데이터 잠금을 기다리는 동안 뒤따르는 상품 조회가 줄줄이 막힌다.
--     그래서 5초만 기다리고 못 잡으면 포기하게 한다(포기하면 아무것도 안 바뀐다 → 다시 실행).
--   · 서버 검사(controllers/product.controller.js 특성최대)와 관리자 입력칸(프론트 ProductOptionEditor)이
--     1000자에 맞춰져 있다. 칸을 바꾸면 같이 바꿀 것.
--   · 2026-11-22 운영 적용 완료(10ms, 154,061줄·글자 수 합계 변화 없음).
-- ============================================================================

-- ── 0) 지금 상태 (먼저 이것만 돌려볼 것) ─────────────────────────────────────
-- SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLLATION_NAME FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_characters' AND COLUMN_NAME = 'character_value';
--   → varchar(100) / YES / NULL / utf8mb4_unicode_ci

-- ── 1) 변경 ─────────────────────────────────────────────────────────────────
SET SESSION lock_wait_timeout = 5;
ALTER TABLE product_characters
  MODIFY character_value VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL,
  ALGORITHM=INPLACE, LOCK=NONE;

-- ── 2) 확인 ─────────────────────────────────────────────────────────────────
-- 위 0) 을 다시 돌려 varchar(1000) 인지 본다.
