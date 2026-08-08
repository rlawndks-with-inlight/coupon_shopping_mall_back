'use strict';
import _ from "lodash";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, makeTree, resolveWriteBrandId, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'post_categories';



const postCategoryCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { page, page_size } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);

            let data = await getSelectQueryList(sql, columns, { ...req.query, page_size: 100 }, [], params);

            data.content = await makeTree(data?.content);
            data.total = data?.content.length ?? 0;
            data.content = (data?.content ?? []).slice((page - 1) * (page_size), page * page_size);
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    get: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE brand_id=?`, [decode_dns?.id ?? 0]);
            data = data[0];
            let category = _.find(data, { id: id });
            data = await makeTree(data, category);
            category = _.find(data, { id: parseInt(id) });
            category.children = category?.children ?? []
            if (!isItemBrandIdSameDnsId(decode_dns, category)) {
                return lowLevelException(req, res);
            }
            return response(req, res, 100, "success", category)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    create: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 레벨 검사가 없어서, 일반 고객 계정(레벨0)으로 로그인만 하면
            // POST /api/post-categories 직접 호출로 그 브랜드 게시판 트리에 카테고리를 꽂을 수 있었다.
            // (brand_id 강제는 아래 resolveWriteBrandId 로 이미 되어 있었고, 없던 것은 레벨 검사다)
            //
            // 기준은 레벨50 이다. 앞서 레벨10 으로 넣은 건 상위 '게시판관리' 그룹(글 관리)의 기준을
            // 잘못 가져온 것이다. 이 API 를 부르는 화면은 '게시판 카테고리 관리'
            // (front: pages/manager/articles/categories/**) 뿐이고, 그 메뉴는
            // layouts/manager/nav/config-navigation.js 의 isUsePostCategory() → level >= 50 에서만 노출된다.
            // (같은 함수의 MAIN_FRONT_URL 분기는 마스터 사이트에서 isMasterSite() 가 먼저 return 해 버려 도달하지 않는다)
            //
            // ⚠ 고객 화면이 읽는 경로는 여기가 아니다 — 스토어프론트는 shop.controller 가
            //   post_categories 를 직접 SELECT 해서 내려주고(IS_RETURN 흐름), 이 컨트롤러의 list/get 도
            //   레벨 가드가 없다. 즉 쓰기(create/update/remove)만 올린 것이라 고객 화면은 영향이 없다.
            // checkLevel 은 실패 시 false 만 돌려주므로 !decode_user 를 먼저 본다.
            if (!decode_user || decode_user?.level < 50) {
                return lowLevelException(req, res);
            }
            const {
                post_category_title, parent_id = -1, is_able_user_add = 0, post_category_type = 0, post_category_read_type = 0
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                post_category_title, parent_id, is_able_user_add, post_category_type, post_category_read_type,
                // dns 쿠키는 GET /api/domain 으로 누구나 발급받으므로 쓰기 대상 브랜드의 근거가 될 수 없다.
                // 로그인 토큰 기준으로 확정하되, 레벨50(개발사)만 접속 도메인의 브랜드로 교차 생성이 가능하다.
                brand_id: resolveWriteBrandId(decode_user, decode_dns?.id, decode_dns),
            };
            obj = { ...obj, ...files };
            let result = await insertQuery(`${table_name}`, obj);
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, result?.insertId);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // create 와 같은 이유(=화면이 레벨50 전용)로 레벨50 이상만 수정할 수 있다.
            if (!decode_user || decode_user?.level < 50) {
                return lowLevelException(req, res);
            }
            const {
                post_category_title, parent_id = -1, is_able_user_add = 0, post_category_type = 0, post_category_read_type = 0, id
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let files = settingFiles(req.files);
            let obj = {
                post_category_title, parent_id, is_able_user_add, post_category_type, post_category_read_type
            };
            obj = { ...obj, ...files };
            let result = await updateQuery(`${table_name}`, obj, id);
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, id);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            // create 와 같은 이유(=화면이 레벨50 전용)로 레벨50 이상만 삭제할 수 있다.
            if (!decode_user || decode_user?.level < 50) {
                return lowLevelException(req, res);
            }
            // deleteQuery 도 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let result = await deleteQuery(`${table_name}`, {
                id
            })
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default postCategoryCtrl;
