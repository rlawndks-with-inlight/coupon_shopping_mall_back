-- ============================================================================
-- 보안질문 기반 아이디찾기 / 비밀번호 재설정 (SMS 없이) — shopgo 하위 가맹점 전용
-- 날짜: 2026-08-05
-- 대상: users (전량 additive · NULL 허용 · 재실행 멱등)
--
-- ⚠ 실행 전 DB 전체 백업 (공유 프로덕션 DB — 타 프로젝트 실고객 공존).
-- ⚠ 반드시 "코드 배포보다 먼저" 실행할 것.
--    insertQuery()(utils.js/query-util.js)는 obj의 키로 INSERT 문을 만들고,
--    signUp 은 insertQuery 실패(false)를 검사하지 않는다(controllers/auth.controller.js).
--    → 컬럼 없이 신코드를 먼저 배포하면 shopgo 가맹점 회원가입이 "성공" 응답을 주면서
--      실제로는 회원이 생성되지 않는다(무증상 데이터 유실).
-- ⚠ HeidiSQL 에서는 이 파일 전체를 열고 F9(전체 실행)로 한 번에 실행하면 된다.
--    '1681 Integer display width deprecated' 경고는 기존 정수컬럼 때문 → 무시.
-- ============================================================================

-- 1) 보안질문 id (1~8). NULL = 미설정 → 로그인 후 "설정하기" 배너 노출 조건.
--    ⚠ 질문 목록의 id 는 영구값이다. 백엔드/프론트 목록의 순서·번호를 바꾸면
--       기존 회원의 질문이 통째로 뒤바뀐다. 추가만 허용, 재배치 금지.
SET @has_col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='security_question_id');
SET @ddl := IF(@has_col=0,
  'ALTER TABLE users ADD COLUMN security_question_id TINYINT UNSIGNED NULL',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 2) 정규화된 답변의 해시 (PBKDF2-SHA512, base64). 평문 저장 금지.
SET @has_col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='security_answer_hash');
SET @ddl := IF(@has_col=0,
  'ALTER TABLE users ADD COLUMN security_answer_hash VARCHAR(255) NULL',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 3) 답변 전용 salt (user_salt 와 분리 — 비밀번호 변경이 답변 검증에 영향 주지 않도록).
SET @has_col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='security_answer_salt');
SET @ddl := IF(@has_col=0,
  'ALTER TABLE users ADD COLUMN security_answer_salt VARCHAR(255) NULL',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 4) 답변 연속 실패 횟수 (5회 → 30분 잠금, 잠금 시 0으로 리셋).
SET @has_col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='security_fail_count');
SET @ddl := IF(@has_col=0,
  'ALTER TABLE users ADD COLUMN security_fail_count INT NOT NULL DEFAULT 0',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 5) 잠금 해제 시각. NULL = 잠금 아님. 판정/설정은 전부 DB의 NOW() 로만(노드↔DB 시간대 어긋남 방지).
SET @has_col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='security_locked_until');
SET @ddl := IF(@has_col=0,
  'ALTER TABLE users ADD COLUMN security_locked_until DATETIME NULL',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 6) 최초/최종 설정 시각 — 문의 대응 및 감사용.
SET @has_col := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='security_set_at');
SET @ddl := IF(@has_col=0,
  'ALTER TABLE users ADD COLUMN security_set_at DATETIME NULL',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;

-- 7) 아이디찾기(브랜드+휴대폰 블라인드인덱스) 조회용 복합 인덱스.
SET @has_idx := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND INDEX_NAME='idx_users_brand_phone_idx');
SET @ddl := IF(@has_idx=0,
  'ALTER TABLE users ADD INDEX idx_users_brand_phone_idx (brand_id, phone_idx)',
  'DO 0');
PREPARE s FROM @ddl; EXECUTE s; DEALLOCATE PREPARE s;


-- ============================================================================
-- 검증 (위 실행 후 아래 2개를 실행해 결과를 확인)
-- ============================================================================

-- V1) 컬럼 6개가 모두 보이면 정상
SHOW COLUMNS FROM users LIKE 'security_%';

-- V2) 배너 대상 규모 — shopgo 하위 가맹점의 보안질문 미설정 회원 수
SELECT COUNT(*) AS 미설정회원
FROM users u
JOIN brands b ON b.id = u.brand_id
WHERE b.parent_id = 98
  AND u.is_delete = 0
  AND u.security_question_id IS NULL;


-- ============================================================================
-- 롤백 (필요 시에만 — 컬럼 삭제는 저장된 보안질문/답변 소실)
-- ============================================================================
-- ALTER TABLE users DROP INDEX idx_users_brand_phone_idx;
-- ALTER TABLE users
--   DROP COLUMN security_question_id,
--   DROP COLUMN security_answer_hash,
--   DROP COLUMN security_answer_salt,
--   DROP COLUMN security_fail_count,
--   DROP COLUMN security_locked_until,
--   DROP COLUMN security_set_at;
-- ============================================================================
