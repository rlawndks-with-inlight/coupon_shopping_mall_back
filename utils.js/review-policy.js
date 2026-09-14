'use strict';
import { readPool, writePool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { deleteKeys } from "./redis-scan.js";
import { hasColumn } from "./query-util.js";
import { isShopgoBrand } from "./is-shopgo.js";
import logger from "./winston/index.js";

// 상품후기 규칙 — 서버 쪽 사본.
//
// 프론트(src/utils/review.js)와 **같은 규칙**이어야 한다. 화면 계산은 검증이 아니다 —
// 요청은 화면을 거치지 않고도 들어오므로 서버가 스스로 다시 판단한다. 두 벌이 어긋나면
// '화면에는 버튼이 있는데 누르면 거절되는' 일이 나므로 검사(scripts/checks/review-policy.mjs)가 대조한다.
//
// 설계 문서: ShopGo 후기·별점 설계(2026-09-07, 결정 반영 09-14) §4.

// shopgo 산하 몰의 is_use_review 가 비어 있을 때의 기본값.
// 배포 첫날은 꺼짐(false)으로 올려 forsmall·mbc01 에서 확인한 뒤 true 로 바꾼다.
// 다른 배포 브랜드(shopgo 밖)는 늘 후기를 써 왔으므로 비어 있으면 켜진 것으로 본다.
export const REVIEW_DEFAULT_ON_SHOPGO = false;

// 비어 있으면(미설정) 기본값 d. ⚠ Number('') 은 0 이라 그냥 Number 로 읽으면 '미설정' 이 0 이 되어
//   최소 글자 1·BEST 0개 같은 엉뚱한 값이 된다(2026-09-14 미리보기에서 실제로 그랬다).
const 수 = (v, d) => {
    if (v === undefined || v === null || String(v).trim() === '') return d;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : d;
};
const 설정 = (dns) => {
    let s = dns?.setting_obj ?? {};
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = {}; } }
    return s ?? {};
};

// brands.setting_obj 의 후기 설정 → 쓸 수 있는 값으로. 상한·하한을 여기서 건다(관리자 화면도 같은 값).
export const reviewSettings = (dns) => {
    const s = 설정(dns);
    const raw = s.is_use_review;
    const enabled = (raw === undefined || raw === null || raw === '')
        ? (isShopgoBrand(dns) ? REVIEW_DEFAULT_ON_SHOPGO : true)
        : Number(raw) === 1;
    return {
        enabled,
        allow_photo: (s.review_allow_photo === undefined || s.review_allow_photo === null || s.review_allow_photo === '') ? true : Number(s.review_allow_photo) === 1,
        // 「도움돼요」 버튼(+도움순 정렬). 끄면 숨을 뿐 쌓인 수는 남는다(2026-09-14 사장님 결정: 선택 기능, 기본 켜짐).
        use_helpful: (s.review_use_helpful === undefined || s.review_use_helpful === null || s.review_use_helpful === '') ? true : Number(s.review_use_helpful) === 1,
        min_length: Math.min(200, Math.max(1, Math.floor(수(s.review_min_length, 10)))),
        max_length: 1000,
        max_images: 5,
        window_days: Math.min(365, Math.max(7, Math.floor(수(s.review_window_days, 90)))),
        edit_days: Math.min(90, Math.max(0, Math.floor(수(s.review_edit_days, 7)))),
        best_max: Math.min(10, Math.max(0, Math.floor(수(s.review_best_max, 3)))),
        notice: String(s.review_notice ?? '').slice(0, 300),
        ship_grace_days: 3, // 배송완료를 안 누르는 몰을 위해: 출고 뒤 이 날짜가 지나면 열린다
    };
};

// 작성자 표시: 앞 두 글자 + ***. 닉네임이 없으면 아이디. (네이버는 아이디 일부 마스킹, 쿠팡은 이름 일부)
export const maskWriter = (name) => {
    const s = String(name ?? '').trim();
    if (!s) return '***';
    return (s.length <= 2 ? s.slice(0, 1) : s.slice(0, 2)) + '***';
};

// 사진은 우리 Cloudinary 주소만 받는다(외부 URL 로 아무 그림이나 꽂지 못하게).
const 우리사진 = (u) => /^https:\/\/res\.cloudinary\.com\/[a-z0-9_-]+\/image\/upload\//i.test(String(u ?? ''));
export const parseImages = (raw, max = 5) => {
    let arr = raw;
    if (typeof raw === 'string') {
        try { arr = JSON.parse(raw); } catch (e) { arr = raw.trim() ? [raw.trim()] : []; }
    }
    if (!Array.isArray(arr)) arr = [];
    const seen = new Set();
    return arr.map((x) => String(x ?? '').trim()).filter((x) => x && 우리사진(x) && !seen.has(x) && seen.add(x)).slice(0, max);
};

// 한 행의 사진 목록. 새 열(images)이 우선이고, 예전 한 장짜리(content_img·profile_img)는 그대로 살려 보여 준다.
export const imagesOf = (row) => {
    const list = parseImages(row?.images, 5);
    if (list.length) return list;
    return [row?.content_img, row?.profile_img].map((x) => String(x ?? '').trim()).filter((x) => x && /^https?:\/\//.test(x)).slice(0, 1);
};

// 주문 줄의 옵션 문구. 추가상품 줄(addon_line=1)은 후기 대상이 아니다.
export const isAddonLine = (order_groups) => {
    try {
        const g = typeof order_groups === 'string' ? JSON.parse(order_groups || '[]') : (order_groups ?? []);
        return (Array.isArray(g) ? g : []).some((x) => Number(x?.addon_line) === 1);
    } catch (e) { return false; }
};
export const optionTextOf = (order_groups) => {
    try {
        const g = typeof order_groups === 'string' ? JSON.parse(order_groups || '[]') : (order_groups ?? []);
        return (Array.isArray(g) ? g : [])
            .filter((x) => Number(x?.addon_line) !== 1)
            .map((x) => {
                const opts = (x?.options ?? []).map((o) => String(o?.option_name ?? '').trim()).filter(Boolean).join(', ');
                const name = String(x?.group_name ?? '').trim();
                return opts ? (name ? `${name}: ${opts}` : opts) : '';
            })
            .filter(Boolean).join(' / ').slice(0, 200);
    } catch (e) { return ''; }
};

// 주문의 출고·배송완료 시각. 상태 이력(transaction_status_logs, 2026-09-14)에서 읽고,
// 이력이 없는 옛 주문은 updated_at 을 근사치로 쓴다. 컬럼을 새로 늘리지 않는다(설계 §5).
export const orderTimes = async (trx) => {
    let shipped = null, delivered = null;
    try {
        const [rows] = await readPool.query(
            `SELECT to_status, created_at FROM transaction_status_logs WHERE trans_id=? AND to_status IN (15,20,25) ORDER BY id ASC`, [trx.id]);
        for (const r of rows) {
            if (!shipped && [15, 20, 25].includes(Number(r.to_status))) shipped = r.created_at;
            if (!delivered && Number(r.to_status) === 25) delivered = r.created_at;
        }
    } catch (e) {
        if (e?.code !== 'ER_NO_SUCH_TABLE') logger.error(`[review] 상태 이력 조회 실패 trans_id=${trx?.id}: ${e?.sqlMessage || e?.message || e}`);
    }
    const st = Number(trx.trx_status);
    if (!shipped && [15, 20, 25].includes(st)) shipped = trx.updated_at;
    if (!delivered && st === 25) delivered = trx.updated_at;
    return { shipped, delivered };
};

// 한 주문 줄에 대해 '지금 이 회원이 후기를 쓸 수 있나'. 작성 API 와 주문내역 버튼이 같은 판정을 쓴다.
// 반환 { ok, state, reason, deadline, review }
//   state: off | not_owner | canceled | written | not_yet | expired | writable
export const reviewState = async ({ brand, userId, line, trx, existing, times }) => {
    const s = reviewSettings(brand);
    if (!s.enabled) return { ok: false, state: 'off', reason: '후기 기능을 사용하지 않는 몰입니다.' };
    if (!(Number(userId) > 0) || Number(trx?.user_id) !== Number(userId)) return { ok: false, state: 'not_owner', reason: '구매한 회원만 후기를 쓸 수 있습니다.' };
    if (isAddonLine(line?.order_groups)) return { ok: false, state: 'not_owner', reason: '구매한 회원만 후기를 쓸 수 있습니다.' };
    const canceled = Number(trx?.is_cancel) === 1 || Number(trx?.is_cancel_trans) === 1
        || Number(line?.cancel_count || 0) >= Number(line?.order_count || 0);
    if (canceled) return { ok: false, state: 'canceled', reason: '취소된 주문에는 후기를 쓸 수 없습니다.', review: existing && Number(existing.is_delete) === 0 ? existing : undefined };
    if (existing && (Number(existing.is_delete) === 0 || Number(existing.rewrite_count) >= 1)) {
        return { ok: false, state: 'written', reason: '이미 후기를 작성한 주문입니다.', review: existing };
    }
    const t = times ?? await orderTimes(trx);
    const now = Date.now();
    let open = t.delivered ? new Date(t.delivered).getTime() : null;
    if (!open && t.shipped) {
        const after = new Date(t.shipped).getTime() + s.ship_grace_days * 86400000;
        if (after <= now) open = after;
    }
    if (!open) return { ok: false, state: 'not_yet', reason: '받으신 뒤에 후기를 쓸 수 있습니다.' };
    const deadline = open + s.window_days * 86400000;
    if (now > deadline) return { ok: false, state: 'expired', reason: '후기 작성 기간이 지났습니다.', deadline };
    return { ok: true, state: 'writable', deadline, review: existing };
};

// 캐시 — 목록·요약은 60초/5분 캐시. 쓰기·숨김·답글 때 지운다.
export const invalidateReviewCache = async (brandId, productId = null, reviewId = null) => {
    try {
        if (!redisClient?.isOpen || !brandId) return;
        await deleteKeys(redisClient, productId
            ? `product_reviews:list:${brandId}:${productId}:*`
            : `product_reviews:list:${brandId}:*`);
        await deleteKeys(redisClient, productId
            ? `product_reviews:summary:${brandId}:${productId}`
            : `product_reviews:summary:${brandId}:*`);
        if (reviewId) await redisClient.del(`product_reviews:get:${brandId}:${reviewId}`);
        else await deleteKeys(redisClient, `product_reviews:get:${brandId}:*`);
    } catch (e) {
        logger.error(`[review] 캐시 삭제 실패 brand=${brandId}: ${e?.message || e}`);
    }
};

// 주문 줄이 전부 취소·반품되면 그 줄의 후기를 숨긴다(설계 §4.6). 삭제가 아니라 숨김 —
// 관리자 후기관리에서 「취소 숨김」으로 구분해 보이고 필요하면 되살릴 수 있다.
// ⚠ 절대 던지지 않는다. 후기는 곁가지다 — 이것 때문에 취소가 실패하면 안 된다.
export const hideReviewsForCanceled = async (trans_id) => {
    const tid = Number(trans_id) || 0;
    if (!tid) return 0;
    try {
        if (!(await hasColumn('product_reviews', 'order_id')) || !(await hasColumn('product_reviews', 'is_hidden'))) return 0;
        const [[trx]] = await readPool.query(`SELECT id, brand_id, is_cancel, is_cancel_trans FROM transactions WHERE id=?`, [tid]);
        if (!trx) return 0;
        const [lines] = await readPool.query(`SELECT id, product_id, order_count, cancel_count FROM transaction_orders WHERE trans_id=?`, [tid]);
        const whole = Number(trx.is_cancel) === 1 || Number(trx.is_cancel_trans) === 1;
        const gone = lines.filter((l) => whole || Number(l.cancel_count || 0) >= Number(l.order_count || 0));
        if (!gone.length) return 0;
        const [r] = await writePool.query(
            `UPDATE product_reviews SET is_hidden=1, hidden_reason='주문 취소' WHERE order_id IN (?) AND is_delete=0 AND is_hidden=0`,
            [gone.map((l) => l.id)]);
        if (r?.affectedRows > 0) {
            for (const pid of new Set(gone.map((l) => l.product_id))) await invalidateReviewCache(trx.brand_id, pid);
            logger.info(`[review] 주문 취소로 후기 ${r.affectedRows}건 숨김 trans_id=${tid}`);
        }
        return r?.affectedRows ?? 0;
    } catch (e) {
        logger.error(`[review] 취소 후기 숨김 실패 trans_id=${tid}: ${e?.sqlMessage || e?.message || e}`);
        return 0;
    }
};

export default { REVIEW_DEFAULT_ON_SHOPGO, reviewSettings, maskWriter, parseImages, imagesOf, isAddonLine, optionTextOf, orderTimes, reviewState, invalidateReviewCache, hideReviewsForCanceled };
