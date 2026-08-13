import { readPool, writePool } from "../config/db-pool.js";
import { encField, decField } from "./pii.js";
import { settingLangs } from "./util.js";

// 상품 추가 입력항목 — 손님이 직접 적는 칸(행사날짜·각인문구 등).
//
// 소속이 두 겹이다:
//   order_form_templates/fields   본사 마스터가 만드는 **템플릿**. 그 자체로는 아무 화면에도 안 뜬다.
//   product_order_form_fields     상품에 실제로 걸린 항목. 손님이 보는 건 이것뿐이다.
//
// 왜 나눴나: 상품 100개에 '행사날짜'를 하나씩 손으로 넣는 건 말이 안 된다.
// 마스터가 만든 템플릿을 가맹점이 상품에서 *불러오기* 하면 내용이 **복사**된다.
// 참조가 아니라 복사여야 한다 — 마스터가 템플릿을 고쳤다고 이미 판매 중인 상품의
// 입력칸이 말없이 바뀌면, 접수된 주문과 뜻이 어긋난다.
//
// (예전에는 가맹점 단위로 서식 하나를 걸었다. 행사날짜는 가맹점의 성질이 아니라
//  상품의 성질이라 답례품만 사는 손님에게도 행사날짜를 물어보는 문제가 있었다.)

// 값에 개인정보가 들어가는 유형. 저장할 때 암호화하고 읽을 때 되돌린다.
//
// 왜 유형으로 가르나: 라벨은 가맹점이 자유롭게 쓰므로 이름으로는 판별할 수 없다
// ('현장 연락처'/'담당자 번호'/'비상연락망'…). 유형은 항목을 만들 때 정해지므로 확실하다.
// ⚠ 전부 암호화하면 관리자 주문목록에서 행사일로 찾는 것조차 막힌다 — 필요한 것만 건다.
export const PII_FIELD_TYPES = ['tel', 'address'];

// 상품 여러 개의 입력항목을 한 번에 읽는다. { [product_id]: [field, ...] }
//
// 테이블이 없어도(코드가 마이그레이션보다 먼저 배포돼도) 던지지 않는다 —
// 여기서 던지면 상품 상세 응답이 통째로 실패해 **몰이 죽는다**.
// 입력칸이 안 뜨는 건 되돌릴 수 있는 문제고, 몰이 죽는 건 아니다.
export const getOrderFormFieldsForProducts = async (product_ids = []) => {
    const ids = [...new Set((product_ids ?? []).map((v) => Number(v) || 0).filter(Boolean))];
    if (!ids.length) return {};
    try {
        const ph = ids.map(() => '?').join(',');
        const [rows] = await readPool.query(
            `SELECT * FROM product_order_form_fields
              WHERE product_id IN (${ph}) AND is_delete=0
              ORDER BY sort ASC, id ASC`, ids);
        const byProduct = {};
        for (const id of ids) byProduct[id] = [];
        for (const f of rows) {
            byProduct[f.product_id]?.push({ ...f, lang_obj: safeParse(f.lang_obj) });
        }
        return byProduct;
    } catch (e) {
        console.error('product_order_form_fields 조회 실패(무시하고 진행):', e?.sqlMessage || e?.message || e);
        return {};
    }
};

const safeParse = (v) => { try { return JSON.parse(v ?? '{}'); } catch (e) { return {}; } };

// 상품 하나의 입력항목.
export const getOrderFormFieldsForProduct = async (product_id) =>
    (await getOrderFormFieldsForProducts([product_id]))[Number(product_id) || 0] ?? [];

// 마스터가 만든 템플릿 목록(+항목). 가맹점 상품등록 화면의 '불러오기'가 쓴다.
export const getOrderFormTemplates = async (master_brand_id) => {
    const id = Number(master_brand_id) || 0;
    if (!id) return [];
    try {
        const [tpls] = await readPool.query(
            `SELECT id, name, guide FROM order_form_templates
              WHERE brand_id=? AND is_delete=0 AND is_use=1 ORDER BY id DESC`, [id]);
        if (!tpls.length) return [];
        const ph = tpls.map(() => '?').join(',');
        const [fields] = await readPool.query(
            `SELECT * FROM order_form_fields
              WHERE template_id IN (${ph}) AND is_delete=0 ORDER BY sort ASC, id ASC`,
            tpls.map((t) => t.id));
        return tpls.map((t) => ({ ...t, fields: fields.filter((f) => f.template_id === t.id) }));
    } catch (e) {
        console.error('order_form 템플릿 조회 실패(무시하고 진행):', e?.sqlMessage || e?.message || e);
        return [];
    }
};

// 상품에 걸린 입력항목을 저장한다(상품등록 화면).
//
// 유형은 화이트리스트로 막는다 — DB 에 아무 문자열이나 들어가면 화면이 그리지 못하고
// 조용히 'text' 로 폴백해, 행사날짜가 달력 없는 자유 입력이 된다.
export const FIELD_TYPES = [
    'text', 'textarea', 'number', 'date', 'time', 'datetime',
    'select', 'multiselect', 'tel', 'address', 'agree', 'file',
];

export const saveProductOrderFormFields = async (product_id, fields = [], brand = null) => {
    const pid = Number(product_id) || 0;
    if (!pid) return false;
    const list = Array.isArray(fields) ? fields : [];
    // 번역 대기열에 넣을 항목(라벨·도움말). 스케줄러가 1분마다 비운다.
    // 안 넣으면 '행사일' 이 외국어 화면에서 한국어로 남는다.
    const 번역대상 = [];

    const 숫자 = (v) => (v === '' || v === null || v === undefined || isNaN(parseInt(v)) ? null : parseInt(v));
    for (let i = 0; i < list.length; i++) {
        const f = list[i];
        const id = Number(f?.id) || 0;
        if (f?.is_delete == 1) {
            // 지워도 행은 남긴다 — 이미 접수된 주문의 값(transaction_order_forms)이 이 id 를 가리킨다.
            if (id) await writePool.query(`UPDATE product_order_form_fields SET is_delete=1 WHERE id=? AND product_id=?`, [id, pid]);
            continue;
        }
        if (!String(f?.label ?? '').trim()) continue; // 이름 없는 항목은 저장하지 않는다
        const 값 = {
            label: String(f.label).slice(0, 60),
            field_type: FIELD_TYPES.includes(f?.field_type) ? f.field_type : 'text',
            placeholder: f?.placeholder ?? null,
            is_required: f?.is_required ? 1 : 0,
            sort: isNaN(parseInt(f?.sort)) ? i : parseInt(f.sort),
            option_list: f?.option_list ?? null,
            max_length: 숫자(f?.max_length),
            min_number: 숫자(f?.min_number),
            max_number: 숫자(f?.max_number),
            lead_days: 숫자(f?.lead_days),
            max_days: 숫자(f?.max_days),
        };
        const 키 = Object.keys(값);
        if (id) {
            await writePool.query(
                `UPDATE product_order_form_fields SET ${키.map((k) => `${k}=?`).join(',')}, is_delete=0 WHERE id=? AND product_id=?`,
                [...키.map((k) => 값[k]), id, pid]);
            번역대상.push({ id, 값 });
        } else {
            const [r] = await writePool.query(
                `INSERT INTO product_order_form_fields (product_id, ${키.join(',')}) VALUES (?, ${키.map(() => '?').join(',')})`,
                [pid, ...키.map((k) => 값[k])]);
            if (r?.insertId) 번역대상.push({ id: r.insertId, 값 });
        }
    }

    // 번역은 큐에 담고 스케줄러가 처리한다(여기서 구글을 부르면 저장이 수 초 멈춘다).
    // 언어팩이 꺼진 브랜드면 settingLangs 가 알아서 아무것도 안 한다.
    if (brand?.id && 번역대상.length) {
        try {
            for (const t of 번역대상) {
                await settingLangs(['label', 'placeholder'], t.값, brand, 'product_order_form_fields', t.id);
            }
        } catch (e) {
            console.error('입력항목 번역 대기열 적재 실패(저장은 완료됨):', e?.sqlMessage || e?.message || e);
        }
    }
    return true;
};

// 고객이 낸 값을 주문 **줄마다** 붙여 저장한다.
//
// 입력을 상품상세에서 받으므로 값은 장바구니 줄에 실려 온다(products[i].order_form_values).
// 날짜가 다른 두 상품을 한 번에 담아도 각각 남는다.
//
// ⚠ 값을 그대로 믿지 않는다. **그 상품에 실제로 걸린 항목만** 저장하고,
//   라벨·유형은 서버가 가진 것을 스냅샷으로 넣는다.
//   프론트가 보낸 라벨을 그대로 쓰면 주문 내역을 위조할 수 있다.
export const saveOrderFormValues = async (trans_id, products) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    const lines = Array.isArray(products) ? products : [];
    if (!lines.length) return false;

    const byProduct = await getOrderFormFieldsForProducts(lines.map((p) => p?.id));
    const rows = [];
    lines.forEach((p, line_index) => {
        const fields = byProduct[Number(p?.id) || 0] ?? [];
        if (!fields.length) return;
        const 값 = (p?.order_form_values && typeof p.order_form_values === 'object') ? p.order_form_values : {};
        fields.forEach((f, idx) => {
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

// 결제로 넘어가기 전, 필수 항목이 다 찼는지 **서버가** 다시 본다.
// 프론트 검사는 우회할 수 있다 — 행사날짜 없는 예약주문이 들어오면 업체가 전화를 돌려야 한다.
// 채워야 할 항목 이름을 돌려준다(다 찼으면 null).
export const findMissingOrderFormField = async (products = []) => {
    const lines = Array.isArray(products) ? products : [];
    if (!lines.length) return null;
    const byProduct = await getOrderFormFieldsForProducts(lines.map((p) => p?.id));
    for (const p of lines) {
        const fields = byProduct[Number(p?.id) || 0] ?? [];
        const 값 = (p?.order_form_values && typeof p.order_form_values === 'object') ? p.order_form_values : {};
        for (const f of fields) {
            if (!f?.is_required) continue;
            const v = 값[String(f.id)];
            if (f.field_type === 'agree') {
                if (v !== true && v !== 1 && v !== '1' && v !== 'Y') return f.label;
                continue;
            }
            if (Array.isArray(v)) { if (!v.length) return f.label; continue; }
            if (v === undefined || v === null || !String(v).trim()) return f.label;
        }
    }
    return null;
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
