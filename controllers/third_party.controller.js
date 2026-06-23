'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import axios from "axios";

const table_name = 'table_name';

const thirdPartyCtrl = {
    // 구글 번역(gtx, 무료 비공식). 여러 언어 동시 번역 지원.
    // body: { text, targets: ['en','ja',...] } 또는 { text, target: 'en' }, source 기본 'auto'
    translate_google: async (req, res, next) => {
        try {
            const { text, targets, target, source = 'auto' } = req.body;
            if (!text || !String(text).trim()) {
                return response(req, res, -100, "번역할 text가 필요합니다", false);
            }
            const targetList = Array.isArray(targets) && targets.length
                ? targets
                : (target ? [target] : []);
            if (!targetList.length) {
                return response(req, res, -100, "target(s)가 필요합니다", false);
            }
            const translateOne = async (tl) => {
                const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
                const { data } = await axios.get(url, { timeout: 10000 });
                // 응답: [[["번역","원문",...], ...], ...] → 세그먼트 합치기
                return (data?.[0] || []).map((seg) => seg?.[0]).filter(Boolean).join('');
            };
            const entries = await Promise.all(
                targetList.map(async (tl) => [tl, await translateOne(tl)])
            );
            const translations = Object.fromEntries(entries);
            return response(req, res, 100, "success", { source, translations });
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err?.message || err));
            return response(req, res, -200, "번역 실패", false);
        }
    },
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
