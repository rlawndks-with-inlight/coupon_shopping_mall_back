-- ============================================================================
-- transactions.ord_num 조회 인덱스 추가
--
-- 왜:
--   포스페이 웹훅 콜백(forspayCallback)·복귀(forspayReturn) 등이
--     SELECT ... FROM transactions WHERE ord_num = ?
--   로 거래를 찾는데, ord_num 에 인덱스가 전혀 없어 매 호출마다 transactions
--   전체(약 424만 행 / 2.6GB)를 풀스캔한다.
--   지금은 forspay 거래가 적어(수십 건) 무해하지만, 향후 다수 하위가맹점의 웹훅이
--   이 단일 엔드포인트로 몰리면 노티 1건마다 풀스캔 → DB 부하가 폭증한다.
--   (결제 복귀 경로도 같은 쿼리라 결제 1건마다도 풀스캔 중이다.)
--   규모가 커지기 전에 인덱스를 깐다.
--
-- ⚠ 반드시 NON-UNIQUE 여야 한다.
--   취소 원장 행(utils.js/cancel.js 의 취소원장행쓰기)이 원거래를 복사하면서
--   같은 ord_num 을 그대로 넣는다 → 같은 ord_num 이 2행 이상 존재한다.
--   UNIQUE 로 걸면 기존 데이터 위반으로 실패한다.
--
-- 온라인 DDL:
--   MySQL 8.0 InnoDB 에서 보조 인덱스 추가는 INPLACE + LOCK=NONE 로 동작한다
--   (테이블 재작성 없음, 동시 읽기/쓰기 허용). 4.24M 행·약 2.6GB 라 수 분 걸릴 수
--   있으나 서비스 중단은 없다.
--
-- 재실행 안전: 인덱스 존재 여부를 먼저 확인하고 없을 때만 생성한다.
-- ============================================================================

SET @exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'transactions'
    AND INDEX_NAME   = 'idx_transactions_ord_num'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE transactions ADD INDEX idx_transactions_ord_num (ord_num), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT ''idx_transactions_ord_num 이미 존재 — 건너뜀'' AS note');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
