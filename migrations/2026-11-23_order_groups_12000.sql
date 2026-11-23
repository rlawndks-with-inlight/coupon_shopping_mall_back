-- 2026-11-23 주문 줄 옵션 스냅샷 5000 → 12000자.
-- 프론트가 고른 옵션 그룹을 등록 시각·설명·번역까지 통째로 보내 그룹 하나에 수백 자를 쓴다.
-- 그룹이 7개쯤 되는 상품이면 5000자를 넘어 주문 저장이 실패했다(지금 가장 긴 값 2,283자).
-- 길이 바이트(2바이트)가 그대로라 메타데이터만 바뀐다(INPLACE·LOCK=NONE, 330만 줄 복사 없음).
-- 행 크기: varchar 최대 바이트 합 20,800 → 48,800(한도 65,535).
-- 서버도 넘칠 때 안 쓰는 값을 덜어 낸다(pay.controller 옵션칸맞추기).
-- 운영 lock_wait_timeout 이 1년이라 5초로 건다 — 못 잡으면 실패하고 다시 돌린다.
SET SESSION lock_wait_timeout = 5;
ALTER TABLE transaction_orders
  MODIFY order_groups VARCHAR(12000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '[]' COMMENT '주문 그룹정보',
  ALGORITHM=INPLACE, LOCK=NONE;
