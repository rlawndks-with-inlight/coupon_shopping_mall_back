-- 2026-11-23 입점 신청서 칸과 브랜드 칸 크기 맞추기.
-- 승인하면 신청서(사업자명 120·통신판매업신고번호 120·대표자 60)를 브랜드 칸(50·20·50)으로 옮겨 담아
-- 긴 값이면 승인(몰 개설)이 실패했다. 신고번호는 「제 2024-경북포항남구-01234 호」처럼 띄어 쓰면 20자를 넘는다.
-- name·company_name·mail_order_num 은 길이 바이트가 1→2 로 바뀌어 INPLACE 가 안 된다 — 128줄이라 COPY(LOCK=SHARED, 읽기는 그대로).
-- 칸 설명(COMMENT)·NULL 여부·기본값은 그대로 다시 적는다.
SET SESSION lock_wait_timeout = 5;
ALTER TABLE brands
  MODIFY name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '브랜드 명',
  MODIFY company_name VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '회사명',
  MODIFY ceo_name VARCHAR(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '대표자명',
  MODIFY mail_order_num VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL COMMENT '통신판매번호 - 240202_1548 인욱 create',
  ALGORITHM=COPY, LOCK=SHARED;
