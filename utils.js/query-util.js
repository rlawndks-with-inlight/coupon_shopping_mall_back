import 'dotenv/config';
import { searchColumns, fulltextColumns, likeOnlyColumns, blindIndexColumns } from './search-columns.js';
import { blindIndex } from './crypto-util.js';
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
    // 값이 undefined 인 키는 SET 절에서 뺀다.
    //
    // Object.keys 는 값이 undefined 인 키도 돌려주고, mysql2 는 그걸 NULL 로 이스케이프한다.
    // 그래서 호출부가 '보내지 않은' 컬럼까지 NULL 로 덮어써졌다.
    // 실제 사고: 회원정보수정(auth.changeInfo)은 nickname·phone_num 두 개만 받는데
    // 핸들러가 12개 컬럼을 객체에 담아 넘겨, 저장 한 번에 계좌번호·사업자번호·
    // 계약서 이미지 등 10개가 NULL 이 됐다(셀러·영업자 계정이 마이페이지에서 저장할 때).
    //
    // null 은 그대로 둔다 — 그건 '비우겠다'는 명시적 의사표시다.
    const keys = Object.keys(obj).filter((key) => obj[key] !== undefined);
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
    let { page = 1, page_size = 100, is_asc = 0, order, search = "", s_dt, e_dt, } = query;
    page = parseInt(page) || 1;
    page_size = Math.min(parseInt(page_size) || 100, 10000);
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

    let promises = sql_list.map((item) =>
        readPool.query(item.sql, item.params).then((content) => ({
            table: item.table,
            content,
        }))
    );
    result_list = await Promise.all(promises);
    let result = result_list;
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
        const ftCols = fulltextColumns[table] || [];
        const likeCols = likeOnlyColumns[table] || [];
        const hasFulltext = ftCols.length > 0;

        sql += ` AND (`;
        let conditions = [];

        // FULLTEXT 대상 컬럼: MATCH AGAINST (한 번에 묶어서 처리)
        if (hasFulltext) {
            conditions.push(`MATCH(${ftCols.join(',')}) AGAINST(? IN BOOLEAN MODE)`);
            params.push(search);
        }

        // JOIN 테이블 등 LIKE 대상 컬럼
        for (var i = 0; i < likeCols.length; i++) {
            conditions.push(likeCols[i] + " LIKE ?");
            params.push(`%${search}%`);
        }

        // 암호화 필드(이름·전화 등) 정확일치 검색: blind-index 컬럼 = blindIndex(검색어)
        const biCols = blindIndexColumns[table] || [];
        if (biCols.length > 0) {
            const bi = blindIndex(search);
            for (var b = 0; b < biCols.length; b++) {
                conditions.push(biCols[b] + " = ?");
                params.push(bi);
            }
        }

        // FULLTEXT 설정 없는 테이블은 기존 LIKE 방식 유지
        if (!hasFulltext && likeCols.length === 0) {
            for (var i = 0; i < searchColumns[table].length; i++) {
                conditions.push(searchColumns[table][i] + " LIKE ?");
                params.push(`%${search}%`);
            }
        }

        sql += conditions.join(' OR ');
        sql += `)`;
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
    let promises = sql_list.map((item) => {
        const sql = (item.sql || '').trimStart().toUpperCase();
        const pool = (sql.startsWith('SELECT') || sql.startsWith('WITH')) ? readPool : writePool;
        return pool.query(item.sql, item?.data ?? item?.params ?? []).then((content) => ({
            table: item.table,
            content,
        }));
    });
    let result_list = await Promise.all(promises);
    let data = {};
    for (var i = 0; i < result_list.length; i++) {
        data[result_list[i].table] = result_list[i]?.content[0]
    }
    return data;
}

// 컬럼이 실제로 존재하는지 — 프로세스당 1회만 조회하고 캐시한다.
//
// [왜 필요한가]
// 스키마 변경(ALTER)과 코드 배포는 순서가 보장되지 않는다. 마이그레이션을 아직 안 돌린 서버에
// 새 컬럼을 포함한 INSERT 가 나가면 "Unknown column" 으로 **그 저장이 통째로 실패**한다.
// 주문 저장 경로에서 이런 일이 나면 결제가 막힌다 — '있으면 쓰고 없으면 건너뛴다'로 만든다.
// (반대로 '국내면 안 보낸다' 같은 우회는, 해외→국내로 되돌리는 수정을 못 하게 만든다)
const columnExistsCache = new Map();
export const hasColumn = async (table, column) => {
    const key = `${table}.${column}`;
    if (columnExistsCache.has(key)) return columnExistsCache.get(key);
    let exists = false;
    try {
        const [rows] = await readPool.query(
            `SELECT 1 FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
            [table, column]);
        exists = rows.length > 0;
    } catch (e) {
        exists = false;
    }
    columnExistsCache.set(key, exists);
    return exists;
};
