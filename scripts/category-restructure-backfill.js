'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 카테고리 구조 정규화 백필 — Phase 3(트리) + Phase 4(브랜드→속성 이전). 멱등.
//
// 설계서: coupon_shopping_mall_front-master/CATEGORY-RESTRUCTURE-SPEC.md
//
// 선행(반드시 순서대로):
//   (1) DB 전체 백업(공유 프로덕션 실고객 데이터).
//   (2) migrations/2026-08-03_category_restructure.sql 실행(Phase 0~2 시드).
//   (3) _mig_group_role 육안검토 → 각 그룹 role 확정 + is_reviewed=1.
//   (4) 본 스크립트 실행.
//
// 사용:
//   node scripts/category-restructure-backfill.js --dry-run          # 쓰기 없이 예상치만
//   node scripts/category-restructure-backfill.js --brand 5          # 특정 몰(brand_id)만
//   node scripts/category-restructure-backfill.js --phase tree       # 트리만
//   node scripts/category-restructure-backfill.js --phase property   # 속성이전만
//   node scripts/category-restructure-backfill.js                    # 전체(tree+property)
//   (--force : 미검토 그룹 있어도 강행 — 권장하지 않음)
//
// 안전/멱등:
//   - 트리: products_categories.UNIQUE(product_id,category_id) + INSERT IGNORE.
//   - 속성: 영속 매핑(_mig_group_to_propgroup / _mig_cat_to_prop) + 링크 존재검사.
//   → 여러 번 돌려도 중복 생성 없음.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { readPool, writePool } from '../config/db-pool.js';

const argVal = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
const hasFlag = (name) => process.argv.indexOf(name) >= 0;

const DRY = hasFlag('--dry-run');
const FORCE = hasFlag('--force');
const BRAND = argVal('--brand') ? Number(argVal('--brand')) : null;
const PHASE = argVal('--phase') || 'all'; // tree | property | all

// brand 필터(선택). params 배열에 push 하는 헬퍼로 SQL 조각 생성.
const brandClause = (alias, params) => {
    if (BRAND == null) return '';
    params.push(BRAND);
    return ` AND ${alias}.brand_id=? `;
};

// ─────────────────────────────────────────────────────────────────────────────
// 사전 점검: 매핑 테이블 존재 + 역할 검토 게이트
// ─────────────────────────────────────────────────────────────────────────────
const precheck = async () => {
    let rows;
    try {
        [rows] = await readPool.query(`SELECT COUNT(*) AS n FROM _mig_group_role`);
    } catch (e) {
        console.error('중단: _mig_group_role 테이블이 없습니다. 먼저 migrations/2026-08-03_category_restructure.sql 를 실행하세요.');
        process.exit(1);
    }
    if (!rows[0].n) {
        console.error('중단: _mig_group_role 이 비어 있습니다. 마이그레이션 SQL Phase 2 시드를 먼저 실행하세요.');
        process.exit(1);
    }
    const params = [];
    const [unrev] = await readPool.query(
        `SELECT group_id, brand_id, group_name, num_categories, num_parent_categories,
                num_products_linked, suggested_role, role, is_reviewed
         FROM _mig_group_role WHERE is_reviewed=0 ${BRAND != null ? 'AND brand_id=?' : ''}`,
        BRAND != null ? [BRAND] : []
    );
    if (unrev.length && !FORCE) {
        console.error(`\n중단: 미검토 그룹 ${unrev.length}개. 아래 그룹의 role 을 확정하고 is_reviewed=1 로 표시하세요.`);
        console.error('(제안값대로 확정: UPDATE _mig_group_role SET is_reviewed=1 WHERE group_id=?; — 신중히)');
        console.table(unrev);
        process.exit(1);
    }
    if (unrev.length && FORCE) {
        console.warn(`경고: 미검토 그룹 ${unrev.length}개를 --force 로 강행합니다(제안 role 사용).`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3. 트리 백필: role='tree' 그룹의 카테고리를 참조한 상품 → 연결테이블
// ─────────────────────────────────────────────────────────────────────────────
const backfillTree = async () => {
    const params = [];
    const bc = brandClause('p', params);
    const where = `
      FROM products p
      JOIN product_categories c ON c.id IN (p.category_id0, p.category_id1, p.category_id2)
      JOIN _mig_group_role gr ON gr.group_id = c.product_category_group_id
      WHERE gr.role='tree' AND c.is_delete=0 AND p.is_delete=0 ${bc}`;

    if (DRY) {
        const [[{ pairs }]] = await readPool.query(
            `SELECT COUNT(*) AS pairs FROM (SELECT DISTINCT p.id, c.id ${where}) t`, params);
        console.log(`[tree][dry-run] 삽입 예상 쌍 수: ${pairs}`);
        return;
    }
    const [r] = await writePool.query(
        `INSERT IGNORE INTO products_categories (brand_id, product_id, category_id, sort_idx)
         SELECT p.brand_id, p.id, c.id, 0 ${where}`, params);
    console.log(`[tree] products_categories 신규 삽입: ${r.affectedRows} (기존행은 IGNORE)`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4. 브랜드/부가축(role='property') → 상품 속성 이전
// ─────────────────────────────────────────────────────────────────────────────
const backfillProperty = async () => {
    const gp = [];
    const [groups] = await readPool.query(
        `SELECT group_id, brand_id, group_name FROM _mig_group_role
         WHERE role='property' ${BRAND != null ? 'AND brand_id=?' : ''}`,
        BRAND != null ? [BRAND] : gp);

    let stat = { propGroups: 0, props: 0, links: 0, dryLinks: 0, hidden: 0 };

    for (const g of groups) {
        // 1) 속성그룹 매핑 확보
        let propGroupId = null;
        const [m] = await readPool.query(
            `SELECT property_group_id FROM _mig_group_to_propgroup WHERE group_id=?`, [g.group_id]);
        if (m.length) {
            propGroupId = m[0].property_group_id;
        } else if (!DRY) {
            const [ins] = await writePool.query(
                `INSERT INTO product_property_groups (property_group_name, is_can_select_multiple, brand_id)
                 VALUES (?, 0, ?)`, [g.group_name, g.brand_id]);
            propGroupId = ins.insertId;
            await writePool.query(
                `INSERT INTO _mig_group_to_propgroup (group_id, brand_id, property_group_id) VALUES (?, ?, ?)`,
                [g.group_id, g.brand_id, propGroupId]);
            stat.propGroups++;
        } else {
            stat.propGroups++;
        }

        // 2) 그룹 내 카테고리(facet) → 속성값
        const [cats] = await readPool.query(
            `SELECT id, category_name, category_img, category_description
             FROM product_categories WHERE product_category_group_id=? AND is_delete=0`, [g.group_id]);

        for (const cat of cats) {
            let propId = null;
            const [cm] = await readPool.query(
                `SELECT property_id FROM _mig_cat_to_prop WHERE category_id=?`, [cat.id]);
            if (cm.length) {
                propId = cm[0].property_id;
            } else if (!DRY) {
                const [pins] = await writePool.query(
                    `INSERT INTO product_properties
                       (property_img, property_type, property_name, property_description, product_property_group_id, brand_id)
                     VALUES (?, 0, ?, ?, ?, ?)`,
                    [cat.category_img ?? null, cat.category_name, cat.category_description ?? null, propGroupId, g.brand_id]);
                propId = pins.insertId;
                await writePool.query(
                    `INSERT INTO _mig_cat_to_prop (category_id, brand_id, property_id, property_group_id) VALUES (?, ?, ?, ?)`,
                    [cat.id, g.brand_id, propId, propGroupId]);
                stat.props++;
            } else {
                stat.props++;
            }

            // 3) 이 카테고리를 cat0/1/2 로 참조하는 상품 → 속성 링크
            const [prods] = await readPool.query(
                `SELECT id FROM products WHERE is_delete=0 AND ? IN (category_id0, category_id1, category_id2)`,
                [cat.id]);
            for (const p of prods) {
                if (DRY || propId == null) { stat.dryLinks++; continue; }
                const [ex] = await readPool.query(
                    `SELECT id FROM products_and_properties WHERE product_id=? AND property_id=? LIMIT 1`,
                    [p.id, propId]);
                if (ex.length) continue;
                await writePool.query(
                    `INSERT INTO products_and_properties (product_id, property_group_id, property_id) VALUES (?, ?, ?)`,
                    [p.id, propGroupId, propId]);
                stat.links++;
            }
        }

        // 4) 이 그룹의 facet 카테고리를 카테고리 트리에서 제거(soft-delete).
        //    → 상품속성으로 이전 완료됐으므로 단일 트리에는 노출되지 않아야 함.
        //    가역적: 롤백 시 _mig_cat_to_prop.category_id 로 is_delete=0 복원.
        if (!DRY) {
            const [del] = await writePool.query(
                `UPDATE product_categories SET is_delete=1
                 WHERE product_category_group_id=? AND is_delete=0`, [g.group_id]);
            stat.hidden += del.affectedRows;
        }
    }

    if (DRY) {
        console.log(`[property][dry-run] 속성그룹 ${stat.propGroups}, 속성값 ${stat.props}, 링크 예상 ${stat.dryLinks} (facet 카테고리 soft-delete는 실행 시)`);
    } else {
        console.log(`[property] 신규 속성그룹 ${stat.propGroups}, 신규 속성값 ${stat.props}, 신규 링크 ${stat.links}, 트리에서 숨긴 facet 카테고리 ${stat.hidden}`);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
const run = async () => {
    console.log(`카테고리 정규화 백필 시작 — phase=${PHASE} brand=${BRAND ?? 'ALL'} dry=${DRY} force=${FORCE}`);
    await precheck();
    if (PHASE === 'tree' || PHASE === 'all') await backfillTree();
    if (PHASE === 'property' || PHASE === 'all') await backfillProperty();

    // 단계 이행 플래그: 해당 브랜드를 단일트리로 전환(shop.controller 가 읽음).
    //  'all'(트리+속성 전부) 완료 + 비 dry-run 에만 설정. tree/property 단독 실행 시엔 부분이라 미설정.
    if (!DRY && PHASE === 'all') {
        let brandIds;
        if (BRAND != null) {
            brandIds = [BRAND];
        } else {
            const [rows] = await readPool.query(`SELECT DISTINCT brand_id FROM _mig_group_role WHERE is_reviewed=1`);
            brandIds = rows.map((r) => r.brand_id).filter((v) => v != null);
        }
        for (const bid of brandIds) {
            await writePool.query(`UPDATE brands SET is_category_migrated=1 WHERE id=?`, [bid]);
        }
        console.log(`[flag] is_category_migrated=1 설정: ${brandIds.length}개 브랜드 (${brandIds.join(',')})`);
    }

    console.log('DONE. 이후 migrations SQL 의 Phase 6 검증쿼리(V1~V6)를 실행해 무결성을 확인하세요.');
    process.exit(0);
};

run().catch((e) => { console.error(e); process.exit(1); });
