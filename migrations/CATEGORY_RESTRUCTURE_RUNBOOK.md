# 카테고리 정규화 — 실행 런북 (단계 이행 / 브랜드별)

대상: `migrations/2026-08-03_category_restructure.sql` + `scripts/category-restructure-backfill.js`
방식: **하위호환 dual-read + 브랜드별 단계 이행** (빅뱅 아님).

## 핵심 개념 (왜 안전한가)
- **dual-read 필터**: 상품목록 카테고리 필터가 `products_categories`(연결테이블) **OR** 기존 `category_id0/1/2`(위치컬럼) 를 본다 → **마이그레이션 안 된 브랜드도 그대로 동작.**
- **`brands.is_category_migrated` 플래그**(기본 0): shop.controller 가 읽어 `1`이면 단일 트리, `0/NULL`이면 기존 그룹 유지. → **브랜드별로 하나씩 전환.**
- **전량 additive · 멱등 · 롤백가능.** 기존 `category_id0/1/2`·그룹 무손상.

> 전제: 82개 브랜드 전부 우리 소유(확인됨). 규모 편차 큼(0상품 ~ 55,000상품). **큰 브랜드일수록 신중히, 파일럿→소형→대형 순.**

---

## GATE 0 — 반드시 먼저
1. **첫 실행은 프로덕션이 아니라 "백업 복사본(스테이징)"에서 리허설.** 검증(V1~V6) 통과 후에만 프로덕션.
2. 리허설은 백엔드 `.env` 의 `DB_HOST`/`DB_DATABASE` **및** `READ_DB_HOST`/`READ_DB_DATABASE` 를 **백업본**으로 향하게 한 뒤 백필을 돌린다.
3. SQL/백필은 **`category-restructure` 브랜치 버전**을 쓸 것(id BIGINT·dual-read·플래그 반영본).

## PREFLIGHT (읽기 전용)
- **id 타입**: 확인 완료(2026-08-03) — 전부 **bigint**. SQL DDL 반영됨. 추가 조정 불필요.
- **테넌트 landscape**(P2): `SELECT g.brand_id, COUNT(*) AS grp_cnt, (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=g.brand_id AND c.is_delete=0) AS cats, (SELECT COUNT(*) FROM products p WHERE p.brand_id=g.brand_id AND p.is_delete=0) AS prods FROM product_category_groups g WHERE g.is_delete=0 GROUP BY g.brand_id ORDER BY prods;` → **prods 오름차순**으로 보고 파일럿(0상품/소형)부터 정한다.

---

## STEP 1 — 백업
```bash
mysqldump -h <HOST> -u <USER> -p <DBNAME> \
  brands products product_categories product_category_groups \
  product_properties product_property_groups products_and_properties \
  > backup_before_category_restructure_$(date +%Y%m%d).sql
```

## STEP 2 — 스키마 + 플래그 + 스냅샷 + 역할 시드 (한 번만, 전 브랜드 공통)
파일 안 검토/검증/롤백은 전부 주석 → 통째 실행 시 **Phase 0(스냅샷)+Phase 1(DDL·`brands.is_category_migrated` ALTER)+Phase 2(역할 시드)** 만 수행(멱등).
```bash
mysql -h <HOST> -u <USER> -p <DBNAME> < migrations/2026-08-03_category_restructure.sql
```
확인:
```sql
SHOW COLUMNS FROM brands LIKE 'is_category_migrated';   -- 생성됐는지(기본 0)
SHOW TABLES LIKE 'products_categories';
SELECT COUNT(*) FROM _mig_group_role;                    -- 그룹 시드됐는지
```
→ 이 시점엔 **전 브랜드 flag=0** 이라 아무 것도 안 바뀐 상태.

## STEP 3 — 새 코드 배포 (백엔드+프론트, `category-restructure`)
flag 기본 0 이므로 **배포해도 82개 전부 기존과 동일하게 동작**(shop.controller=기존 그룹, 필터=dual-read 폴백). 여기서 스토어 몇 개 스모크 테스트(카테고리 클릭→상품 뜨는지)로 dual-read 정상 확인.

## STEP 4 — 브랜드별 이행 (파일럿 → 소형 → 대형, 하나씩)

각 대상 브랜드 `<B>` 에 대해:

**4-1. 역할 검토** (그 브랜드 그룹만)
```sql
SELECT group_id, brand_id, group_name, num_categories, num_parent_categories,
       num_products_linked, suggested_role, role, is_reviewed
FROM _mig_group_role WHERE brand_id=<B>
ORDER BY suggested_role DESC, num_products_linked DESC;
```
확정(실분류축=tree, 제조사/상표 평면=property):
```sql
UPDATE _mig_group_role SET role='tree',     is_reviewed=1 WHERE group_id=<G>;
UPDATE _mig_group_role SET role='property', is_reviewed=1 WHERE group_id=<G>;
```

**4-2. dry-run → 실행** (해당 브랜드만; `all` 이어야 완료 후 flag=1 설정됨)
```bash
node scripts/category-restructure-backfill.js --brand <B> --dry-run
node scripts/category-restructure-backfill.js --brand <B>
```
→ 마지막에 `[flag] is_category_migrated=1 설정: 1개 브랜드 (<B>)` 확인. 이때부터 그 브랜드만 단일 트리로 전환.

**4-3. 검증 V1~V6** (아래) — 그 브랜드 범위로 확인. 문제 없으면 스토어 스모크 테스트(카테고리·상품·저장).
**4-4. 문제 시 그 브랜드만 롤백**: `UPDATE brands SET is_category_migrated=0 WHERE id=<B>;` (즉시 기존 그룹 모드로 복귀. 산출물 정리는 SQL 롤백 블록 참조.)

다음 브랜드로 반복. 안정화되면 대형 브랜드(5·27·46…) 진행.

## STEP 5 — 검증 쿼리 V1~V6 (백필 후)

**V1 보존성** — 기대 `distinct_pairs == pc_rows` (전 브랜드; 특정 브랜드면 각 서브쿼리에 `AND brand_id=<B>`)
```sql
SELECT
  (SELECT COUNT(*) FROM (
     SELECT DISTINCT p.id AS pid, c.id AS cid
     FROM products p
     JOIN product_categories c ON c.id IN (p.category_id0,p.category_id1,p.category_id2)
     JOIN _mig_group_role r ON r.group_id=c.product_category_group_id
     WHERE r.role='tree' AND c.is_delete=0 AND p.is_delete=0
   ) t) AS distinct_pairs,
  (SELECT COUNT(*) FROM products_categories WHERE is_delete=0) AS pc_rows;
```
**V2 고아** — 기대 `0`
```sql
SELECT COUNT(*) AS orphan_rows FROM products_categories pc
LEFT JOIN product_categories c ON c.id=pc.category_id
WHERE pc.is_delete=0 AND (c.id IS NULL OR c.is_delete=1);
```
**V3 분류 유실** — 활성인데 트리 카테고리 0인 상품(육안)
```sql
SELECT p.id, p.brand_id, p.product_name, p.category_id0, p.category_id1, p.category_id2
FROM products p
WHERE p.is_delete=0
  AND NOT EXISTS (SELECT 1 FROM products_categories pc WHERE pc.product_id=p.id AND pc.is_delete=0)
ORDER BY p.brand_id, p.id;
```
**V4 브랜드(속성) 커버리지**
```sql
SELECT r.group_id, r.group_name, m.property_group_id,
       (SELECT COUNT(*) FROM _mig_cat_to_prop cp WHERE cp.property_group_id=m.property_group_id) AS props,
       (SELECT COUNT(*) FROM products_and_properties pp
         WHERE pp.property_group_id=m.property_group_id AND pp.is_delete=0) AS links
FROM _mig_group_role r
LEFT JOIN _mig_group_to_propgroup m ON m.group_id=r.group_id
WHERE r.role='property' ORDER BY r.brand_id, r.group_id;
```
**V5 사전 중복** — 기대 빈 결과
```sql
SELECT product_id, category_id, COUNT(*) c FROM products_categories
WHERE is_delete=0 GROUP BY product_id, category_id HAVING c>1;
```
**V6 스냅샷 대비 미이전** — 원래 깨진 참조 후보(육안)
```sql
SELECT s.id AS product_id, s.brand_id, v.slot, v.cat_id
FROM _mig_products_snapshot s
JOIN (
  SELECT id, 'cat0' slot, category_id0 cat_id FROM _mig_products_snapshot WHERE category_id0>0
  UNION ALL SELECT id, 'cat1', category_id1 FROM _mig_products_snapshot WHERE category_id1>0
  UNION ALL SELECT id, 'cat2', category_id2 FROM _mig_products_snapshot WHERE category_id2>0
) v ON v.id=s.id
LEFT JOIN products_categories pc ON pc.product_id=s.id AND pc.category_id=v.cat_id AND pc.is_delete=0
LEFT JOIN _mig_cat_to_prop cp ON cp.category_id=v.cat_id
WHERE pc.id IS NULL AND cp.category_id IS NULL
ORDER BY s.brand_id, s.id;
```

## 롤백
- **브랜드 단위(권장)**: `UPDATE brands SET is_category_migrated=0 WHERE id=<B>;` → 즉시 기존 그룹 모드.
- **전체/산출물 정리**: 구코드(rladlsdnr) 재배포 + `2026-08-03_category_restructure.sql` 하단 "롤백" 주석 블록(연결테이블 DROP, 생성 속성행/그룹 삭제, soft-delete facet 복원, 플래그 원복).

## 마무리(전 브랜드 이행 안정화 후, 후속)
- product.controller 필터의 위치컬럼 OR 폴백 제거(순수 연결테이블) → 인덱스 최적.
- `category_id0/1/2`·`product_category_group_id`·그룹 테이블 지연 삭제.
