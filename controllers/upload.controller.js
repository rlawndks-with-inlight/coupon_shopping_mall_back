'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { checkLevel, makeUserToken, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
const uploadCtrl = {
    single: async (req, res, next) => {
        try {
            let files = settingFiles(req.files);
            return response(req, res, 100, "success", {
                url: files?.post_img
            });
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    muiltiple: async (req, res, next) => {
        try {
            let files = req.files;
            console.log(files)
            return response(req, res, 100, "success", []);
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
}

export default uploadCtrl;