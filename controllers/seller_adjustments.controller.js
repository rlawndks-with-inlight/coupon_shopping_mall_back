'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";

const table_name = 'transactions';

const sellerAdjustmentsCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies?.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const { trx_status, cancel_status, is_confirm, cancel_type, type, state, s_dt, e_dt } = req.query;
            if (!decode_user) {
                return lowLevelException(req, res);
            }

            let data = {
                //trx: {},
            };

            if (state == 0) {
                const topBrandSql = `
                SELECT tp.id AS top_id, 
                tp.name AS top_name, 
                SUM(t.amount) AS total_amount,
                SUM(t.amount * 0.1) AS total_card,
                SUM((t.amount * 0.9) - t.agent_amount) AS total_seller,
                SUM(t.amount - ((t.amount * 0.9) - t.agent_amount) - ((t.agent_amount * (1 / (1 + sl.seller_trx_fee))) * (1 / (1 + ag.oper_trx_fee))) ) AS total_agent
                FROM users tp
                LEFT JOIN users ag 
                ON ag.oper_id = tp.id AND ag.level = 15 
                LEFT JOIN users sl 
                ON sl.oper_id = ag.id AND sl.level = 10
                LEFT JOIN (
                SELECT *
                FROM ${table_name}
                WHERE trx_status = 5 AND is_cancel = 0
                ${s_dt ? ` AND created_at >= '${s_dt} 00:00:00'` : ''}
                ${e_dt ? ` AND created_at <= '${e_dt} 23:59:59'` : ''}
                ) t
                 ON t.seller_id = sl.id
                 WHERE tp.level = 20 
                 AND tp.brand_id = ${decode_dns?.id}
                 AND tp.is_delete = 0
                 GROUP BY tp.id, tp.name
                 ORDER BY tp.id;
                 `;
                let topSales = await readPool.query(topBrandSql);
                topSales = topSales[0];

                // 결과를 총판별로 구성
                const result = topSales.map(row => ({
                    id: row.top_id,
                    name: row.top_name,
                    total_amount: row.total_amount ?? 0, // null 방지
                    total_card: row.total_card ? parseInt(row.total_card) : 0,
                    total_seller: row.total_seller ? parseInt(row.total_seller) : 0,
                    total_agent: row.total_agent ? parseInt(row.total_agent) : 0
                }));

                data['content'] = result;
                return response(req, res, 100, "success", data);
            }

            else if (state == 1) {
                let agBrandSql = ``
                if (decode_user?.level >= 20) {
                    agBrandSql = `
                SELECT ag.id AS ag_id, 
                ag.name AS ag_name, 
                SUM(t.amount) AS total_amount,
                SUM(t.amount * 0.1) AS total_card,
                SUM((t.amount * 0.9) - t.agent_amount) AS total_seller,
                SUM(t.amount - ((t.amount * 0.9) - t.agent_amount) - ((t.agent_amount * (1 / (1 + sl.seller_trx_fee))) * (1 / (1 + ag.oper_trx_fee))) ) AS total_agent
                FROM users ag
                LEFT JOIN users sl 
                ON sl.oper_id = ag.id AND sl.level = 10
                LEFT JOIN (
                SELECT *
                FROM ${table_name}
                WHERE trx_status = 5 AND is_cancel = 0
                ${s_dt ? ` AND created_at >= '${s_dt} 00:00:00'` : ''}
                ${e_dt ? ` AND created_at <= '${e_dt} 23:59:59'` : ''}
                ) t
                 ON t.seller_id = sl.id
                 WHERE ag.level = 15 
                 AND ag.brand_id = ${decode_dns?.id}
                 AND ag.is_delete = 0
                 GROUP BY ag.id, ag.name
                 ORDER BY ag.id;
                 `;
                } else if (decode_user?.level == 15) {
                    agBrandSql = `
                SELECT ag.id AS ag_id, 
                ag.name AS ag_name, 
                SUM(t.amount) AS total_amount,
                SUM(t.amount * 0.1) AS total_card,
                SUM((t.amount * 0.9) - t.agent_amount) AS total_seller,
                SUM(t.amount - ((t.amount * 0.9) - t.agent_amount) - ((t.agent_amount * (1 / (1 + sl.seller_trx_fee))) * (1 / (1 + ag.oper_trx_fee))) ) AS total_agent
                FROM users ag
                LEFT JOIN users sl 
                ON sl.oper_id = ag.id AND sl.level = 10
                LEFT JOIN (
                SELECT *
                FROM ${table_name}
                WHERE trx_status = 5 AND is_cancel = 0
                ${s_dt ? ` AND created_at >= '${s_dt} 00:00:00'` : ''}
                ${e_dt ? ` AND created_at <= '${e_dt} 23:59:59'` : ''}
                ) t
                 ON t.seller_id = sl.id
                 WHERE ag.id = ${decode_user?.id} 
                 AND ag.brand_id = ${decode_dns?.id}
                 AND ag.is_delete = 0
                 GROUP BY ag.id, ag.name
                 ORDER BY ag.id;
                 `;
                }
                let agSales = await readPool.query(agBrandSql);
                agSales = agSales[0];

                // 결과를 총판별로 구성
                const result = agSales.map(row => ({
                    id: row.ag_id,
                    name: row.ag_name,
                    total_amount: row.total_amount ?? 0, // null 방지
                    total_card: row.total_card ? parseInt(row.total_card) : 0,
                    total_seller: row.total_seller ? parseInt(row.total_seller) : 0,
                    total_agent: row.total_agent ? parseInt(row.total_agent) : 0
                }));

                data['content'] = result;
                return response(req, res, 100, "success", data);
            }

            else if (state == 2) {
                let sellerBrandSql = ``
                if (decode_user?.level >= 20) {
                    sellerBrandSql = `
                SELECT sl.id AS seller_id, 
                sl.name AS seller_name, 
                SUM(t.amount) AS total_amount,
                SUM(t.amount * 0.1) AS total_card,
                SUM((t.amount * 0.9) - t.agent_amount) AS total_seller
                FROM users sl
                LEFT JOIN (
                SELECT *
                FROM ${table_name}
                WHERE trx_status = 5 AND is_cancel = 0
                ${s_dt ? ` AND created_at >= '${s_dt} 00:00:00'` : ''}
                ${e_dt ? ` AND created_at <= '${e_dt} 23:59:59'` : ''}
                ) t
                 ON t.seller_id = sl.id
                 WHERE sl.level = 10 
                 AND sl.brand_id = ${decode_dns?.id}
                 AND sl.is_delete = 0
                 GROUP BY sl.id, sl.name
                 ORDER BY sl.id;
                 `;
                } else if (decode_user?.level == 15) {
                    sellerBrandSql = `
                SELECT sl.id AS seller_id, 
                sl.name AS seller_name, 
                SUM(t.amount) AS total_amount,
                SUM(t.amount * 0.1) AS total_card,
                SUM((t.amount * 0.9) - t.agent_amount) AS total_seller
                FROM users sl
                LEFT JOIN (
                SELECT *
                FROM ${table_name}
                WHERE trx_status = 5 AND is_cancel = 0
                ${s_dt ? ` AND created_at >= '${s_dt} 00:00:00'` : ''}
                ${e_dt ? ` AND created_at <= '${e_dt} 23:59:59'` : ''}
                ) t
                 ON t.seller_id = sl.id
                 WHERE sl.level = 10 
                 AND sl.oper_id = ${decode_user?.id}
                 AND sl.brand_id = ${decode_dns?.id}
                 AND sl.is_delete = 0
                 GROUP BY sl.id, sl.name
                 ORDER BY sl.id;
                 `;
                } else if (decode_user?.level == 10) {
                    sellerBrandSql = `
                SELECT sl.id AS seller_id, 
                sl.name AS seller_name, 
                SUM(t.amount) AS total_amount,
                SUM(t.amount * 0.1) AS total_card,
                SUM((t.amount * 0.9) - t.agent_amount) AS total_seller
                FROM users sl
                LEFT JOIN (
                SELECT *
                FROM ${table_name}
                WHERE trx_status = 5 AND is_cancel = 0
                ${s_dt ? ` AND created_at >= '${s_dt} 00:00:00'` : ''}
                ${e_dt ? ` AND created_at <= '${e_dt} 23:59:59'` : ''}
                ) t
                 ON t.seller_id = sl.id
                 WHERE sl.level = 10 
                 AND sl.id = ${decode_user?.id}
                 AND sl.brand_id = ${decode_dns?.id}
                 AND sl.is_delete = 0
                 GROUP BY sl.id, sl.name
                 ORDER BY sl.id;
                 `;
                }
                let sellerSales = await readPool.query(sellerBrandSql);
                sellerSales = sellerSales[0];

                // 결과를 총판별로 구성
                const result = sellerSales.map(row => ({
                    id: row.seller_id,
                    name: row.seller_name,
                    total_amount: row.total_amount ?? 0, // null 방지
                    total_card: row.total_card ? parseInt(row.total_card) : 0,
                    total_seller: row.total_seller ? parseInt(row.total_seller) : 0,
                    total_agent: row.total_agent ? parseInt(row.total_agent) : 0
                }));

                data['content'] = result;
                return response(req, res, 100, "success", data);
            }
            else {
                return response(req, res, -200, "서버 에러 발생", false);
            }

        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default sellerAdjustmentsCtrl;
