'use strict';
import { deleteQuery, getSelectQueryList, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkLevel, checkDns, response, createHashedPassword } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
import { sendMail } from "../utils.js/mail.js";
import { encForSave, decRow, decRows } from "../utils.js/pii.js";

// ── ShopGo 브랜드 이메일 템플릿 ─────────────────────────────────────────────
// 다크 헤더(ShopGo 워드마크) + 본문 + 회사정보/면책 푸터로 감싸는 공통 셸.
const MAIL_GREEN = '#9ee54e';
// 이메일 클라이언트 호환을 위해 div가 아닌 table 기반으로 구성.
// (Outlook은 div의 max-width를 무시 → 화면 끝까지 늘어남. 고정폭 600px table로 방지)
// 카드는 좌측 정렬(align="left") 고정폭 600px.
const mailShell = (inner) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;border-collapse:collapse">
    <tr><td align="left" style="padding:24px 16px">
      <table role="presentation" width="650" cellpadding="0" cellspacing="0" style="width:650px;max-width:650px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #ececec;border-collapse:separate;font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic','맑은 고딕',sans-serif;color:#222">
        <tr><td style="background:#141414;padding:18px 30px">
          <span style="font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#ffffff">Shop<span style="color:${MAIL_GREEN}">Go</span></span>
        </td></tr>
        <tr><td style="padding:26px 30px 28px">${inner}</td></tr>
        <tr><td style="padding:20px 30px;background:#fafafa;border-top:1px solid #eee;font-size:12px;color:#999;line-height:1.7">
          <div style="font-weight:700;color:#666">주식회사 우진플랫폼</div>
          <div>서울시 영등포구 여의대방로 67길 11, 5층 에이5-41호(여의도동)</div>
          <div>쇼핑몰 문의 kimin6756@gmail.com &middot; 가맹 및 결제 문의 office@forspay.com</div>
          <div style="margin-top:9px;color:#bbb;font-size:11px">무료 쇼핑몰은 ㈜우진플랫폼이 제공하며, 결제서비스는 ㈜포스페이의 결제 솔루션을 통해 제공됩니다. 상품의 판매, 계약, 배송, 환불, 고객응대 및 쇼핑몰 운영에 관한 모든 책임은 해당 판매자에게 있으며, 양사는 플랫폼 및 결제서비스 제공자로서 거래의 당사자가 아닙니다.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>`;
const mailRow = (k, v) => `<tr><td style="padding:11px 18px 11px 20px;color:#9a9aa2;white-space:nowrap;vertical-align:top;font-size:13px;border-bottom:1px solid #f0f0f0;width:120px">${k}</td><td style="padding:11px 20px 11px 0;color:#222;font-weight:600;font-size:13px;border-bottom:1px solid #f0f0f0;word-break:break-all">${v || '-'}</td></tr>`;
const mailBox = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #eee;border-radius:10px;border-collapse:separate">${rows}</table>`;

// 운영사(마스터) 수신용 — 새 신청 알림
const buildApplicationMailHtml = (obj) => mailShell(`
  <div style="font-size:20px;font-weight:800;color:#191919;letter-spacing:-0.4px">새 가맹점 신청이 접수되었습니다</div>
  <div style="font-size:13px;color:#8a8a90;margin:7px 0 18px">아래 내용으로 신규 가맹점 신청이 접수되었습니다.</div>
  ${mailBox(
    mailRow('사업자명', `<b>${obj.business_name}</b>`) +
    mailRow('사업자번호', obj.business_number) +
    mailRow('통신판매업신고번호', obj.mail_order_number) +
    mailRow('대표자', `${obj.ceo_name} / ${obj.ceo_phone} / ${obj.ceo_email || '-'}`) +
    mailRow('담당자', `${obj.manager_name} / ${obj.manager_phone} / ${obj.manager_email || '-'}`) +
    mailRow('고객센터', obj.cs_phone) +
    mailRow('영업추천인', obj.referrer_name) +
    mailRow('희망 URL', obj.desired_slug) +
    mailRow('프레임', obj.selected_frame)
  )}
`);

// 신청자(대표자/담당자) 수신용 — 접수 확인
const buildApplicantReceiptHtml = (obj, shopUrl) => mailShell(`
  <h2 style="margin:0 0 8px;font-size:19px">무료쇼핑몰 가맹점 신청이 접수되었습니다.</h2>
  <p style="margin:0 0 22px;font-size:14px;color:#555;line-height:1.75">
    ShopGo 무료쇼핑몰을 신청해 주셔서 진심으로 감사드립니다.<br>
    신청 내용을 확인 후 <b>포스페이 담당자가 순차적으로 서비스 상담</b>을 진행해 드리겠습니다.<br>
    상담 완료 후 <b>관리자(Admin) 계정 및 운영 매뉴얼</b>을 제공해 드릴 예정입니다.<br>
    앞으로 성공적인 온라인 비즈니스 운영을 위해 최선을 다해 지원하겠습니다.
  </p>
  ${mailBox(
    mailRow('사업자명', `<b>${obj.business_name}</b>`) +
    mailRow('사업자번호', obj.business_number) +
    mailRow('통신판매업신고번호', obj.mail_order_number) +
    mailRow('대표자', `${obj.ceo_name} / ${obj.ceo_phone}`) +
    mailRow('담당자', `${obj.manager_name} / ${obj.manager_phone}`) +
    mailRow('고객센터', obj.cs_phone) +
    mailRow('희망 URL', shopUrl || obj.desired_slug) +
    mailRow('프레임', obj.selected_frame)
  )}
`);

// 신청자(대표자/담당자) 수신용 — 승인/개설 완료 + 관리자 계정 안내
const buildApprovalHtml = ({ businessName, adminId, adminUrl, shopUrl, manualUrl }) => mailShell(`
  <h2 style="margin:0 0 8px;font-size:19px">가맹점 개설이 완료되었습니다 🎉</h2>
  <p style="margin:0 0 22px;font-size:14px;color:#555;line-height:1.75">
    <b>${businessName}</b> 님, 무료쇼핑몰 가맹점 개설이 완료되었습니다.<br>
    아래 관리자 정보로 로그인하여 <b>상품 등록부터</b> 바로 시작하실 수 있습니다.
  </p>
  ${mailBox(
    mailRow('관리자 페이지', `<a href="https://${adminUrl}" style="color:#1a73e8;text-decoration:none">${adminUrl}</a>`) +
    mailRow('쇼핑몰 주소', `<a href="https://${shopUrl}" style="color:#1a73e8;text-decoration:none">${shopUrl}</a>`) +
    mailRow('아이디', `<b>${adminId}</b>`) +
    mailRow('초기 비밀번호', `아이디와 동일 (<b>${adminId}</b>)`)
  )}
  <div style="background:#fff8e1;border:1px solid #ffe0a3;border-radius:8px;padding:12px 16px;margin-top:14px;font-size:13px;color:#8a5a00;line-height:1.7">
    ⚠ 보안을 위해 <b>로그인 후 반드시 비밀번호를 변경</b>해 주세요. (관리자 페이지 우측 상단 프로필 → 비밀번호 변경)
  </div>
  <p style="margin:22px 0 0">
    <a href="${manualUrl}" style="display:inline-block;background:#141414;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:700;font-size:14px">📘 운영 매뉴얼 보기</a>
  </p>
`);

const table_name = 'merchant_applications';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const BIZNO_RE = /^[0-9]{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_ID_RE = /^[a-zA-Z0-9_-]{3,20}$/; // 가맹점 관리자 로그인 아이디

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

// 마스터(본사) 브랜드 조회. 못 찾으면 null.
const getMasterBrand = async () => {
    const rootDomain = getRootDomain();
    if (!rootDomain) return null;
    const masterRes = await readPool.query(
        `SELECT id FROM brands WHERE dns=? AND is_main_dns=1 LIMIT 1`, [rootDomain]
    );
    return masterRes[0][0] || null;
};

// 본사(마스터) 전용 가드.
// ⚠ dns 쿠키는 '신원'이 아니다: GET /api/domain?dns=... 는 인증 없이 누구나 호출할 수 있어
//    가맹점 관리자(레벨40)도 [자기 로그인 토큰 + 마스터 dns 쿠키] 조합을 손쉽게 만들 수 있다.
//    따라서 isMasterManager(=지금 보고 있는 사이트가 마스터냐)만으로는 인가가 성립하지 않는다.
// → (1) 유효한 로그인 토큰, (2) 요구 레벨, (3) '본사 브랜드 소속' 또는 플랫폼 관리자(레벨50+)까지 확인한다.
//    가맹점 관리자는 brand_id가 자기 하위 브랜드이고 레벨이 40이므로 (3)에서 차단된다.
// 통과 시 { decode_user, master }(master는 못 찾으면 null), 실패 시 응답을 보내고 null 반환.
const requireMasterManager = async (req, res, minLevel = 10) => {
    const decode_user = checkLevel(req.cookies.token, minLevel, res);
    if (!decode_user || !isMasterManager(req)) {
        await response(req, res, -403, "권한이 없습니다", false);
        return null;
    }
    const master = await getMasterBrand();
    const isHqUser = decode_user?.level >= 50
        || (master && Number(decode_user?.brand_id) === Number(master.id));
    if (!isHqUser) {
        await response(req, res, -403, "권한이 없습니다", false);
        return null;
    }
    return { decode_user, master };
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
// adminId: 마스터가 가맹점과 협의해 지정하는 로그인 아이디(초기 비밀번호도 아이디와 동일).
const createSubBrandFromApplication = async (app, adminId) => {
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

    // 관리자 아이디 확정/검증을 브랜드 생성 '전에' 수행 (중복 시 반쪽 생성 방지)
    const finalAdminId = String(adminId || app.desired_slug || '').trim();
    if (!ADMIN_ID_RE.test(finalAdminId)) {
        throw new Error('관리자 아이디 형식이 올바르지 않습니다 (영문/숫자/-/_ 3~20자)');
    }
    const dupUser = await readPool.query(`SELECT id FROM users WHERE user_name=? LIMIT 1`, [finalAdminId]);
    if (dupUser[0]?.length > 0) {
        throw new Error('이미 사용 중인 아이디입니다: ' + finalAdminId);
    }

    // 이미 같은 dns 브랜드가 있으면 그걸 반환(중복 생성 방지)
    const dup = await readPool.query(`SELECT id FROM brands WHERE dns=? LIMIT 1`, [subDns]);
    if (dup[0]?.length > 0) return { brandId: dup[0][0].id, created: false, subDns, adminId: finalAdminId };

    const demo = frameToDemo(app.selected_frame);
    const setting_obj = JSON.stringify({
        max_use_point: '0', point_rate: '0', use_point_min_price: '0', tutorial_num: '0',
        shop_demo_num: demo.shop_demo_num, blog_demo_num: demo.blog_demo_num,
        is_use_seller: '0', is_use_consignment: '0', is_use_item_card_style: '0',
        is_use_lang: '1', lang_list: ['ko', 'en', 'ja', 'cn', 'es'], default_lang: 'ko', is_use_shop_obj_style: '0', is_use_blog_obj_style: '0',
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
        // 가맹점 관리자 계정 생성 (레벨40). 초기 비밀번호 = 아이디 → 가맹점이 로그인 후 변경.
        const pw = await createHashedPassword(finalAdminId);
        await insertQuery('users', encForSave('users', {
            user_name: finalAdminId,
            user_pw: pw.hashedPassword,
            user_salt: pw.salt,
            name: app.manager_name || app.business_name || finalAdminId,
            nickname: app.manager_name || app.business_name || finalAdminId,
            level: 40,
            brand_id: newBrandId,
            phone_num: app.manager_phone || app.ceo_phone || '',
        }));
    }
    return { brandId: newBrandId, adminId: finalAdminId, subDns, created: true };
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
            if (!ceo_email || !EMAIL_RE.test(ceo_email)) {
                return response(req, res, -103, "대표자 이메일을 정확히 입력해 주세요", false);
            }
            if (!manager_email || !EMAIL_RE.test(manager_email)) {
                return response(req, res, -104, "담당자 이메일을 정확히 입력해 주세요", false);
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

            // 운영사(마스터)에게 신청 알림 메일 (실패해도 접수는 성공 처리)
            // 수신자 = env MAIL_TO. 미설정 시에만 office@forspay.com으로 폴백.
            // (env를 '지우면' 폴백이 켜져 office로 감 → 테스트 시엔 MAIL_TO를 원하는 주소로 '지정'할 것)
            const operatorTo = process.env.MAIL_TO || 'office@forspay.com';
            logger.info(`[가맹점신청] 운영사 알림 수신자 → ${operatorTo} (env MAIL_TO=${process.env.MAIL_TO || '(미설정)'})`);
            sendMail({
                to: operatorTo,
                subject: `[ShopGo] 새 가맹점 신청 - ${obj.business_name}`,
                html: buildApplicationMailHtml(obj),
            }).catch(() => { });

            // 신청자(대표자+담당자)에게 접수 확인 메일 (실패해도 접수는 성공 처리)
            const applicantTo = [...new Set([obj.ceo_email, obj.manager_email].filter(Boolean))].join(',');
            if (applicantTo) {
                const rootDomain = getRootDomain();
                const shopUrl = rootDomain ? `${obj.desired_slug}.${rootDomain}` : obj.desired_slug;
                sendMail({
                    to: applicantTo,
                    subject: `[ShopGo] 무료쇼핑몰 신청이 접수되었습니다 - ${obj.business_name}`,
                    html: buildApplicantReceiptHtml(obj, shopUrl),
                }).catch(() => { });
            }

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
            if (!await requireMasterManager(req, res)) return;
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
            const auth = await requireMasterManager(req, res);
            if (!auth) return;
            const { master } = auth;
            const { s_dt, e_dt } = req.query;
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
            // 가맹점 관리자(레벨40) 계정은 상관 서브쿼리로 가져온다.
            // - 브랜드당 레벨40이 여러 개여도 항상 1행(id 최소값)만 나오도록 ORDER BY id ASC LIMIT 1.
            // - 관리자가 없는 브랜드는 NULL.
            // - JOIN이 아닌 서브쿼리라서 매출 SUM/COUNT가 부풀지 않고 GROUP BY도 그대로 유효하다
            //   (서브쿼리는 GROUP BY 키인 b.id에만 의존 → ONLY_FULL_GROUP_BY 안전).
            // - user_name(아이디)은 암호화 대상이 아니라 반환 가능. name/phone_num/비밀번호 해시는 절대 반환하지 않는다.
            const sql = `
                SELECT b.id, b.name, b.dns, b.created_at, b.logo_img,
                       COALESCE(SUM(t.amount), 0) AS sales,
                       COUNT(t.id) AS order_count,
                       (SELECT u.id        FROM users u WHERE u.brand_id=b.id AND u.level=40 AND u.is_delete=0 ORDER BY u.id ASC LIMIT 1) AS admin_user_id,
                       (SELECT u.user_name FROM users u WHERE u.brand_id=b.id AND u.level=40 AND u.is_delete=0 ORDER BY u.id ASC LIMIT 1) AS admin_user_name
                FROM brands b
                LEFT JOIN transactions t
                  ON t.brand_id = b.id AND t.trx_status >= 5 AND t.is_cancel = 0${joinDate}
                WHERE b.parent_id = ? AND b.is_delete = 0
                GROUP BY b.id, b.name, b.dns, b.created_at, b.logo_img
                ORDER BY sales DESC, b.created_at DESC`;
            const rows = (await readPool.query(sql, params))[0];
            // 가맹점 관리자 연락처(users.phone_num)는 AES 암호화 저장이라 위 SQL의 서브쿼리로 뽑으면 암호문이 그대로 나온다.
            // → 브랜드 id들을 모아 '한 번만' 조회한 뒤 decRows('users', ...)로 복호화해서 매핑한다(N+1 방지).
            // ⚠ 조회 컬럼은 id/brand_id/user_name/phone_num 뿐 — user_pw/user_salt/otp_token 등 자격증명은 애초에 SELECT하지 않는다.
            const brandIds = rows.map((r) => r.id);
            const adminInfoByBrand = {};
            if (brandIds.length > 0) {
                const ph = brandIds.map(() => '?').join();
                const adminRows = (await readPool.query(
                    `SELECT id, brand_id, user_name, name, phone_num FROM users
                     WHERE brand_id IN (${ph}) AND level=40 AND is_delete=0 ORDER BY id ASC`,
                    brandIds
                ))[0];
                decRows('users', adminRows); // 실명·전화번호 복호화(평문/암호문 자동판별)
                // 브랜드당 id 최소값 1건만 사용 → 목록의 admin_user_id·비밀번호 초기화 대상과 '같은 계정'의 정보가 된다.
                // (ORDER BY id ASC 이므로 먼저 만나는 행이 최소 id)
                adminRows.forEach((u) => {
                    if (adminInfoByBrand[u.brand_id] === undefined) {
                        adminInfoByBrand[u.brand_id] = {
                            name: u.name || null,
                            phone_num: u.phone_num || null,
                        };
                    }
                });
            }
            const merchants = rows.map((r) => ({
                id: r.id,
                name: r.name,
                dns: r.dns,
                created_at: r.created_at,
                logo_img: r.logo_img,
                sales: Number(r.sales) || 0,
                order_count: Number(r.order_count) || 0,
                admin_user_id: r.admin_user_id ?? null,
                admin_user_name: r.admin_user_name ?? null,
                // 레벨40 관리자가 없는 브랜드는 admin_user_id와 동일하게 null.
                // admin_name(실명)은 '아이디 찾기'가 매칭에 쓰는 값이라, 비어 있으면 그 계정은
                // 아이디 찾기가 불가능하다 → 본사가 화면에서 바로 알아볼 수 있도록 함께 내려준다.
                admin_name: adminInfoByBrand[r.id]?.name ?? null,
                admin_phone_num: adminInfoByBrand[r.id]?.phone_num ?? null,
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
            const auth = await requireMasterManager(req, res);
            if (!auth) return;
            const { master } = auth;
            const { id } = req.params;
            const { s_dt, e_dt } = req.query;
            if (!master) {
                return response(req, res, -404, "마스터 브랜드를 찾을 수 없습니다", false);
            }
            // 대상이 마스터의 하위 가맹점인지 검증 (무관 브랜드 조회 차단)
            // brands.phone_num = 쇼핑몰 자체 고객센터 번호(공개용). PII_FIELDS에 brands가 없으므로 평문 → 복호화 불필요.
            const brandRes = await readPool.query(
                `SELECT id, name, dns, created_at, phone_num FROM brands WHERE id=? AND parent_id=? AND is_delete=0 LIMIT 1`,
                [id, master.id]
            );
            const brand = brandRes[0][0];
            if (!brand) {
                return response(req, res, -403, "해당 가맹점을 조회할 권한이 없습니다", false);
            }

            // 가맹점 관리자(레벨40) 계정 연락처 — 목록/비밀번호 초기화와 동일 기준(id 최소값 1건).
            // users.name/phone_num은 암호화 저장이므로 decRow('users', ...)로 복호화한다.
            // ⚠ 자격증명(user_pw/user_salt/otp_token)은 SELECT 자체를 하지 않는다.
            const adminRes = await readPool.query(
                `SELECT id, user_name, name, phone_num FROM users WHERE brand_id=? AND level=40 AND is_delete=0 ORDER BY id ASC LIMIT 1`,
                [brand.id]
            );
            const admin = decRow('users', adminRes[0][0]);
            brand.admin_user_id = admin?.id ?? null;
            brand.admin_user_name = admin?.user_name ?? null;
            // 실명(name)은 '아이디 찾기'의 매칭 기준이라 비어 있으면 그 계정은 아이디 찾기가 불가능하다.
            brand.admin_name = admin?.name || null;
            brand.admin_phone_num = admin?.phone_num || null;

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
            decRows('transactions', orders); // 주문자명 복호화

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

    // 매니저 전용(본사/마스터): 하위 가맹점 관리자(레벨40) 비밀번호를 "본인 아이디"로 초기화.
    // 개설 시 초기 비밀번호 규칙(비밀번호=아이디)과 동일하게 되돌리는 동작.
    // 마스터의 하위 가맹점만 대상 → 무관한 브랜드 계정 초기화 차단.
    resetMerchantAdminPassword: async (req, res, next) => {
        try {
            // 다른 가맹점 계정을 탈취할 수 있는 동작이므로 관리자급(40+) 본사 계정만 허용.
            const auth = await requireMasterManager(req, res, 40);
            if (!auth) return;
            const { decode_user, master } = auth;
            const { id } = req.params;
            if (!master) {
                return response(req, res, -404, "마스터 브랜드를 찾을 수 없습니다", false);
            }
            // 대상이 마스터의 하위 가맹점인지 검증 (무관 브랜드 초기화 차단)
            const brandRes = await readPool.query(
                `SELECT id, name, dns FROM brands WHERE id=? AND parent_id=? AND is_delete=0 LIMIT 1`,
                [id, master.id]
            );
            const brand = brandRes[0][0];
            if (!brand) {
                return response(req, res, -100, "가맹점을 찾을 수 없습니다.", false);
            }
            // 해당 가맹점의 관리자(레벨40) 계정 — 여러 개면 id 최소값 1개 (목록 API와 동일 기준)
            const adminRes = await readPool.query(
                `SELECT id, user_name FROM users WHERE brand_id=? AND level=40 AND is_delete=0 ORDER BY id ASC LIMIT 1`,
                [brand.id]
            );
            const admin = adminRes[0][0];
            if (!admin || !admin.user_name) {
                return response(req, res, -100, "가맹점 관리자 계정을 찾을 수 없습니다.", false);
            }
            // 초기화 값 = 관리자 본인 아이디(user_name). salt도 새로 발급해 user_pw와 함께 갱신.
            const pw_data = await createHashedPassword(admin.user_name);
            await updateQuery('users', {
                user_pw: pw_data.hashedPassword,
                user_salt: pw_data.salt,
            }, admin.id);
            // 감사 로그: 누가 어떤 가맹점의 어떤 계정을 초기화했는지
            logger.info(`[merchant-admin-pw-reset] by user_id=${decode_user?.id} (level=${decode_user?.level}) ip=${extractIp(req)} -> brand_id=${brand.id} (${brand.dns}) target_user_id=${admin.id} user_name=${admin.user_name}`);
            return response(req, res, 100, "success", { user_name: admin.user_name });
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
            if (!await requireMasterManager(req, res)) return;
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
            if (!await requireMasterManager(req, res)) return;
            const { id, status, memo, brand_id, admin_id } = req.body;
            if (!id || !status) {
                return response(req, res, -100, "필수 항목이 누락되었습니다", false);
            }
            if (!['pending', 'approved', 'rejected'].includes(status)) {
                return response(req, res, -100, "상태값이 올바르지 않습니다", false);
            }
            const obj = { status };
            if (memo !== undefined) obj.memo = memo;
            if (brand_id !== undefined) obj.brand_id = brand_id;

            let app = null;
            let approval = null;
            // 승인 시: 아직 연결된 brand가 없으면 하위 가맹점 자동 생성
            if (status === 'approved') {
                const appRes = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id]);
                app = appRes[0][0];
                if (!app) {
                    return response(req, res, -100, "신청 내역을 찾을 수 없습니다", false);
                }
                if (!app.brand_id && !brand_id) {
                    try {
                        approval = await createSubBrandFromApplication(app, admin_id);
                        if (approval?.brandId) obj.brand_id = approval.brandId;
                    } catch (e) {
                        logger.error('sub-brand 생성 실패: ' + (e?.message || e));
                        return response(req, res, -110, e?.message || "하위 가맹점 생성 실패", false);
                    }
                }
            }

            await updateQuery(`${table_name}`, obj, id);

            // 신규 개설된 경우 신청자(대표자+담당자)에게 승인/계정 안내 메일 (실패해도 승인은 성공)
            if (approval?.created && app) {
                const rootDomain = getRootDomain();
                const applicantTo = [...new Set([app.ceo_email, app.manager_email].filter(Boolean))].join(',');
                if (applicantTo) {
                    sendMail({
                        to: applicantTo,
                        subject: `[ShopGo] 가맹점 개설이 완료되었습니다 - ${app.business_name}`,
                        html: buildApprovalHtml({
                            businessName: app.business_name,
                            adminId: approval.adminId,
                            adminUrl: `${approval.subDns}/manager`,
                            shopUrl: approval.subDns,
                            manualUrl: rootDomain ? `https://${rootDomain}/manual` : '/manual',
                        }),
                    }).catch(() => { });
                }
            }

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
            if (!await requireMasterManager(req, res)) return;
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
