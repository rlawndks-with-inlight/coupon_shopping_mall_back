"use strict";
import {
  deleteQuery,
  getSelectQueryList,
  insertQuery,
  updateQuery,
} from "../utils.js/query-util.js";
import { redisClient } from "../config/redis-client.js";
import { seedDefaultBoards } from "../utils.js/seed-boards.js";
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
      // 브랜드 행 전체(SELECT *)를 돌려준다 — 사업자정보·외부 API 키가 들어 있다.
      // 예전엔 로그인 검사가 없어서, 본사 도메인에 접속해 dns 쿠키(is_main_dns=1)만 받아오면
      // 누구나 전 가맹점 목록을 통째로 받아갈 수 있었다.
      if (!decode_user || decode_user?.level < 40) {
        return lowLevelException(req, res);
      }
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
      // 브랜드 행 전체(SELECT *)를 그대로 돌려주는 자리다 — 사업자정보·외부 API 키가 들어 있다.
      // 검사가 하나도 없어서 id 만 바꿔가며 아무 브랜드나 읽을 수 있었다.
      // 조건은 update 와 동일하게 맞춘다(자기 브랜드는 40 이상, 남의 브랜드는 50 이상).
      if (
        !decode_user ||
        (decode_user?.level < 50 && decode_user?.brand_id != id) ||
        decode_user?.level < 40
      ) {
        return lowLevelException(req, res);
      }
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

      // 신규 몰의 상위(본사) 지정.
      //
      // 예전엔 parent_id 를 아예 넣지 않아 NULL 로 들어갔다. 그래서 '브랜드 추가'로 만든
      // 가맹점은 본사 가맹점 현황·정산 집계(WHERE parent_id=본사id)에서 통째로 빠졌다.
      // 가맹점 신청 승인 경로(merchant_application.controller)는 parent_id: master.id 를
      // 넣는데 이 경로만 빠져 있어, 같은 가맹점인데 만든 경로에 따라 집계에 잡히고 안 잡히는
      // 차이가 났다. 기준을 그 경로와 똑같이 맞춘다.
      //   · body 로 parent_id 가 명시되면 그 값을 쓴다(수동 지정 여지).
      //   · 아니면 MAIN_FRONT_URL 도메인 + is_main_dns=1 인 브랜드를 본사로 본다.
      //   · 본사를 못 찾으면 넣지 않는다 — 이 DB 는 다른 프로젝트와 공유하므로
      //     ShopGo 가 아닌 환경에서 엉뚱한 상위를 박지 않기 위해서다(기존 동작 유지).
      const root_domain = String(process.env.MAIN_FRONT_URL || '').replace(/^www\./, '');
      let parent_brand_id = Number(req.body?.parent_id) > 0 ? Number(req.body.parent_id) : 0;
      if (!parent_brand_id && root_domain) {
        const master_rows = await readPool.query(
          `SELECT id FROM ${table_name} WHERE dns=? AND is_main_dns=1 AND is_delete=0 LIMIT 1`,
          [root_domain]
        );
        parent_brand_id = Number(master_rows[0][0]?.id) || 0;
      }
      if (parent_brand_id > 0) obj.parent_id = parent_brand_id;

      let result = await insertQuery(`${table_name}`, obj);
      // 신규 몰: 기본 게시판(공지사항 · 1:1문의).
      //
      // 이 경로에는 없었다. 그래서 '브랜드설정 → 브랜드 추가'로 만든 몰은 게시판이
      // 통째로 없는 채로 시작했다 — 게시판 생성은 레벨50 전용이라 가맹점이 스스로
      // 만들 수도 없고, 대시보드 '문의관리' 카드도 빈 채로 남는다.
      // 신청 승인 경로(merchant_application.controller)에만 있던 것을 여기에도 맞춘다.
      // (자체 도메인 가맹점은 신청 화면을 안 거치고 이 경로로 들어온다)
      //
      // 실패해도 몰 생성 자체는 성공으로 둔다 — 게시판은 나중에 심을 수 있지만
      // 여기서 에러를 내면 이미 만들어진 브랜드 행과 관리자 계정이 붕 뜬다.
      try {
        await seedDefaultBoards(result?.insertId);
      } catch (e) {
        logger.error('기본 게시판 생성 실패(brand_id=' + result?.insertId + '): ' + (e?.message || e));
      }
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
      // checkLevel 은 실패 시 false 를 반환한다(예외를 던지지 않는다).
      // 그래서 비로그인이면 decode_user?.level 이 undefined 이고, undefined < 50 은 false 라
      // '막으려던' 조건이 통째로 거짓이 되어 오히려 비로그인만 통과했다.
      // 로그인 여부를 먼저 본다.
      if (
        !decode_user ||
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
      // 배송비 정책에 말도 안 되는 값이 들어가지 않게 한다.
      //
      // [왜] setting_obj 는 JSON 컬럼이라 **DB 가 아무것도 안 막는다.**
      //   2026-08-28 운영 API 로 확인해 보니 배송비 -5,000원과 99,999,999,999원이
      //   그대로 저장됐다. 이 값은 상품상세·장바구니 표시와 **서버 결제 재계산**이 함께 읽는다
      //   (pay.controller 의 recalcOrderAmount). 즉 손님 청구액에 바로 들어간다.
      //   음수 배송비는 결제 금액을 깎고, 천문학적 값은 주문을 통째로 막는다.
      // ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
      const 배송비상한 = 10000000;   // 1천만원
      if (obj.setting_obj !== undefined) {
        const 수 = (v) => {
          if (v === '' || v === null || v === undefined) return 0;
          const t = String(v).replace(/,/g, '').trim();
          return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN;
        };
        const 설정 = req.body.setting_obj ?? {};
        for (const 키 of ['delivery_fee_default', 'free_ship_min']) {
          if (설정[키] === undefined) continue;
          const n = 수(설정[키]);
          if (isNaN(n)) return response(req, res, -100, '배송비 설정은 숫자로만 입력해 주세요.', false);
          if (n < 0) return response(req, res, -100, '배송비 설정은 0 이상으로 입력해 주세요.', false);
          if (n > 배송비상한) return response(req, res, -100, '배송비 설정 금액이 너무 큽니다. 다시 확인해 주세요.', false);
        }
      }

      let files = settingFiles(req.files);
      obj = { ...obj, ...files };

      // 언어팩(is_use_lang) 처리: shop_obj가 실제로 제공됐을 때만 번역 결과를 반영.
      // (부분 업데이트에서 shop_obj를 '[]'로 덮어쓰지 않도록 가드)
      let lang_setting = await brandSettingLang({ ...obj, id });
      if (obj.shop_obj !== undefined && lang_setting?.shop_obj !== undefined) {
        obj.shop_obj = lang_setting.shop_obj;
      }
      // 홈 화면 섹션 문구(setting_obj.home_texts)의 번역도 같은 방식으로 되받는다.
      // shop_obj 와 마찬가지로 '실제로 보내온 경우'에만 덮어쓴다 — 부분 업데이트에서
      // setting_obj 를 통째로 날리면 안 된다.
      if (obj.setting_obj !== undefined && lang_setting?.setting_obj !== undefined) {
        obj.setting_obj = lang_setting.setting_obj;
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
      // 검사가 전혀 없어서 id 만 알면 아무 브랜드나 지울 수 있었다.
      // 가맹점 삭제는 본사·개발사(50) 전용이다(프론트 호출부도 settings/brands 뿐).
      if (!decode_user || decode_user?.level < 50) {
        return lowLevelException(req, res);
      }
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
      // ⚠ 레벨 가드는 넣지 않는다. 프레임1·2 고객 회원가입 화면이 비로그인으로 이 엔드포인트를 부른다.
      // 대신 body 의 brand_id 를 무시하고 접속한 도메인(decode_dns) 기준으로만 조회한다.
      // body brand_id 를 신뢰하면 임의 브랜드의 시크릿을 발급받을 수 있었다.
      let dns_data = await readPool.query(`SELECT ${table_name}.* FROM ${table_name} WHERE id=?`, [decode_dns?.id ?? 0]);
      dns_data = dns_data[0][0];
      if (!dns_data) {
        return response(req, res, -100, "브랜드 정보를 찾을 수 없습니다.", false)
      }
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
