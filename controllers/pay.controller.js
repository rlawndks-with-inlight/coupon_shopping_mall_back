'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';

const table_name = 'table_name';

const payCtrl = {
    cart: {
        list: async (req, res, next) => { //장바구니 담기
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const {
                } = req.body;
                let files = settingFiles(req.files);
                let obj = {
                    brand_id, name, note, price, category_id
                };

                obj = { ...obj, ...files };

                let result = await insertQuery(`${table_name}`, obj);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        create: async (req, res, next) => { //장바구니 담기
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const {
                } = req.body;
                let files = settingFiles(req.files);
                let obj = {
                    brand_id, name, note, price, category_id
                };

                obj = { ...obj, ...files };

                let result = await insertQuery(`${table_name}`, obj);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        update: async (req, res, next) => { //장바구니 담기
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const {
                } = req.body;
                let files = settingFiles(req.files);
                let obj = {
                    brand_id, name, note, price, category_id
                };

                obj = { ...obj, ...files };

                let result = await insertQuery(`${table_name}`, obj);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
        delete: async (req, res, next) => { //장바구니 담기
            try {
                let is_manager = await checkIsManagerUrl(req);
                const decode_user = checkLevel(req.cookies.token, 0, res);
                const decode_dns = checkDns(req.cookies.dns);
                const {
                } = req.body;
                let files = settingFiles(req.files);
                let obj = {
                    brand_id, name, note, price, category_id
                };

                obj = { ...obj, ...files };

                let result = await insertQuery(`${table_name}`, obj);

                return response(req, res, 100, "success", {})
            } catch (err) {
                console.log(err)
                return response(req, res, -200, "서버 에러 발생", false)
            } finally {

            }
        },
    },
    hand: async (req, res, next) => { //수기결제
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id
            };

            obj = { ...obj, ...files };

            let result = await insertQuery(`${table_name}`, obj);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    auth: async (req, res, next) => { //인증결제
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id
            };

            obj = { ...obj, ...files };

            let result = await insertQuery(`${table_name}`, obj);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    cancel: async (req, res, next) => { //결제취소
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id
            };

            obj = { ...obj, ...files };

            let result = await insertQuery(`${table_name}`, obj);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default payCtrl;
