'use strict';
import _ from "lodash";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { canWriteBrand, checkDns, checkLevel, findChildIds, findParent, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";
import { readPool } from "../config/db-pool.js";
import { decField } from "../utils.js/crypto-util.js";
import { encForSave, decRow, blindIndex } from "../utils.js/pii.js";
import { hashOrderPassword, orderPasswordCandidates } from "../utils.js/order-password.js";
const table_name = 'posts';

// 비회원 작성자 이름 가리기 — 목록은 누구나 보는 화면이라 실명을 그대로 노출하지 않는다.
//   홍길동 → 홍*동 / 김철 → 김* / 이 → 이
const maskGuestName = (name) => {
    const v = String(name ?? '').trim();
    if (!v) return null;
    if (v.length <= 1) return v;
    if (v.length === 2) return v[0] + '*';
    return v[0] + '*'.repeat(v.length - 2) + v[v.length - 1];
};


// 글 제목은 비어 있으면 목록에서 아무것도 안 보인다. 운영 API 로 빈 제목이 그대로 저장됐다.
// (옛 데이터에도 빈 제목 글이 3건 남아 있다 — 그건 건드리지 않았다)
// varchar(255) 라 그보다 길면 DB 가 막는데, 화면엔 사유가 안 보여 무엇을 고칠지 알 수 없다.
// ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
const 제목검사 = (post_title) => {
    const v = String(post_title ?? '').trim();
    if (!v) return '제목을 입력해 주세요.';
    if ([...v].length > 255) return '제목은 255자 이내로 입력해 주세요.';
    return null;
};
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
            // ⚠ 브랜드 스코프는 무조건 건다.
            //
            // 예전엔 브랜드 조건이 아예 없었고, 좁히는 건 아래 `if (category_id)` 하나뿐이었다.
            // 즉 category_id 를 빼고 부르면 **전 가맹점의 글**이 한 번에 나왔다(직원 레벨10 이상).
            // 글은 게시판(post_categories)을 통해 브랜드에 속하므로 그 조인으로 스코프를 건다.
            // (LEFT JOIN 이지만 이 조건이 붙으면 사실상 INNER — 카테고리 없는 글은 목록 대상이 아니다)
            sql += ` AND post_categories.brand_id=? `
            params.push(decode_dns?.id ?? 0);
            if (category_id) {
                sql += ` AND ${table_name}.category_id IN (${category_ids.map(() => '?').join(',')}) `
                params.push(...category_ids);
            }

            // 게시판 id 91 = 본사(마스터) 브랜드의 가맹점 문의 게시판.
            //
            // 이 좁히기 규칙(레벨15 는 자기 하위 계정 글, 레벨10 은 자기 글만)은 본사 게시판에서만
            // 뜻이 있는데 id 하나만 보고 있었다. 위에서 '이 브랜드가 가진 게시판인지' 를 이미
            // 확인하므로 남의 브랜드 글이 새지는 않지만, 마스터 브랜드인지까지 함께 본다
            // — 나중에 id 가 재배치되거나 복제되면 엉뚱한 가맹점 게시판이 조용히 좁혀진다.
            if (category_id == 91 && decode_dns?.is_main_dns == 1) {
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
                // ⚠ 조회 컬럼이 `posts.*` 라 비회원 문의용 컬럼까지 통째로 실린다.
                //    비밀번호 해시(HMAC)와 연락처 blind-index 가 게시판을 보는 누구에게나 내려가면
                //    오프라인 대입으로 비밀번호를 알아낼 수 있다 — 응답에서 반드시 제거한다.
                //    연락처 원문도 목록에서는 쓸 일이 없다(상세에서 직원만 본다).
                const { password, none_user_phone_idx, none_user_phone, none_user_name, ...safe } = item;
                return {
                    ...safe,
                    replies: (child_posts.filter(itm => itm.parent_id == item.id))
                        // 답변에도 같은 컬럼이 실려 온다(SELECT *) — 같은 이유로 제거한다.
                        .map(({ password, none_user_phone_idx, none_user_phone, none_user_name, ...r }) => r),
                    lang_obj: JSON.parse(item?.lang_obj ?? `{}`),
                    // 작성자 표시. 회원은 닉네임, 비회원은 이름을 가려서 보여준다(홍*동).
                    // 예전엔 비회원 글이 목록에 작성자 '---' 로만 떠서 누가 쓴 글인지 알 수 없었다.
                    writer_nickname: item?.writer_nickname ?? maskGuestName(decField(none_user_name)),
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
            //
            // 비회원 글은 '연락처 + 글비밀번호' 로 본인임을 증명한다(계정이 없으므로 이것뿐이다).
            // 조회 화면이 그 두 값을 함께 보내오면 소유자로 인정한다.
            // ⚠ 비밀번호는 저장할 때와 같은 해시로 만들어 대조한다 — 평문 비교가 아니다.
            //   그리고 **글에 비밀번호가 실제로 설정돼 있을 때만** 인정한다. 안 그러면
            //   password 가 NULL 인 옛 글이 빈 값 두 개로 열린다.
            const guestPhone = String(req.query?.none_user_phone ?? req.body?.none_user_phone ?? '').trim();
            const guestPw = String(req.query?.password ?? req.body?.password ?? '');
            const isGuestOwner = !!data?.password && !!data?.none_user_phone_idx
                && !!guestPhone && !!guestPw
                && data.none_user_phone_idx === blindIndex(guestPhone)
                && orderPasswordCandidates(guestPw).includes(data.password);

            if (data?.post_category_read_type == 1 && !isStaff
                && !(decode_user?.id > 0 && data?.user_id == decode_user?.id)
                && !isGuestOwner) {
                return lowLevelException(req, res);
            }
            // 비밀번호 해시와 blind-index 는 화면에 쓸 일이 없다 — 응답에서 뺀다.
            // (해시가 나가면 오프라인 대입으로 비밀번호를 알아낼 수 있다)
            delete data.password;
            delete data.none_user_phone_idx;
            // 이름·연락처는 암호화되어 있으므로 복호화한다.
            decRow(table_name, data);
            // 다만 **연락처 원문은 직원과 작성자 본인에게만** 내려준다.
            // 공개 게시판(read_type != 1)은 아무나 상세를 열 수 있어서, 안 가리면
            // 비회원 문의 연락처가 그대로 노출된다.
            if (!isStaff && !isGuestOwner) {
                delete data.none_user_phone;
                data.none_user_name = maskGuestName(data.none_user_name);
            }
            data.lang_obj = JSON.parse(data?.lang_obj ?? '{}')
            // 목록과 같은 이유로 지운 답변을 제외한다.
            let child_posts = await readPool.query(`SELECT * FROM posts WHERE parent_id=? AND is_delete=0 ORDER BY id DESC`, [id]);
            // 답변도 SELECT * 라 비회원 컬럼(비밀번호 해시·연락처·blind-index)이 실려 온다 — 제거한다.
            data.replies = child_posts[0].map(
                ({ password, none_user_phone_idx, none_user_phone, none_user_name, ...r }) => r);
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
                category_id, parent_id = -1, post_title, post_content, is_reply = 0,
                // 비회원 1:1문의. 회원 글에는 들어오지 않는다.
                none_user_name, none_user_phone, password,
            } = req.body;
            const 제목잘못 = 제목검사(post_title);
            if (제목잘못) { return response(req, res, -100, 제목잘못, false); }
            let files = settingFiles(req.files);

            let obj = {
                post_title_img,
                category_id, parent_id, post_title, post_content, is_reply,
                user_id: decode_user?.id,
            };
            // 비회원 글이면 작성자 정보와 조회용 비밀번호를 함께 넣는다.
            //  · 이름·연락처는 다른 개인정보와 같은 규칙으로 암호화하고, 연락처는 조회를 위해
            //    blind-index 컬럼을 함께 채운다(encForSave 가 둘 다 처리한다).
            //  · 비밀번호는 평문으로 저장하지 않는다. 비회원 주문조회와 같은 HMAC 해시를 쓴다.
            //  ⚠ 회원 글에는 이 컬럼들을 아예 넣지 않는다 — 넣으면 빈 문자열로 덮여
            //    '비회원 글'과 구분이 흐려진다.
            if (!(Number(decode_user?.id) > 0)) {
                obj = {
                    ...obj,
                    ...encForSave(table_name, {
                        none_user_name: String(none_user_name ?? '').trim(),
                        none_user_phone: String(none_user_phone ?? '').trim(),
                    }),
                    password: hashOrderPassword(password),
                };
            }
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
            // 관리자 경로는 자기 브랜드 글만(예전엔 레벨10+ 면 id 로 남의 브랜드 글도 수정됐다).
            // posts 엔 brand_id 가 없고 카테고리(post_categories.brand_id)로 브랜드가 정해진다 — 조인해서 본다.
            if (!req.IS_RETURN) {
                const owned = (await readPool.query(
                    `SELECT p.id, c.brand_id FROM ${table_name} p LEFT JOIN post_categories c ON c.id=p.category_id WHERE p.id=? LIMIT 1`, [id]))[0][0];
                if (!owned || !canWriteBrand(decode_user, owned.brand_id)) {
                    return lowLevelException(req, res);
                }
            }
            const 제목잘못 = 제목검사(post_title);
            if (제목잘못) { return response(req, res, -100, 제목잘못, false); }
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
            // 자기 브랜드 글만(예전엔 레벨10+ 면 id 로 남의 브랜드 글도 지워졌다). 브랜드는 카테고리 조인으로 본다.
            const owned = (await readPool.query(
                `SELECT p.id, c.brand_id FROM ${table_name} p LEFT JOIN post_categories c ON c.id=p.category_id WHERE p.id=? LIMIT 1`, [id]))[0][0];
            if (!owned || !canWriteBrand(decode_user, owned.brand_id)) {
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
