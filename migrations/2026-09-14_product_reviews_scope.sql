-- ============================================================================
-- 상품후기 다시 켜기 ② 별점 눈금 — 2~10(반 별) → 1~5 정수
-- 날짜: 2026-09-14  (설계: ShopGo 후기·별점 설계 §4.3·§5)
--
-- 쿠팡·네이버와 같은 눈금이고, 백엔드 검사(1~5)와 폼(×2)이 어긋나 3점 이상이 거절되던 버그도 함께 없앤다.
-- 다른 배포 브랜드 4곳(65 jjmoon888 · 66 shirts4989 · 69 hynet777 · 70 naro-one, 2,927건)도 함께 옮긴다
-- (2026-09-14 사장님 동의). 짝수는 정확히 절반, 홀수 3건(thegrazia 7→4, forsmall 삭제행 5→3)은 반올림.
--
-- ⚠ 반드시 집계 코드(product.controller: AVG(scope)/2 → ROUND(AVG(scope),1))·폼(×2 제거) 배포와
--   **같은 자리에서** 돌린다. 사이가 벌어지면 그동안 그 4곳의 별점이 반으로 보인다.
--   순서: ① _v2.sql(컬럼) → 백엔드 배포 → 이 파일 → 프론트 배포.
-- 6 이상인 값이 하나라도 있을 때만 돌아 두 번 돌려도 안전하다(되돌릴 수는 없다 — 반올림으로 정보가 줄었다).
-- ============================================================================

SET @sql := IF(EXISTS(SELECT 1 FROM product_reviews WHERE scope > 5),
  'UPDATE product_reviews SET scope = LEAST(5, GREATEST(1, ROUND(scope / 2)))',
  'SELECT ''별점은 이미 1~5 — 건너뜀'' AS 안내');
PREPARE st FROM @sql; EXECUTE st; DEALLOCATE PREPARE st;

-- 확인 -----------------------------------------------------------------------
SELECT '별점 6 이상 남은 행' AS 항목, IF(EXISTS(SELECT 1 FROM product_reviews WHERE scope > 5), 'X(남음)', 'O(없음)') AS 결과
UNION ALL SELECT '별점 분포', (SELECT GROUP_CONCAT(CONCAT(scope, ':', n) ORDER BY scope SEPARATOR ' ')
                              FROM (SELECT scope, COUNT(*) n FROM product_reviews GROUP BY scope) d);
