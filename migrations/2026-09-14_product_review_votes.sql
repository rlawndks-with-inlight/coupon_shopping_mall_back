-- ============================================================================
-- 상품후기 다시 켜기 ③ 「도움돼요」 표 — 누가 어느 후기에 눌렀나
-- 날짜: 2026-09-14  (설계: ShopGo 후기·별점 설계 §6, 사장님 결정 2026-09-14 "선택 기능으로 넣자")
--
-- 규칙: 회원만 · 회원당 후기 하나에 한 번(다시 누르면 취소) · 내 후기에는 못 누름.
-- 건수는 product_reviews.helpful_count 에 같이 적어 목록에서 JOIN 없이 읽고, 이 표는 '누가'를 기억해
-- 중복을 막고 취소를 가능하게 한다. 가맹점이 후기설정에서 버튼을 끄면 숨을 뿐 지워지지 않는다.
--
-- 코드 배포 전에 돌려도 안전하다(표만 만든다). 두 번 돌려도 안전하다(IF NOT EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_review_votes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  review_id  BIGINT          NOT NULL,
  user_id    INT             NOT NULL,
  brand_id   BIGINT          NULL,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_votes_review_user (review_id, user_id),
  KEY idx_review_votes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 확인 -----------------------------------------------------------------------
SELECT '도움돼요 표' AS 항목,
       IF(EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_review_votes'), 'O', 'X') AS 결과;

-- 되돌리기(필요할 때만) ---------------------------------------------------------
-- DROP TABLE product_review_votes;
