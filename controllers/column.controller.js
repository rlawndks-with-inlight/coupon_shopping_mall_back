'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";

const table_name = 'table_name';

const columnCtrl = {

    tables: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 50, res);
            const decode_dns = checkDns(req.cookies.dns);
            let data = await readPool.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='comagain_shop' GROUP BY TABLE_NAME ORDER BY TABLE_NAME ASC`);
            data = data[0];
            data = data.map(item => {
                return item?.TABLE_NAME
            })
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    columns: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { table } = req.params;
            let data = await readPool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='comagain_shop' AND TABLE_NAME='${table}' `);
            data = data[0];
            data = data.map(item => {
                return item?.COLUMN_NAME
            })
            let add_columns = {
                'products': [
                    'characters',
                    'properties',
                    'options',
                ]
            }
            data = [...data, ...add_columns[table] ?? []];
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    onChangeUseColumn: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { table } = req.params;
            const { column, is_not_use = 0 } = req.body;

            let brand_data = await readPool.query(`SELECT * FROM brands WHERE id=${decode_dns?.id}`);
            brand_data = brand_data[0][0];
            brand_data['none_use_column_obj'] = JSON.parse(brand_data?.none_use_column_obj ?? '{}');
            if (!brand_data['none_use_column_obj'][table]) {
                brand_data['none_use_column_obj'][table] = [];
            }
            if (is_not_use == 1) {
                brand_data['none_use_column_obj'][table].push(column);
            } else {
                let find_idx = brand_data['none_use_column_obj'][table].indexOf(column);
                if (find_idx >= 0) {
                    brand_data['none_use_column_obj'][table].splice(find_idx, 1);
                }
            }

            let result = await writePool.query(`UPDATE brands SET none_use_column_obj=? WHERE id=${decode_dns?.id}`, [
                JSON.stringify(brand_data?.none_use_column_obj),
            ])
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default columnCtrl;
