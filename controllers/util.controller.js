'use strict';
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';


const utilCtrl = {
    sort: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0);
            const decode_dns = checkDns(req.cookies.dns);
            let { source_id, source_sort_idx, dest_id, dest_sort_idx } = req.body;
            const { table } = req.params;
            await db.beginTransaction();
            console.log(req.body)
            let update_sql = ` UPDATE ${table} SET `
            source_id = parseInt(source_id);
            source_sort_idx = parseInt(source_sort_idx);
            dest_id = parseInt(dest_id);
            dest_sort_idx = parseInt(dest_sort_idx);
            if (source_sort_idx >= dest_sort_idx) {//드래그한게 더 클때
                update_sql += ` sort_idx=sort_idx+1 WHERE sort_idx < ${source_sort_idx} AND sort_idx >= ${dest_sort_idx} AND id!=${source_id} `;
            } else {//드래그한게 더 작을때
                update_sql += ` sort_idx=sort_idx-1 WHERE sort_idx > ${source_sort_idx} AND sort_idx <= ${dest_sort_idx} AND id!=${source_id} `;
            }
            console.log(update_sql)
            let update_result = await pool.query(update_sql);

            let result = await pool.query(`UPDATE ${table} SET sort_idx=? WHERE id=?`, [dest_sort_idx, source_id]);

            await db.commit();
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            await db.rollback();
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    changeStatus: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 10);
            const decode_dns = checkDns(req.cookies.dns);
            const { table, column_name } = req.params;
            const { value, id } = req.body;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let result = await pool.query(`UPDATE ${table} SET ${column_name}=? WHERE id=?`, [value, id]);
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default utilCtrl;
