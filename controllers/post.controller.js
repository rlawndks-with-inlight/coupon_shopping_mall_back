'use strict';
import _ from "lodash";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, findParent, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
import { decField } from "../utils.js/crypto-util.js";
const table_name = 'posts';


const postCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 관리자 경로(/api/posts)는 직원 전용이다. 여기엔 '작성자만 열람' 게이트가 없어서
            // (그 게이트는 아래 req.IS_RETURN 블록에만 있다) 로그인만 하면 남의 문의 글이 다 보였다.
            // 고객화면은 /api/shop/posts 로 들어오고 shop.controller 가 IS_RETURN 을 붙인다.
            if (!req.IS_RETURN && (!decode_user || decode_user?.level < 10)) {
                return lowLevelException(req, res);
            }
            const { category_id } = req.query;

            let category_sql = `SELECT id, parent_id, post_category_type, post_category_read_type, is_able_user_add FROM post_categories `;
            category_sql += ` WHERE post_categories.brand_id=? `;
            let category_list = await readPool.query(category_sql, [decode_dns?.id ?? 0]);
            category_list = category_list[0];

            let category = _.find(category_list, { id: parseInt(category_id) });
            // 요청한 게시판이 이 브랜드 것이 아니면 여기서 끊는다.
            // 예전엔 못 찾으면 category 가 undefined → top_parent 도 undefined 가 되어
            // 아래 '작성자 본인만' 필터가 통째로 건너뛰어졌다. 그런데 실제 데이터 쿼리에는
            // 브랜드 조건이 없어서, 남의 브랜드 게시판 id 를 넣으면 그 브랜드 1:1문의가
            // 비로그인 상태로 전부 조회됐다(dns 쿠키는 누구나 발급받는다).
            if (category_id && !category) {
                return response(req, res, 100, "success", { content: [], total: 0 });
            }
            let top_parent = findParent(category_list, category);
            top_parent = _.find(category_list, { id: parseInt(top_parent?.id) });

            let category_ids = findChildIds(category_list, category_id)
            category_ids.unshift(parseInt(category_id))
            const is_manager = await checkIsManagerUrl(req);
            let columns = [
                `${table_name}.*`,
                `users.nickname AS writer_nickname`,
                `users.user_name AS writer_user_name`,
                ...(is_manager ? [`users.name AS writer_name`] : []),
                `post_categories.post_category_title`,
            ]

            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON ${table_name}.user_id=users.id `
            sql += ` LEFT JOIN post_categories ON ${table_name}.category_id=post_categories.id `
            sql += ` WHERE ${table_name}.parent_id=-1 `
            let params = [];
            if (category_id) {
                sql += ` AND ${table_name}.category_id IN (${category_ids.map(() => '?').join(',')}) `
                params.push(...category_ids);
            }

            if (category_id == 91) {
                // 비로그인이면 undefined < 20 이 false 라 '좁히기'가 통째로 건너뛰어져
                // 이 카테고리 글이 전부 보였다. 비로그인은 가장 좁게(아무것도 못 봄) 잡는다.
                if (!decode_user) {
                    sql += ` AND ${table_name}.user_id = ? `
                    params.push(0);
                } else if (decode_user?.level < 20) {
                    if (decode_user?.level == 15) {
                        sql += ` AND ${table_name}.user_id IN (SELECT id FROM users WHERE oper_id=?)`
                        params.push(decode_user?.id ?? 0);
                    } else if (decode_user?.level == 10) {
                        sql += ` AND ${table_name}.user_id = ?`
                        params.push(decode_user?.id ?? 0);
                    }
                }
            }

            if (req.IS_RETURN) {
                if (top_parent?.post_category_read_type == 1) {
                    sql += ` AND user_id=? `;
                    params.push(decode_user?.id ?? 0);
                }
            }
            let data = await getSelectQueryList(sql, columns, req.query, [], params);

            let post_ids = data.content.map(item => {
                return item?.id
            });
            post_ids.unshift(0);
            // 답변 삭제는 소프트 삭제(query-util deleteQuery 가 is_delete=1 로 UPDATE)다.
            // is_delete 를 안 걸러서 지운 답변이 replies 에 그대로 실렸고,
            // 목록은 '답변완료'로 뜨고 상세에는 지운 본문까지 보였다.
            let child_posts = await readPool.query(`SELECT * FROM posts WHERE parent_id IN (${post_ids.map(() => '?').join(',')}) AND is_delete=0 ORDER BY id DESC`, post_ids);
            child_posts = child_posts[0];
            data.content = data.content.map((item) => {
                return {
                    ...item,
                    replies: child_posts.filter(itm => itm.parent_id == item.id),
                    lang_obj: JSON.parse(item?.lang_obj ?? `{}`),
                    ...(is_manager ? { writer_name: decField(item?.writer_name) } : {}),
                }
            })
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
            let columns = [
                `${table_name}.*`,
                `post_categories.brand_id`,
                // 열람권한 판정에 쓴다(1 = 작성자만 열람)
                `post_categories.post_category_read_type`
            ]
            let sql = ` SELECT ${columns.join()} FROM ${table_name} `
            sql += ` LEFT JOIN post_categories ON ${table_name}.category_id=post_categories.id `;
            sql += ` WHERE ${table_name}.id=? `
            let data = await readPool.query(sql, [id]);
            data = data[0][0];
            // 이 함수에는 검사가 하나도 없었다. id 만 바꾸면
            //   (1) 다른 브랜드의 글도,
            //   (2) '작성자만 열람'(1:1 문의) 게시판의 남의 글도
            // 그대로 열렸다. 게다가 글이 없으면 아래 JSON.parse 에서 터졌다.
            if (!data) {
                return response(req, res, -100, "게시글을 찾을 수 없습니다.", false)
            }
            if (decode_dns?.id && data?.brand_id != decode_dns?.id) {
                return lowLevelException(req, res);
            }
            // 관리자 경로(/api/posts)는 직원 전용. 고객 경로는 shop.controller 가 IS_RETURN 을 붙여 들어온다.
            const isStaff = !!decode_user && decode_user?.level >= 10;
            if (!req.IS_RETURN && !isStaff) {
                return lowLevelException(req, res);
            }
            // 작성자만 열람인 게시판은 본인 글만. 직원은 답변해야 하므로 예외.
            // 예전 조건은 `data?.user_id != decode_user?.id` 였는데, JS 느슨비교라
            // null != undefined 가 false 다 — 즉 user_id 가 NULL 로 들어간 글(비회원 작성분)은
            // 아무 비로그인 요청이나 그대로 열람할 수 있었다.
            // '로그인했고 + 소유자가 일치' 를 양성 조건으로 두고 그 외는 전부 막는다.
            if (data?.post_category_read_type == 1 && !isStaff && !(decode_user?.id > 0 && data?.user_id == decode_user?.id)) {
                return lowLevelException(req, res);
            }
            data.lang_obj = JSON.parse(data?.lang_obj ?? '{}')
            // 목록과 같은 이유로 지운 답변을 제외한다.
            let child_posts = await readPool.query(`SELECT * FROM posts WHERE parent_id=? AND is_delete=0 ORDER BY id DESC`, [id]);
            child_posts = child_posts[0];
            data.replies = child_posts;
            return response(req, res, 100, "success", data)
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
            // 고객 글쓰기는 /api/shop/posts(IS_RETURN)로 들어온다. 관리자 경로는 직원 전용.
            if (!req.IS_RETURN && (!decode_user || decode_user?.level < 10)) {
                return lowLevelException(req, res);
            }
            const {
                post_title_img,
                category_id, parent_id = -1, post_title, post_content, is_reply = 0
            } = req.body;
            let files = settingFiles(req.files);

            let obj = {
                post_title_img,
                category_id, parent_id, post_title, post_content, is_reply,
                user_id: decode_user?.id,
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
            // 고객의 글 수정은 /api/shop/posts(IS_RETURN)로 들어오고 그쪽에서 소유자를 확인한다.
            // 관리자 경로는 직원 전용.
            if (!req.IS_RETURN && (!decode_user || decode_user?.level < 10)) {
                return lowLevelException(req, res);
            }
            const {
                post_title_img,
                category_id, parent_id = -1, post_title, post_content, is_reply = 0, id
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                post_title_img,
                category_id, parent_id, post_title, post_content, is_reply,
            };
            let langs = await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, id);
            obj = { ...obj, ...files };

            let result = await updateQuery(`${table_name}`, obj, id);

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
            // 삭제는 shop.controller 가 재사용하지 않는다(관리자 경로 전용).
            // 검사가 없어 id 만 알면 아무 글이나 지워졌다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
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

export default postCtrl;
