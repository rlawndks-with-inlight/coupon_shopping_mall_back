'use strict';
import { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";

const table_name = 'transactions';

const dashboardCtrl = {
    all: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const { s_dt, e_dt } = req.query;

            let data = {
                trx: {},
            };
            //결제내역
            let trx_counts_sql = `SELECT trx_status, COUNT(*) AS cnt FROM ${table_name} `;
            trx_counts_sql += ` WHERE is_cancel=0 AND brand_id=${decode_dns?.id} `;
            let trx_cancel_counts_sql = `SELECT COUNT(*) AS cnt FROM ${table_name} `;
            trx_cancel_counts_sql += ` WHERE is_cancel=1 AND brand_id=${decode_dns?.id} `;
            if (s_dt) {
                trx_counts_sql += ` AND ${table_name}.created_at >= '${s_dt} 00:00:00' `;
                trx_cancel_counts_sql += ` AND ${table_name}.created_at >= '${s_dt} 00:00:00' `;
            }
            if (e_dt) {
                trx_counts_sql += ` AND ${table_name}.created_at <= '${e_dt} 23:59:59' `;
                trx_cancel_counts_sql += ` AND ${table_name}.created_at <= '${e_dt} 23:59:59' `;
            }
            trx_counts_sql += ` GROUP BY trx_status `;
            let trx_counts = await pool.query(trx_counts_sql);
            trx_counts = trx_counts?.result;
            let trx_sum = 0;
            for (var i = 0; i < trx_counts.length; i++) {
                data.trx[`trx_${trx_counts[i]?.trx_status}`] = trx_counts[i]?.cnt;
                trx_sum += trx_counts[i]?.cnt;
            }


            let trx_cancel_counts = await pool.query(trx_cancel_counts_sql);
            trx_cancel_counts = trx_cancel_counts?.result[0];
            data['is_cancel'] = trx_cancel_counts?.cnt;
            trx_sum += trx_cancel_counts?.cnt;
            data['trx_sum'] = trx_sum;
            if (trx_sum == 0) {
                data['trx_sum'] = 1;
            }

            //문의관리
            let post_category_columns = [
                `post_categories.*`,
            ]
            let post_category_sql = `SELECT ${post_category_columns.join()} FROM post_categories `;
            post_category_sql += ` WHERE post_categories.brand_id=${decode_dns?.id ?? 0} `;
            post_category_sql += ` AND post_categories.is_delete=0 ORDER BY sort_idx DESC`;
            let post_categories = await pool.query(post_category_sql);
            post_categories = post_categories?.result;
            let post_categories_tree = makeTree(post_categories);
            let request_post_categories = post_categories_tree.filter(el => el?.post_category_read_type == 1 && el?.is_able_user_add == 1)

            for (var i = 0; i < request_post_categories.length; i++) {
                let ids = findChildIds(post_categories, request_post_categories[i]?.id);
                ids.unshift(parseInt(request_post_categories[i]?.id));
                let request_counts_sql = ` SELECT COUNT(*) AS cnt FROM posts `;
                request_counts_sql += ` LEFT JOIN post_categories ON posts.category_id=post_categories.id `;
                request_counts_sql += ` WHERE category_id IN (${ids.join()}) `;
                request_counts_sql += ` AND posts.is_reply=0`   //문의의 is_reply==0, 답변의 is_reply==1
                request_counts_sql += ` AND posts.is_delete=0` //이미 지워진 문의는 포함x
                
                if (s_dt) {
                    request_counts_sql += ` AND posts.created_at >= '${s_dt} 00:00:00' `;
                }
                if (e_dt) {
                    request_counts_sql += ` AND posts.created_at <= '${e_dt} 23:59:59' `;
                }
                let request_counts = await pool.query(request_counts_sql);
                request_counts = request_counts?.result[0];
                data[`request_${request_post_categories[i]?.id}`] = request_counts?.cnt ?? 0;
            }
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default dashboardCtrl;
