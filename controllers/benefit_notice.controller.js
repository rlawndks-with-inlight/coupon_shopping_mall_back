'use strict';
import { deleteQuery, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, lowLevelException, response, settingLangs } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { invalidateAllShopSettingCache } from "../utils.js/cache.js";
import { readPool } from "../config/db-pool.js";
import { lang_obj_columns } from "../utils.js/schedules/lang-process.js";

const table_name = 'benefit_notices';
const tab_table_name = 'benefit_notice_tabs';

// 상품상세 '혜택 안내'.
//
// 이 데이터는 **본사 한 곳에서만** 만들고 전 가맹점 상품상세에 그대로 나간다.
// 무이자 할부 같은 행사는 결제사(PG) 계약에 딸린 것이라 가맹점마다 다르지 않고,
// 가맹점이 각자 적으면 실제 행사와 어긋난 고지가 몰마다 흩어지기 때문이다.
//
// 그래서 쓰기 권한이 보통 CRUD 보다 좁다:
//   · **본사 브랜드(is_main_dns=1)의 관리자**만 쓴다.
//   · brand_id 는 body 를 믿지 않고 **로그인한 관리자의 브랜드**로 못박는다.
//     (한 줄만 잘못 들어가도 전 가맹점 화면에 동시에 나간다)
//
// 읽기는 가맹점 스토어프론트가 shop.controller 의 setting 묶음으로 받아간다
// (여기 list 는 관리자 화면 전용이다).

// 쓰기·조회 주체를 확정한다. 본사 브랜드의 관리자만 통과하고, 그 브랜드 id 를 돌려준다.
//
// ⚠ 레벨 50 으로 걸었다가 본사에서 '권한이 없습니다'만 떴다.
//   레벨 50 은 개발사 계정이고 ShopGo 본사 운영자는 레벨 40 이다(본사에 50 계정이 아예 없다).
//   그렇다고 레벨 40 만 보면 가맹점 관리자도 통과하므로, **브랜드가 마스터인지**를 함께 본다.
//   이 DB 는 다른 클라이언트와 공유하는데, 그쪽 마스터는 자기 산하 가맹점에만 영향을 주므로
//   같은 규칙으로 통과시켜도 서로 침범하지 않는다(읽기가 부모 brand_id 기준이라 격리된다).
// 라벨 글자수 상한.
//
// [왜 필요한가]
// 상품상세에서 라벨은 왼쪽 칸이고, 그 칸은 **가장 긴 라벨에 맞춰 늘어난다**(DetailNotices 그리드).
// 라벨이 길어지면 오른쪽 내용 칸이 그만큼 좁아진다. 모바일 375px 에서 실측(2026-08-28):
//     2자 → 내용 281px   8자 → 236px   14자 → 163px   20자 → 91px(한 줄에 7글자)
// 화면이 깨지거나 넘치지는 않는다 — 그리드가 조용히 흡수한다. 그래서 더 위험하다:
// 아무 경고 없이 손님 화면만 나빠지고, 아무도 눈치채지 못한다.
//
// DB 는 varchar(50) 이라 50자까지 들어간다. 그건 저장 한계일 뿐 화면이 견디는 값이 아니다.
// ⚠ 관리자 입력란에도 같은 값을 걸어 두었지만, **여기가 진짜 관문이다** — 입력란은 API 를
//   직접 부르면 그냥 우회된다(회원가입 아이디 검증에서 같은 일을 이미 겪었다).
export const 라벨상한 = 8;

const 라벨검사 = (label) => {
    const 값 = String(label ?? '').trim();
    if (!값) return null;                      // 비우면 아래에서 '혜택' 으로 채운다
    // ⚠ 문구를 템플릿으로 만들면 안 된다. 서버 메시지는 프론트 사전에서 **글자 그대로** 찾아
    //   번역되므로, `라벨은 ${n}자…` 처럼 조립하면 사전에 없어 외국어 화면에 한국어가 나간다.
    //   숫자를 바꾸면 이 문구와 5개 언어 사전도 함께 고쳐야 한다(검사가 어긋남을 잡는다).
    return [...값].length > 라벨상한
        ? '라벨은 8자 이내로 입력해 주세요.'
        : null;
};
const 본사관리자 = (decode_user, decode_dns) => {
    if (!decode_user || Number(decode_user?.level) < 40) return 0;
    if (Number(decode_dns?.is_main_dns) !== 1) return 0;
    return Number(decode_dns?.id) || 0;
};

const benefitNoticeCtrl = {
    // 관리자 화면용 목록 — 탭까지 붙여서 한 번에 준다(항목 수가 적어 N+1 걱정이 없다).
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) {
                return lowLevelException(req, res);
            }

            let rows = await readPool.query(
                `SELECT * FROM ${table_name} WHERE brand_id=? AND is_delete=0 ORDER BY sort ASC, id ASC`,
                [brand_id]
            );
            rows = rows[0];

            let tabs = [];
            if (rows.length > 0) {
                const ids = rows.map((r) => r.id);
                const found = await readPool.query(
                    `SELECT * FROM ${tab_table_name} WHERE notice_id IN (${ids.map(() => '?').join()}) AND is_delete=0 ORDER BY sort ASC, id ASC`,
                    ids
                );
                tabs = found[0];
            }
            for (const row of rows) {
                row.lang_obj = JSON.parse(row?.lang_obj ?? '{}');
                row.tabs = tabs
                    .filter((t) => t.notice_id === row.id)
                    .map((t) => ({ ...t, lang_obj: JSON.parse(t?.lang_obj ?? '{}') }));
            }

            return response(req, res, 100, "success", { content: rows });
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    get: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) {
                return lowLevelException(req, res);
            }
            const { id } = req.params;
            let rows = await readPool.query(`SELECT * FROM ${table_name} WHERE id=? AND is_delete=0`, [id]);
            let data = rows[0][0];
            // 남의 브랜드 행을 열어보지 못하게 — 본사가 여럿인 공유 DB 다.
            if (!data || Number(data.brand_id) !== brand_id) {
                return lowLevelException(req, res);
            }
            data.lang_obj = JSON.parse(data?.lang_obj ?? '{}');
            let tabs = await readPool.query(
                `SELECT * FROM ${tab_table_name} WHERE notice_id=? AND is_delete=0 ORDER BY sort ASC, id ASC`, [id]
            );
            data.tabs = tabs[0].map((t) => ({ ...t, lang_obj: JSON.parse(t?.lang_obj ?? '{}') }));
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) {
                return lowLevelException(req, res);
            }
            const { label, summary, icon_img, popup_title, sort, is_show, tabs } = req.body;
            const 라벨오류 = 라벨검사(label);
            if (라벨오류) {
                return response(req, res, -100, 라벨오류, false);
            }
            let obj = {
                brand_id,
                label: label || '혜택',
                summary: summary ?? '',
                icon_img: icon_img ?? null,
                popup_title: popup_title ?? null,
                sort: Number(sort) || 0,
                is_show: Number(is_show) === 0 ? 0 : 1,
            };
            let result = await insertQuery(table_name, obj);
            const notice_id = result?.insertId;
            await saveTabs(notice_id, tabs, decode_dns);
            await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, notice_id);
            // 이 내용은 전 가맹점 화면에 나간다 — 한 브랜드 캐시만 지우면 나머지는 최대 3분간 옛 내용이다.
            await invalidateAllShopSettingCache();
            return response(req, res, 100, "success", notice_id);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    update: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) {
                return lowLevelException(req, res);
            }
            const { id } = req.params;
            let rows = await readPool.query(`SELECT * FROM ${table_name} WHERE id=? AND is_delete=0`, [id]);
            const before = rows[0][0];
            if (!before || Number(before.brand_id) !== brand_id) {
                return lowLevelException(req, res);
            }
            const { label, summary, icon_img, popup_title, sort, is_show, tabs } = req.body;
            const 라벨오류 = 라벨검사(label);
            if (라벨오류) {
                return response(req, res, -100, 라벨오류, false);
            }
            let obj = {
                label: label || '혜택',
                summary: summary ?? '',
                icon_img: icon_img ?? null,
                popup_title: popup_title ?? null,
                sort: Number(sort) || 0,
                is_show: Number(is_show) === 0 ? 0 : 1,
            };
            await updateQuery(table_name, obj, id);
            await saveTabs(id, tabs, decode_dns);
            await settingLangs(lang_obj_columns[table_name], obj, decode_dns, table_name, id);
            await invalidateAllShopSettingCache();
            return response(req, res, 100, "success", id);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
    remove: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const brand_id = 본사관리자(decode_user, decode_dns);
            if (!brand_id) {
                return lowLevelException(req, res);
            }
            const { id } = req.params;
            let rows = await readPool.query(`SELECT * FROM ${table_name} WHERE id=? AND is_delete=0`, [id]);
            const before = rows[0][0];
            if (!before || Number(before.brand_id) !== brand_id) {
                return lowLevelException(req, res);
            }
            await deleteQuery(table_name, { id }); // 스칼라로 넘기면 WHERE 가 비어 아무것도 안 지워졌다
            // 탭은 따로 지운다 — 남겨 두면 같은 notice_id 로 새 줄을 만들 때 되살아난다.
            await readPool.query(`UPDATE ${tab_table_name} SET is_delete=1 WHERE notice_id=?`, [id]);
            await invalidateAllShopSettingCache();
            return response(req, res, 100, "success", id);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        }
    },
};

// 탭은 통째로 갈아끼운다.
//
// 부분 갱신(추가/수정/삭제를 따로)으로 만들면 화면에서 순서를 바꿀 때마다
// id 를 맞춰 보내야 해서 관리 화면이 복잡해지고, 어긋나면 탭이 중복된다.
// 항목 수가 많아야 두세 개라 지우고 다시 넣는 편이 단순하고 안전하다.
//
// ⚠ 지웠다 넣으므로 탭의 lang_obj(번역본)도 함께 날아간다. 새 행으로 다시 번역 대기열에
//   올라가므로 결과는 같지만, 저장 직후 잠깐은 원문(한국어)으로 보인다.
async function saveTabs(notice_id, tabs, decode_dns) {
    if (!notice_id || !Array.isArray(tabs)) return;
    await readPool.query(`UPDATE ${tab_table_name} SET is_delete=1 WHERE notice_id=?`, [notice_id]);
    for (let i = 0; i < tabs.length; i++) {
        const t = tabs[i] || {};
        if (!String(t.tab_title ?? '').trim()) continue; // 제목 없는 탭은 화면에 누를 것이 없다
        let obj = {
            notice_id,
            tab_title: t.tab_title,
            tab_content: t.tab_content ?? '',
            sort: i,
        };
        const result = await insertQuery(tab_table_name, obj);
        await settingLangs(lang_obj_columns[tab_table_name], obj, decode_dns, tab_table_name, result?.insertId);
    }
}

export default benefitNoticeCtrl;
