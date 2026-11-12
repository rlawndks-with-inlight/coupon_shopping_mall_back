'use strict';
import { canWriteBrand, checkDns, checkLevel, errText, lowLevelException, response } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";

// 엑셀 내려받기 기록(2026-11-12 사장님 요청). 테이블: migrations/2026-11-12_excel_download_logs.sql
//
// 주문 엑셀에는 손님 이름·연락처·주소가 평문으로 들어간다. 누가·언제·어떤 조건으로·몇 건 받았는지 남긴다.
//   · 남기기: 파일을 만든 화면이 알려 준다. 사람은 서버가 로그인 토큰으로 정한다(화면이 보낸 이름은 쓰지 않는다).
//   · 보기: 최상위 관리자(level 50)만. 가맹점 관리자에게는 메뉴도 API 도 없다.
// ⚠ 화면이 알려 주는 방식이라 목록 API 를 직접 불러 만든 파일은 남지 않는다 — 막는 장치가 아니라 기록이다.
// ⚠ 검색어는 내용을 남기지 않는다(손님 이름·전화번호가 검색어로 들어온다). 썼는지만 남긴다.

const table = 'excel_download_logs';
const 종류들 = ['orders'];
const 상태열쇠 = /^(waiting|cancelled|failed|0|1|5|10|15|20|25)$/;
const 날짜꼴 = /^\d{4}-\d{2}-\d{2}$/;
const 아이피 = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64);

// 화면이 보낸 조건을 정해진 모양으로만 줄인다(모르는 값·긴 글은 버린다)
export const 조건정리 = (v = {}) => {
    const 상태 = String(v?.statuses ?? '').split(',').map((s) => s.trim()).filter((s) => 상태열쇠.test(s));
    return {
        s_dt: 날짜꼴.test(String(v?.s_dt ?? '')) ? v.s_dt : '',
        e_dt: 날짜꼴.test(String(v?.e_dt ?? '')) ? v.e_dt : '',
        statuses: [...new Set(상태)],
        search: Boolean(String(v?.search ?? '').trim()),
    };
};

const excelLogCtrl = {
    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 10, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const brand_id = Number(decode_dns?.id) || 0;
            // 자기 몰의 기록만 남긴다(최상위 관리자는 어느 몰이든)
            if (!(brand_id > 0) || !canWriteBrand(decode_user, brand_id)) return lowLevelException(req, res);
            const kind = 종류들.includes(req.body?.kind) ? req.body.kind : null;
            if (!kind) return response(req, res, -100, '알 수 없는 내려받기입니다.', false);
            const scope = req.body?.scope === 'selected' ? 'selected' : 'condition';
            const row_count = Math.max(0, Math.min(1000000, parseInt(req.body?.row_count) || 0));
            const conditions = scope === 'condition' ? JSON.stringify(조건정리(req.body?.conditions)) : null;
            await writePool.query(
                `INSERT INTO ${table} (brand_id, user_id, user_name, user_level, kind, scope, conditions, row_count, ip) VALUES (?,?,?,?,?,?,?,?,?)`,
                [brand_id, Number(decode_user.id) || 0, String(decode_user.user_name ?? '').slice(0, 100), Number(decode_user.level) || 0,
                    kind, scope, conditions, row_count, 아이피(req)]);
            return response(req, res, 100, "success", {});
        } catch (err) {
            // 기록을 못 남겨도 파일은 이미 받았다. 서버 로그에만 남기고 화면은 조용히 지나간다.
            logger.error('엑셀 내려받기 기록 실패: ' + errText(err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },
    // 최상위 관리자만. scope=all 이면 모든 몰, 아니면 지금 보고 있는 몰.
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 50, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const page = Math.max(1, parseInt(req.query?.page) || 1);
            const page_size = Math.min(100, Math.max(1, parseInt(req.query?.page_size) || 20));
            const 전체 = req.query?.scope === 'all';
            const 조건 = [];
            const params = [];
            if (!전체) { 조건.push(`l.brand_id=?`); params.push(Number(decode_dns?.id) || 0); }
            const where = 조건.length ? `WHERE ${조건.join(' AND ')}` : '';
            const [[{ total }]] = await readPool.query(`SELECT COUNT(*) AS total FROM ${table} l ${where}`, params);
            const [rows] = await readPool.query(
                `SELECT l.id, l.brand_id, b.name AS brand_name, b.dns AS brand_dns, l.user_id, l.user_name, l.user_level, l.kind, l.scope,
                        l.conditions, l.row_count, l.ip, l.created_at
                   FROM ${table} l LEFT JOIN brands b ON b.id=l.brand_id ${where}
                  ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...params, page_size, (page - 1) * page_size]);
            const content = rows.map((r) => {
                let conditions = null;
                try { conditions = r.conditions ? JSON.parse(r.conditions) : null; } catch (e) { conditions = null; }
                return { ...r, conditions };
            });
            return response(req, res, 100, "success", { content, total: Number(total) || 0, page, page_size });
        } catch (err) {
            // 테이블이 아직 없으면(마이그레이션 전) 빈 목록 — 화면이 서버 에러로 깨지지 않게
            if (err?.code === 'ER_NO_SUCH_TABLE') return response(req, res, 100, "success", { content: [], total: 0, page: 1, page_size: 20 });
            logger.error(errText(err));
            return response(req, res, -200, "서버 에러 발생", false);
        }
    },
};

export default excelLogCtrl;
