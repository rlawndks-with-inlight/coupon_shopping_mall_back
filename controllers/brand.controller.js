"use strict";
import {
  deleteQuery,
  getSelectQueryList,
  insertQuery,
  updateQuery,
} from "../utils.js/query-util.js";
import { redisClient } from "../config/redis-client.js";
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
import { brandSettingLang } from "../utils.js/schedules/lang-process.js";
import speakeasy from 'speakeasy';
import { readPool } from "../config/db-pool.js";
import { encForSave } from "../utils.js/pii.js";

const table_name = "brands";

const brandCtrl = {
  list: async (req, res, next) => {
    try {
      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { } = req.query;
      let columns = [`${table_name}.*`];
      let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
      let params = [];
      if (decode_dns?.is_main_dns != 1) {
        sql += `WHERE id=?`;
        params.push(decode_dns?.id ?? 0);
      }
      let data = await getSelectQueryList(sql, columns, req.query, [], params);
      /*
      let setting_list = await axios.get(`${process.env.SETTING_SITEMAP_URL}/api/setting-check-list`);
      setting_list = setting_list?.data?.data
      for (var i = 0; i < data.content.length; i++) {
        let brand = data.content[i]
        if (setting_list['letsencrypt_files'].includes(brand?.dns) && setting_list['letsencrypt_files'].includes(brand?.dns)) {
          data.content[i].is_linux_setting_confirm = 1;
        }
      }
      */


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

      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { id } = req.params;
      let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id]);
      data = data[0][0];
      // 행 없음 가드: id에 해당하는 브랜드가 없으면 500 크래시 대신 명확히 응답 + 로그.
      if (!data) {
        logger.error(`brand get: not found id=${id}`);
        return response(req, res, -200, `브랜드 정보를 불러오지 못했습니다. (id=${id})`, false);
      }
      data["theme_css"] = JSON.parse(data?.theme_css ?? "{}");
      //data["slider_css"] = JSON.parse(data?.slider_css ?? "{}");
      data["setting_obj"] = JSON.parse(data?.setting_obj ?? "{}");
      data["none_use_column_obj"] = JSON.parse(data?.none_use_column_obj ?? "{}");
      data["bonaeja_obj"] = JSON.parse(data?.bonaeja_obj ?? "{}");
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
        establish_date,
        mail_order_num,
        note,
        basic_info,
        show_basic_info,
        theme_css = {},
        //slider_css = {},
        setting_obj = {},
        none_use_column_obj = {},
        bonaeja_obj = {},
        shop_obj = [],
        blog_obj = [],
        seo_obj = {},
        user_name,
        user_pw,
        seller_name,
        is_use_otp = 0,
        is_closure = 0,
      } = req.body;
      // 브랜드 생성은 곧바로 그 몰의 '본사 관리자(레벨40)' 계정까지 만든다.
      // 빈 비밀번호를 그대로 해싱하면 hash('') 가 저장되는데, signIn 에는 빈값 체크가 없어서
      // 아이디만 알면 비밀번호 없이 그 관리자 계정으로 로그인된다. → 인서트 '전에' 막는다.
      // (brands / product_category_groups 인서트보다 위에 두어야 반쪽짜리 브랜드가 남지 않는다)
      const admin_user_pw = typeof user_pw === 'string' ? user_pw.trim() : user_pw;
      if (!admin_user_pw) {
        return response(req, res, -100, "본사 비밀번호를 입력해 주세요.", false);
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
        establish_date,
        mail_order_num,
        note,
        basic_info,
        show_basic_info,
        theme_css,
        //slider_css,
        setting_obj,
        none_use_column_obj,
        bonaeja_obj,
        shop_obj,
        blog_obj,
        seo_obj,
        is_use_otp,
        is_closure,
        is_category_migrated: 1,   // 신규 몰은 단일 카테고리 트리로 시작(레거시 그룹 모델 안 씀)
      };
      obj["theme_css"] = JSON.stringify(obj.theme_css);
      //obj["slider_css"] = JSON.stringify(obj.slider_css);
      obj["setting_obj"] = JSON.stringify(obj.setting_obj);
      obj["none_use_column_obj"] = JSON.stringify(obj.none_use_column_obj);
      obj["bonaeja_obj"] = JSON.stringify(obj.bonaeja_obj);
      obj["shop_obj"] = JSON.stringify(obj.shop_obj);
      obj["blog_obj"] = JSON.stringify(obj.blog_obj);
      obj["seo_obj"] = JSON.stringify(obj.seo_obj);
      obj = { ...obj, ...files };

      let result = await insertQuery(`${table_name}`, obj);
      // 신규 몰: 기본 '카테고리' 그룹 1개 생성(단일 트리의 컨테이너 그룹). is_category_migrated=1 과 짝.
      //   스토어는 단일 합성 트리로 노출되지만, 카테고리 생성 시 유효한 group_id 컨테이너가 필요.
      await insertQuery('product_category_groups', {
        category_group_name: '카테고리',
        brand_id: result?.insertId,
        max_depth: 10,
        sort_type: 0,
        is_show_header_menu: 1,
        is_use_en_name: 0,
      });
      let user_obj = {
        user_name: user_name,
        name: seller_name,
        nickname: seller_name,
        seller_name: seller_name,
        level: 40,
        brand_id: result?.insertId,
      };
      // ⚠ 평문을 user_obj 에 먼저 넣지 않는다(넣으면 해싱 누락 시 평문이 그대로 저장된다).
      //    user_pw 와 user_salt 는 반드시 '쌍으로' 세팅한다 — salt 없이 저장하면 signIn 이 깨진다.
      let pw_data = await createHashedPassword(admin_user_pw);
      user_obj["user_pw"] = pw_data.hashedPassword;
      user_obj["user_salt"] = pw_data.salt;
      let user_sign_up = await insertQuery("users", encForSave("users", user_obj)); // 판매자 실명(name) 암호화 + name_idx 세팅
      return response(req, res, 100, "success", {});
    } catch (err) {
      console.log(err);
      logger.error(JSON.stringify(err?.response?.data || err));
      return response(req, res, -200, "서버 에러 발생", false);
    }
  },
  update: async (req, res, next) => {
    // 40레벨일시 자기 브랜드 수정, 50레벨일시 모든 브랜드 수정가능
    try {

      const decode_user = checkLevel(req.cookies.token, 0, res);
      const decode_dns = checkDns(req.cookies.dns);
      const { id } = req.params;
      if (
        (decode_user?.level < 50 && decode_user?.brand_id != id) ||
        decode_user?.level < 40
      ) {
        return lowLevelException(req, res);
      }

      // ── merge-safe 업데이트 ─────────────────────────────────────────────
      // 요청 body에 '실제로 온' 필드만 갱신한다. 예전 방식(전체 컬럼 destructure +
      // 기본값)은 부분 업데이트(예: 온보딩 닫기 = setting_obj만 전송) 시 나머지 컬럼을
      // NULL/{}/[]로 덮어써 브랜드(상호·로고·테마·홈레이아웃·폐쇄여부 등)를 지웠다.
      const SCALAR_COLS = [
        'logo_img', 'dark_logo_img', 'favicon_img', 'og_img', 'name', 'dns',
        'og_description', 'company_name', 'business_num', 'pvcy_rep_name',
        'ceo_name', 'addr', 'resident_num', 'phone_num', 'fax_num',
        'establish_date', 'mail_order_num', 'note', 'basic_info',
        'show_basic_info', 'is_use_otp', 'is_closure',
      ];
      const JSON_COLS = [
        'theme_css', 'setting_obj', 'none_use_column_obj', 'bonaeja_obj',
        'shop_obj', 'blog_obj', 'seo_obj',
      ];
      let obj = {};
      for (const k of SCALAR_COLS) {
        if (req.body[k] !== undefined) obj[k] = req.body[k];
      }
      for (const k of JSON_COLS) {
        if (req.body[k] !== undefined) obj[k] = JSON.stringify(req.body[k]);
      }
      let files = settingFiles(req.files);
      obj = { ...obj, ...files };

      // 언어팩(is_use_lang) 처리: shop_obj가 실제로 제공됐을 때만 번역 결과를 반영.
      // (부분 업데이트에서 shop_obj를 '[]'로 덮어쓰지 않도록 가드)
      let lang_setting = await brandSettingLang({ ...obj, id });
      if (obj.shop_obj !== undefined && lang_setting?.shop_obj !== undefined) {
        obj.shop_obj = lang_setting.shop_obj;
      }

      if (Object.keys(obj).length === 0) {
        return response(req, res, 100, "success", {});
      }
      let result = await updateQuery(`${table_name}`, obj, id);

      // 브랜드 설정 변경 시 캐시 삭제 (shop:setting + domain)
      if (redisClient?.isOpen) {
        try {
          // domain 캐시 삭제
          let brandDns = req.body?.dns;
          if (!brandDns) {
            let [brandRow] = await readPool.query(`SELECT dns FROM ${table_name} WHERE id=?`, [id]);
            brandDns = brandRow?.[0]?.dns;
          }
          if (brandDns) {
            await redisClient.del(`domain:${brandDns}`);
          }
          // shop:setting 캐시 삭제
          let keys = await redisClient.keys(`shop:setting:${id}:*`);
          if (keys.length > 0) {
            await redisClient.del(keys);
          }
        } catch (e) { console.log('Redis cache clear error:', e.message); }
      }

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
  settingOtp: async (req, res, next) => {
    try {
      const decode_user = await checkLevel(req.cookies.token, 0, req);
      const decode_dns = checkDns(req.cookies.dns);
      const { brand_id } = req.body;
      let dns_data = await readPool.query(`SELECT ${table_name}.* FROM ${table_name} WHERE id=?`, [brand_id]);
      dns_data = dns_data[0][0];
      const secret = speakeasy.generateSecret({
        length: 20, // 비밀키의 길이를 설정 (20자리)
        name: dns_data?.dns, // 사용자 아이디를 비밀키의 이름으로 설정
        algorithm: 'sha512' // 해시 알고리즘 지정 (SHA-512 사용)
      })
      return response(req, res, 100, "success", secret)
    } catch (err) {
      console.log(err)
      return response(req, res, -200, "서버 에러 발생", false)
    } finally {

    }
  },
  design: {
    get: async (req, res, next) => {
      try {

        const decode_user = checkLevel(req.cookies.token, 0, res);
        const decode_dns = checkDns(req.cookies.dns);
        const { id } = req.params;
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

        const decode_user = checkLevel(req.cookies.token, 0, res);
        const decode_dns = checkDns(req.cookies.dns);
        const { id } = req.params;
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
