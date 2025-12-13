"use strict";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { checkLevel, makeUserToken, response } from "../utils.js/util.js";
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

      // 1) 캐시 먼저 조회
      if (CACHEABLE && redisClient?.isOpen) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            const brand = JSON.parse(cached);

            const token = await makeUserToken(brand);
            await res.cookie("dns", token, {
              httpOnly: true,
              maxAge: 60 * 60 * 1000 * 3,
            });

            return response(req, res, 100, "success(cache)", brand);
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
        "bonaeja_obj",
        "seo_obj",
        "is_main_dns",
        "company_name",
        "business_num",
        "resident_num",
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
          //`SELECT ${columns.join()} FROM brands WHERE (dns = ? OR admin_dns = ?) AND is_delete = 0`, [dns, dns]
          `SELECT ${columns.join()} FROM brands WHERE id=74`
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

      // JSON 파싱
      brand.theme_css = JSON.parse(brand?.theme_css ?? "{}");
      brand.setting_obj = JSON.parse(brand?.setting_obj ?? "{}");
      brand.none_use_column_obj = JSON.parse(brand?.none_use_column_obj ?? "{}");
      brand.bonaeja_obj = JSON.parse(brand?.bonaeja_obj ?? "{}");
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
        const [productRows] = await readPool.query(
          `SELECT * FROM products WHERE id = ? AND brand_id = ?`,
          [product_id, brand.id]
        );
        const product = productRows[0];
        if (product) {
          brand.name = `${brand.name} - ${product.product_name}`;
          brand.og_img = `${product.product_img}`;
          brand.og_description = `${product.product_comment}`;
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
      const token = await makeUserToken(brand);
      await res.cookie("dns", token, {
        httpOnly: true,
        maxAge: 60 * 60 * 1000 * 3,
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

      return response(req, res, 100, "success", brand);
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
};

export default domainCtrl;
