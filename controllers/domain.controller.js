"use strict";
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { checkLevel, makeUserToken, response } from "../utils.js/util.js";
import "dotenv/config";
import logger from "../utils.js/winston/index.js";
const domainCtrl = {
  get: async (req, res, next) => {

    try {
      const {
        dns,
        product_id = -1,
        post_id = -1,
        seller_id = -1,
      } = req.query;
      let columns = [
        "id",
        "name",
        "dns",
        "logo_img",
        "dark_logo_img",
        "favicon_img",
        "og_img",
        "og_description",
        "theme_css",
        //"slider_css",
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
      ];
      //console.log(req.query);
      let brand = await pool.query(
        `SELECT ${columns.join()} FROM brands WHERE (dns='${dns}' OR admin_dns='${dns}') AND is_delete=0`
        //`SELECT ${columns.join()} FROM brands WHERE id=66`
      );
      //console.log(brand);

      if (brand?.result.length == 0) {
        return response(req, res, -120, "등록된 도메인이 아닙니다.", false);
      }
      brand = brand?.result[0];
      brand["theme_css"] = JSON.parse(brand?.theme_css ?? "{}");
      //brand["slider_css"] = JSON.parse(brand?.slider_css ?? "{}");
      brand["setting_obj"] = JSON.parse(brand?.setting_obj ?? "{}");
      brand["none_use_column_obj"] = JSON.parse(brand?.none_use_column_obj ?? "{}");
      brand["bonaeja_obj"] = JSON.parse(brand?.bonaeja_obj ?? "{}");
      brand["seo_obj"] = JSON.parse(brand?.seo_obj ?? "{}");

      const token = await makeUserToken(brand);
      await res.cookie("dns", token, {
        httpOnly: true,
        maxAge: 60 * 60 * 1000 * 3,
        //sameSite: 'none',
        //secure: true
      });
      brand.ssr_content = {};
      if (product_id > 0) {
        let product = await pool.query(`SELECT * FROM products WHERE id=${product_id} AND brand_id=${brand?.id}`);
        product = product?.result[0];
        if (product) {
          brand.name = `${brand?.name} - ${product?.product_name}`;
          brand.og_img = `${product?.product_img}`;
          brand.og_description = `${product?.product_comment}`;
        }
      } else if (post_id > 0) {
        let post = await pool.query(`SELECT posts.* FROM posts LEFT JOIN post_categories ON posts.category_id=post_categories.id WHERE posts.id=${post_id} AND post_categories.brand_id=${brand?.id}`);
        post = post?.result[0];
        brand.name = `${brand?.name} - ${post?.post_title}`;
      } else if (seller_id > 0) {
        let seller = await pool.query(`SELECT * FROM users WHERE id=${seller_id} AND brand_id=${brand?.id} AND level>=10`);
        seller = seller?.result[0];

        brand.name = `${brand?.name} - ${seller?.nickname}`;
        brand.og_img = `${seller?.profile_img}`;
        brand.og_description = `${seller?.seller_name}`;
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
