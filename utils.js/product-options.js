import { readPool, writePool } from "../config/db-pool.js";
import { isTruthyFlag, settingLangs } from "./util.js";

// 상품 옵션 — 선택옵션 / 추가상품 / 조합형 / 재고 공용 로직.
//
// 용어 (네이버 스마트스토어·카페24와 같은 뜻으로 맞췄다):
//   선택옵션 group_type=0  골라야 산다. 그룹마다 1개.            색상 · 사이즈
//   추가상품 group_type=1  안 골라도 산다. 여러 개 고를 수 있다.  한복 +10,000
//   조합형   option_mode=1 옵션 조합마다 가격·재고가 따로 있다.   분홍/M +5,000
//
// 재고는 NULL 이 '무제한'이다. 0 이 아니다 —
// 0 을 기본값으로 뒀다면 마이그레이션 직후 전 상품이 품절이 된다.

export const 선택옵션 = 0;
export const 추가상품 = 1;

// 조합 키 — 고른 옵션 id 를 **오름차순 정렬해** 하이픈으로 잇는다.
// 정렬하지 않으면 '101-205' 와 '205-101' 이 다른 조합으로 갈려 재고가 두 벌이 된다.
export const comboKey = (optionIds = []) =>
    [...new Set((optionIds ?? []).map((v) => Number(v) || 0).filter(Boolean))]
        .sort((a, b) => a - b)
        .join('-');

// 주문 줄에 실려 온 groups 에서 고른 옵션 id 만 뽑는다.
// 프론트 저장 형태: groups[i].options[j] = { id, option_name, option_price, ... }
// 문자열 옵션(특성 잔재)은 id 가 없으므로 걸러진다 — 재고 대상이 아니다.
export const pickedOptionIds = (groups) => {
    const list = Array.isArray(groups) ? groups : [];
    const ids = [];
    for (const g of list) {
        for (const o of (Array.isArray(g?.options) ? g.options : [])) {
            const id = Number(o?.id) || 0;
            if (id) ids.push(id);
        }
    }
    return [...new Set(ids)];
};

// 상품 여러 개의 옵션 묶음을 한 번에 읽는다(스토어프론트 상세·목록용).
// 상품마다 쿼리를 돌리면 목록 화면에서 N+1 이 된다.
export const getOptionsForProducts = async (product_ids = []) => {
    const ids = [...new Set((product_ids ?? []).map((v) => Number(v) || 0).filter(Boolean))];
    if (!ids.length) return {};
    const ph = ids.map(() => '?').join(',');

    const [groups] = await readPool.query(
        `SELECT * FROM product_option_groups
          WHERE product_id IN (${ph}) AND is_delete=0
          ORDER BY group_type ASC, sort ASC, id ASC`, ids);
    const group_ids = groups.map((g) => g.id);

    let options = [];
    if (group_ids.length) {
        const gph = group_ids.map(() => '?').join(',');
        const [rows] = await readPool.query(
            `SELECT * FROM product_options
              WHERE group_id IN (${gph}) AND is_delete=0
              ORDER BY sort ASC, id ASC`, group_ids);
        options = rows;
    }

    const [combos] = await readPool.query(
        `SELECT * FROM product_option_combinations
          WHERE product_id IN (${ph}) AND is_delete=0`, ids);

    const byProduct = {};
    for (const id of ids) byProduct[id] = { groups: [], combinations: [] };
    for (const g of groups) {
        byProduct[g.product_id]?.groups.push({
            ...g,
            lang_obj: safeParse(g.lang_obj),
            options: options
                .filter((o) => o.group_id === g.id)
                .map((o) => ({ ...o, lang_obj: safeParse(o.lang_obj) })),
        });
    }
    for (const c of combos) byProduct[c.product_id]?.combinations.push(c);
    return byProduct;
};

const safeParse = (v) => { try { return JSON.parse(v ?? '{}'); } catch (e) { return {}; } };

// ── 저장 ────────────────────────────────────────────────────────────────────
//
// create 와 update 가 **같은 함수**를 쓴다.
// 예전에는 두 갈래에 비슷한 코드가 따로 있어서, 한쪽에만 컬럼을 추가하면
// '새로 만들 땐 되는데 수정하면 사라지는' 종류의 버그가 생겼다.

const 정수 = (v, 기본 = 0) => (isNaN(parseInt(v)) ? 기본 : parseInt(v));

// 돈·수량은 **음수가 될 수 없다.**
//
// [왜 서버에서 막나]
// 관리자 화면이 음수를 안 받게 해도 그건 안내일 뿐이다. 요청은 화면을 거치지 않고도 보낼 수 있다.
// 옵션 변동가가 음수면 손님이 그 옵션을 고르는 것만으로 결제금액이 깎인다 —
// 결제 재계산(pay.controller recalcOrderAmount)은 **DB 의 옵션 가격을 그대로 믿기** 때문에
// 금액 위조를 막는 그 방어를 이 값 하나로 우회할 수 있다.
// (그 파일 주석에도 '관리자 폼이 음수 변동가를 막지 않는다' 고 적혀 있었다 — 여기서 막는다.)
//
// 조합 변동가(add_price)도 같은 경로로 금액에 더해진다.
const 음수없는정수 = (v, 기본 = 0) => Math.max(0, 정수(v, 기본));

// 재고칸을 비우면 '무제한'이다. 0 으로 접으면 저장하는 순간 품절이 된다.
// 음수 재고는 뜻이 없다 — 0(품절)으로 접는다.
const 재고 = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = parseInt(v);
    return isNaN(n) ? null : Math.max(0, n);
};

// 켜짐/꺼짐 값. **그냥 `v ? 1 : 0` 을 쓰면 안 된다.**
//
// 상품 저장은 multipart/form-data 다(프론트 api.js 가 object-to-formdata 로 직렬화한다).
// 그래서 서버에 닿을 땐 **모든 값이 문자열**이다 — 꺼 둔 스위치는 0 이 아니라 "0" 으로 온다.
// 자바스크립트에서 문자열 "0" 은 참이므로 `o?.is_soldout ? 1 : 0` 은 **항상 1** 이 된다.
// 실제로 이 때문에 새로 만든 상품의 옵션이 전부 품절로 저장됐다(2026-08-18 확인).
//
// 조합(combinations)은 JSON 문자열로 따로 실려 와 숫자로 되살아나므로 증상이 없었다.
// 그 차이가 곧 원인이었다 — 같은 코드인데 한쪽만 틀렸다.
//
// 같은 사고가 배송지 is_default(모든 배송지가 '기본'이 됐다)와
// 회원목록 is_user(운영자 계정이 안 보였다)에서도 났다. 그래서 판정을 한 곳(util.js)에 둔다.
const 켜짐 = (v) => (isTruthyFlag(v) ? 1 : 0);

// 옵션그룹 + 옵션 저장. 화면이 보낸 is_delete=1 을 소프트 삭제로 처리한다.
// 돌려주는 값: { [group_name]: { id, options: { [option_name]: id } } } — 조합 해석에 쓴다.
//
// brand 를 넘겨야 옵션 이름이 번역 대기열에 실린다(언어팩 켠 몰만).
// 안 넘기면 외국어 화면에서 '장판 : 블랙' 처럼 옵션만 한국어로 남는다 —
// 표시 쪽은 이미 formatLang 을 거치고 product_options·product_option_groups 도
// 번역 대상 목록에 있는데, **저장할 때 대기열에 넣는 고리만 없었다.**
// 주문서 입력항목(saveProductOrderFormFields)이 쓰는 방식과 같다.
export const saveOptionGroups = async (product_id, groups = [], brand = null) => {
    const pid = Number(product_id) || 0;
    const 이름표 = {};
    if (!pid) return 이름표;

    // 번역 대기열에 넣을 것. 스케줄러가 1분마다 비운다.
    const 번역대상 = [];
    // 이름이 그대로면 다시 번역하지 않는다.
    //
    // 상품 하나에 옵션이 수십 개인 몰이 있다. 저장할 때마다 전부 다시 담으면
    // 고치지도 않은 이름을 매번 번역기에 보내게 되고, 번역 API 는 호출이 몰리면 막힌다
    // (lang-process 에 429 차단 처리가 따로 있을 만큼 겪은 일이다).
    const 옛그룹이름 = {};
    const 옛옵션이름 = {};
    if (brand?.id) {
        const [gs] = await readPool.query(
            `SELECT id, group_name FROM product_option_groups WHERE product_id=?`, [pid]);
        for (const g of gs) 옛그룹이름[g.id] = g.group_name;
        const [os] = await readPool.query(
            `SELECT o.id, o.option_name FROM product_options o
               LEFT JOIN product_option_groups g ON o.group_id = g.id
              WHERE g.product_id=?`, [pid]);
        for (const o of os) 옛옵션이름[o.id] = o.option_name;
    }

    for (let i = 0; i < (Array.isArray(groups) ? groups.length : 0); i++) {
        const g = groups[i];
        const gid = Number(g?.id) || 0;
        if (g?.is_delete == 1) {
            if (gid) {
                await writePool.query(`UPDATE product_option_groups SET is_delete=1 WHERE id=? AND product_id=?`, [gid, pid]);
                await writePool.query(`UPDATE product_options SET is_delete=1 WHERE group_id=?`, [gid]);
            }
            continue;
        }
        if (!String(g?.group_name ?? '').trim()) continue; // 이름 없는 그룹은 저장하지 않는다

        const 그룹값 = {
            group_name: g.group_name,
            group_type: 정수(g?.group_type, 0),
            // 추가상품은 여러 개 고를 수 있다. 선택옵션은 그룹당 하나다.
            is_able_duplicate_select: 정수(g?.group_type, 0) === 추가상품 ? 1 : 0,
            group_description: g?.group_description ?? '',
            sort: 정수(g?.sort, i),
        };

        let group_id = gid;
        if (group_id) {
            const 키 = Object.keys(그룹값);
            await writePool.query(
                `UPDATE product_option_groups SET ${키.map((k) => `${k}=?`).join(',')} WHERE id=? AND product_id=?`,
                [...키.map((k) => 그룹값[k]), group_id, pid]);
        } else {
            const [r] = await writePool.query(
                `INSERT INTO product_option_groups (product_id, group_name, group_type, is_able_duplicate_select, group_description, sort)
                 VALUES (?,?,?,?,?,?)`,
                [pid, 그룹값.group_name, 그룹값.group_type, 그룹값.is_able_duplicate_select, 그룹값.group_description, 그룹값.sort]);
            group_id = r?.insertId;
        }
        if (!group_id) continue;
        if (옛그룹이름[group_id] !== 그룹값.group_name) {
            번역대상.push({ 표: 'product_option_groups', id: group_id, 값: { group_name: 그룹값.group_name } });
        }

        이름표[그룹값.group_name] = { id: group_id, type: 그룹값.group_type, options: {} };

        const options = Array.isArray(g?.options) ? g.options : [];
        for (let j = 0; j < options.length; j++) {
            const o = options[j];
            const oid = Number(o?.id) || 0;
            if (o?.is_delete == 1) {
                if (oid) await writePool.query(`UPDATE product_options SET is_delete=1 WHERE id=? AND group_id=?`, [oid, group_id]);
                continue;
            }
            if (!String(o?.option_name ?? '').trim()) continue;
            const 옵션값 = {
                option_name: o.option_name,
                option_price: 음수없는정수(o?.option_price, 0),
                option_description: o?.option_description ?? '',
                stock_qty: 재고(o?.stock_qty),
                is_soldout: 켜짐(o?.is_soldout),
                sort: 정수(o?.sort, j),
            };
            let option_id = oid;
            if (option_id) {
                const 키 = Object.keys(옵션값);
                await writePool.query(
                    `UPDATE product_options SET ${키.map((k) => `${k}=?`).join(',')} WHERE id=? AND group_id=?`,
                    [...키.map((k) => 옵션값[k]), option_id, group_id]);
            } else {
                const [r] = await writePool.query(
                    `INSERT INTO product_options (group_id, option_name, option_price, option_description, stock_qty, is_soldout, sort)
                     VALUES (?,?,?,?,?,?,?)`,
                    [group_id, 옵션값.option_name, 옵션값.option_price, 옵션값.option_description,
                     옵션값.stock_qty, 옵션값.is_soldout, 옵션값.sort]);
                option_id = r?.insertId;
            }
            if (!option_id) continue;
            if (옛옵션이름[option_id] !== 옵션값.option_name) {
                번역대상.push({ 표: 'product_options', id: option_id, 값: { option_name: 옵션값.option_name } });
            }
            이름표[그룹값.group_name].options[옵션값.option_name] = option_id;
        }
    }

    // 번역은 큐에 담고 스케줄러가 처리한다 — 여기서 번역기를 부르면 저장이 수 초 멈춘다.
    // 언어팩이 꺼진 브랜드면 settingLangs 가 알아서 아무것도 안 한다.
    // 실패해도 저장은 이미 끝났으므로 던지지 않는다(번역만 안 될 뿐이다).
    if (brand?.id && 번역대상.length) {
        try {
            for (const t of 번역대상) {
                await settingLangs(Object.keys(t.값), t.값, brand, t.표, t.id);
            }
        } catch (e) {
            console.error('옵션 번역 대기열 적재 실패(저장은 완료됨):', e?.sqlMessage || e?.message || e);
        }
    }
    return 이름표;
};

// 조합형 저장.
//
// 화면은 조합을 **이름으로** 보낸다: { option_names: ['분홍','M'], add_price, stock_qty }.
// id 로 보내면 새로 만든 옵션은 아직 id 가 없어(저장 전) 조합을 못 만든다.
// 이름 → id 는 방금 저장한 결과(이름표)로 푼다.
export const saveCombinations = async (product_id, combinations = [], 이름표 = {}) => {
    const pid = Number(product_id) || 0;
    if (!pid) return;
    const list = Array.isArray(combinations) ? combinations : [];

    // 그룹이 달라도 옵션 이름은 상품 안에서 유일하다고 본다(색상 '분홍' 과 사이즈 '분홍' 은 없다).
    const 전체옵션 = {};
    for (const g of Object.values(이름표)) {
        for (const [name, id] of Object.entries(g.options)) 전체옵션[name] = id;
    }

    const 살아있는 = [];
    for (const c of list) {
        const names = Array.isArray(c?.option_names) ? c.option_names : [];
        const ids = names.map((n) => 전체옵션[n]).filter(Boolean);
        if (ids.length !== names.length || !ids.length) continue; // 못 푼 조합은 건너뛴다
        const key = comboKey(ids);
        살아있는.push(key);
        await writePool.query(
            `INSERT INTO product_option_combinations (product_id, combo_key, add_price, stock_qty, is_soldout, is_delete)
             VALUES (?,?,?,?,?,0)
             ON DUPLICATE KEY UPDATE add_price=VALUES(add_price), stock_qty=VALUES(stock_qty),
                                     is_soldout=VALUES(is_soldout), is_delete=0`,
            [pid, key, 음수없는정수(c?.add_price, 0), 재고(c?.stock_qty), 켜짐(c?.is_soldout)]);
    }
    // 화면에서 사라진 조합은 내린다. 지우지 않고 내리는 이유는 지난 주문의 재고 복구 때문이다.
    if (살아있는.length) {
        const ph = 살아있는.map(() => '?').join(',');
        await writePool.query(
            `UPDATE product_option_combinations SET is_delete=1 WHERE product_id=? AND combo_key NOT IN (${ph})`,
            [pid, ...살아있는]);
    } else {
        await writePool.query(`UPDATE product_option_combinations SET is_delete=1 WHERE product_id=?`, [pid]);
    }
};

// ── 재고 ────────────────────────────────────────────────────────────────────
//
// 어디에 붙는가:
//   조합형        조합(product_option_combinations.stock_qty)
//   단독형 옵션   옵션(product_options.stock_qty)
//   옵션 없는 상품 상품(products.stock_qty)
//
// 추가상품 수량은 **상품 수량과 같다**. 돌상 2세트를 시키면 한복도 2벌이다.
// (수량을 따로 받게 하면 화면과 검증이 배로 늘고, 이 업종에서 쓸 일이 거의 없다)

// 주문 한 줄이 재고를 얼마나 쓰는지 계산한다. 실제 차감은 하지 않는다.
const 줄별차감 = async (line) => {
    const product_id = Number(line?.id) || 0;
    const count = Math.max(1, Number(line?.order_count) || 1);
    if (!product_id) return [];

    const [[product]] = await readPool.query(
        `SELECT id, option_mode, stock_qty FROM products WHERE id=?`, [product_id]);
    if (!product) return [];

    const ids = pickedOptionIds(line?.groups);

    // 조합형 — 고른 옵션 조합 하나가 재고 단위다.
    if (Number(product.option_mode) === 1 && ids.length) {
        const key = comboKey(ids);
        const [[combo]] = await readPool.query(
            `SELECT id, stock_qty, is_soldout FROM product_option_combinations
              WHERE product_id=? AND combo_key=? AND is_delete=0`, [product_id, key]);
        if (!combo) return []; // 등록 안 된 조합이면 재고를 걸지 않는다(주문은 막지 않음)
        return [{ product_id, option_id: 0, combo_id: combo.id, qty: count,
                  stock: combo.stock_qty, soldout: combo.is_soldout, label: '선택한 조합' }];
    }

    // 단독형 — 고른 옵션마다 따로 센다.
    if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const [rows] = await readPool.query(
            `SELECT id, option_name, stock_qty, is_soldout FROM product_options
              WHERE id IN (${ph}) AND is_delete=0`, ids);
        if (rows.length) {
            return rows.map((o) => ({
                product_id, option_id: o.id, combo_id: 0, qty: count,
                stock: o.stock_qty, soldout: o.is_soldout, label: o.option_name,
            }));
        }
    }

    // 옵션을 안 쓰는 상품 — 상품 자체 재고.
    return [{ product_id, option_id: 0, combo_id: 0, qty: count,
              stock: product.stock_qty, soldout: 0, label: '상품' }];
};

// 필수 옵션(선택옵션)을 다 골랐는지 **서버가** 본다.
//
// 왜 서버가 또 보나: 프론트 검사는 우회할 수 있고, 무엇보다 우회할 필요도 없었다.
// 상품 목록 카드의 '장바구니담기' 는 선택 정보 없이(false) 담기를 부르는데,
// 목록 응답에는 옵션이 실려 있지 않아 프론트 검사가 '모르면 통과' 로 빠져나갔다.
// 그러면 옵션 없는 주문이 그대로 접수되고, 가맹점은 무엇을 보내야 할지 모른다.
//
// 추가상품(group_type=1)은 검사하지 않는다 — 안 골라도 되는 것이 그 개념이다.
export const findMissingRequiredOption = async (products = []) => {
    const lines = Array.isArray(products) ? products : [];
    const ids = [...new Set(lines.map((p) => Number(p?.id) || 0).filter(Boolean))];
    if (!ids.length) return null;
    const ph = ids.map(() => '?').join(',');

    const [groups] = await readPool.query(
        `SELECT g.id, g.product_id, g.group_name
           FROM product_option_groups g
          WHERE g.product_id IN (${ph}) AND g.is_delete=0 AND g.group_type=0
            AND EXISTS (SELECT 1 FROM product_options o WHERE o.group_id=g.id AND o.is_delete=0)`, ids);
    if (!groups.length) return null;

    // 고른 옵션 id 가 어느 그룹 소속인지 확인한다.
    // 남의 상품 옵션 id 를 실어 보내도 그 그룹을 채운 것으로 쳐주면 안 된다.
    const 고른ids = [...new Set(lines.flatMap((p) => pickedOptionIds(p?.groups)))];
    let 소속 = new Map();
    if (고른ids.length) {
        const oph = 고른ids.map(() => '?').join(',');
        const [rows] = await readPool.query(
            `SELECT id, group_id FROM product_options WHERE id IN (${oph}) AND is_delete=0`, 고른ids);
        소속 = new Map(rows.map((r) => [Number(r.id), Number(r.group_id)]));
    }

    for (const line of lines) {
        const pid = Number(line?.id) || 0;
        const 필요 = groups.filter((g) => Number(g.product_id) === pid);
        if (!필요.length) continue;
        const 채운그룹 = new Set(pickedOptionIds(line?.groups).map((oid) => 소속.get(oid)).filter(Boolean));
        const 빠진 = 필요.find((g) => !채운그룹.has(Number(g.id)));
        if (빠진) return 빠진.group_name;
    }
    return null;
};

// ── 한정판: 1인당 구매 개수 ──────────────────────────────────────────────────
//
// products.purchase_limit 이 있으면 그 상품은 **회원만** 살 수 있다.
// 비회원은 같은 사람인지 확인할 방법이 없어서, 제한을 걸어도 지켜지지 않는다.
// (전화번호로 세는 방법도 있지만 번호만 바꾸면 그만이다)
// 제한을 안 건 상품은 지금처럼 비회원도 그대로 산다 — 전체 정책이 아니라 상품별 정책이다.
export const checkPurchaseLimit = async (user_id, products = []) => {
    const lines = Array.isArray(products) ? products : [];
    const ids = [...new Set(lines.map((p) => Number(p?.id) || 0).filter(Boolean))];
    if (!ids.length) return { ok: true };
    const ph = ids.map(() => '?').join(',');

    const [rows] = await readPool.query(
        `SELECT id, product_name, purchase_limit FROM products
          WHERE id IN (${ph}) AND purchase_limit IS NOT NULL AND purchase_limit > 0`, ids);
    if (!rows.length) return { ok: true }; // 한정 상품이 하나도 없다

    const uid = Number(user_id) || 0;
    if (!uid) {
        return { ok: false, message: `'${rows[0].product_name}' 은(는) 회원만 구매할 수 있는 한정 상품입니다. 로그인 후 이용해 주세요.` };
    }

    // 지난 구매 수량. 취소된 주문은 빼고, 결제대기는 센다 —
    // 한정 상품은 '덜 세서 초과 판매' 보다 '더 세서 막는' 쪽이 안전하다.
    // (버려진 결제대기는 cleanup-abandoned 스케줄러가 지운다)
    const [past] = await readPool.query(
        `SELECT o.product_id, SUM(o.order_count) AS cnt
           FROM transaction_orders o
           JOIN transactions t ON t.id = o.trans_id
          WHERE o.product_id IN (${ph}) AND t.user_id = ?
            AND t.is_cancel = 0 AND t.is_cancel_trans = 0 AND t.is_delete = 0
          GROUP BY o.product_id`, [...ids, uid]);
    const 지난것 = new Map(past.map((r) => [Number(r.product_id), Number(r.cnt) || 0]));

    for (const p of rows) {
        const pid = Number(p.id);
        // 같은 상품을 옵션만 달리해 여러 줄로 담았을 수 있다 — 합쳐서 본다.
        const 이번 = lines.filter((l) => Number(l?.id) === pid)
            .reduce((s, l) => s + Math.max(1, Number(l?.order_count) || 1), 0);
        const 합 = (지난것.get(pid) ?? 0) + 이번;
        if (합 > Number(p.purchase_limit)) {
            const 남은 = Math.max(0, Number(p.purchase_limit) - (지난것.get(pid) ?? 0));
            return {
                ok: false,
                message: 남은 > 0
                    ? `'${p.product_name}' 은(는) 1인 ${p.purchase_limit}개까지 구매할 수 있습니다. (지금 ${남은}개 더 구매 가능)`
                    : `'${p.product_name}' 은(는) 1인 ${p.purchase_limit}개까지 구매할 수 있습니다. 이미 모두 구매하셨습니다.`,
            };
        }
    }
    return { ok: true };
};

// 주문 전체가 재고 안에 들어오는지 본다. 부족하면 { ok:false, message } 를 돌려준다.
export const checkStock = async (products = []) => {
    const lines = Array.isArray(products) ? products : [];
    // 같은 옵션을 두 줄에 나눠 담았을 수 있다 — 합쳐서 봐야 한다.
    // (한 줄씩 보면 재고 1개짜리를 1개씩 두 줄로 담아 통과시킬 수 있다)
    const 합계 = new Map();
    for (const line of lines) {
        for (const need of await 줄별차감(line)) {
            const k = `${need.product_id}/${need.option_id}/${need.combo_id}`;
            const prev = 합계.get(k);
            합계.set(k, prev ? { ...prev, qty: prev.qty + need.qty } : need);
        }
    }
    for (const need of 합계.values()) {
        if (Number(need.soldout) === 1) return { ok: false, message: `${need.label} 은(는) 품절입니다.` };
        if (need.stock === null || need.stock === undefined) continue; // 무제한
        if (Number(need.stock) < need.qty) {
            return { ok: false, message: `${need.label} 의 재고가 부족합니다. (남은 수량 ${Number(need.stock)}개)` };
        }
    }
    return { ok: true };
};

// 주문 확정 시 차감. 원장(product_stock_moves)에 남기고 실제 수량을 줄인다.
//
// ⚠ 결제를 막지 않는다. 여기서 던지면 카드는 승인됐는데 주문이 안 만들어진다.
//   재고가 안 줄어든 것은 사람이 고칠 수 있지만, 결제 실패는 되돌리기 어렵다.
//   재고 검사는 결제 **전에** checkStock 으로 이미 한 번 한다.
export const decreaseStock = async (trans_id, products = []) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    const 합계 = new Map();
    for (const line of (Array.isArray(products) ? products : [])) {
        for (const need of await 줄별차감(line)) {
            if (need.stock === null || need.stock === undefined) continue; // 무제한은 원장도 안 남긴다
            const k = `${need.product_id}/${need.option_id}/${need.combo_id}`;
            const prev = 합계.get(k);
            합계.set(k, prev ? { ...prev, qty: prev.qty + need.qty } : need);
        }
    }
    for (const n of 합계.values()) {
        // UNIQUE(trans_id, kind, product_id, option_id, combo_id) 가 중복 차감을 DB 에서 막는다.
        // 결제 콜백이 두 번 들어와도 재고는 한 번만 줄어든다.
        const [r] = await writePool.query(
            `INSERT IGNORE INTO product_stock_moves (trans_id, product_id, option_id, combo_id, qty, kind)
             VALUES (?,?,?,?,?,'out')`,
            [tid, n.product_id, n.option_id, n.combo_id, n.qty]);
        if (!r?.affectedRows) continue; // 이미 차감된 주문
        const 뺐다 = await 차감(n);
        if (!뺐다) {
            // checkStock 을 통과한 뒤 결제가 끝나기 전에 다른 주문이 마지막 재고를 가져간 경우.
            // 마지막 1개를 두 사람이 동시에 누르면 둘 다 검사를 통과한다(검사와 차감 사이가 벌어져 있다).
            //
            // 여기서 결제를 되돌리지는 않는다 — 취소는 관리자가 PG 에 직접 요청하는 절차다.
            // 대신 '누구의 어느 주문이 초과 판매됐는지'를 남긴다. 안 남기면 재고만 0 으로 멈춰 있고
            // 업체는 무엇이 잘못됐는지 영영 모른다.
            console.error(`[재고] 초과 판매 — 주문 ${tid} / 상품 ${n.product_id}`
                + `${n.option_id ? ` / 옵션 ${n.option_id}` : ''}${n.combo_id ? ` / 조합 ${n.combo_id}` : ''}`
                + ` / 필요 ${n.qty}개. 재고가 모자라 차감하지 못했다 — 업체 확인 필요.`);
        }
    }
    return true;
};

// 부분취소 — 주문 한 줄에서 **수량만큼만** 되돌린다.
//
// 전체취소(restoreStock)와 다른 점 둘:
//   ① 차감 원장 전부가 아니라 **그 줄이 쓴 옵션**만 되돌린다.
//      같은 상품을 옵션만 달리해 두 줄로 담았을 수 있어서, product_id 만 보면 남의 줄까지 푼다.
//   ② 원장 'in' 행에 cancel_id 를 넣는다. 안 넣으면 UNIQUE 때문에
//      **첫 부분취소만 반영되고 두 번째부터 재고가 안 돌아온다.**
export const restoreStockPartial = async (trans_id, { product_id, option_ids = [], qty, cancel_id }) => {
    const tid = Number(trans_id) || 0;
    const pid = Number(product_id) || 0;
    const 수량 = Math.max(0, Number(qty) || 0);
    const cid = Number(cancel_id) || 0;
    if (!tid || !pid || !수량 || !cid) return false;

    const [outs] = await readPool.query(
        `SELECT * FROM product_stock_moves WHERE trans_id=? AND kind='out' AND product_id=?`, [tid, pid]);
    if (!outs.length) return true; // 재고를 안 쓰는 상품(무제한)

    const 고른것 = new Set(option_ids.map((v) => Number(v) || 0).filter(Boolean));
    // 옵션이 걸린 행은 그 줄이 고른 옵션만, 상품/조합 단위 행(option_id=0)은 그대로 되돌린다.
    const 대상 = outs.filter((r) => Number(r.option_id) === 0 || 고른것.has(Number(r.option_id)));

    for (const n of 대상) {
        // 이 줄이 원래 몇 개를 잡았는지보다 많이 되돌리면 안 된다.
        const 이미 = (await readPool.query(
            `SELECT COALESCE(SUM(qty),0) q FROM product_stock_moves
              WHERE trans_id=? AND kind='in' AND product_id=? AND option_id=? AND combo_id=?`,
            [tid, pid, n.option_id, n.combo_id]))[0][0];
        const 남은 = Math.max(0, Number(n.qty) - (Number(이미?.q) || 0));
        const 이번 = Math.min(수량, 남은);
        if (이번 <= 0) continue;

        const [r] = await writePool.query(
            `INSERT IGNORE INTO product_stock_moves (trans_id, product_id, option_id, combo_id, qty, kind, cancel_id)
             VALUES (?,?,?,?,?,'in',?)`,
            [tid, pid, n.option_id, n.combo_id, 이번, cid]);
        if (!r?.affectedRows) continue; // 같은 취소 건이 두 번 들어왔다
        await 수량이동({ product_id: pid, option_id: n.option_id, combo_id: n.combo_id }, 이번);
    }
    return true;
};

// 취소·환불 시 복구. 차감 원장에 남은 만큼만 되돌린다.
export const restoreStock = async (trans_id) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return false;
    const [outs] = await readPool.query(
        `SELECT * FROM product_stock_moves WHERE trans_id=? AND kind='out'`, [tid]);
    for (const n of outs) {
        // ⚠ 이미 부분취소로 되돌린 만큼은 빼고 되돌린다.
        //   안 빼면 '3개 중 1개 부분취소 → 나머지 전체취소' 때 3개를 또 되돌려
        //   **재고가 실제보다 1개 늘어난다**(팔지도 않은 재고가 생긴다).
        const 이미 = (await readPool.query(
            `SELECT COALESCE(SUM(qty),0) q FROM product_stock_moves
              WHERE trans_id=? AND kind='in' AND product_id=? AND option_id=? AND combo_id=?`,
            [tid, n.product_id, n.option_id, n.combo_id]))[0][0];
        const 남은 = Math.max(0, Number(n.qty) - (Number(이미?.q) || 0));
        if (남은 <= 0) continue;

        const [r] = await writePool.query(
            `INSERT IGNORE INTO product_stock_moves (trans_id, product_id, option_id, combo_id, qty, kind)
             VALUES (?,?,?,?,?,'in')`,
            [tid, n.product_id, n.option_id, n.combo_id, 남은]);
        if (!r?.affectedRows) continue; // 이미 전체복구된 주문 — 두 번 늘지 않는다
        await 수량이동(n, 남은);
    }
    return true;
};

// 재고를 **조건부로** 뺀다. 남은 수량이 모자라면 아무것도 하지 않고 false 를 돌려준다.
//
// 왜 조건부인가: `stock_qty = stock_qty - N` 을 무조건 실행하면, 마지막 1개를 두 사람이
// 동시에 산 경우 둘 다 성공한 것처럼 보이고 재고만 0(또는 음수)이 된다.
// `WHERE stock_qty >= N` 을 걸면 **DB 가 한 명만 통과**시킨다 — 밀린 쪽은 affectedRows=0 이라
// 초과 판매를 그 자리에서 알 수 있다.
// (읽고-빼는 두 단계로 나누면 그 사이가 벌어져 같은 문제가 생긴다. 한 문장이어야 한다)
const 차감 = async (n) => {
    const [표, 키] = n.combo_id ? ['product_option_combinations', n.combo_id]
        : n.option_id ? ['product_options', n.option_id]
            : ['products', n.product_id];
    const [r] = await writePool.query(
        `UPDATE ${표} SET stock_qty = stock_qty - ?
          WHERE id=? AND stock_qty IS NOT NULL AND stock_qty >= ?`,
        [n.qty, 키, n.qty]);
    return (r?.affectedRows ?? 0) > 0;
};

// 취소로 되돌릴 때 쓴다(양수만). 차감은 위 조건부 함수를 쓴다.
const 수량이동 = async (n, delta) => {
    if (n.combo_id) {
        await writePool.query(
            `UPDATE product_option_combinations SET stock_qty = GREATEST(IFNULL(stock_qty,0) + ?, 0)
              WHERE id=? AND stock_qty IS NOT NULL`, [delta, n.combo_id]);
    } else if (n.option_id) {
        await writePool.query(
            `UPDATE product_options SET stock_qty = GREATEST(IFNULL(stock_qty,0) + ?, 0)
              WHERE id=? AND stock_qty IS NOT NULL`, [delta, n.option_id]);
    } else {
        await writePool.query(
            `UPDATE products SET stock_qty = GREATEST(IFNULL(stock_qty,0) + ?, 0)
              WHERE id=? AND stock_qty IS NOT NULL`, [delta, n.product_id]);
    }
};
