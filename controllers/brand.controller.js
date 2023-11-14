"use strict";
import axios from "axios";
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import {
  deleteQuery,
  getSelectQueryList,
  insertQuery,
  updateQuery,
} from "../utils.js/query-util.js";
import {
  checkDns,
  checkLevel,
  createHashedPassword,
  lowLevelException,
  response,
  settingFiles,
} from "../utils.js/util.js";
import "dotenv/config";
import logger from "../utils.js/winston/index.js";

const table_name = "brands";

const brandCtrl = {
  list: async (req, res, next) => {
    try {
      let is_manager = await checkIsManagerUrl(req);
      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { } = req.query;
      let columns = [`${table_name}.*`];
      let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
      if (decode_dns?.is_main_dns != 1) {
        sql += `WHERE id=${decode_dns?.id ?? 0}`;
      }
      let data = await getSelectQueryList(sql, columns, req.query);
      let setting_list = await axios.get(`${process.env.SETTING_SITEMAP_URL}/api/setting-check-list`);
      setting_list = setting_list?.data?.data
      for (var i = 0; i < data.content.length; i++) {
        let brand = data.content[i]
        if (setting_list['letsencrypt_files'].includes(brand?.dns) && setting_list['letsencrypt_files'].includes(brand?.dns)) {
          data.content[i].is_linux_setting_confirm = 1;
        }
      }

      return response(req, res, 100, "success", data);
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
  get: async (req, res, next) => {
    try {
      let is_manager = await checkIsManagerUrl(req);
      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { id } = req.params;
      let data = await pool.query(`SELECT * FROM ${table_name} WHERE id=${id}`);
      data = data?.result[0];
      data["theme_css"] = JSON.parse(data?.theme_css ?? "{}");
      data["setting_obj"] = JSON.parse(data?.setting_obj ?? "{}");
      data["shop_obj"] = JSON.parse(data?.shop_obj ?? "[]");
      data["blog_obj"] = JSON.parse(data?.blog_obj ?? "[]");
      data["seo_obj"] = JSON.parse(data?.seo_obj ?? "{}");

      return response(req, res, 100, "success", data);
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
  create: async (req, res, next) => {
    // 50레벨이상 관리자 url만
    try {
      let is_manager = await checkIsManagerUrl(req);
      const decode_user = checkLevel(req.cookies.token, 50);
      if (!decode_user) {
        return lowLevelException(req, res);
      }
      const decode_dns = checkDns(req.cookies.dns);
      const {
        logo_img,
        dark_logo_img,
        favicon_img,
        og_img,
        name,
        dns,
        og_description,
        company_name,
        business_num,
        pvcy_rep_name,
        ceo_name,
        addr,
        resident_num,
        phone_num,
        fax_num,
        note,
        theme_css = {},
        setting_obj = {},
        shop_obj = [],
        blog_obj = [],
        seo_obj = {},
        user_name,
        user_pw,
        seller_name,
      } = req.body;
      let files = settingFiles(req.files);
      let obj = {
        logo_img,
        dark_logo_img,
        favicon_img,
        og_img,
        name,
        dns,
        og_description,
        company_name,
        business_num,
        pvcy_rep_name,
        ceo_name,
        addr,
        resident_num,
        phone_num,
        fax_num,
        note,
        theme_css,
        setting_obj,
        shop_obj,
        blog_obj,
        seo_obj,
      };
      obj["theme_css"] = JSON.stringify(obj.theme_css);
      obj["setting_obj"] = JSON.stringify(obj.setting_obj);
      obj["shop_obj"] = JSON.stringify(obj.shop_obj);
      obj["blog_obj"] = JSON.stringify(obj.blog_obj);
      obj["seo_obj"] = JSON.stringify(obj.seo_obj);
      obj = { ...obj, ...files };
      await db.beginTransaction();

      let result = await insertQuery(`${table_name}`, obj);
      let user_obj = {
        user_name: user_name,
        user_pw: user_pw,
        name: seller_name,
        nickname: seller_name,
        seller_name: seller_name,
        level: 40,
        brand_id: result?.result?.insertId,
      };
      let pw_data = await createHashedPassword(user_obj.user_pw);
      user_obj.user_pw = pw_data.hashedPassword;
      let user_salt = pw_data.salt;
      user_obj["user_salt"] = user_salt;
      let user_sign_up = await insertQuery("users", user_obj);
      await db.commit();
      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      await db.rollback();
      return response(req, res, -200, "서버 에러 발생", false);
    }
  },
  update: async (req, res, next) => {
    // 40레벨일시 자기 브랜드 수정, 50레벨일시 모든 브랜드 수정가능
    try {
      let is_manager = await checkIsManagerUrl(req);
      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const {
        logo_img,
        dark_logo_img,
        favicon_img,
        og_img,
        name,
        dns,
        og_description,
        company_name,
        business_num,
        pvcy_rep_name,
        ceo_name,
        addr,
        resident_num,
        phone_num,
        fax_num,
        note,
        theme_css = {},
        setting_obj = {},
        shop_obj = [],
        blog_obj = [],
        seo_obj = {},
      } = req.body;
      const { id } = req.params;
      if (
        (decode_user?.level < 50 && decode_user?.brand_id != id) ||
        decode_user?.level < 40
      ) {
        return lowLevelException(req, res);
      }
      let files = settingFiles(req.files);

      let obj = {
        logo_img,
        dark_logo_img,
        favicon_img,
        og_img,
        name,
        dns,
        og_description,
        company_name,
        business_num,
        pvcy_rep_name,
        ceo_name,
        addr,
        resident_num,
        phone_num,
        fax_num,
        note,
        theme_css,
        setting_obj,
        shop_obj,
        blog_obj,
        seo_obj,
      };
      obj["theme_css"] = JSON.stringify(obj.theme_css);
      obj["setting_obj"] = JSON.stringify(obj.setting_obj);
      obj["shop_obj"] = JSON.stringify(obj.shop_obj);
      obj["blog_obj"] = JSON.stringify(obj.blog_obj);
      obj["seo_obj"] = JSON.stringify(obj.seo_obj);
      obj = { ...obj, ...files };

      let result = await updateQuery(`${table_name}`, obj, id);
      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
  remove: async (req, res, next) => {
    try {
      let is_manager = await checkIsManagerUrl(req);
      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { id } = req.params;
      let result = await deleteQuery(`${table_name}`, {
        id,
      });
      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, "서버 에러 발생", false);
    } finally {
    }
  },
  design: {
    get: async (req, res, next) => {
      try {
        let is_manager = await checkIsManagerUrl(req);
        const decode_user = checkLevel(req.cookies.token, 0, res);
        const decode_dns = checkDns(req.cookies.dns);
        const { id } = req.params;
        console.log(id);
        let files = settingFiles(req.files);

        return response(req, res, 100, "success", {});
      } catch (err) {
        console.log(err);
        logger.error(JSON.stringify(err?.response?.data || err));
        return response(req, res, -200, "서버 에러 발생", false);
      } finally {
      }
    },
    update: async (req, res, next) => {
      try {
        let is_manager = await checkIsManagerUrl(req);
        const decode_user = checkLevel(req.cookies.token, 0, res);
        const decode_dns = checkDns(req.cookies.dns);
        const { id } = req.params;
        console.log(id);
        let files = settingFiles(req.files);

        return response(req, res, 100, "success", {});
      } catch (err) {
        console.log(err);
        logger.error(JSON.stringify(err?.response?.data || err));
        return response(req, res, -200, "서버 에러 발생", false);
      } finally {
      }
    },
  },
};

export default brandCtrl;
