import { pool } from '../config/db.js';
import 'dotenv/config';
import when from 'when';
import { searchColumns } from './search-columns.js';

export const insertQuery = async (table, obj) => {
    try {
        let find_column = await pool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=?`, [table, process.env.DB_DATABASE]);
        find_column = find_column?.result;
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
        
        let result = await pool.query(`INSERT INTO ${table} (${keys.join()}) VALUES (${question_list.join()})`, values);
        if (find_column.includes('sort_idx')) {
            let setting_sort_idx = await pool.query(`UPDATE ${table} SET sort_idx=? WHERE id=?`, [
                result?.result?.insertId,
                result?.result?.insertId,
            ])
        }
        return result;
    } catch (err) {
        return false;
    }
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
    let result = await pool.query(`INSERT INTO ${table} (${keys.join()}) VALUES (${question_list.join()})`, values);
    return result;
}
export const deleteQuery = async (table, where_obj, delete_true) => {
    let keys = Object.keys(where_obj);
    let where_list = [];
    for (var i = 0; i < keys.length; i++) {
        where_list.push(` ${keys[i]}=${where_obj[keys[i]]} `);
    }
    if(where_list.length == 0){
        return true;
    }
    let sql = `UPDATE ${table} SET is_delete=1 WHERE ${where_list.join('AND')} `;
    if(delete_true){
        sql = `DELETE FROM ${table} WHERE ${where_list.join('AND')}`
    }
    let result = await pool.query(sql);
    return result;
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
    let result = await pool.query(`UPDATE ${table} SET ${question_list.join()} WHERE id=${id}`, values);
    return result;
}
export const selectQuerySimple = async (table, id) => {
    let result = await pool.query(`SELECT * FROM ${table} WHERE id=${id}`);
    return result;
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
export const getSelectQueryList = async (sql_, columns, query, add_sql_list = []) => {
    let { page = 1, page_size = 100000, is_asc = false, order, search = "" } = query;
    let sql = sql_;
    let table = getTableNameBySelectQuery(sql);
    let find_columns = await pool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=?`, [table, process.env.DB_DATABASE]);
    find_columns = find_columns?.result;
    find_columns = find_columns.map((column) => {
        return column?.COLUMN_NAME
    })

    sql = settingSelectQueryWhere(sql, query, table, find_columns);
    for (var i = 0; i < add_sql_list.length; i++) {
        add_sql_list[i].sql = settingSelectQueryWhere(add_sql_list[i].sql, query, table);
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
    content_sql += ` ORDER BY ${table}.${order} ${is_asc ? 'ASC' : 'DESC'} `;
    content_sql += ` LIMIT ${(page - 1) * page_size}, ${page_size} `;
    let total_sql = sql.replaceAll(process.env.SELECT_COLUMN_SECRET, 'COUNT(*) as total');
    let result_list = [];
    let sql_list = [
        { table: 'total', sql: total_sql },
        { table: 'content', sql: content_sql },
        ...add_sql_list
    ]

    for (var i = 0; i < sql_list.length; i++) {
        result_list.push({
            table: sql_list[i].table,
            content: (await pool.query(sql_list[i].sql))
        });
    }

    for (var i = 0; i < result_list.length; i++) {
        await result_list[i];
    }
    let result = (await when(result_list));
    let obj = {
        page,
        page_size,
    }
    for (var i = 0; i < result.length; i++) {
        obj[result[i].table] = result[i]?.content?.result
    }
    return settingSelectQueryObj(obj);
}
const settingSelectQueryWhere = (sql_, query, table, find_columns=[]) => {
    let sql = sql_;
    const { s_dt, e_dt, search } = query;
    if(find_columns.includes('is_delete')){
        sql += ` ${sql.includes('WHERE') ? 'AND' : 'WHERE'} ${table}.is_delete=0 `;
    } else {
        sql += ` ${sql.includes('WHERE') ? '' : 'WHERE 1=1'}  `;
    }
    if (s_dt) {
        sql += ` AND ${table}.created_at >= '${s_dt} 00:00:00' `;
    }
    if (e_dt) {
        sql += ` AND ${table}.created_at <= '${e_dt} 23:59:59' `;
    }
    if (search && searchColumns[table]?.length > 0) {
        sql += ` AND (`
        for (var i = 0; i < searchColumns[table].length; i++) {
            if (i > 0) {
                sql += ' OR '
            }
            sql += searchColumns[table][i] + " LIKE '%" + search + "%' ";
        }
        sql += `)`
    }
    return sql;
}
const settingSelectQueryObj = (obj_) => {
    let obj = obj_;
    if (obj?.total) {
        obj['total'] = obj?.total[0]?.total ?? 0
    }
    return obj;
}
export const getMultipleQueryByWhen = async (sql_list, is_list) => {
    let result_list = [];
    for (var i = 0; i < sql_list.length; i++) {
        result_list.push({
            table: sql_list[i].table,
            content: (await pool.query(sql_list[i].sql, sql_list[i]?.data ?? []))
        });
    }
    for (var i = 0; i < result_list.length; i++) {
        await result_list[i];
    }
    let result = (await when(result_list));
    let data = {};
    for (var i = 0; i < result.length; i++) {
        data[result[i].table] = result[i]?.content?.result
    }
    return data;
}