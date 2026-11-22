"use strict";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { checkLevel, makeUserToken, makeDnsToken, response, 공개용브랜드, 서버오류문구 } from "../utils.js/util.js";
import "dotenv/config";
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js"; // ← 추가

const domainCtrl = {
  get: async (req, res, next) => {
    try {
      const {
        dns,
        product_id = -1,
        post_id = -1,
        seller_id = -1,
      } = req.query;

      if (!dns) {
        return response(req, res, -400, "dns 값이 필요합니다.", false);
      }

      // product_id/post_id/seller_id가 없을 때만 "순수 도메인 정보"로 보고 캐시
      const CACHEABLE =
        Number(product_id) <= 0 &&
        Number(post_id) <= 0 &&
        Number(seller_id) <= 0;

      const cacheKey = `domain:${dns}`;
      // 검색엔진용 상품 목록(몰 첫 화면·전체 상품 목록에서만 _app 이 요청). 쿠키·도메인 캐시에는 안 넣고 응답에만 붙인다.
      const 상품목록포함 = Number(req.query.with_products) === 1;

      // 1) 캐시 먼저 조회
      if (CACHEABLE && redisClient?.isOpen) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            const brand = 공개용브랜드(JSON.parse(cached)); // 옛 캐시에 비공개 칸이 남아 있어도 내보내지 않는다

            const token = makeDnsToken(brand); // dns 전용 토큰(kind:'dns') — 사용자 토큰으로 못 쓰게
            await res.cookie("dns", token, {
              httpOnly: true,
              maxAge: 60 * 60 * 1000 * 3,
              sameSite: 'lax',
              secure: process.env.NODE_ENV !== 'development',
            });

            return response(req, res, 100, "success(cache)", 상품목록포함 ? await 상품목록붙이기(brand) : brand);
          }
        } catch (e) {
          console.error("Redis get error (domain):", e);
          // 캐시 문제 나도 DB로 계속 진행
        }
      }

      // ===== 기존 DB 로직 =====

      const columns = [
        "id",
        "name",
        "dns",
        "logo_img",
        "dark_logo_img",
        "favicon_img",
        "og_img",
        "og_description",
        "theme_css",
        "setting_obj",
        "none_use_column_obj",
        "seo_obj",
        "is_main_dns",
        "company_name",
        "business_num",
        "ceo_name",
        "pvcy_rep_name",
        "addr",
        "phone_num",
        "fax_num",
        "establish_date",
        "mail_order_num",
        "show_basic_info",
        "is_use_otp",
        "is_closure",
        "parent_id",
        // 약관·개인정보처리방침의 시행일자로 쓴다. 관리자에서 손으로 넣는 establish_date 는
        // 대부분 비어 있어 "이 약관은 (빈칸)부터 시행합니다" 로 나갔다 — 가맹점 등록일을 쓴다.
        "created_at",
      ];

      const columns_seller = [
        "id",
        "brand_id",
        "is_delete",
        "user_name",
        "name",
        "nickname",
        "parent_id",
        "level",
        "dns",
        "oper_id",
        "seller_trx_fee",
        "seller_trx_fee_type",
        "seller_point",
        "seller_logo_img",
        "seller_color",
        "seller_demo_num",
      ];

      // 셀러몰인지 확인 (users.dns)
      const [sellerRows] = await readPool.query(
        `SELECT ${columns_seller.join()} FROM users WHERE dns = ? AND is_delete = 0`,
        [dns]
      );

      let brandRows;

      if (sellerRows.length === 0) {
        // 일반 브랜드 도메인
        [brandRows] = await readPool.query(
          `SELECT ${columns.join()} FROM brands WHERE (dns = ? OR admin_dns = ?) AND is_delete = 0`, [dns, dns]
          //`SELECT ${columns.join()} FROM brands WHERE id=74`
        );
        if (brandRows.length === 0) {
          return response(req, res, -120, "등록된 도메인이 아닙니다.", false);
        }
      } else {
        // 셀러몰 도메인
        const sellerBrandId = sellerRows[0].brand_id;
        [brandRows] = await readPool.query(
          `SELECT ${columns.join()} FROM brands WHERE id = ? AND is_delete = 0`,
          [sellerBrandId]
        );
        if (brandRows.length === 0) {
          return response(req, res, -120, "등록된 도메인이 아닙니다.", false);
        }
      }

      let brand = brandRows[0];

      // JSON 파싱 (문자 발송 키 bonaeja_obj·주민등록번호 resident_num 은 공개 응답이라 아예 읽지 않는다 — util.js DNS_비공개칸)
      brand.theme_css = JSON.parse(brand?.theme_css ?? "{}");
      brand.setting_obj = JSON.parse(brand?.setting_obj ?? "{}");
      brand.none_use_column_obj = JSON.parse(brand?.none_use_column_obj ?? "{}");
      brand.seo_obj = JSON.parse(brand?.seo_obj ?? "{}");

      // 셀러몰인 경우 셀러 정보 반영
      if (sellerRows.length > 0) {
        const seller = sellerRows[0];

        brand.seller_id = seller.id;
        brand.oper_id = seller.oper_id;
        brand.seller_point = seller.seller_point;

        if (seller.seller_logo_img) {
          brand.logo_img = seller.seller_logo_img;
        }
        if (seller.seller_color) {
          brand.theme_css.main_color = seller.seller_color;
        }
        if (seller.seller_demo_num) {
          brand.setting_obj = brand.setting_obj || {};
          if (seller.seller_demo_num == 1) {
            brand.setting_obj.shop_demo_num = 4;
          }
          if (seller.seller_demo_num == 2) {
            brand.setting_obj.shop_demo_num = 9;
          }
        }
      }

      // ssr_content 및 product/post/seller에 따른 타이틀/OG 수정
      brand.ssr_content = {};

      if (product_id > 0) {
        // 지운 상품·숨긴 상품(status 5)은 손님 화면에도 안 나오므로 제목·검색 정보도 만들지 않는다.
        const [productRows] = await readPool.query(
          `SELECT id, product_name, product_img, product_comment, product_price, product_sale_price, status
             FROM products WHERE id = ? AND brand_id = ? AND is_delete = 0 AND status != 5`,
          [product_id, brand.id]
        );
        const product = productRows[0];
        if (product) {
          const 몰이름 = brand.name;
          brand.name = `${brand.name} - ${product.product_name}`;
          if (product.product_img) brand.og_img = `${product.product_img}`;
          // 한 줄 소개가 비면(null 이면 예전엔 문자열 "null" 이 나갔다) 몰 소개를 그대로 둔다 — 화면(_app)이 다시 채운다.
          if (String(product.product_comment ?? '').trim()) brand.og_description = `${product.product_comment}`;
          // 검색엔진용 상품 정보(_app 이 schema.org Product 로 그린다). 가격은 손님 화면과 같은 판매가.
          brand.ssr_content.product = {
            id: product.id,
            name: product.product_name,
            img: product.product_img || '',
            comment: String(product.product_comment ?? '').trim(),
            price: Number(product.product_sale_price) || 0,
            list_price: Number(product.product_price) || 0,
            status: Number(product.status),
            shop_name: 몰이름,
          };
        } else {
          // 없는 상품(지움·숨김·다른 몰 상품) — 프론트가 404 로 응답하게 알린다(2026-11-19).
          // 상세 API(product.controller get, IS_RETURN)와 같은 조건이라 손님이 보는 상품을 404 로 만들 일은 없다.
          // 그대로 두면 「상품을 찾을 수 없음」 화면이 200 으로 나가 구글이 soft 404 로 잡는다.
          brand.ssr_content.product_missing = true;
        }
      } else if (post_id > 0) {
        const [postRows] = await readPool.query(
          `SELECT posts.* 
           FROM posts 
           LEFT JOIN post_categories ON posts.category_id = post_categories.id 
           WHERE posts.id = ? AND post_categories.brand_id = ?`,
          [post_id, brand.id]
        );
        const post = postRows[0];
        if (post) {
          brand.name = `${brand.name} - ${post.post_title}`;
        }
      } else if (seller_id > 0) {
        const [sellerDetailRows] = await readPool.query(
          `SELECT * FROM users WHERE id = ? AND brand_id = ? AND level >= 10`,
          [seller_id, brand.id]
        );
        const sellerDetail = sellerDetailRows[0];
        if (sellerDetail) {
          brand.name = `${brand.name} - ${sellerDetail.nickname}`;
          brand.og_img = `${sellerDetail.profile_img}`;
          brand.og_description = `${sellerDetail.seller_name}`;
        }
      }

      // 쿠키 세팅
      const token = makeDnsToken(brand); // dns 전용 토큰(kind:'dns') — 사용자 토큰으로 못 쓰게
      await res.cookie("dns", token, {
        httpOnly: true,
        maxAge: 60 * 60 * 1000 * 3,
        sameSite: 'lax',
        secure: process.env.NODE_ENV !== 'development',
      });

      // 3) 캐시 가능한 경우 Redis에 저장
      if (CACHEABLE && redisClient?.isOpen) {
        try {
          await redisClient.set(cacheKey, JSON.stringify(brand), {
            EX: 300, // 5분
          });
        } catch (e) {
          console.error("Redis set error (domain):", e);
        }
      }

      return response(req, res, 100, "success", 상품목록포함 ? await 상품목록붙이기(brand) : brand);
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, 서버오류문구(err), false);
    } finally {
    }
  },

  // 검색엔진에 알릴 몰 주소 목록 — 샵고 메인 사이트맵(sitemap.xml)이 각 몰 사이트맵을 묶는 데 쓴다.
  //
  // 대상: 본사(MAIN_FRONT_URL + is_main_dns=1) 아래 몰 중 지우지·닫지 않았고 「검색 노출」이 켜진 몰.
  //   검색 노출 끔 = seo_obj.search_hidden 참(관리자 SEO설정 탭, 본사만). 값이 없으면 켜짐 — 새 몰은 기본 노출.
  //   본사 아래로 한정하는 까닭: 이 DB 는 다른 프로젝트 브랜드와 함께 쓴다(그쪽 도메인은 우리 서버에 없다).
  // 공개 응답이다 — 이미 누구나 열 수 있는 몰 주소만 내보내고 다른 칸은 싣지 않는다.
  searchBrands: async (req, res, next) => {
    try {
      const 메인 = String(process.env.MAIN_FRONT_URL || '').replace(/^www\./, '');
      if (!메인) return response(req, res, 100, "success", []);
      const [rows] = await readPool.query(
        `SELECT b.dns, b.seo_obj FROM brands b
           JOIN brands m ON m.id = b.parent_id AND m.dns = ? AND m.is_main_dns = 1 AND m.is_delete = 0
          WHERE b.is_delete = 0 AND b.is_closure = 0 AND b.dns IS NOT NULL AND b.dns != ''
          ORDER BY b.id`, [메인]);
      const 목록 = rows
        .filter((r) => !검색막힘(r.seo_obj))
        .map((r) => String(r.dns).trim().toLowerCase())
        .filter((d) => /^[a-z0-9.-]+$/.test(d) && d.includes('.'));
      return response(req, res, 100, "success", 목록);
    } catch (err) {
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, 서버오류문구(err), false);
    }
  },
};

// 검색엔진용 상품 목록 — 몰 첫 화면·전체 상품 목록의 서버 HTML 에 상품명·가격·링크를 글로 싣는 데 쓴다(_app 검색용본문).
//   손님 화면에서 지운 상품·숨긴 상품(status 5)은 뺀다. 최신 40개. 「검색엔진 노출」을 끈 몰은 붙이지 않는다.
//   몰마다 5분 캐시(상품을 고쳐도 최대 5분 뒤 반영 — 검색엔진용이라 충분하다).
const 상품목록최대 = 40;
const 상품목록붙이기 = async (brand) => {
  if (!(brand?.id > 0) || 검색막힘(brand?.seo_obj)) return brand;
  const 키 = `domain-products:${brand.id}`;
  let 목록 = null;
  if (redisClient?.isOpen) {
    try { const c = await redisClient.get(키); if (c) 목록 = JSON.parse(c); } catch (e) { /* 캐시 문제면 DB 로 */ }
  }
  if (!목록) {
    try {
      const [rows] = await readPool.query(
        `SELECT id, product_name, product_sale_price, product_price, status FROM products
          WHERE brand_id = ? AND is_delete = 0 AND status != 5
          ORDER BY id DESC LIMIT ?`, [brand.id, 상품목록최대]);
      목록 = rows.map((p) => ({ id: p.id, name: p.product_name, price: Number(p.product_sale_price) || 0, list_price: Number(p.product_price) || 0, status: Number(p.status) }));
      if (redisClient?.isOpen) { try { await redisClient.set(키, JSON.stringify(목록), { EX: 300 }); } catch (e) { /* 무시 */ } }
    } catch (e) {
      logger.error('domain products: ' + (e?.message || e));
      return brand; // 목록을 못 만들어도 몰 정보는 그대로 준다
    }
  }
  return { ...brand, ssr_content: { ...(brand.ssr_content || {}), products: 목록 } };
};

// seo_obj 는 문자열(varchar)로 저장돼 있다. 깨진 값이면 막지 않은 것으로 본다(기본=노출).
export const 검색막힘 = (seo_obj) => {
  let o = seo_obj;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
  const v = o?.search_hidden;
  return v === true || v === 1 || v === '1' || v === 'true';
};

export default domainCtrl;
