'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, resolveWriteBrandId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { encForSave, decRow, decListContent, decField, blindIndex } from "../utils.js/pii.js";

const table_name = 'phone_registration';

const phoneRegistrationCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { type = 'manager', brand_id, seller_id, phone_number } = req.query;

            let columns = [
                `${table_name}.*`,
                `sellers.dns`,
                `registered_user.id AS registered_user_id`,
                `registered_user.user_name AS registered_user_name`,
                `registered_user.name AS registered_name`,
                `registered_user.created_at AS registered_at`
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            sql += ` LEFT JOIN users AS sellers ON ${table_name}.seller_id=sellers.id `
            sql += ` LEFT JOIN users AS registered_user ON (${table_name}.phone_number=registered_user.phone_num OR ${table_name}.phone_idx=registered_user.phone_idx) AND ${table_name}.brand_id=registered_user.brand_id AND registered_user.is_delete=0 `

            let whereParams = [];
            if (type == 'manager') {
                if (decode_user?.level >= 20) {
                    sql += ` WHERE ${table_name}.brand_id=? `;
                    whereParams.push(decode_dns?.id ?? 0);
                } else {
                    sql += ` WHERE ${table_name}.seller_id=? `;
                    whereParams.push(decode_user?.id ?? 0);
                }
            } else {
                sql += ` WHERE ${table_name}.brand_id=? AND ${table_name}.seller_id=? AND (${table_name}.phone_number=? OR ${table_name}.phone_idx=?) `;
                whereParams.push(brand_id, seller_id, phone_number, blindIndex(phone_number));
            }
            //console.log(sql)

            let data = await getSelectQueryList(sql, columns, req.query, [], whereParams);

            decListContent('phone_registration', data); // phone_number 복호화
            (data?.content || []).forEach((r) => { if (r.registered_name) r.registered_name = decField(r.registered_name); }); // JOIN된 회원 실명 복호화
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
            const { brand_id, seller_id, phone_num } = req.params;
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE brand_id=? AND seller_id=? AND (phone_number=? OR phone_idx=?)`, [brand_id, seller_id, phone_num, blindIndex(phone_num)])
            data = data[0][0];

            //console.log(data)
            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
            decRow('phone_registration', data); // 읽기 복호화
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
            let {
                brand_id, seller_id, phone_number, registrar
            } = req.body;
            // 가입허용 전화번호 등록은 운영자(레벨10+)만, brand_id 는 body 를 믿지 않는다.
            // 예전엔 인증 없이 아무 브랜드에 번호를 넣어 '가입 제한 브랜드' 의 전화번호 화이트리스트를 우회할 수 있었다.
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            brand_id = resolveWriteBrandId(decode_user, brand_id, decode_dns);
            let files = settingFiles(req.files);

            let is_exist_number = await readPool.query(`SELECT * FROM ${table_name} WHERE (phone_number=? OR phone_idx=?) AND brand_id=? AND seller_id=? AND is_delete=0`, [phone_number, blindIndex(phone_number), brand_id, seller_id]);
            if (is_exist_number[0].length > 0) {
                return response(req, res, -100, "등록된 번호가 이미 존재합니다.", false)
            }

            let obj = {
                brand_id, seller_id, phone_number, registrar
            };

            obj = { ...obj, ...files };
            obj = encForSave('phone_registration', obj); // 전화번호 암호화 + blind-index

            //console.log(obj)

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
            let {
                id, phone_number, brand_id
            } = req.body;
            // 운영자만, 자기 브랜드 행만(예전엔 인증 없이 아무 행이나 갱신).
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            if (!(await loadOwnedRow(readPool, table_name, id, decode_user))) {
                return lowLevelException(req, res);
            }
            brand_id = resolveWriteBrandId(decode_user, brand_id, decode_dns);
            let files = settingFiles(req.files);

            let is_exist_number = await readPool.query(`SELECT * FROM ${table_name} WHERE (phone_number=? OR phone_idx=?) AND brand_id=?`, [phone_number, blindIndex(phone_number), brand_id]);
            if (is_exist_number[0].length > 0) {
                return response(req, res, -100, "등록된 번호가 이미 존재합니다.", false)
            }

            let obj = {
            };
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
            // 운영자만, 자기 브랜드 행만(예전엔 인증 없이 삭제 가능).
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            if (!(await loadOwnedRow(readPool, table_name, id, decode_user))) {
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

export default phoneRegistrationCtrl;
