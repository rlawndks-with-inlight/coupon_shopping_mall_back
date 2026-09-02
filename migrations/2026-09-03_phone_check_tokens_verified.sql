-- ============================================================================
-- phone_check_tokens.verified 추가 — SMS 인증 '완료' 표시
--
-- 왜:
--   /auth/code 는 문자를 보내자마자 phone_token 을 응답으로 돌려주고, 비밀번호 찾기(changePassword)는
--   그 토큰이 '존재하고 1시간 안'인지만 봤다. 인증번호를 맞혔는지(checkPhoneVerifyCode)를 확인하는 곳이 없어
--   전화번호만 알면 남의 비밀번호를 바꿀 수 있었다(SMS 게이트웨이가 설정된 브랜드 한정).
--   → 인증번호 확인 성공 때 verified=1 을 찍고, 비밀번호 변경은 verified=1 인 토큰만 받는다.
--
-- 코드는 hasColumn 으로 컬럼 존재를 확인하므로 이 마이그레이션 전/후 어느 순서로 배포해도 깨지지 않는다.
-- 재실행 안전.
-- ============================================================================
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'phone_check_tokens' AND COLUMN_NAME = 'verified'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE phone_check_tokens ADD COLUMN verified TINYINT NOT NULL DEFAULT 0, ADD COLUMN used TINYINT NOT NULL DEFAULT 0',
  'SELECT ''phone_check_tokens.verified 이미 존재 — 건너뜀'' AS note');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
