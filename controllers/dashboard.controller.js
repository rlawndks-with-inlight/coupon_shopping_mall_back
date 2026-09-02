'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, findChildIds, isItemBrandIdSameDnsId, lowLevelException, makeTree, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";

const table_name = 'transactions';

const dashboardCtrl = {
    all: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 매출·주문 집계는 운영자만, 브랜드는 '토큰의 brand_id'(마스터는 dns). 예전엔 dns 쿠키만으로 아무 브랜드 매출을 볼 수 있었다.
            if (!decode_user || Number(decode_user?.level) < 10) {
                return lowLevelException(req, res);
            }
            const dashBrandId = Number(decode_user?.level) >= 50 ? Number(decode_dns?.id) : Number(decode_user?.brand_id);

            const { s_dt, e_dt } = req.query;

            let data = {
                trx: {},
            };
            //결제내역
            let trx_counts_sql = `SELECT trx_status, COUNT(*) AS cnt FROM ${table_name} `;
            // 목록은 query-util 이 is_delete=0 을 자동으로 붙이는데(query-util.js:194-195)
            // 이 집계 3종에는 없었다. 삭제(soft delete)한 주문이 대시보드 건수·매출에만
            // 계속 잡혀서 목록 건수와 어긋났다.
            // 취소된 주문은 매출이 아니다. is_cancel=0 만 걸면 취소 원장 행(음수)만 빠지고,
            // 정작 취소된 원주문(is_cancel_trans=1, 금액 양수)은 그대로 잡혀 매출이 부풀었다.
            trx_counts_sql += ` WHERE is_cancel=0 AND is_cancel_trans=0 AND is_delete=0 AND brand_id=? `;
            let trx_counts_params = [dashBrandId];

            let trx_cancel_counts_sql = `SELECT COUNT(*) AS cnt FROM ${table_name} `;
            trx_cancel_counts_sql += ` WHERE is_cancel=1 AND is_delete=0 AND brand_id=? `;
            let trx_cancel_counts_params = [dashBrandId];

            let trx_amounts_sql = ` SELECT DATE(created_at) AS date, SUM(amount) AS total_amount FROM ${table_name} `;
            trx_amounts_sql += ` WHERE trx_status=5 AND is_cancel=0 AND is_cancel_trans=0 AND is_delete=0 AND brand_id=? `;
            let trx_amounts_params = [dashBrandId];

            if (decode_user?.level == 10) { //셀러의 경우 영업자를 거친 차익을 계산해야 함
                let trx_agent_amounts_sql = ` SELECT DATE(created_at) AS date, SUM(agent_amount) AS total_agent_amount FROM ${table_name} `;
                trx_agent_amounts_sql += ` WHERE trx_status=5 AND is_cancel=0 AND is_cancel_trans=0 AND brand_id=? `;
                let trx_agent_amounts_params = [dashBrandId];
                trx_agent_amounts_sql += ` AND seller_id = ? `;
                trx_agent_amounts_params.push(decode_user?.id);
                if (s_dt) {
                    trx_agent_amounts_sql += ` AND ${table_name}.created_at >= ? `
                    trx_agent_amounts_params.push(`${s_dt} 00:00:00`);
                }
                if (e_dt) {
                    trx_agent_amounts_sql += ` AND ${table_name}.created_at <= ? `
                    trx_agent_amounts_params.push(`${e_dt} 23:59:59`);
                }
                trx_agent_amounts_sql += ` GROUP BY DATE(created_at) `;
                let trx_agent_amounts = await readPool.query(trx_agent_amounts_sql, trx_agent_amounts_params);
                trx_agent_amounts = trx_agent_amounts[0];
                data['trx_agent_amounts_sum'] = trx_agent_amounts;

            }

            if (decode_user?.level == 10) { //셀러
                trx_counts_sql += ` AND seller_id = ? `;
                trx_counts_params.push(decode_user?.id);
                trx_cancel_counts_sql += ` AND seller_id = ? `;
                trx_cancel_counts_params.push(decode_user?.id);
                trx_amounts_sql += ` AND seller_id = ? `;
                trx_amounts_params.push(decode_user?.id);
            }

            if (decode_user?.level == 15) { // 영업자 (총판이 아닌 영업자의 경우에도 총판을 거친 차익을 계산해야 함)

                let trx_agent_amounts_sql = ` SELECT DATE(created_at) AS date, SUM(agent_amount) AS total_agent_amount FROM ${table_name} `;
                trx_agent_amounts_sql += ` WHERE trx_status=5 AND is_cancel=0 AND is_cancel_trans=0 AND brand_id=? `;
                let trx_agent_amounts_params = [dashBrandId];
                trx_agent_amounts_sql += ` AND seller_id IN (SELECT id FROM users WHERE oper_id=?) `;
                trx_agent_amounts_params.push(decode_user?.id);
                if (s_dt) {
                    trx_agent_amounts_sql += ` AND ${table_name}.created_at >= ? `
                    trx_agent_amounts_params.push(`${s_dt} 00:00:00`);
                }
                if (e_dt) {
                    trx_agent_amounts_sql += ` AND ${table_name}.created_at <= ? `
                    trx_agent_amounts_params.push(`${e_dt} 23:59:59`);
                }
                trx_agent_amounts_sql += ` GROUP BY DATE(created_at) `;
                let trx_agent_amounts = await readPool.query(trx_agent_amounts_sql, trx_agent_amounts_params);
                trx_agent_amounts = trx_agent_amounts[0];
                data['trx_agent_amounts_sum'] = trx_agent_amounts;
                //영업자의 경우 영업자 하위 셀러의 전체 매출을 표시, 그리고 셀러별 가져오는 수익의 퍼센트를 표시하는 것인지 아니면 전체 매출의 일정 퍼센트를 표시하는 것인지 알아봐야 함

                trx_counts_sql += ` AND seller_id IN (SELECT id FROM users WHERE oper_id=?) `;
                trx_counts_params.push(decode_user?.id);
                trx_cancel_counts_sql += ` AND seller_id IN (SELECT id FROM users WHERE oper_id=?) `;
                trx_cancel_counts_params.push(decode_user?.id);
                trx_amounts_sql += ` AND seller_id IN (SELECT id FROM users WHERE oper_id=?) `;
                trx_amounts_params.push(decode_user?.id);
            }

            if (s_dt) {
                trx_counts_sql += ` AND ${table_name}.created_at >= ? `;
                trx_counts_params.push(`${s_dt} 00:00:00`);
                trx_cancel_counts_sql += ` AND ${table_name}.created_at >= ? `;
                trx_cancel_counts_params.push(`${s_dt} 00:00:00`);
                trx_amounts_sql += ` AND ${table_name}.created_at >= ? `
                trx_amounts_params.push(`${s_dt} 00:00:00`);
            }
            if (e_dt) {
                trx_counts_sql += ` AND ${table_name}.created_at <= ? `;
                trx_counts_params.push(`${e_dt} 23:59:59`);
                trx_cancel_counts_sql += ` AND ${table_name}.created_at <= ? `;
                trx_cancel_counts_params.push(`${e_dt} 23:59:59`);
                trx_amounts_sql += ` AND ${table_name}.created_at <= ? `
                trx_amounts_params.push(`${e_dt} 23:59:59`);
            }
            trx_counts_sql += ` GROUP BY trx_status `;
            let trx_counts = await readPool.query(trx_counts_sql, trx_counts_params);
            trx_counts = trx_counts[0];
            let trx_sum = 0;
            for (var i = 0; i < trx_counts.length; i++) {
                data.trx[`trx_${trx_counts[i]?.trx_status}`] = trx_counts[i]?.cnt;
                trx_sum += trx_counts[i]?.cnt;
            }


            let trx_cancel_counts = await readPool.query(trx_cancel_counts_sql, trx_cancel_counts_params);
            trx_cancel_counts = trx_cancel_counts[0][0];
            data['is_cancel'] = trx_cancel_counts?.cnt;
            trx_sum += trx_cancel_counts?.cnt;
            data['trx_sum'] = trx_sum;
            if (trx_sum == 0) {
                data['trx_sum'] = 1;
            }

            //s_dt와 e_dt 사이 매출 합
            trx_amounts_sql += ` GROUP BY DATE(created_at) `;
            let trx_amounts = await readPool.query(trx_amounts_sql, trx_amounts_params);
            trx_amounts = trx_amounts[0];
            data['trx_amounts_sum'] = trx_amounts;

            //console.log(data)

            //문의관리
            let post_category_columns = [
                `post_categories.*`,
            ]
            let post_category_sql = `SELECT ${post_category_columns.join()} FROM post_categories `;
            post_category_sql += ` WHERE post_categories.brand_id=? `;
            post_category_sql += ` AND post_categories.is_delete=0 ORDER BY sort_idx DESC`;
            let post_categories = await readPool.query(post_category_sql, [dashBrandId]);
            post_categories = post_categories[0];
            let post_categories_tree = makeTree(post_categories);
            let request_post_categories = post_categories_tree.filter(el => el?.post_category_read_type == 1 && el?.is_able_user_add == 1)

            for (var i = 0; i < request_post_categories.length; i++) {
                let ids = findChildIds(post_categories, request_post_categories[i]?.id);
                ids.unshift(parseInt(request_post_categories[i]?.id));
                let request_counts_sql = ` SELECT COUNT(*) AS cnt FROM posts `;
                request_counts_sql += ` LEFT JOIN post_categories ON posts.category_id=post_categories.id `;
                request_counts_sql += ` WHERE category_id IN (${ids.map(() => '?').join(',')}) `;
                let request_counts_params = [...ids];
                request_counts_sql += ` AND posts.is_reply=0`   //문의의 is_reply==0, 답변의 is_reply==1
                request_counts_sql += ` AND posts.is_delete=0` //이미 지워진 문의는 포함x
                request_counts_sql += ` AND NOT EXISTS (SELECT 1 FROM posts AS child WHERE child.parent_id = posts.id)`

                /*if (s_dt) {
                    request_counts_sql += ` AND posts.created_at >= '${s_dt} 00:00:00' `;
                }
                if (e_dt) {
                    request_counts_sql += ` AND posts.created_at <= '${e_dt} 23:59:59' `;
                }*/
                //console.log(request_counts_sql)
                let request_counts = await readPool.query(request_counts_sql, request_counts_params);
                request_counts = request_counts[0][0];
                data[`request_${request_post_categories[i]?.id}`] = request_counts?.cnt ?? 0;
            }
            //console.log(data)
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
