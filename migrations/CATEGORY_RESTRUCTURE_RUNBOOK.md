# 카테고리 정규화 — 실행 런북 (리허설/컷오버)

대상: `migrations/2026-08-03_category_restructure.sql` + `scripts/category-restructure-backfill.js`
원칙: **전량 additive · 멱등 · 롤백가능**. 하지만 공유 프로덕션 DB이므로 아래 게이트를 반드시 지킨다.

---

## GATE 0 — 반드시 먼저 (읽고 넘어갈 것)

1. **처음엔 프로덕션이 아니라 "백업 복사본(스테이징)"에서 리허설한다.** 백업본은 격리돼 있어 무엇을 돌려도 안전하다. 리허설이 검증(V1~V6)까지 통과한 뒤에만 프로덕션 컷오버로 넘어간다.
2. **멀티테넌시 범위 확인.** 이 재구조화 + 새 프론트 배포는 `products`/`product_categories`/`product_category_groups` 테이블을 쓰는 **모든 테넌트**에 영향을 준다(shopgo 가맹점 + 같은 코드의 다른 클라이언트). 아래 PREFLIGHT-2 로 영향 범위를 먼저 파악한다. (리허설은 복사본이라 범위 무관, 프로덕션 컷오버 전 확정.)
3. 리허설은 백엔드 `.env` 의 `DB_HOST`/`DB_DATABASE` **및** `READ_DB_HOST`/`READ_DB_DATABASE` 를 **백업본**으로 향하게 한 상태에서 백필 스크립트를 돌린다.

---

## PREFLIGHT — 읽기 전용 (아무것도 안 바꿈)

### P1. id 타입 확인 (SQL은 INT 가정 — bigint면 조정 필요)
```sql
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND ( (TABLE_NAME='products'                AND COLUMN_NAME IN ('id','brand_id','category_id0','category_id1','category_id2'))
     OR (TABLE_NAME='product_categories'      AND COLUMN_NAME IN ('id','brand_id','parent_id','product_category_group_id'))
     OR (TABLE_NAME='product_category_groups' AND COLUMN_NAME='id') )
ORDER BY TABLE_NAME, COLUMN_NAME;
```
→ **확인 완료(2026-08-03): 전부 bigint** (products.id, product_categories.id, category_id0/1/2). SQL DDL을 BIGINT로 이미 반영함. 추가 조정 불필요.

### P2. 영향 테넌트 landscape (누구의 데이터가 바뀌나)
```sql
-- 주의: MySQL8 에서 GROUPS 는 예약어 → 별칭은 grp_cnt 등으로.
SELECT g.brand_id,
       COUNT(*) AS grp_cnt,
       (SELECT COUNT(*) FROM product_categories c WHERE c.brand_id=g.brand_id AND c.is_delete=0) AS cats,
       (SELECT COUNT(*) FROM products p          WHERE p.brand_id=g.brand_id AND p.is_delete=0) AS prods
FROM product_category_groups g
WHERE g.is_delete=0
GROUP BY g.brand_id
ORDER BY g.brand_id;
```
→ 카테고리 그룹을 가진 모든 brand_id 목록. shopgo(98 및 parent_id=98 가맹점)인지, 다른 클라이언트인지 확인. **프로덕션 컷오버 시 여기 나온 테넌트 전부가 함께 마이그레이션·새 프론트로 배포되어야 정합.**

### P3. 현재 규모(소량인지)
```sql
SELECT
  (SELECT COUNT(*) FROM product_category_groups WHERE is_delete=0) AS groups,
  (SELECT COUNT(*) FROM product_categories      WHERE is_delete=0) AS categories,
  (SELECT COUNT(*) FROM products                WHERE is_delete=0) AS products;
```

---

## STEP 1 — 백업 (프로덕션이면 필수, 리허설이면 이 복사본 자체가 백업원)
```bash
mysqldump -h <HOST> -u <USER> -p <DBNAME> \
  products product_categories product_category_groups \
  product_properties product_property_groups products_and_properties \
  > backup_before_category_restructure_$(date +%Y%m%d).sql
```
(전체 DB 백업이 이미 있으면 그것으로 충분.)

## STEP 2 — 스키마 + 스냅샷 + 역할 시드 (SQL 파일 실행)
파일 안의 검토/검증/롤백 쿼리는 전부 주석이라, 파일을 통째로 실행하면 **Phase 0(스냅샷)+Phase 1(DDL)+Phase 2(역할 시드)** 만 수행된다. 멱등(재실행 안전).
```bash
mysql -h <HOST> -u <USER> -p <DBNAME> < migrations/2026-08-03_category_restructure.sql
```
확인:
```sql
SHOW TABLES LIKE '_mig_%';            -- _mig_group_role, _mig_products_snapshot 등 생성됐는지
SHOW TABLES LIKE 'products_categories';
```

## STEP 3 — ★그룹 역할(tree/property) 검토 (사람이 판단) ★
```sql
SELECT group_id, brand_id, group_name, num_categories, num_parent_categories,
       num_products_linked, suggested_role, role, is_reviewed
FROM _mig_group_role
ORDER BY brand_id, suggested_role DESC, num_products_linked DESC;
```
판단: 실제 분류축(상의>티셔츠, 계층/큐레이션)=**tree**, 제조사·상표 평면 facet(나이키/샤넬)=**property**.
각 그룹 확정:
```sql
UPDATE _mig_group_role SET role='tree',     is_reviewed=1 WHERE group_id=<G>;
UPDATE _mig_group_role SET role='property', is_reviewed=1 WHERE group_id=<G>;
```
(제안값이 전부 맞다고 육안 확인했으면: `UPDATE _mig_group_role SET is_reviewed=1;` — 신중히.)
백필은 미검토(is_reviewed=0) 그룹이 있으면 **중단**한다.

## STEP 4 — 백필 dry-run (쓰기 없음, 예상치만)
백엔드 디렉터리에서:
```bash
node scripts/category-restructure-backfill.js --dry-run
```
→ 삽입 예상 트리쌍 수 / 속성그룹·속성값·링크 예상치 확인. 수치가 P3 규모와 상식적으로 맞는지 본다.

## STEP 5 — 백필 실행 (트리 백필 + 브랜드→속성 이전 + facet 카테고리 숨김)
```bash
node scripts/category-restructure-backfill.js
```
(특정 테넌트만: `--brand <id>` / 트리만: `--phase tree` / 속성만: `--phase property`)

## STEP 6 — 검증 V1~V6 (아래 쿼리 실행, 기대결과 확인)

**V1 보존성** — 기대: `distinct_pairs == pc_rows`
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

**V2 고아** — 기대: `0`
```sql
SELECT COUNT(*) AS orphan_rows FROM products_categories pc
LEFT JOIN product_categories c ON c.id=pc.category_id
WHERE pc.is_delete=0 AND (c.id IS NULL OR c.is_delete=1);
```

**V3 분류 유실** — 활성인데 트리 카테고리 0인 상품(육안: dangling/속성전용이면 정상)
```sql
SELECT p.id, p.brand_id, p.product_name, p.category_id0, p.category_id1, p.category_id2
FROM products p
WHERE p.is_delete=0
  AND NOT EXISTS (SELECT 1 FROM products_categories pc WHERE pc.product_id=p.id AND pc.is_delete=0)
ORDER BY p.brand_id, p.id;
```

**V4 브랜드(속성) 커버리지** — property 그룹 이전 요약
```sql
SELECT r.group_id, r.group_name, m.property_group_id,
       (SELECT COUNT(*) FROM _mig_cat_to_prop cp WHERE cp.property_group_id=m.property_group_id) AS props,
       (SELECT COUNT(*) FROM products_and_properties pp
         WHERE pp.property_group_id=m.property_group_id AND pp.is_delete=0) AS links
FROM _mig_group_role r
LEFT JOIN _mig_group_to_propgroup m ON m.group_id=r.group_id
WHERE r.role='property' ORDER BY r.brand_id, r.group_id;
```

**V5 사전 중복** — 기대: 빈 결과(UNIQUE로 0 보장, 확인용)
```sql
SELECT product_id, category_id, COUNT(*) c FROM products_categories
WHERE is_delete=0 GROUP BY product_id, category_id HAVING c>1;
```

**V6 스냅샷 대비 미이전** — 위치컬럼에 있었으나 트리·속성 어디로도 안 간 (product,slot) 후보
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
→ V6 에 나오는 행은 "삭제/미존재 카테고리를 가리키던 위치값"(원래 깨진 참조)일 가능성이 큼. 목록 보고 판단.

---

## 프로덕션 컷오버 (리허설 통과 후)
1. 상품/카테고리 **쓰기 동결**(수 분) + 최신 백업
2. STEP 2(SQL) → STEP 3(역할 검토) → STEP 4(dry-run) → STEP 5(백필) → STEP 6(검증)
3. **프론트+백엔드 `category-restructure` 브랜치 원자적 배포** (같은 창에서)
4. 스모크 테스트(스토어 카테고리 네비/상품목록/상품 저장) → 쓰기 동결 해제

## 롤백 (문제 시)
- **즉시**: 구코드(rladlsdnr) 재배포. 기존 `category_id0/1/2`·그룹 무손상이라 바로 복귀.
- **산출물 정리**: `2026-08-03_category_restructure.sql` 하단 "롤백" 주석 블록 참조(연결테이블 DROP, 생성 속성행/그룹 삭제, soft-delete 한 facet 카테고리 복원).
