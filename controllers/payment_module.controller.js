'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
// lowLevelException 은 45행에서 이미 쓰고 있었는데 import 가 빠져 있었다.
// try/catch 가 ReferenceError 를 삼켜 '서버 에러 발생'으로 보였을 뿐, 의도한 403 이 아니었다.
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
const table_name = 'payment_modules';

const paymentModuleCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 결제모듈 행에는 PG 자격증명(pay_key·mid·tid)이 들어 있다.
            // 5개 메서드 전부 로그인 검사가 없어서 dns 쿠키만으로 조회·변조·삭제가 됐다.
            // 프론트 호출부는 pages/manager/settings/payment-modules/** 뿐이다(관리자 전용).
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const { } = req.query;

            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE ${table_name}.brand_id=? `;
            let params = [decode_dns?.id ?? 0];

            let data = await getSelectQueryList(sql, columns, req.query, [], params);

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
            // 결제모듈 행에는 PG 자격증명(pay_key·mid·tid)이 들어 있다.
            // 5개 메서드 전부 로그인 검사가 없어서 dns 쿠키만으로 조회·변조·삭제가 됐다.
            // 프론트 호출부는 pages/manager/settings/payment-modules/** 뿐이다(관리자 전용).
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
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
    create: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 결제모듈 행에는 PG 자격증명(pay_key·mid·tid)이 들어 있다.
            // 5개 메서드 전부 로그인 검사가 없어서 dns 쿠키만으로 조회·변조·삭제가 됐다.
            // 프론트 호출부는 pages/manager/settings/payment-modules/** 뿐이다(관리자 전용).
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                pay_key, mid, tid, trx_type = 0, is_old_auth = 0, brand_id, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url, forspay_config
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                // body 의 brand_id 를 그대로 insert 하면 다른 가맹점 앞으로 PG 자격증명 행을 만들 수 있다.
                // 쓰기 대상 브랜드는 로그인 토큰 기준으로 확정한다(레벨50 이상만 교차 브랜드 허용).
                brand_id: resolveWriteBrandId(decode_user, brand_id),
                pay_key, mid, tid, trx_type, is_old_auth, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url
            };
            if (forspay_config !== undefined) obj.forspay_config = forspay_config; // 포스페이 수단별 PG 라우팅(JSON). 컬럼 필요(ALTER).
            let columns = [
                `${table_name}.*`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` WHERE ${table_name}.brand_id=? `;
            obj = { ...obj, ...files };
            let is_exist_trx_type = await readPool.query(`SELECT * FROM ${table_name} WHERE trx_type=? AND brand_id=?`, [trx_type, decode_dns?.id ?? 0]);
            is_exist_trx_type = is_exist_trx_type[0];
            if (is_exist_trx_type.length > 0) {
                return response(req, res, -100, `결제타입은 브랜드당 한개씩만 가능합니다.`, false)
            }
            let result = await insertQuery(`${table_name}`, obj);


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
            // 결제모듈 행에는 PG 자격증명(pay_key·mid·tid)이 들어 있다.
            // 5개 메서드 전부 로그인 검사가 없어서 dns 쿠키만으로 조회·변조·삭제가 됐다.
            // 프론트 호출부는 pages/manager/settings/payment-modules/** 뿐이다(관리자 전용).
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                pay_key, mid, tid, trx_type = 0, is_old_auth = 0, brand_id, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url, forspay_config,
                id
            } = req.body;
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없다.
            // 소유 검증 없이는 남의 가맹점 PG 자격증명을 id 만 바꿔 덮어쓸 수 있었다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let files = settingFiles(req.files);
            let obj = {
                pay_key, mid, tid, trx_type, is_old_auth, virtual_acct_url, virtual_acct_num, virtual_acct_name, virtual_acct_bank, gift_certificate_url
            };
            if (forspay_config !== undefined) obj.forspay_config = forspay_config; // 포스페이 수단별 PG 라우팅(JSON). 컬럼 필요(ALTER).
            obj = { ...obj, ...files };
            let is_exist_trx_type = await readPool.query(`SELECT * FROM ${table_name} WHERE trx_type=? AND brand_id=? AND id!=?`, [trx_type, decode_dns?.id ?? 0, id]);
            is_exist_trx_type = is_exist_trx_type[0];
            if (is_exist_trx_type.length > 0) {
                return response(req, res, -200, `결제타입은 브랜드당 한개씩만 가능합니다.`, false)
            }
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
            // 결제모듈 행에는 PG 자격증명(pay_key·mid·tid)이 들어 있다.
            // 5개 메서드 전부 로그인 검사가 없어서 dns 쿠키만으로 조회·변조·삭제가 됐다.
            // 프론트 호출부는 pages/manager/settings/payment-modules/** 뿐이다(관리자 전용).
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const { id } = req.params;
            // deleteQuery 도 WHERE id=? 만 걸어 브랜드 스코프가 없다. 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let result = await deleteQuery(`${table_name}`, {
                id
            }, true)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default paymentModuleCtrl;
