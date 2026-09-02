'use strict';
import { deleteQuery, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, lowLevelException, response, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { invalidateAllShopSettingCache } from "../utils.js/cache.js";
import { readPool } from "../config/db-pool.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { getOrderFormTemplates } from "../utils.js/order-form.js";

const table_name = 'order_form_templates';
const field_table = 'order_form_fields';
const target_table = 'order_form_targets';

// 주문서 추가 입력항목 서식 — 본사 마스터 전용.
//
// 예약·출장 업체가 주문 시 행사일·행사장소 등을 받아야 하는데, 지금은 그럴 방법이 없다.
// 서식을 본사가 만들고 어느 가맹점에 적용할지 지정한다(가맹점은 만들지도 고르지도 않는다).
//
// 권한 판정은 혜택 안내와 같은 규칙이다 — 레벨 숫자만 보면 가맹점 관리자도 통과하므로
// 브랜드가 마스터인지 함께 본다. (레벨 50 으로 걸었다가 본사 운영자가 레벨 40 이라 막혔던 적 있다)
const 본사관리자 = (decode_user, decode_dns) => {
    if (!decode_user || Number(decode_user?.level) < 40) return 0;
    if (Number(decode_dns?.is_main_dns) !== 1) return 0;
    return Number(decode_dns?.id) || 0;
};

// 화면이 보내는 유형 중 우리가 아는 것만 저장한다.
// 모르는 유형이 들어오면 주문서가 그릴 방법이 없어 입력칸이 통째로 사라진다.
const FIELD_TYPES = [
    'text', 'textarea', 'number', 'date', 'time', 'datetime',
    'select', 'multiselect', 'tel', 'address', 'agree', 'file',
];

const 서식가져오기 = async (template_id) => {
    const rows = await readPool.query(
        `SELECT * FROM ${table_name} WHERE id=? AND is_delete=0`, [template_id]
    );
    return rows[0][0];
};

const orderFormCtrl = {
    // 목록 — 항목과 적용 가맹점까지 붙여서 한 번에 준다(서식 수가 적다).
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) return lowLevelException(req, res);

            let rows = await readPool.query(
                `SELECT * FROM ${table_name} WHERE brand_id=? AND is_delete=0 ORDER BY id DESC`, [brand_id]
            );
            rows = rows[0];
            if (rows.length > 0) {
                const ids = rows.map((r) => r.id);
                const ph = ids.map(() => '?').join();
                const f = await readPool.query(
                    `SELECT * FROM ${field_table} WHERE template_id IN (${ph}) AND is_delete=0 ORDER BY sort ASC, id ASC`, ids
                );
                // 적용 가맹점은 도메인까지 붙여 준다 — 화면에서 id 만 보이면 어느 몰인지 알 수 없다.
                const t = await readPool.query(
                    `SELECT g.*, b.dns, b.name AS brand_name
                       FROM ${target_table} g LEFT JOIN brands b ON g.brand_id=b.id
                      WHERE g.template_id IN (${ph}) AND g.is_delete=0`, ids
                );
                for (const row of rows) {
                    row.fields = f[0].filter((x) => x.template_id === row.id)
                        .map((x) => ({ ...x, lang_obj: JSON.parse(x?.lang_obj ?? '{}') }));
                    row.targets = t[0].filter((x) => x.template_id === row.id);
                }
            }
            return response(req, res, 100, "success", { content: rows });
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    // 적용 대상으로 고를 수 있는 가맹점 목록(본사 산하만).
    merchants: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) return lowLevelException(req, res);
            const rows = await readPool.query(
                `SELECT id, dns, name FROM brands WHERE parent_id=? AND is_delete=0 ORDER BY dns ASC`, [brand_id]
            );
            return response(req, res, 100, "success", { content: rows[0] });
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    // 가맹점 상품등록 화면의 '서식 불러오기'용 — 본사가 만든 템플릿을 읽기만 한다.
    //
    // 이 하나만 마스터가 아니어도 열려 있다. 상품 100개에 '행사날짜'를 손으로 넣는 건
    // 말이 안 되므로, 본사가 만든 서식을 가맹점이 상품에 **복사해** 붙일 수 있어야 한다.
    // (복사한 뒤에는 상품의 것이다 — 본사가 템플릿을 고쳐도 판매 중인 상품은 안 바뀐다)
    templates: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 가맹점 관리자 이상이면 읽을 수 있다. 고객에게는 열지 않는다.
            if (!decode_user || Number(decode_user?.level) < 10) return lowLevelException(req, res);
            // 소유자는 항상 본사다. 가맹점이면 부모, 본사 자신이면 자기 id.
            const owner = Number(decode_dns?.parent_id) > 0
                ? Number(decode_dns.parent_id)
                : Number(decode_dns?.id) || 0;
            return response(req, res, 100, "success", { content: await getOrderFormTemplates(owner) });
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) return lowLevelException(req, res);

            const { name, guide, is_use, fields, targets } = req.body;
            const obj = {
                brand_id,
                name: name || '새 서식',
                guide: guide ?? null,
                is_use: Number(is_use) === 0 ? 0 : 1,
            };
            const result = await insertQuery(table_name, obj);
            const template_id = result?.insertId;
            await 항목저장(template_id, fields, decode_dns);
            await 대상저장(template_id, targets);
            await invalidateAllShopSettingCache();
            return response(req, res, 100, "success", template_id);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    update: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) return lowLevelException(req, res);

            const { id } = req.params;
            const before = await 서식가져오기(id);
            if (!before || Number(before.brand_id) !== brand_id) return lowLevelException(req, res);

            const { name, guide, is_use, fields, targets } = req.body;
            await updateQuery(table_name, {
                name: name || '새 서식',
                guide: guide ?? null,
                is_use: Number(is_use) === 0 ? 0 : 1,
            }, id);
            await 항목저장(id, fields, decode_dns);
            await 대상저장(id, targets);
            await invalidateAllShopSettingCache();
            return response(req, res, 100, "success", id);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    remove: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) return lowLevelException(req, res);

            const { id } = req.params;
            const before = await 서식가져오기(id);
            if (!before || Number(before.brand_id) !== brand_id) return lowLevelException(req, res);

            await deleteQuery(table_name, { id }); // 스칼라로 넘기면 WHERE 가 비어 아무것도 안 지워졌다
            // 항목·적용대상도 함께 내린다. 남겨두면 같은 template_id 로 새 서식을 만들 때 되살아난다.
            // ⚠ 이미 접수된 주문의 입력값(transaction_order_forms)은 건드리지 않는다 —
            //   주문 내역은 서식이 없어져도 그대로 남아야 한다.
            await readPool.query(`UPDATE ${field_table} SET is_delete=1 WHERE template_id=?`, [id]);
            await readPool.query(`UPDATE ${target_table} SET is_delete=1 WHERE template_id=?`, [id]);
            await invalidateAllShopSettingCache();
            return response(req, res, 100, "success", id);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
};

// 항목은 통째로 갈아끼운다(혜택 안내 탭과 같은 이유 — 순서 변경을 id 로 맞추면 화면이 복잡해진다).
// ⚠ 갈아끼우면 항목 id 가 바뀌지만, 접수된 주문은 라벨·유형을 스냅샷으로 갖고 있어 영향이 없다.
async function 항목저장(template_id, fields, decode_dns) {
    if (!template_id || !Array.isArray(fields)) return;
    await readPool.query(`UPDATE ${field_table} SET is_delete=1 WHERE template_id=?`, [template_id]);
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i] || {};
        if (!String(f.label ?? '').trim()) continue; // 이름 없는 칸은 고객이 무엇을 적을지 알 수 없다
        const type = FIELD_TYPES.includes(f.field_type) ? f.field_type : 'text';
        const obj = {
            template_id,
            label: f.label,
            field_type: type,
            placeholder: f.placeholder ?? null,
            is_required: Number(f.is_required) === 1 ? 1 : 0,
            sort: i,
            option_list: ['select', 'multiselect'].includes(type) ? (f.option_list ?? '') : null,
            max_length: 숫자또는null(f.max_length),
            min_number: 숫자또는null(f.min_number),
            max_number: 숫자또는null(f.max_number),
            lead_days: 숫자또는null(f.lead_days),
            max_days: 숫자또는null(f.max_days),
        };
        const result = await insertQuery(field_table, obj);
        await settingLangs(lang_obj_columns[field_table], obj, decode_dns, field_table, result?.insertId);
    }
}

async function 대상저장(template_id, targets) {
    if (!template_id || !Array.isArray(targets)) return;
    await readPool.query(`UPDATE ${target_table} SET is_delete=1 WHERE template_id=?`, [template_id]);
    for (const t of targets) {
        const bid = Number(t?.brand_id ?? t) || 0;
        if (!bid) continue;
        await insertQuery(target_table, {
            template_id,
            brand_id: bid,
            // 지금 화면에서는 카테고리를 고르게 하지 않는다. 컬럼만 미리 둔 자리다.
            category_ids: t?.category_ids ? JSON.stringify(t.category_ids) : null,
        });
    }
}

const 숫자또는null = (v) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));

export default orderFormCtrl;
