'use strict';
import { deleteQuery, getSelectQueryList, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkLevel, checkDns, response } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
import { sendMail } from "../utils.js/mail.js";

// 신청 접수 알림 메일 본문
const buildApplicationMailHtml = (obj) => `
  <div style="font-family:sans-serif;font-size:14px;color:#222;line-height:1.7">
    <h2 style="margin:0 0 12px">새 가맹점 신청이 접수되었습니다</h2>
    <table style="border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#888">사업자명</td><td><b>${obj.business_name}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">사업자번호</td><td>${obj.business_number}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">통신판매업신고번호</td><td>${obj.mail_order_number || '-'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">대표자</td><td>${obj.ceo_name} / ${obj.ceo_phone} / ${obj.ceo_email || '-'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">담당자</td><td>${obj.manager_name} / ${obj.manager_phone} / ${obj.manager_email || '-'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">고객센터</td><td>${obj.cs_phone || '-'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">영업추천인</td><td>${obj.referrer_name || '-'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">희망 URL</td><td>${obj.desired_slug}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888">프레임</td><td>${obj.selected_frame || '-'}</td></tr>
    </table>
  </div>`;

const table_name = 'merchant_applications';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const BIZNO_RE = /^[0-9]{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const extractIp = (req) => {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.socket?.remoteAddress || '';
};

// 메인 도메인(마스터)에서 앞의 www. 제거
const getRootDomain = () => String(process.env.MAIN_FRONT_URL || '').replace(/^www\./, '');

// 현재 접속 브랜드가 마스터(메인 도메인)인지 검증.
// merchant_applications 관리는 마스터(freeshop) 브랜드 매니저만 가능해야 한다.
const isMasterManager = (req) => {
    const decode_dns = checkDns(req.cookies.dns);
    if (!decode_dns) return false;
    if (decode_dns.is_main_dns == 1) return true;
    const root = getRootDomain();
    return root && decode_dns.dns === root;
};

// 선택 프레임("shop:1" / "blog:4") → 데모번호 매핑
const frameToDemo = (frame) => {
    const [category, num] = String(frame || '').split(':');
    const n = parseInt(num) || 0;
    if (category === 'blog') return { shop_demo_num: '0', blog_demo_num: String(n) };
    return { shop_demo_num: String(n), blog_demo_num: '0' };
};

// 신규 가맹점에 기본 게시판(공지사항 / 1:1문의) 자동 생성.
// 1:1문의 = 볼수있는대상 '자신 및 관리자만'(read_type=1) + 회원 글쓰기 허용(is_able_user_add=1)
//   → 고객이 남긴 문의에 관리자가 답변하는 문의함으로 동작하며, 대시보드 '문의관리' 카드에도 집계됨.
// 가맹점은 게시판 생성 권한이 없으므로(레벨50 전용) 개설 단계에서 우리가 미리 심어준다.
// 이미 같은 이름의 게시판이 있으면 중복 생성하지 않는다(멱등).
const seedDefaultBoards = async (brandId) => {
    if (!brandId) return;
    const boards = [
        { post_category_title: '공지사항', parent_id: -1, is_able_user_add: 0, post_category_type: 0, post_category_read_type: 0 },
        { post_category_title: '1:1문의', parent_id: -1, is_able_user_add: 1, post_category_type: 0, post_category_read_type: 1 },
    ];
    const exist = await readPool.query(
        `SELECT post_category_title FROM post_categories WHERE brand_id=? AND is_delete=0`,
        [brandId]
    );
    const existTitles = (exist[0] || []).map((r) => r.post_category_title);
    for (const b of boards) {
        if (existTitles.includes(b.post_category_title)) continue;
        await insertQuery('post_categories', { ...b, brand_id: brandId });
    }
};

// 마스터 하위 가맹점 중 기본 게시판이 없는 곳에 일괄 시드(멱등). 개설된 가맹점 수 반환.
export const backfillDefaultBoards = async () => {
    const rootDomain = getRootDomain();
    const masterRes = await readPool.query(
        `SELECT id FROM brands WHERE dns=? AND is_main_dns=1 LIMIT 1`, [rootDomain]
    );
    const master = masterRes[0][0];
    if (!master) throw new Error('마스터 브랜드를 찾을 수 없습니다');
    const subs = await readPool.query(
        `SELECT id, dns FROM brands WHERE parent_id=? AND is_delete=0`, [master.id]
    );
    let count = 0;
    for (const b of (subs[0] || [])) {
        await seedDefaultBoards(b.id);
        count++;
    }
    return count;
};

// 승인 시 신청 정보로 하위 가맹점(brands) 자동 생성. 생성된 brand_id 반환.
const createSubBrandFromApplication = async (app) => {
    const rootDomain = getRootDomain();
    if (!rootDomain) throw new Error('MAIN_FRONT_URL 미설정');

    // 마스터(부모) 브랜드 조회
    const masterRes = await readPool.query(
        `SELECT id FROM brands WHERE dns=? AND is_main_dns=1 LIMIT 1`,
        [rootDomain]
    );
    const master = masterRes[0][0];
    if (!master) throw new Error('마스터 브랜드를 찾을 수 없습니다');

    const subDns = `${app.desired_slug}.${rootDomain}`;

    // 이미 같은 dns 브랜드가 있으면 그걸 반환(중복 생성 방지)
    const dup = await readPool.query(`SELECT id FROM brands WHERE dns=? LIMIT 1`, [subDns]);
    if (dup[0]?.length > 0) return dup[0][0].id;

    const demo = frameToDemo(app.selected_frame);
    const setting_obj = JSON.stringify({
        max_use_point: '0', point_rate: '0', use_point_min_price: '0', tutorial_num: '0',
        shop_demo_num: demo.shop_demo_num, blog_demo_num: demo.blog_demo_num,
        is_use_seller: '0', is_use_consignment: '0', is_use_item_card_style: '0',
        is_use_lang: '0', is_use_shop_obj_style: '0', is_use_blog_obj_style: '0',
        is_use_product_sub_category: '0', product_sub_category_name: '',
    });

    const obj = {
        dns: subDns,
        admin_dns: '',
        parent_id: master.id,
        name: app.business_name,
        company_name: app.business_name,
        ceo_name: app.ceo_name || '',
        phone_num: app.cs_phone || app.ceo_phone || '',
        business_num: app.business_number || '',
        mail_order_num: app.mail_order_number || '',
        theme_css: JSON.stringify({ main_color: '#111111' }),
        blog_obj: '[]',
        shop_obj: '[]',
        setting_obj,
        none_use_column_obj: '{}',
        seo_obj: JSON.stringify({ naver_token: '', google_token: '' }),
        bonaeja_obj: JSON.stringify({ api_key: '', user_id: '', sender: '' }),
        is_delete: 0,
        is_main_dns: 0,
        brand_type: 0,
    };

    const result = await insertQuery('brands', obj);
    const newBrandId = result?.insertId;
    // 개설 즉시 기본 게시판(공지사항 / 1:1문의) 자동 생성. 실패해도 브랜드 생성은 유지.
    if (newBrandId) {
        try {
            await seedDefaultBoards(newBrandId);
        } catch (e) {
            logger.error('기본 게시판 시드 실패: ' + (e?.message || e));
        }
    }
    return newBrandId;
};

const merchantApplicationCtrl = {
    // 공개: 신청 접수
    create: async (req, res, next) => {
        try {
            const {
                business_name,
                business_number,
                mail_order_number,
                ceo_name,
                ceo_phone,
                ceo_email,
                manager_name,
                manager_phone,
                manager_email,
                cs_phone,
                referrer_name,
                desired_slug,
                selected_frame,
                agreement_agreed,
            } = req.body;

            if (!business_name || !ceo_name || !ceo_phone || !manager_name || !manager_phone) {
                return response(req, res, -100, "필수 항목이 누락되었습니다", false);
            }
            const bizNo = String(business_number || '').replace(/-/g, '');
            if (!BIZNO_RE.test(bizNo)) {
                return response(req, res, -102, "사업자번호 형식이 올바르지 않습니다", false);
            }
            if (ceo_email && !EMAIL_RE.test(ceo_email)) {
                return response(req, res, -103, "대표자 이메일 형식이 올바르지 않습니다", false);
            }
            if (manager_email && !EMAIL_RE.test(manager_email)) {
                return response(req, res, -104, "담당자 이메일 형식이 올바르지 않습니다", false);
            }
            const slug = String(desired_slug || '').toLowerCase().trim();
            if (!SLUG_RE.test(slug)) {
                return response(req, res, -105, "가맹점명 형식이 올바르지 않습니다", false);
            }
            if (!agreement_agreed) {
                return response(req, res, -106, "약정서 동의가 필요합니다", false);
            }

            // 중복 체크는 "실제 운영 중인 쇼핑몰(brands) 주소"와만 한다.
            // 처리 전(pending) 신청끼리는 중복을 허용 — 승인·개설은 우리가 수동으로 하며,
            // 이때 slug가 겹치면 확인/조정하면 되고, 브랜드 생성 단계에서 dns 중복이 한 번 더 방지된다.
            const mainDomain = process.env.MAIN_FRONT_URL || '';
            if (mainDomain) {
                const fullDns = `${slug}.${mainDomain.replace(/^www\./, '')}`;
                const dupBrand = await readPool.query(
                    `SELECT id FROM brands WHERE dns=? LIMIT 1`,
                    [fullDns]
                );
                if (dupBrand[0]?.length > 0) {
                    return response(req, res, -101, "이미 운영 중인 쇼핑몰 주소입니다", false);
                }
            }

            const obj = {
                business_name,
                business_number: bizNo,
                mail_order_number: mail_order_number || '',
                ceo_name,
                ceo_phone,
                ceo_email: ceo_email || '',
                manager_name,
                manager_phone,
                manager_email: manager_email || '',
                cs_phone: cs_phone || '',
                referrer_name: referrer_name || '',
                desired_slug: slug,
                selected_frame: selected_frame || '',
                agreement_agreed: 1,
                agreement_agreed_at: new Date(),
                agreement_agreed_ip: extractIp(req),
                status: 'pending',
            };

            await insertQuery(`${table_name}`, obj);

            // 관리자에게 신청 알림 메일 (실패해도 접수는 성공 처리)
            sendMail({
                to: process.env.MAIL_TO || 'office@forspay.com',
                subject: `[ShopGo] 새 가맹점 신청 - ${obj.business_name}`,
                html: buildApplicationMailHtml(obj),
            }).catch(() => { });

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 공개: 슬러그 중복 확인
    checkSlug: async (req, res, next) => {
        try {
            const slug = String(req.query.name || '').toLowerCase().trim();
            if (!SLUG_RE.test(slug)) {
                return response(req, res, 100, "success", { available: false, reason: 'invalid' });
            }
            const dup = await readPool.query(
                `SELECT id FROM ${table_name} WHERE desired_slug=? AND status IN ('pending','approved') LIMIT 1`,
                [slug]
            );
            if (dup[0]?.length > 0) {
                return response(req, res, 100, "success", { available: false, reason: 'taken' });
            }
            const mainDomain = process.env.MAIN_FRONT_URL || '';
            if (mainDomain) {
                const fullDns = `${slug}.${mainDomain.replace(/^www\./, '')}`;
                const dupBrand = await readPool.query(
                    `SELECT id FROM brands WHERE dns=? LIMIT 1`,
                    [fullDns]
                );
                if (dupBrand[0]?.length > 0) {
                    return response(req, res, 100, "success", { available: false, reason: 'taken' });
                }
            }
            return response(req, res, 100, "success", { available: true });
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 매니저 전용: 신청 목록
    list: async (req, res, next) => {
        try {
            checkLevel(req.cookies.token, 10, res);
            if (!isMasterManager(req)) {
                return response(req, res, -403, "권한이 없습니다", false);
            }
            let columns = [`${table_name}.*`];
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE 1=1 `;
            if (req.query.status) {
                sql += ` AND ${table_name}.status='${String(req.query.status).replace(/'/g, '')}' `;
            }
            // 정렬/LIMIT은 getSelectQueryList가 자체적으로 붙인다(기본 id DESC = 최신순).
            // 여기서 ORDER BY를 또 붙이면 ORDER BY가 중복돼 SQL 문법 오류가 난다.
            const data = await getSelectQueryList(sql, columns, req.query);
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 매니저 전용: 개설된 하위 가맹점 현황 + 매출 집계 (마스터 대시보드 / 가맹점 현황 페이지용)
    merchants: async (req, res, next) => {
        try {
            checkLevel(req.cookies.token, 10, res);
            if (!isMasterManager(req)) {
                return response(req, res, -403, "권한이 없습니다", false);
            }
            const { s_dt, e_dt } = req.query;
            const rootDomain = getRootDomain();
            const masterRes = await readPool.query(
                `SELECT id FROM brands WHERE dns=? AND is_main_dns=1 LIMIT 1`, [rootDomain]
            );
            const master = masterRes[0][0];
            if (!master) {
                return response(req, res, 100, "success", { merchants: [], summary: { merchant_count: 0, total_sales: 0, order_count: 0 } });
            }
            // 매출 = 결제완료 이후 단계(trx_status>=5) & 미취소(is_cancel=0) 합계.
            // 집계를 마스터의 하위 가맹점으로만 스코프(transactions 전체 스캔 방지).
            let joinDate = '';
            const params = [];
            if (s_dt) { joinDate += ` AND t.created_at >= ? `; params.push(`${s_dt} 00:00:00`); }
            if (e_dt) { joinDate += ` AND t.created_at <= ? `; params.push(`${e_dt} 23:59:59`); }
            params.push(master.id);
            const sql = `
                SELECT b.id, b.name, b.dns, b.created_at, b.logo_img,
                       COALESCE(SUM(t.amount), 0) AS sales,
                       COUNT(t.id) AS order_count
                FROM brands b
                LEFT JOIN transactions t
                  ON t.brand_id = b.id AND t.trx_status >= 5 AND t.is_cancel = 0${joinDate}
                WHERE b.parent_id = ? AND b.is_delete = 0
                GROUP BY b.id, b.name, b.dns, b.created_at, b.logo_img
                ORDER BY sales DESC, b.created_at DESC`;
            const rows = (await readPool.query(sql, params))[0];
            const merchants = rows.map((r) => ({
                id: r.id,
                name: r.name,
                dns: r.dns,
                created_at: r.created_at,
                logo_img: r.logo_img,
                sales: Number(r.sales) || 0,
                order_count: Number(r.order_count) || 0,
            }));
            const summary = {
                merchant_count: merchants.length,
                total_sales: merchants.reduce((a, m) => a + m.sales, 0),
                order_count: merchants.reduce((a, m) => a + m.order_count, 0),
            };
            return response(req, res, 100, "success", { merchants, summary });
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 매니저 전용: 특정 하위 가맹점의 상세 내역 (상태별 집계 + 최근 주문). 마스터의 하위 가맹점만 조회 허용.
    merchantDetail: async (req, res, next) => {
        try {
            checkLevel(req.cookies.token, 10, res);
            if (!isMasterManager(req)) {
                return response(req, res, -403, "권한이 없습니다", false);
            }
            const { id } = req.params;
            const { s_dt, e_dt } = req.query;
            const rootDomain = getRootDomain();
            const masterRes = await readPool.query(
                `SELECT id FROM brands WHERE dns=? AND is_main_dns=1 LIMIT 1`, [rootDomain]
            );
            const master = masterRes[0][0];
            if (!master) {
                return response(req, res, -404, "마스터 브랜드를 찾을 수 없습니다", false);
            }
            // 대상이 마스터의 하위 가맹점인지 검증 (무관 브랜드 조회 차단)
            const brandRes = await readPool.query(
                `SELECT id, name, dns, created_at FROM brands WHERE id=? AND parent_id=? AND is_delete=0 LIMIT 1`,
                [id, master.id]
            );
            const brand = brandRes[0][0];
            if (!brand) {
                return response(req, res, -403, "해당 가맹점을 조회할 권한이 없습니다", false);
            }

            let dateWhere = '';
            const dateParams = [];
            if (s_dt) { dateWhere += ` AND created_at >= ? `; dateParams.push(`${s_dt} 00:00:00`); }
            if (e_dt) { dateWhere += ` AND created_at <= ? `; dateParams.push(`${e_dt} 23:59:59`); }

            // 상태별 집계(미취소)
            const statusRows = (await readPool.query(
                `SELECT trx_status, COUNT(*) AS cnt, SUM(amount) AS amt FROM transactions WHERE brand_id=? AND is_cancel=0${dateWhere} GROUP BY trx_status`,
                [brand.id, ...dateParams]
            ))[0];
            const status = {};
            statusRows.forEach((r) => { status[r.trx_status] = { cnt: Number(r.cnt) || 0, amt: Number(r.amt) || 0 }; });
            // 취소 건수
            const cancelRow = (await readPool.query(
                `SELECT COUNT(*) AS cnt FROM transactions WHERE brand_id=? AND is_cancel=1${dateWhere}`,
                [brand.id, ...dateParams]
            ))[0][0];
            // 총 매출/주문(결제완료 이후, 미취소)
            const totalRow = (await readPool.query(
                `SELECT COALESCE(SUM(amount),0) AS sales, COUNT(*) AS cnt FROM transactions WHERE brand_id=? AND trx_status>=5 AND is_cancel=0${dateWhere}`,
                [brand.id, ...dateParams]
            ))[0][0];
            // 최근 주문 30건
            const orders = (await readPool.query(
                `SELECT id, buyer_name, amount, trx_status, is_cancel, trx_dt, trx_tm, created_at FROM transactions WHERE brand_id=?${dateWhere} ORDER BY id DESC LIMIT 30`,
                [brand.id, ...dateParams]
            ))[0];

            return response(req, res, 100, "success", {
                brand,
                summary: {
                    total_sales: Number(totalRow?.sales) || 0,
                    order_count: Number(totalRow?.cnt) || 0,
                    status,
                    cancel_count: Number(cancelRow?.cnt) || 0,
                },
                orders,
            });
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 공개: 가맹점·상품 검색 (메인 사이트 방문자용)
    // 가맹점명 / 주소(dns) / 상품명 중 하나라도 일치하면 해당 가맹점 + 상품 반환.
    // 스코프: 현재 마스터의 서브브랜드(parent_id=master)만 → 무관 브랜드 노출 방지.
    searchShops: async (req, res, next) => {
        try {
            const q = String(req.query.q || '').trim();
            // 부하 방지: 2글자 미만은 검색하지 않음
            if (q.length < 2) {
                return response(req, res, 100, "success", { shops: [] });
            }
            const rootDomain = getRootDomain();
            const masterRes = await readPool.query(
                `SELECT id FROM brands WHERE dns=? AND is_main_dns=1 LIMIT 1`,
                [rootDomain]
            );
            const master = masterRes[0][0];
            if (!master) {
                return response(req, res, 100, "success", { shops: [] });
            }
            const like = `%${q}%`;
            // (가맹점명/주소) 매칭
            const byBrand = await readPool.query(
                `SELECT id FROM brands WHERE parent_id=? AND is_delete=0 AND (is_closure IS NULL OR is_closure!=1) AND (name LIKE ? OR dns LIKE ?) LIMIT 100`,
                [master.id, like, like]
            );
            // (상품명) 매칭 → 해당 상품이 속한 가맹점
            const byProduct = await readPool.query(
                `SELECT DISTINCT b.id FROM brands b JOIN products p ON p.brand_id=b.id
                 WHERE b.parent_id=? AND b.is_delete=0 AND (b.is_closure IS NULL OR b.is_closure!=1) AND p.is_delete=0 AND (p.product_name LIKE ? OR p.lang_obj LIKE ?) LIMIT 100`,
                [master.id, like, like]
            );
            const idSet = new Set();
            byBrand[0].forEach((r) => idSet.add(r.id));
            byProduct[0].forEach((r) => idSet.add(r.id));
            const ids = [...idSet].slice(0, 30);
            if (ids.length === 0) {
                return response(req, res, 100, "success", { shops: [] });
            }
            const ph = ids.map(() => '?').join();
            const brandsRes = await readPool.query(
                `SELECT id, name, dns, logo_img FROM brands WHERE id IN (${ph}) AND is_delete=0`,
                ids
            );
            const productsRes = await readPool.query(
                `SELECT id, brand_id, product_name, product_sale_price, product_img, lang_obj
                 FROM products WHERE brand_id IN (${ph}) AND is_delete=0 ORDER BY id DESC LIMIT 800`,
                ids
            );
            const prodByBrand = {};
            productsRes[0].forEach((p) => {
                if (!prodByBrand[p.brand_id]) prodByBrand[p.brand_id] = [];
                prodByBrand[p.brand_id].push({
                    id: p.id,
                    product_name: p.product_name,
                    product_sale_price: p.product_sale_price,
                    product_img: p.product_img,
                    lang_obj: p.lang_obj,
                });
            });
            const shops = brandsRes[0].map((b) => ({
                name: b.name,
                dns: b.dns,
                logo_img: b.logo_img,
                products: (prodByBrand[b.id] || []).slice(0, 12),
            }));
            return response(req, res, 100, "success", { shops });
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 매니저 전용: 신청 단건
    get: async (req, res, next) => {
        try {
            checkLevel(req.cookies.token, 10, res);
            if (!isMasterManager(req)) {
                return response(req, res, -403, "권한이 없습니다", false);
            }
            const { id } = req.params;
            const result = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id]);
            const data = result[0][0];
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 매니저 전용: 상태 변경
    updateStatus: async (req, res, next) => {
        try {
            checkLevel(req.cookies.token, 10, res);
            if (!isMasterManager(req)) {
                return response(req, res, -403, "권한이 없습니다", false);
            }
            const { id, status, memo, brand_id } = req.body;
            if (!id || !status) {
                return response(req, res, -100, "필수 항목이 누락되었습니다", false);
            }
            if (!['pending', 'approved', 'rejected'].includes(status)) {
                return response(req, res, -100, "상태값이 올바르지 않습니다", false);
            }
            const obj = { status };
            if (memo !== undefined) obj.memo = memo;
            if (brand_id !== undefined) obj.brand_id = brand_id;

            // 승인 시: 아직 연결된 brand가 없으면 하위 가맹점 자동 생성
            if (status === 'approved') {
                const appRes = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id]);
                const app = appRes[0][0];
                if (!app) {
                    return response(req, res, -100, "신청 내역을 찾을 수 없습니다", false);
                }
                if (!app.brand_id && !brand_id) {
                    try {
                        const newBrandId = await createSubBrandFromApplication(app);
                        if (newBrandId) obj.brand_id = newBrandId;
                    } catch (e) {
                        logger.error('sub-brand 생성 실패: ' + (e?.message || e));
                        return response(req, res, -110, "하위 가맹점 생성 실패: " + (e?.message || ''), false);
                    }
                }
            }

            await updateQuery(`${table_name}`, obj, id);
            return response(req, res, 100, "success", { brand_id: obj.brand_id });
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },

    // 매니저 전용: 삭제
    remove: async (req, res, next) => {
        try {
            checkLevel(req.cookies.token, 10, res);
            if (!isMasterManager(req)) {
                return response(req, res, -403, "권한이 없습니다", false);
            }
            const { id } = req.params;
            await deleteQuery(`${table_name}`, { id });
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },
};

export default merchantApplicationCtrl;
