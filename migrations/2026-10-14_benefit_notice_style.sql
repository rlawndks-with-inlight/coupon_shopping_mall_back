-- ============================================================================
-- 혜택 안내 — 제목 색·크기, 요약 문구 색 (style_obj)
-- 날짜: 2026-10-14 (사장님 요청: 「제목을 강조할 수단이 없다」)
--
-- 칸 하나만 붙인다. 기존 행은 NULL = 예전 모양 그대로 보인다. 기존 데이터를 바꾸지 않는다.
-- 값은 JSON 문자열: {"title_color":"#d32f2f","title_size":"large","summary_color":"#d32f2f"}
--   서버(benefit_notice.controller 꾸밈정리)가 색은 #rrggbb, 크기는 normal/large/xlarge 만 받는다.
--
-- ⚠ 백엔드 배포 **전에** 실행한다 — 새 백엔드는 저장할 때 style_obj 칸에 쓴다.
-- 되돌리기: ALTER TABLE benefit_notices DROP COLUMN style_obj;
-- ============================================================================
ALTER TABLE benefit_notices
    ADD COLUMN style_obj VARCHAR(500) NULL COMMENT '제목·요약 강조(색·크기) JSON — 비면 기본 모양' AFTER popup_title;
