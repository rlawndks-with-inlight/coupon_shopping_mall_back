-- ============================================================================
-- 비회원 1:1문의 — posts 테이블 확장
-- 날짜: 2026-08-10
--
-- 목적: 로그인하지 않은 고객도 1:1문의를 남기고, 나중에 답변을 확인할 수 있게 한다.
--   작성 시  : 이름 + 연락처 + 글비밀번호를 받는다 (회원은 지금처럼 아무것도 안 받는다)
--   조회 시  : 연락처 + 글비밀번호로 본인 글을 찾는다 (비회원 주문조회와 같은 방식)
--
-- 왜 이 방식인가:
--   이 시스템에는 문자 게이트웨이가 없고(아이디찾기도 보안질문 방식) 고객 이메일도 받지 않는다.
--   즉 답변이 달렸다고 알려줄 수단이 없다. 회원도 마찬가지로 직접 들어와서 확인하는 구조이므로,
--   비회원에게도 '다시 찾아와서 확인하는 경로'만 만들어 주면 회원과 동등해진다.
--
-- 개인정보 취급:
--   이름·연락처는 다른 개인정보와 같은 규칙으로 **암호화해서 저장한다**(utils.js/crypto-util.js encField).
--   암호문은 정확일치 조회가 불가능하므로, 조회용으로 연락처의 블라인드 인덱스를 따로 둔다
--   (transactions.buyer_phone_idx / users.phone_idx 와 같은 방식).
--   비밀번호는 평문으로 저장하지 않고 HMAC 해시로 저장한다(utils.js/order-password.js).
--
-- ⚠ 실행 전 반드시 DB 백업 (공유 DB 이므로 필수):
--     mysqldump -u <user> -p <db> posts > posts_backup_20260810.sql
--
-- 안전성: 전부 NULL 허용 "추가 컬럼" 이라 기존 162건과 다른 프로젝트에 무해하다.
--         기존 글은 전부 user_id 가 있는 회원 글이라 이 컬럼들은 NULL 로 남는다.
-- ============================================================================

ALTER TABLE posts
  ADD COLUMN none_user_name      VARCHAR(255) NULL COMMENT '비회원 작성자 이름(암호화 저장)',
  ADD COLUMN none_user_phone     VARCHAR(255) NULL COMMENT '비회원 연락처(암호화 저장)',
  ADD COLUMN none_user_phone_idx VARCHAR(64)  NULL COMMENT '비회원 연락처 블라인드 인덱스(조회용)',
  ADD COLUMN password            VARCHAR(255) NULL COMMENT '비회원 글 조회 비밀번호(HMAC 해시)';

-- 조회는 '연락처 + 비밀번호' 로 들어온다. 두 컬럼을 함께 태우는 인덱스를 건다.
CREATE INDEX idx_posts_guest_lookup ON posts (none_user_phone_idx, password);

-- 확인용:
--   SHOW COLUMNS FROM posts LIKE 'none_user%';
--   SHOW COLUMNS FROM posts LIKE 'password';
--   SHOW INDEX FROM posts WHERE Key_name = 'idx_posts_guest_lookup';
--   SELECT COUNT(*) FROM posts WHERE user_id IS NULL;   -- 비회원 글 수(처음엔 0)

-- ============================================================================
-- 롤백 (필요 시에만):
-- DROP INDEX idx_posts_guest_lookup ON posts;
-- ALTER TABLE posts
--   DROP COLUMN none_user_name,
--   DROP COLUMN none_user_phone,
--   DROP COLUMN none_user_phone_idx,
--   DROP COLUMN password;
-- ============================================================================
