'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, hasColumn, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { decField } from "../utils.js/crypto-util.js";
import {
    reviewSettings, maskWriter, parseImages, imagesOf, isAddonLine, optionTextOf,
    orderTimes, reviewState, invalidateReviewCache,
} from "../utils.js/review-policy.js";

// 상품후기.
//
// 2026-09-14 다시 켜면서 바뀐 것(설계 문서 §4·§6):
//   · 후기는 '산 상품 한 줄'(transaction_orders, order_id)에 붙는다. 줄당 1건. 서버가 구매·시점·기한을 다시 판정한다.
//   · 별점은 정수 1~5. 사진은 우리 Cloudinary 주소만, 최대 5장(images JSON). 제목은 받지 않는다.
//   · 목록은 숨김(is_hidden) 제외, BEST 먼저, 정렬 latest|high|low|helpful, 사진만 필터.
//   · 작성자는 마스킹(ho***). 실명·아이디는 관리자 화면에서만.
//   · 관리자: 전 상품 목록(manage)·답글(reply)·숨김(hide)·BEST(best).
// 이 파일이 새 컬럼을 요구한다(migrations/2026-09-14_product_reviews_v2.sql). 컬럼이 없으면 쓰기는 막고 읽기는 옛 모양으로 돈다.

const table_name = 'product_reviews';

// 별점은 정수 1~5 다. 화면은 별 다섯 개라 그 밖의 값이 나올 수 없지만, 요청은 화면을 안 거쳐도 보낼 수 있다.
// [확인 2026-08-28] 운영 API 로 -5 가 그대로 저장됐다. 음수·소수·6 이상은 평균을 망가뜨린다.
// ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
const 별점검사 = (scope) => {
    const v = String(scope ?? '').trim();
    if (!/^\d+$/.test(v)) return '별점은 1~5 사이로 입력해 주세요.';
    const n = parseInt(v, 10);
    return (n < 1 || n > 5) ? '별점은 1~5 사이로 입력해 주세요.' : null;
};

const v2Ready = async () => (await hasColumn(table_name, 'order_id')) && (await hasColumn(table_name, 'is_hidden'));
// 「도움돼요」 표(product_review_votes)가 있나. 마이그레이션 ③ 전엔 버튼이 준비 중이라고 답한다.
let votesTable = null;
const votesReady = async () => {
    if (votesTable !== null) return votesTable;
    try {
        const [rows] = await readPool.query(`SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_review_votes' LIMIT 1`);
        votesTable = rows.length > 0;
    } catch (e) { return false; } // 일시 오류를 '없음'으로 굳히지 않는다
    return votesTable;
};

const brandRow = async (id) => {
    const [[row]] = await readPool.query(`SELECT id, parent_id, setting_obj FROM brands WHERE id=? LIMIT 1`, [Number(id) || 0]);
    return row;
};

// 손님 화면으로 나가는 모양. 실명·아이디·전화는 여기서 걸러진다.
const shapePublic = (row, settings, { manager = false } = {}) => {
    const created = row?.created_at ? new Date(row.created_at).getTime() : 0;
    const out = {
        id: row.id, product_id: row.product_id, order_id: row.order_id ?? null, user_id: row.user_id,
        scope: Number(row.scope) || 0, content: row.content ?? '', images: imagesOf(row),
        option_text: row.option_text ?? '', created_at: row.created_at, updated_at: row.updated_at,
        writer: maskWriter(row.nickname || row.user_name),
        reply_content: row.reply_content ?? null, replied_at: row.replied_at ?? null,
        helpful_count: Number(row.helpful_count) || 0, is_best: Number(row.is_best) || 0, is_hidden: Number(row.is_hidden) || 0,
        hidden_reason: row.hidden_reason ?? null,
        editable_until: created && settings ? new Date(created + settings.edit_days * 86400000) : null,
    };
    if (manager) {
        out.writer_name = decField(row.writer_name);
        out.user_name = row.user_name;
        out.product_name = row.product_name;
        out.product_img = row.product_img;
        out.ord_num = row.ord_num;
        out.report_count = Number(row.report_count) || 0;
    }
    return out;
};

const 사진있음조건 = (v2) => v2
    ? `((${table_name}.images IS NOT NULL AND ${table_name}.images<>'' AND ${table_name}.images<>'[]') OR (${table_name}.content_img IS NOT NULL AND ${table_name}.content_img<>'') OR (${table_name}.profile_img IS NOT NULL AND ${table_name}.profile_img<>''))`
    : `((${table_name}.content_img IS NOT NULL AND ${table_name}.content_img<>'') OR (${table_name}.profile_img IS NOT NULL AND ${table_name}.profile_img<>''))`;

// 주문 줄 + 주문 한 벌. 작성·판정에 쓴다.
const orderLine = async (order_id, brandId) => {
    const [[row]] = await readPool.query(
        `SELECT o.id AS order_id, o.trans_id, o.product_id, o.order_name, o.order_count, o.cancel_count, o.order_groups,
                t.id, t.user_id, t.brand_id, t.trx_status, t.is_cancel, t.is_cancel_trans, t.is_delete, t.updated_at, t.ord_num
           FROM transaction_orders o JOIN transactions t ON t.id=o.trans_id
          WHERE o.id=? AND t.brand_id=? LIMIT 1`, [Number(order_id) || 0, brandId]);
    return row;
};

const productReviewCtrl = {

    // 손님 목록. ?product_id&page&page_size&sort=latest|high|low|helpful&photo_only=1
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { product_id } = req.query;
            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const page_size = Math.min(50, Math.max(1, parseInt(req.query.page_size, 10) || 10));
            const sort = ['latest', 'high', 'low', 'helpful'].includes(req.query.sort) ? req.query.sort : 'latest';
            const photo_only = String(req.query.photo_only ?? '') === '1';

            const brandId = decode_dns?.id ?? 0;
            const productIdNum = parseInt(product_id, 10) || 0;
            if (!brandId || !productIdNum) {
                return response(req, res, -400, "brand_id 또는 product_id가 올바르지 않습니다.", false);
            }
            const v2 = await v2Ready();
            const level = decode_user?.level ?? 0;
            const is_manager = (await checkIsManagerUrl(req)) && level >= 10;
            const settings = reviewSettings(decode_dns);

            // 내가 누른 「도움돼요」 표시. 목록 캐시는 손님 공통이므로 캐시된 뒤에 사람별로 합친다.
            const withVoted = async (d) => {
                const me = Number(decode_user?.id) || 0;
                if (!(me > 0) || !settings.use_helpful || !(await votesReady())) return d;
                const ids = (d?.content ?? []).map((x) => x.id).filter(Boolean);
                if (!ids.length) return d;
                const [vs] = await readPool.query(`SELECT review_id FROM product_review_votes WHERE user_id=? AND review_id IN (?)`, [me, ids]);
                const mine = new Set(vs.map((v) => Number(v.review_id)));
                return { ...d, content: d.content.map((x) => ({ ...x, voted: mine.has(Number(x.id)) ? 1 : 0 })) };
            };
            const canUseCache = !!redisClient?.isOpen && level < 10;
            const cacheKey = canUseCache ? `product_reviews:list:${brandId}:${productIdNum}:${JSON.stringify({ page, page_size, sort, photo_only })}` : null;
            if (cacheKey) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) return response(req, res, 100, "success(cache)", await withVoted(JSON.parse(cached)));
                } catch (e) { logger.error(`[review] 캐시 읽기 실패: ${e?.message || e}`); }
            }

            let where = ` WHERE ${table_name}.brand_id=? AND ${table_name}.product_id=? AND ${table_name}.is_delete=0 `;
            const params = [brandId, productIdNum];
            if (v2) where += ` AND ${table_name}.is_hidden=0 `;
            if (photo_only) where += ` AND ${사진있음조건(v2)} `;

            const orderBy = {
                latest: `${table_name}.id DESC`,
                high: `${table_name}.scope DESC, ${table_name}.id DESC`,
                low: `${table_name}.scope ASC, ${table_name}.id DESC`,
                helpful: v2 ? `${table_name}.helpful_count DESC, ${table_name}.id DESC` : `${table_name}.id DESC`,
            }[sort];
            const best = v2 ? `${table_name}.is_best DESC, ` : '';

            const [[{ total }]] = await readPool.query(`SELECT COUNT(*) AS total FROM ${table_name} ${where}`, params);
            const [rows] = await readPool.query(
                `SELECT ${table_name}.*, users.nickname, users.user_name ${is_manager ? ', users.name AS writer_name' : ''}
                   FROM ${table_name} LEFT JOIN users ON ${table_name}.user_id=users.id
                   ${where} ORDER BY ${best}${orderBy} LIMIT ?, ?`,
                [...params, (page - 1) * page_size, page_size]);

            const data = {
                total: Number(total) || 0, page, page_size, sort, photo_only,
                content: rows.map((r) => shapePublic(r, settings, { manager: is_manager })),
            };
            if (cacheKey) {
                try { await redisClient.set(cacheKey, JSON.stringify(data), { EX: 60 }); } catch (e) { /* 캐시는 곁가지 */ }
            }
            return response(req, res, 100, "success", await withVoted(data));
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 요약: 평균·건수·별점 분포·사진 후기 수·사진 몇 장. 5분 캐시.
    summary: async (req, res, next) => {
        try {
            const decode_dns = checkDns(req.cookies.dns);
            const brandId = decode_dns?.id ?? 0;
            const productIdNum = parseInt(req.query.product_id, 10) || 0;
            if (!brandId || !productIdNum) {
                return response(req, res, -400, "brand_id 또는 product_id가 올바르지 않습니다.", false);
            }
            const settings = reviewSettings(decode_dns);
            const cacheKey = redisClient?.isOpen ? `product_reviews:summary:${brandId}:${productIdNum}` : null;
            if (cacheKey) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) return response(req, res, 100, "success(cache)", JSON.parse(cached));
                } catch (e) { /* 캐시는 곁가지 */ }
            }
            const v2 = await v2Ready();
            const visible = ` ${table_name}.brand_id=? AND ${table_name}.product_id=? AND ${table_name}.is_delete=0 ${v2 ? `AND ${table_name}.is_hidden=0` : ''} `;
            const [dist] = await readPool.query(
                `SELECT scope, COUNT(*) AS n FROM ${table_name} WHERE ${visible} GROUP BY scope`, [brandId, productIdNum]);
            const [[photo]] = await readPool.query(
                `SELECT COUNT(*) AS n FROM ${table_name} WHERE ${visible} AND ${사진있음조건(v2)}`, [brandId, productIdNum]);
            const [photoRows] = await readPool.query(
                `SELECT id, ${v2 ? 'images,' : ''} content_img, profile_img FROM ${table_name} WHERE ${visible} AND ${사진있음조건(v2)} ORDER BY ${v2 ? 'is_best DESC,' : ''} id DESC LIMIT 12`,
                [brandId, productIdNum]);

            const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
            let count = 0, sum = 0;
            for (const d of dist) {
                const s = Math.min(5, Math.max(1, Number(d.scope) || 0));
                distribution[s] += Number(d.n) || 0;
                count += Number(d.n) || 0;
                sum += s * (Number(d.n) || 0);
            }
            const photos = [];
            for (const r of photoRows) {
                for (const u of imagesOf(r)) { if (photos.length < 8 && !photos.find((p) => p.url === u)) photos.push({ url: u, review_id: r.id }); }
                if (photos.length >= 8) break;
            }
            const data = {
                enabled: settings.enabled,
                count, avg: count ? Math.round((sum / count) * 10) / 10 : 0, distribution,
                photo_count: Number(photo?.n) || 0, photos,
                settings: { allow_photo: settings.allow_photo, min_length: settings.min_length, max_length: settings.max_length, max_images: settings.max_images, notice: settings.notice, edit_days: settings.edit_days, window_days: settings.window_days },
            };
            if (cacheKey) { try { await redisClient.set(cacheKey, JSON.stringify(data), { EX: 300 }); } catch (e) { /* */ } }
            return response(req, res, 100, "success", data);
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 내 주문 줄마다 '쓸 수 있나'. 주문내역의 버튼과 상품 상세의 「후기 쓰기」가 이걸 본다.
    // ?product_id 를 주면 그 상품 줄만. 로그인 전이면 빈 목록(오류 아님 — 화면이 로그인 안내를 낸다).
    writable: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brandId = decode_dns?.id ?? 0;
            const userId = Number(decode_user?.id) || 0;
            const productIdNum = parseInt(req.query.product_id, 10) || 0;
            const settings = reviewSettings(decode_dns);
            if (!brandId || !userId || !settings.enabled || !(await v2Ready())) {
                return response(req, res, 100, "success", { enabled: settings.enabled, logged_in: userId > 0, lines: [], writable_count: 0 });
            }
            const params = [brandId, userId];
            let sql = `SELECT o.id AS order_id, o.trans_id, o.product_id, o.order_name, o.order_count, o.cancel_count, o.order_groups,
                              t.trx_status, t.is_cancel, t.is_cancel_trans, t.updated_at, t.ord_num, t.user_id, t.created_at AS ordered_at,
                              p.product_name, p.product_img
                         FROM transaction_orders o
                         JOIN transactions t ON t.id=o.trans_id
                         LEFT JOIN products p ON p.id=o.product_id
                        WHERE t.brand_id=? AND t.user_id=? AND t.is_delete=0 AND t.trx_status IN (15,20,25) `;
            if (productIdNum) { sql += ` AND o.product_id=? `; params.push(productIdNum); }
            sql += ` ORDER BY o.id DESC LIMIT 200`;
            const [lines] = await readPool.query(sql, params);
            const orderIds = lines.map((l) => l.order_id);
            let existingByOrder = new Map();
            if (orderIds.length) {
                const [ex] = await readPool.query(
                    `SELECT id, order_id, is_delete, is_hidden, hidden_reason, rewrite_count, scope FROM ${table_name} WHERE brand_id=? AND order_id IN (?)`,
                    [brandId, orderIds]);
                existingByOrder = new Map(ex.map((r) => [Number(r.order_id), r]));
            }
            // 같은 주문의 줄들은 출고·배송 시각이 같다 — 주문당 한 번만 읽는다.
            const timesByTrx = new Map();
            const out = [];
            for (const l of lines) {
                if (isAddonLine(l.order_groups)) continue; // 추가상품 줄은 후기 대상이 아니다
                const trx = { id: l.trans_id, user_id: l.user_id, trx_status: l.trx_status, is_cancel: l.is_cancel, is_cancel_trans: l.is_cancel_trans, updated_at: l.updated_at };
                if (!timesByTrx.has(l.trans_id)) timesByTrx.set(l.trans_id, await orderTimes(trx));
                const st = await reviewState({ brand: decode_dns, userId, line: l, trx, existing: existingByOrder.get(Number(l.order_id)), times: timesByTrx.get(l.trans_id) });
                out.push({
                    order_id: l.order_id, trans_id: l.trans_id, ord_num: l.ord_num, product_id: l.product_id,
                    product_name: l.product_name || l.order_name, product_img: l.product_img,
                    option_text: optionTextOf(l.order_groups), ordered_at: l.ordered_at, trx_status: l.trx_status,
                    state: st.state, reason: st.reason ?? null, deadline: st.deadline ? new Date(st.deadline) : null,
                    review_id: st.review && Number(st.review.is_delete) === 0 ? st.review.id : null,
                    review_hidden: st.review && Number(st.review.is_delete) === 0 && Number(st.review.is_hidden) === 1 ? (st.review.hidden_reason || '숨김') : null,
                });
            }
            return response(req, res, 100, "success", {
                enabled: true, logged_in: true, lines: out,
                writable_count: out.filter((x) => x.state === 'writable').length,
            });
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    get: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const reviewId = parseInt(req.params.id, 10) || 0;
            if (!reviewId) return response(req, res, -400, "리뷰 id가 올바르지 않습니다.", false);
            const [[row]] = await readPool.query(
                `SELECT ${table_name}.*, users.nickname, users.user_name FROM ${table_name} LEFT JOIN users ON ${table_name}.user_id=users.id WHERE ${table_name}.id=?`, [reviewId]);
            if (!row) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            const level = decode_user?.level ?? 0;
            const own = Number(row.user_id) === Number(decode_user?.id);
            // 숨김·삭제된 후기는 본인·관리자만 본다.
            if ((Number(row.is_delete) === 1 || Number(row.is_hidden) === 1) && !(own || level >= 10)) {
                return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            }
            return response(req, res, 100, "success", shapePublic(row, reviewSettings(decode_dns), { manager: level >= 10 }));
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 작성. { order_id, scope, content, images: JSON 배열 문자열 }
    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brandId = Number(decode_dns?.id) || 0;
            const userId = Number(decode_user?.id) || 0;
            if (!brandId) return response(req, res, -400, "brand_id 또는 product_id가 올바르지 않습니다.", false);
            // 후기는 로그인한 본인 이름으로만. body 의 user_id·brand_id 는 쓰지 않는다(명의 도용 방지).
            if (!(userId > 0)) return lowLevelException(req, res);
            if (Number(decode_user?.level) >= 10) return response(req, res, -100, "구매한 회원만 후기를 쓸 수 있습니다.", false);
            if (!(await v2Ready())) return response(req, res, -100, "후기 기능 준비 중입니다.", false);

            const brand = await brandRow(brandId);
            const settings = reviewSettings(brand);
            if (!settings.enabled) return response(req, res, -100, "후기 기능을 사용하지 않는 몰입니다.", false);

            const { order_id, scope, content, images } = req.body;
            const line = await orderLine(order_id, brandId);
            if (!line) return response(req, res, -100, "주문 정보를 찾을 수 없습니다.", false);
            const [[existing]] = await readPool.query(
                `SELECT id, is_delete, is_hidden, rewrite_count FROM ${table_name} WHERE order_id=? LIMIT 1`, [line.order_id]);
            const st = await reviewState({ brand, userId, line, trx: line, existing });
            if (!st.ok) return response(req, res, -100, st.reason, false);

            const 별점잘못 = 별점검사(scope);
            if (별점잘못) return response(req, res, -100, 별점잘못, false);
            const text = String(content ?? '').replace(/\r\n/g, '\n').trim();
            if ([...text].length < settings.min_length) return response(req, res, -100, "후기가 너무 짧습니다. 조금 더 적어 주세요.", false);
            if ([...text].length > settings.max_length) return response(req, res, -100, "후기는 1,000자 이내로 입력해 주세요.", false);
            let imgs = settings.allow_photo ? parseImages(images, 99) : [];
            if (imgs.length > settings.max_images) return response(req, res, -100, "사진은 최대 5장까지 올릴 수 있습니다.", false);
            imgs = imgs.slice(0, settings.max_images);

            const [[product]] = await readPool.query(`SELECT id FROM products WHERE id=? AND brand_id=? AND is_delete=0 LIMIT 1`, [line.product_id, brandId]);
            if (!product) return response(req, res, -100, "상품을 찾을 수 없습니다.", false);

            const fields = {
                scope: parseInt(scope, 10), content: text,
                images: JSON.stringify(imgs), content_img: imgs[0] ?? null, profile_img: null, title: null,
                option_text: optionTextOf(line.order_groups),
            };
            let id;
            if (existing) {
                // 삭제 뒤 같은 줄에 다시 쓰는 경우(1회). 같은 행을 되살린다 — order_id 가 UNIQUE 라 새 행을 못 만든다.
                await writePool.query(
                    `UPDATE ${table_name} SET scope=?, content=?, images=?, content_img=?, profile_img=NULL, title=NULL, option_text=?,
                            is_delete=0, is_hidden=0, hidden_reason=NULL, reply_content=NULL, reply_user_id=NULL, replied_at=NULL,
                            helpful_count=0, report_count=0, is_best=0, rewrite_count=rewrite_count+1, created_at=NOW(), updated_at=NOW()
                      WHERE id=?`,
                    [fields.scope, fields.content, fields.images, fields.content_img, fields.option_text, existing.id]);
                id = existing.id;
            } else {
                const result = await insertQuery(table_name, {
                    brand_id: brandId, product_id: line.product_id, trans_id: line.trans_id, order_id: line.order_id, user_id: userId,
                    ...fields,
                });
                id = result?.insertId;
            }
            await invalidateReviewCache(brandId, line.product_id, id);
            return response(req, res, 100, "success", { id });
        } catch (err) {
            if (err?.code === 'ER_DUP_ENTRY') return response(req, res, -100, "이미 후기를 작성한 주문입니다.", false);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 수정. 본인만, 작성 후 edit_days 안에. 별점·본문·사진.
    update: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const reviewId = parseInt(req.body.id ?? req.params.id, 10) || 0;
            if (!reviewId) return response(req, res, -400, "리뷰 id가 올바르지 않습니다.", false);
            const [[row]] = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [reviewId]);
            if (!row || Number(row.is_delete) === 1) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            const userId = Number(decode_user?.id) || 0;
            if (!(userId > 0) || Number(row.user_id) !== userId) return lowLevelException(req, res);

            const settings = reviewSettings(await brandRow(row.brand_id));
            const created = row.created_at ? new Date(row.created_at).getTime() : 0;
            if (Date.now() > created + settings.edit_days * 86400000) return response(req, res, -100, "후기 수정 기간이 지났습니다.", false);

            const { scope, content, images } = req.body;
            const obj = {};
            if (scope !== undefined && scope !== null && String(scope) !== '') {
                const 별점잘못 = 별점검사(scope);
                if (별점잘못) return response(req, res, -100, 별점잘못, false);
                obj.scope = parseInt(scope, 10);
            }
            if (content !== undefined) {
                const text = String(content ?? '').replace(/\r\n/g, '\n').trim();
                if ([...text].length < settings.min_length) return response(req, res, -100, "후기가 너무 짧습니다. 조금 더 적어 주세요.", false);
                if ([...text].length > settings.max_length) return response(req, res, -100, "후기는 1,000자 이내로 입력해 주세요.", false);
                obj.content = text;
            }
            if (images !== undefined && (await hasColumn(table_name, 'images'))) {
                let imgs = settings.allow_photo ? parseImages(images, 99) : [];
                if (imgs.length > settings.max_images) return response(req, res, -100, "사진은 최대 5장까지 올릴 수 있습니다.", false);
                imgs = imgs.slice(0, settings.max_images);
                obj.images = JSON.stringify(imgs);
                obj.content_img = imgs[0] ?? null;
                obj.profile_img = null;
            }
            if (Object.keys(obj).length) await updateQuery(table_name, obj, reviewId);
            await invalidateReviewCache(row.brand_id, row.product_id, reviewId);
            return response(req, res, 100, "success", {});
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 삭제(소프트). 본인 또는 관리자(레벨>=10, 같은 브랜드).
    remove: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const reviewId = parseInt(req.params.id, 10) || 0;
            if (!reviewId) return response(req, res, -400, "리뷰 id가 올바르지 않습니다.", false);
            const [[row]] = await readPool.query(`SELECT id, brand_id, product_id, user_id FROM ${table_name} WHERE id=?`, [reviewId]);
            if (!row) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            const loginUserId = Number(decode_user?.id) || 0;
            const loginLevel = Number(decode_user?.level) || 0;
            if (!(loginLevel >= 10 || (loginUserId > 0 && Number(row.user_id) === loginUserId))) return lowLevelException(req, res);
            await deleteQuery(table_name, { id: reviewId });
            await invalidateReviewCache(row.brand_id, row.product_id, reviewId);
            return response(req, res, 100, "success", {});
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // ── 관리자 ────────────────────────────────────────────────────────────

    // 전 상품 후기 목록. ?page&page_size&scope&has_photo=1&no_reply=1&hidden=1|0&is_best=1&search&s_dt&e_dt&product_id
    manage: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 10, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const brandId = decode_dns?.id ?? 0;
            if (!brandId) return response(req, res, -400, "brand_id 또는 product_id가 올바르지 않습니다.", false);
            const v2 = await v2Ready();
            const q = req.query;
            const page = Math.max(1, parseInt(q.page, 10) || 1);
            const page_size = Math.min(100, Math.max(1, parseInt(q.page_size, 10) || 20));

            let where = ` WHERE ${table_name}.brand_id=? AND ${table_name}.is_delete=0 `;
            const params = [brandId];
            const scope = parseInt(q.scope, 10);
            if (scope >= 1 && scope <= 5) { where += ` AND ${table_name}.scope=? `; params.push(scope); }
            if (String(q.has_photo) === '1') where += ` AND ${사진있음조건(v2)} `;
            if (v2 && String(q.no_reply) === '1') where += ` AND (${table_name}.reply_content IS NULL OR ${table_name}.reply_content='') `;
            if (v2 && (String(q.hidden) === '1' || String(q.hidden) === '0')) { where += ` AND ${table_name}.is_hidden=? `; params.push(Number(q.hidden)); }
            if (v2 && String(q.is_best) === '1') where += ` AND ${table_name}.is_best=1 `;
            const productId = parseInt(q.product_id, 10) || 0;
            if (productId) { where += ` AND ${table_name}.product_id=? `; params.push(productId); }
            const search = String(q.search ?? '').trim();
            if (search) { where += ` AND (products.product_name LIKE ? OR ${table_name}.content LIKE ?) `; params.push(`%${search}%`, `%${search}%`); }
            if (q.s_dt) { where += ` AND ${table_name}.created_at >= ? `; params.push(`${q.s_dt} 00:00:00`); }
            if (q.e_dt) { where += ` AND ${table_name}.created_at <= ? `; params.push(`${q.e_dt} 23:59:59`); }

            const from = ` FROM ${table_name}
                             LEFT JOIN products ON ${table_name}.product_id=products.id
                             LEFT JOIN users ON ${table_name}.user_id=users.id
                             LEFT JOIN transactions ON ${table_name}.trans_id=transactions.id `;
            const [[{ total }]] = await readPool.query(`SELECT COUNT(*) AS total ${from} ${where}`, params);
            const [rows] = await readPool.query(
                `SELECT ${table_name}.*, users.nickname, users.user_name, users.name AS writer_name,
                        products.product_name, products.product_img, transactions.ord_num
                   ${from} ${where} ORDER BY ${table_name}.id DESC LIMIT ?, ?`,
                [...params, (page - 1) * page_size, page_size]);
            const settings = reviewSettings(decode_dns);
            const [[counts]] = v2
                ? await readPool.query(
                    `SELECT SUM(is_hidden=1) AS hidden, SUM(reply_content IS NULL OR reply_content='') AS no_reply, SUM(report_count>0 AND is_hidden=0) AS reported
                       FROM ${table_name} WHERE brand_id=? AND is_delete=0`, [brandId])
                : [[{ hidden: 0, no_reply: 0, reported: 0 }]];
            return response(req, res, 100, "success", {
                total: Number(total) || 0, page, page_size,
                content: rows.map((r) => shapePublic(r, settings, { manager: true })),
                counts: { hidden: Number(counts?.hidden) || 0, no_reply: Number(counts?.no_reply) || 0, reported: Number(counts?.reported) || 0 },
                settings,
            });
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 판매자 답글. 비우면 답글 삭제.
    reply: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 10, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const reviewId = parseInt(req.params.id, 10) || 0;
            const [[row]] = await readPool.query(`SELECT id, brand_id, product_id FROM ${table_name} WHERE id=?`, [reviewId]);
            if (!row) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            if (!(await hasColumn(table_name, 'reply_content'))) return response(req, res, -100, "후기 기능 준비 중입니다.", false);
            const text = String(req.body?.reply_content ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
            if (text) {
                await writePool.query(`UPDATE ${table_name} SET reply_content=?, reply_user_id=?, replied_at=NOW() WHERE id=?`, [text, Number(decode_user.id) || null, reviewId]);
            } else {
                await writePool.query(`UPDATE ${table_name} SET reply_content=NULL, reply_user_id=NULL, replied_at=NULL WHERE id=?`, [reviewId]);
            }
            await invalidateReviewCache(row.brand_id, row.product_id, reviewId);
            return response(req, res, 100, "success", {});
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 숨김/해제. { is_hidden: 1|0, hidden_reason }
    hide: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 10, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const reviewId = parseInt(req.params.id, 10) || 0;
            const [[row]] = await readPool.query(`SELECT id, brand_id, product_id FROM ${table_name} WHERE id=?`, [reviewId]);
            if (!row) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            if (!(await hasColumn(table_name, 'is_hidden'))) return response(req, res, -100, "후기 기능 준비 중입니다.", false);
            const hidden = Number(req.body?.is_hidden) === 1 ? 1 : 0;
            const reason = hidden ? String(req.body?.hidden_reason ?? '').trim().slice(0, 100) || '관리자 숨김' : null;
            await writePool.query(`UPDATE ${table_name} SET is_hidden=?, hidden_reason=?, is_best=IF(?=1, 0, is_best) WHERE id=?`, [hidden, reason, hidden, reviewId]);
            await invalidateReviewCache(row.brand_id, row.product_id, reviewId);
            return response(req, res, 100, "success", {});
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // BEST 지정/해제. 상품당 best_max 개까지.
    best: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 10, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const reviewId = parseInt(req.params.id, 10) || 0;
            const [[row]] = await readPool.query(`SELECT id, brand_id, product_id, is_hidden FROM ${table_name} WHERE id=?`, [reviewId]);
            if (!row) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            if (!(await hasColumn(table_name, 'is_best'))) return response(req, res, -100, "후기 기능 준비 중입니다.", false);
            const on = Number(req.body?.is_best) === 1 ? 1 : 0;
            if (on) {
                if (Number(row.is_hidden) === 1) return response(req, res, -100, "숨긴 후기는 BEST로 지정할 수 없습니다.", false);
                const settings = reviewSettings(await brandRow(row.brand_id));
                const [[{ n }]] = await readPool.query(
                    `SELECT COUNT(*) AS n FROM ${table_name} WHERE product_id=? AND is_delete=0 AND is_hidden=0 AND is_best=1 AND id<>?`, [row.product_id, reviewId]);
                if (Number(n) >= settings.best_max) return response(req, res, -100, "BEST 후기 지정 개수를 넘었습니다.", false);
            }
            await writePool.query(`UPDATE ${table_name} SET is_best=? WHERE id=?`, [on, reviewId]);
            await invalidateReviewCache(row.brand_id, row.product_id, reviewId);
            return response(req, res, 100, "success", {});
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 「도움돼요」 누르기/취소. 회원만 · 후기당 한 번 · 내 후기엔 못 누름 · 관리자 계정은 못 누름.
    // 건수는 INSERT/DELETE 가 실제로 바뀐 때만 ±1 — 두 번 눌러도, 두 창에서 눌러도 어긋나지 않는다.
    helpful: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const userId = Number(decode_user?.id) || 0;
            if (!(userId > 0)) return response(req, res, -100, "로그인을 해주세요.", false);
            if ((decode_user?.level ?? 0) >= 10) return response(req, res, -100, "관리자 계정으로는 누를 수 없습니다.", false);
            const settings = reviewSettings(decode_dns);
            if (!settings.enabled || !settings.use_helpful) return response(req, res, -100, "이 몰에서는 도움돼요를 쓰지 않습니다.", false);
            if (!(await votesReady()) || !(await hasColumn(table_name, 'helpful_count'))) return response(req, res, -100, "후기 기능 준비 중입니다.", false);
            const reviewId = parseInt(req.params.id, 10) || 0;
            const [[row]] = await readPool.query(`SELECT id, brand_id, product_id, user_id, is_delete, is_hidden FROM ${table_name} WHERE id=?`, [reviewId]);
            if (!row || Number(row.is_delete) === 1 || Number(row.is_hidden) === 1) return response(req, res, -404, "리뷰를 찾을 수 없습니다.", false);
            if (!isItemBrandIdSameDnsId(decode_dns, row)) return lowLevelException(req, res);
            if (Number(row.user_id) === userId) return response(req, res, -100, "내 후기에는 누를 수 없습니다.", false);
            const on = Number(req.body?.on) === 1 ? 1 : 0;
            if (on) {
                const [ins] = await writePool.query(`INSERT IGNORE INTO product_review_votes (review_id, user_id, brand_id) VALUES (?, ?, ?)`, [reviewId, userId, row.brand_id]);
                if (ins.affectedRows > 0) await writePool.query(`UPDATE ${table_name} SET helpful_count=helpful_count+1 WHERE id=?`, [reviewId]);
            } else {
                const [del] = await writePool.query(`DELETE FROM product_review_votes WHERE review_id=? AND user_id=?`, [reviewId, userId]);
                if (del.affectedRows > 0) await writePool.query(`UPDATE ${table_name} SET helpful_count=GREATEST(0, helpful_count-1) WHERE id=?`, [reviewId]);
            }
            const [[{ n }]] = await writePool.query(`SELECT helpful_count AS n FROM ${table_name} WHERE id=?`, [reviewId]);
            await invalidateReviewCache(row.brand_id, row.product_id, reviewId);
            return response(req, res, 100, "success", { helpful_count: Number(n) || 0, voted: on });
        } catch (err) {
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },
};

export default productReviewCtrl;
