import 'dotenv/config';
import when from 'when';
import { searchColumns } from './search-columns.js';
import { readPool, writePool } from '../config/db-pool.js';

export const insertQuery = async (table, obj) => {
    try {
        let find_column = await readPool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=?`, [table, process.env.DB_DATABASE]);
        find_column = find_column[0];
        find_column = find_column.map((column) => {
            return column?.COLUMN_NAME
        })
        let keys = Object.keys(obj);
        if (keys.length == 0) {
            return false;
        }
        let question_list = keys.map(key => {
            return '?'
        });
        let values = keys.map(key => {
            return obj[key]
        });

        let result = await writePool.query(`INSERT INTO ${table} (${keys.join()}) VALUES (${question_list.join()})`, values);
        if (find_column.includes('sort_idx')) {
            let setting_sort_idx = await writePool.query(`UPDATE ${table} SET sort_idx=? WHERE id=?`, [
                result[0]?.insertId,
                result[0]?.insertId,
            ])
        }
        return result[0];
    } catch (err) {
        console.log(err);
        return false;
    }
}
export const insertMultyQuery = async (table, keys, list = []) => {
    if (keys.length == 0) {
        return false;
    }
    let result = await writePool.query(`INSERT INTO ${table} (${keys.join()}) VALUES ?`, [list]);
    return result[0];
}
export const insertQueryMultiRow = async (table, list) => {// 개발예정
    let keys = Object.keys(obj);
    if (keys.length == 0) {
        return false;
    }
    let question_list = keys.map(item => {
        return '?'
    });
    let values = keys.map(key => {
        return obj[key]
    });
    let result = await writePool.query(`INSERT INTO ${table} (${keys.join()}) VALUES (${question_list.join()})`, values);
    return result[0];
}
export const deleteQuery = async (table, where_obj, delete_true) => {
    let keys = Object.keys(where_obj);
    let where_list = [];
    let where_values = [];
    for (var i = 0; i < keys.length; i++) {
        where_list.push(` ${keys[i]}=? `);
        where_values.push(where_obj[keys[i]]);
    }
    if (where_list.length == 0) {
        return true;
    }
    let sql = `UPDATE ${table} SET is_delete=1 WHERE ${where_list.join('AND')} `;
    if (delete_true) {
        sql = `DELETE FROM ${table} WHERE ${where_list.join('AND')}`
    }
    let result = await writePool.query(sql, where_values);
    return result[0];
}
export const updateQuery = async (table, obj, id) => {
    let keys = Object.keys(obj);
    if (keys.length == 0) {
        return false;
    }
    let question_list = keys.map(key => {
        return `${key}=?`
    });
    let values = keys.map(key => {
        return obj[key]
    });
    values.push(id);
    let result = await writePool.query(`UPDATE ${table} SET ${question_list.join()} WHERE id=?`, values);

    return result[0];
}
export const selectQuerySimple = async (table, id) => {
    let result = await readPool.query(`SELECT * FROM ${table} WHERE id=?`, [id]);
    return result[0];
}
export const getTableNameBySelectQuery = (sql) => {// select query 가지고 불러올 메인 table명 불러오기 select * from user as asd
    let sql_split_list = sql.split(' FROM ')[1].split(' ');
    let table = '';
    for (var i = 0; i < sql_split_list.length; i++) {
        if (sql_split_list[i]) {
            table = sql_split_list[i];
            break;
        }
    }
    return table;
}
export const getSelectQueryList = async (sql_, columns, query, add_sql_list = [], params = []) => {
    let { page = 1, page_size = 150000, is_asc = 0, order, search = "", s_dt, e_dt, } = query;
    page = parseInt(page) || 1;
    page_size = parseInt(page_size) || 150000;
    let sql = sql_;
    let table = getTableNameBySelectQuery(sql);
    let find_columns = await readPool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=?`, [table, process.env.DB_DATABASE]);
    find_columns = find_columns[0];
    find_columns = find_columns.map((column) => {
        return column?.COLUMN_NAME
    })
    let { type } = query;
    let whereResult = settingSelectQueryWhere(sql, query, table, find_columns, params);
    sql = whereResult.sql;
    let whereParams = whereResult.params;
    for (var i = 0; i < add_sql_list.length; i++) {
        let addResult = settingSelectQueryWhere(add_sql_list[i].sql, query, table, [], params);
        add_sql_list[i].sql = addResult.sql;
        add_sql_list[i].params = addResult.params;
    }
    let content_sql = sql.replaceAll(process.env.SELECT_COLUMN_SECRET, columns.join());
    if (order) {
        order = order
    } else {

        if (find_columns.includes('sort_idx')) {
            order = 'sort_idx';
        } else {
            order = 'id';
        }
    }
    //console.log(sql_)
    //console.log(columns)
    //console.log(query)
    //console.log(table)
    // Whitelist order column to prevent SQL injection (only allow alphanumeric and underscores)
    const safeOrder = order.replace(/[^a-zA-Z0-9_]/g, '');
    const direction = is_asc == 1 ? 'ASC' : 'DESC';
    if (table == 'products' && type == 'user') {
        content_sql += ` ORDER BY CASE WHEN (products.status = 2 OR products.status = 3 OR products.status = 4 OR products.status = 5) THEN 1 ELSE 0 END ASC, ${table}.${safeOrder} ${direction} `;
    } else {
        content_sql += ` ORDER BY ${table}.${safeOrder} ${direction} `;
    }
    content_sql += ` LIMIT ?, ? `;
    let contentParams = [...whereParams, (page - 1) * page_size, page_size];
    let total_sql = sql.replaceAll(process.env.SELECT_COLUMN_SECRET, 'COUNT(*) as total');
    let result_list = [];
    let sql_list = [
        { table: 'total', sql: total_sql, params: whereParams },
        { table: 'content', sql: content_sql, params: contentParams },
        ...add_sql_list.map(item => ({ table: item.table, sql: item.sql, params: item.params || whereParams }))
    ]

    //console.log(sql_list)

    for (var i = 0; i < sql_list.length; i++) {
        result_list.push({
            table: sql_list[i].table,
            content: (await readPool.query(sql_list[i].sql, sql_list[i].params))
        });
    }
    //console.log(result_list)
    for (var i = 0; i < result_list.length; i++) {
        await result_list[i];
    }
    let result = (await when(result_list));
    let obj = {
        page,
        page_size,
    }
    for (var i = 0; i < result.length; i++) {
        obj[result[i].table] = result[i]?.content[0]
    }

    //console.log(obj)
    return settingSelectQueryObj(obj);
}
const settingSelectQueryWhere = (sql_, query, table, find_columns = [], whereParams = []) => {
    let sql = sql_;
    let params = [...whereParams];
    const { s_dt, e_dt, search } = query;
    if (find_columns.includes('is_delete')) {
        sql += ` ${sql.includes('WHERE') ? 'AND' : 'WHERE'} ${table}.is_delete=0 `;
    } else {
        sql += ` ${sql.includes('WHERE') ? '' : 'WHERE 1=1'}  `;
    }
    if (s_dt) {
        sql += ` AND ${table}.created_at >= ? `;
        params.push(`${s_dt} 00:00:00`);
    }
    if (e_dt) {
        sql += ` AND ${table}.created_at <= ? `;
        params.push(`${e_dt} 23:59:59`);
    }
    if (search && searchColumns[table]?.length > 0) {
        sql += ` AND (`
        for (var i = 0; i < searchColumns[table].length; i++) {
            if (i > 0) {
                sql += ' OR '
            }
            sql += searchColumns[table][i] + " LIKE ? ";
            params.push(`%${search}%`);
        }
        sql += `)`
    }
    return { sql, params };
}
const settingSelectQueryObj = (obj_) => {
    let obj = obj_;
    if (obj?.total) {
        obj['total'] = obj?.total[0]?.total ?? 0
    }
    return obj;
}
export const getMultipleQueryByWhen = async (sql_list = [], is_list) => {
    let result_list = [];
    for (var i = 0; i < sql_list.length; i++) {
        result_list.push({
            table: sql_list[i].table,
            content: (await writePool.query(sql_list[i].sql, sql_list[i]?.data ?? sql_list[i]?.params ?? []))
        });
    }
    for (var i = 0; i < result_list.length; i++) {
        await result_list[i];
    }
    let result = (await when(result_list));
    let data = {};
    for (var i = 0; i < result.length; i++) {
        data[result[i].table] = result[i]?.content[0]
    }
    return data;
}