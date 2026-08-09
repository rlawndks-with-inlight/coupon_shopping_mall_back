-- ============================================================================
-- 회원 수신동의 저장 컬럼
-- 날짜: 2026-08-10
--
-- 왜 필요한가:
--   가입 폼(프레임1·2·3)에 '쇼핑정보 수신 동의 / SMS 수신 동의 / 이메일 수신 동의'
--   체크박스가 있는데, 이 값들은 **어디에도 저장되지 않았다** — 가입 요청 바디에
--   아예 실리지 않았고 받을 컬럼도 없었다.
--   게다가 그 아래 안내문은 '회원가입 후 회원정보수정 페이지에서 언제든지 수신여부를
--   변경하실 수 있습니다' 라고 적혀 있었는데, 그 화면에는 해당 항목 자체가 없었다.
--   즉 고객에게는 지키지 않는 약속이 표시되고 있었다.
--
--   광고성 정보를 보내려면 동의 사실과 시점을 남겨야 한다(정보통신망법 제50조).
--   지금은 문자·메일 발송 수단이 없지만, 동의 기록은 발송 여부와 무관하게 남겨야
--   나중에 채널이 생겼을 때 소급해서 물어보지 않아도 된다.
--
-- 안전성:
--   · 컬럼 추가만 한다(기존 행은 전부 0 = 미동의). 데이터 변경·삭제 없음.
--   · 코드에는 hasColumn 가드가 있어 이 마이그레이션 전에 배포해도 동작한다
--     (컬럼이 없으면 해당 값을 빼고 저장한다). 반대 순서도 안전하다.
--   ⚠ 실행 후 백엔드 재시작 필요 — hasColumn 은 결과를 프로세스 단위로 캐시한다.
--
-- 실행 전 백업(공유 DB 이므로 권장):
--   mysqldump -u <user> -p <db> users > users_backup_20260810.sql
-- ============================================================================

-- ── 0) 이미 있는지 확인 (먼저 이것만 돌려볼 것) ───────────────────────────
-- SELECT COLUMN_NAME FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
--    AND COLUMN_NAME IN ('is_marketing_agree','is_sms_agree','is_email_agree','marketing_agreed_at');

-- ── 1) 컬럼 추가 ────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN is_marketing_agree TINYINT(1) NOT NULL DEFAULT 0 COMMENT '쇼핑정보(광고성) 수신 동의',
  ADD COLUMN is_sms_agree       TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'SMS 수신 동의',
  ADD COLUMN is_email_agree     TINYINT(1) NOT NULL DEFAULT 0 COMMENT '이메일 수신 동의',
  -- 동의 '시점'도 남긴다. 분쟁 시 동의 사실만으로는 부족하다.
  ADD COLUMN marketing_agreed_at DATETIME NULL DEFAULT NULL COMMENT '수신동의를 마지막으로 켠 시각';

-- ── 2) 실행 후 확인 — 4행이 나와야 한다 ─────────────────────────────────────
-- SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
--    AND COLUMN_NAME IN ('is_marketing_agree','is_sms_agree','is_email_agree','marketing_agreed_at');

-- ============================================================================
-- 롤백:
--   ALTER TABLE users
--     DROP COLUMN is_marketing_agree,
--     DROP COLUMN is_sms_agree,
--     DROP COLUMN is_email_agree,
--     DROP COLUMN marketing_agreed_at;
-- ============================================================================
