import { readPool, writePool } from "../config/db-pool.js";
import { encField, decField } from "./pii.js";

// 주문서 추가 입력항목 — 조회·저장 공용 로직.
//
// 서식은 본사 마스터만 만들고, 적용받을 가맹점을 지정한다(order_form_targets).
// 고객 주문서는 자기 브랜드에 걸린 서식 하나를 받아 입력칸을 그린다.

// 값에 개인정보가 들어가는 유형. 저장할 때 암호화하고 읽을 때 되돌린다.
//
// 왜 유형으로 가르나: 라벨은 본사가 자유롭게 쓰므로 이름으로는 판별할 수 없다
// ('현장 연락처'/'담당자 번호'/'비상연락망'…). 유형은 서식을 만들 때 정해지므로 확실하다.
// ⚠ 전부 암호화하면 관리자 주문목록에서 행사일로 찾는 것조차 막힌다 — 필요한 것만 건다.
export const PII_FIELD_TYPES = ['tel', 'address'];

// 이 브랜드에 적용된 서식 하나(+항목들)를 돌려준다. 없으면 null.
//
// 여러 서식이 걸려 있으면 가장 최근 것 하나만 쓴다. 주문서에 두 벌을 그리면
// 고객이 같은 걸 두 번 입력하게 된다 — 운영 실수를 화면에서 막아준다.
export const getOrderFormForBrand = async (brand_id) => {
    const id = Number(brand_id) || 0;
    if (!id) return null;
    try {
        return await 서식조회(id);
    } catch (e) {
        // ⚠ 여기서 던지면 스토어프론트 setting 응답이 통째로 실패해 **모든 가맹점 몰이 죽는다**.
        //   특히 마이그레이션 전에 코드가 먼저 배포되면 테이블이 없어 매 요청이 터진다
        //   (배포 순서를 사람이 지켜야 하는 구조를 코드로 막는다).
        //   서식을 못 읽으면 입력칸이 안 뜰 뿐이고, 그건 되돌릴 수 있는 문제다.
        console.error('order_form 조회 실패(무시하고 진행):', e?.sqlMessage || e?.message || e);
        return null;
    }
};

const 서식조회 = async (id) => {
    const rows = await readPool.query(
        `SELECT t.id, t.name, t.guide
           FROM order_form_targets g
           LEFT JOIN order_form_templates t ON g.template_id = t.id
          WHERE g.brand_id = ? AND g.is_delete = 0
            AND t.is_delete = 0 AND t.is_use = 1
          ORDER BY t.id DESC
          LIMIT 1`,
        [id]
    );
    const tpl = rows[0][0];
    if (!tpl?.id) return null;

    const found = await readPool.query(
        `SELECT * FROM order_form_fields WHERE template_id = ? AND is_delete = 0 ORDER BY sort ASC, id ASC`,
        [tpl.id]
    );
    const fields = found[0].map((f) => ({ ...f, lang_obj: JSON.parse(f?.lang_obj ?? '{}') }));
    if (!fields.length) return null; // 항목이 없으면 그릴 것도 없다

    return { ...tpl, fields };
};

// 고객이 낸 값을 주문 **줄마다** 붙여 저장한다.
//
// 입력을 상품상세에서 받으므로 값은 장바구니 줄에 실려 온다(products[i].order_form_values).
// 날짜가 다른 두 상품을 한 번에 담아도 각각 남는다 — 주문서에서 한 번만 받던 때는 불가능했다.
//
// ⚠ 값을 그대로 믿지 않는다. 서식에 있는 항목만 저장하고, 라벨·유형은 **서버가 가진 것**을
//   스냅샷으로 넣는다. 프론트가 보낸 라벨을 그대로 쓰면 주문 내역을 위조할 수 있다.
export const saveOrderFormValues = async (trans_id, brand_id, products) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    if (!Array.isArray(products) || !products.length) return false;
    const form = await getOrderFormForBrand(brand_id);
    if (!form) return false;

    const rows = [];
    products.forEach((p, line_index) => {
        const 값 = (p?.order_form_values && typeof p.order_form_values === 'object') ? p.order_form_values : {};
        form.fields.forEach((f, idx) => {
            let v = 값[String(f.id)];
            if (Array.isArray(v)) v = v.join(', '); // multiselect
            if (v === true) v = 'Y';                // 동의 체크
            v = v === undefined || v === null || v === false ? '' : String(v);
            if (!v.trim()) return; // 빈 값은 남기지 않는다(선택 항목을 안 채운 것)
            rows.push([
                tid,
                Number(p?.id) || null,
                line_index,
                f.id,
                f.label,
                f.field_type,
                PII_FIELD_TYPES.includes(f.field_type) ? encField(v) : v,
                idx,
            ]);
        });
    });
    if (!rows.length) return false;

    await writePool.query(
        `INSERT INTO transaction_order_forms (trans_id, product_id, line_index, field_id, label, field_type, value, sort) VALUES ?`,
        [rows]
    );
    return true;
};

// 관리자 화면에서 보여줄 때 — 암호화된 값을 되돌린다.
// decField 는 평문/암호문을 자동 판별하므로 옛 행이 섞여 있어도 안전하다.
export const getOrderFormValues = async (trans_id) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return [];
    const rows = await readPool.query(
        `SELECT * FROM transaction_order_forms WHERE trans_id = ? ORDER BY sort ASC, id ASC`,
        [tid]
    );
    return rows[0].map((r) => ({
        ...r,
        value: PII_FIELD_TYPES.includes(r.field_type) ? decField(r.value) : r.value,
    }));
};
