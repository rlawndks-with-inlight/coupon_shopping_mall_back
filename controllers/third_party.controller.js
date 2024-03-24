'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import axios from "axios";

const table_name = 'table_name';

const thirdPartyCtrl = {
    translate_naver: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { } = req.query;
            var api_url = 'https://openapi.naver.com/v1/papago/n2mt';
            var request = require('request');
            var options = {
                url: api_url,
                form: { 'source': 'ko', 'target': 'en', 'text': query },
                headers: { 'X-Naver-Client-Id': client_id, 'X-Naver-Client-Secret': client_secret }
            };
            let result = await axios.post(api_url, {
                'source': 'ko',
                'target': 'en',
                'text': query
            }, {
                headers: { 'X-Naver-Client-Id': client_id, 'X-Naver-Client-Secret': client_secret }
            }
            )
            //console.log(result);
            request.post(options, function (error, response, body) {
                if (!error && response.statusCode == 200) {
                    res.writeHead(200, { 'Content-Type': 'text/json;charset=utf-8' });
                    res.end(body);
                } else {
                    res.status(response.statusCode).end();
                    console.log('error = ' + response.statusCode);
                }
            });

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default thirdPartyCtrl;
