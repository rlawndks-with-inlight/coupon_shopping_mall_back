'use strict';
import agoDB, { agoPool } from "../config/ago-db.js";
import db, { pool } from "../config/db.js";
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';


const utilCtrl = {
    sort: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 0, res);
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
    copy: async (req, res, next) => {
        try {
            let is_manager = await checkIsManagerUrl(req);
            const decode_user = checkLevel(req.cookies.token, 10);
            const decode_dns = checkDns(req.cookies.dns);

            const {
                brand_id,//참조한 브랜드
                insert_brand_id //넣을 브랜드
            } = req.body;

            //브랜드테이블 업데이트
            //상품 카테고리 그룹 추가
            //상품 카테고리 추가
            //상품 추가
            //게시물 카테고리 추가
            //게시물추가

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

const copyAgoDB = async () => {
    
    /* let table_name = 'users'
     let new_table_name = 'users'
     let find_column = await pool.query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=? AND TABLE_SCHEMA=?`, [table_name, process.env.DB_DATABASE]);
     find_column = find_column?.result;
     find_column = find_column.map(item => {
         return {
             agoColumn: item.COLUMN_NAME,
             newColumn: item.COLUMN_NAME,
         }
     })
     console.log(find_column);
     return;
     let insert_columns = [
         { agoColumn: 'id', newColumn: 'id' },
         { agoColumn: 'category_id', newColumn: 'category_id' },
         { agoColumn: 'user_id', newColumn: 'user_id' },
         { agoColumn: 'parent_id', newColumn: 'parent_id' },
         { agoColumn: 'post_title', newColumn: 'post_title' },
         { agoColumn: 'post_content', newColumn: 'post_content' },
         { agoColumn: 'post_title_img', newColumn: 'post_title_img' },
         { agoColumn: 'is_reply', newColumn: 'is_reply' },
     ]
     let data = await agoPool.query(`SELECT * FROM ${table_name}`);
     data = data?.result;
     let insert_data = [];
     for (var i = 0; i < data.length; i++) {
         let list = [];
         for (var j = 0; j < insert_columns.length; j++) {
             list.push(
                 data[i][insert_columns[j].agoColumn]
             )
         }
         insert_data.push(list);
     }
 
     await db.beginTransaction();
     try {
        for(var i = 0;i<)
         let result = await pool.query(`INSERT INTO ${new_table_name} (${insert_columns.map(item => { return item.newColumn }).join()}) VALUES ? `, [insert_data]);
         if (insert_columns.map(item => { return item.newColumn }).includes('parent_id')) {
             let result2 = await pool.query(`update ${new_table_name} SET parent_id=-1 WHERE parent_id IS NULL`)
         }
         await db.commit();
     } catch (err) {
         console.log(err);
         await db.rollback();
     }
 */
}
copyAgoDB();
export default utilCtrl;
