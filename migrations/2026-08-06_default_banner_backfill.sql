-- 기존 개설 브랜드 중 메인페이지 섹션이 하나도 없는 곳에 기본 배너슬라이드를 심는다.
--
-- 배경: 브랜드 생성 시 shop_obj/blog_obj를 '[]'로 만들어서 홈이 백지였다.
--       (2026-08-06 부로 신규 개설은 merchant_application.controller.js가 알아서 심는다 → 이 스크립트는 기존 분량 정리용)
-- 프론트에 '섹션 0개면 렌더 시점에 기본 배너를 끼우는' 폴백도 들어가 있어서
-- 이 스크립트를 실행하지 않아도 화면은 나온다. 다만 실행하면 관리자 디자인관리에
-- 실제 섹션으로 보여서 가맹점이 이미지만 바로 교체할 수 있다.
--
-- 안전: 섹션이 이미 하나라도 있는 브랜드는 절대 건드리지 않는다(= 가맹점이 만든 구성 보존).
-- 멱등: 여러 번 실행해도 결과가 같다.
--
-- ※ 실행 전 반드시 brands 테이블 백업.
--    mysqldump -u<user> -p <db> brands > brands_backup_20260806.sql

-- ─────────────────────────────────────────────────────────────
-- 0) 사전 확인 — 대상이 몇 개인지 먼저 본다 (변경 없음)
-- ─────────────────────────────────────────────────────────────
SELECT
  CAST(JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.shop_demo_num')) AS UNSIGNED) AS shop_demo,
  CAST(JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.blog_demo_num')) AS UNSIGNED) AS blog_demo,
  COUNT(*) AS cnt
FROM brands
WHERE is_delete = 0
  AND is_main_dns <> 1
  AND (shop_obj IS NULL OR shop_obj = '' OR shop_obj = '[]')
  AND (blog_obj IS NULL OR blog_obj = '' OR blog_obj = '[]')
GROUP BY shop_demo, blog_demo
ORDER BY shop_demo, blog_demo;

-- ─────────────────────────────────────────────────────────────
-- 1) 스토어형 — 섹션 빌더 데모(1·2·3·4·5·6·9)만 대상
--    4·5·6·9는 배너 컨테이너가 2:1(contain)이라 2x1 이미지 세트를 쓴다.
--    7·8은 자체 고정 레이아웃, 10은 빈 컴포넌트 → 심어도 화면에 안 나오므로 제외.
-- ─────────────────────────────────────────────────────────────
UPDATE brands
SET shop_obj = CASE
  WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.shop_demo_num')) AS UNSIGNED) IN (4,5,6,9) THEN
    '[{"type":"banner","list":[{"src":"/assets/images/banners/banner-2x1-1.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2x1-2.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2x1-3.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2x1-4.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2x1-5.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2x1-6.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""}],"style":{"min_height":200}}]'
  ELSE
    '[{"type":"banner","list":[{"src":"/assets/images/banners/banner-1.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-3.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-4.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-5.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-6.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""}],"style":{"min_height":200}}]'
END
WHERE is_delete = 0
  AND is_main_dns <> 1
  AND (shop_obj IS NULL OR shop_obj = '' OR shop_obj = '[]')
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.shop_demo_num')) AS UNSIGNED) IN (1,2,3,4,5,6,9);

-- ─────────────────────────────────────────────────────────────
-- 2) 블로그형 — 섹션 빌더 데모(1·2·3)만 대상
--    4~9는 고정 레이아웃(대표상품 + 홈 문구)이라 blog_obj를 안 읽는다 → 제외.
--    블로그 배너는 cover(840x424)라 비율 세트 구분 없이 2.35:1 세트 사용.
-- ─────────────────────────────────────────────────────────────
UPDATE brands
SET blog_obj = '[{"type":"banner","list":[{"src":"/assets/images/banners/banner-1.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-2.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-3.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-4.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-5.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""},{"src":"/assets/images/banners/banner-6.jpg","title":"","title_color":"#ffffff","sub_title":"","sub_title_color":"#ffffff","link":""}],"style":{"min_height":200}}]'
WHERE is_delete = 0
  AND is_main_dns <> 1
  AND (blog_obj IS NULL OR blog_obj = '' OR blog_obj = '[]')
  AND CAST(JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.blog_demo_num')) AS UNSIGNED) IN (1,2,3);

-- ─────────────────────────────────────────────────────────────
-- 3) 사후 확인 — 배너가 심어진 브랜드 목록
-- ─────────────────────────────────────────────────────────────
SELECT id, dns, name,
  JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.shop_demo_num')) AS shop_demo,
  JSON_UNQUOTE(JSON_EXTRACT(setting_obj, '$.blog_demo_num')) AS blog_demo,
  JSON_LENGTH(shop_obj) AS shop_sections,
  JSON_LENGTH(blog_obj) AS blog_sections
FROM brands
WHERE is_delete = 0 AND is_main_dns <> 1
ORDER BY id;
