'use strict';
import axios from "axios";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, hasColumn, insertQuery, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'logs'
const logCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 요청 로그(과거 요청 본문 포함)는 운영자만 본다. 예전엔 dns 쿠키만으로 전 브랜드 로그가 열렸다.
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            // logs 테이블은 실제 DB 에 없다(logRequestResponse 가 주석 처리된 죽은 기능). 예전엔 이 화면이 늘 '서버 에러' 였다.
            // 테이블이 없으면 빈 목록을 돌려 화면이 정상적으로 '없음' 을 보이게 한다.
            if (!(await hasColumn(table_name, 'id'))) {
                return response(req, res, 100, "success", { content: [], total: 0, page: 1, page_size: 20, maxPage: 1, success: 0, fail: 0 });
            }
            const { response_result_type } = req.query;
            let columns = [
                `${table_name}.*`,
                'users.user_name',
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users ON users.id=${table_name}.user_id `
            let params = [];
            sql += ` WHERE 1=1 `
            // 브랜드 범위: 마스터(50+)만 전체, 그 외는 '토큰의 brand_id'(서명됨)로 고정.
            // dns 쿠키는 누구나 임의 브랜드 것을 받을 수 있어 범위 기준이 될 수 없다.
            if (!(Number(decode_user?.level) >= 50)) {
                sql += ` AND ${table_name}.brand_id=?`
                params.push(decode_user?.brand_id ?? 0);
            }
            let sql_list = [
                { table: 'success', sql: (sql + ` ${sql.includes('WHERE') ? 'AND' : 'WHERE'} response_result > 0 `).replaceAll(process.env.SELECT_COLUMN_SECRET, 'COUNT(*) AS success') },
                { table: 'fail', sql: (sql + ` ${sql.includes('WHERE') ? 'AND' : 'WHERE'} response_result < 0 `).replaceAll(process.env.SELECT_COLUMN_SECRET, 'COUNT(*) AS fail') },
            ];
            if (response_result_type) {
                sql += ` AND ${table_name}.response_result ${response_result_type == 1 ? '>=' : '<'} 0 `
            }

            let data = await getSelectQueryList(sql, columns, req.query, sql_list, params);
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
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id])
            data = data[0][0];
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 50, res);
            const decode_dns = checkDns(req.cookies.dns);
            if (!decode_user) return lowLevelException(req, res);
            const { id } = req.params;
            // ⚠ 예전엔 여기서 'brands' 를 soft-delete 했다 — 인증 없는 로그 삭제 API 로 몰을 통째로 내릴 수 있었다.
            //    이 컨트롤러의 대상은 logs 다.
            let result = await deleteQuery(table_name, {
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

export default logCtrl;
