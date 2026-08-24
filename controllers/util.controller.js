'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getMultipleQueryByWhen, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, createHashedPassword, findChildIds, findParent, findParents, isItemBrandIdSameDnsId, lowLevelException, response, settingFiles } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import _ from "lodash";
import { readPool, writePool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { deleteKeys } from "../utils.js/redis-scan.js";
import axios from "axios";
import * as cheerio from "cheerio";

// 테이블 → 테넌트(브랜드) 컬럼.
//
// sort·changeStatus 는 테이블명을 URL 로 받아 동적으로 UPDATE 한다. 그런데 WHERE 에
// 브랜드 조건이 없어서 한 가맹점의 조작이 다른 가맹점 행까지 건드렸다.
// sort 는 특히 나빴다 — sort_idx 가 브랜드별 독립 공간이 아니라 전역이라
// (insertQuery 가 행 생성 직후 sort_idx 에 auto_increment id 를 박는다)
// 형제 둘 사이 간격에 다른 브랜드 행이 수천 개 끼고, ▲▼ 한 번에 그만큼 UPDATE 가 나갔다.
// 순서 자체는 구간 전체가 같은 방향으로 밀리는 회전이라 보존되지만,
// 쓰기 증폭과 락 경합으로 다른 가맹점 요청이 느려지고 테넌트 경계가 새는 건 그대로다.
//
// 두 테이블은 예외다:
//   posts  : brand_id 컬럼이 없다. post_categories 를 통해 브랜드에 매인다.
//   brands : 자기 id 가 곧 테넌트 키라 브랜드로 좁히면 정렬 자체가 불가능하다 → 레벨로 막는다.
const TENANT_COLUMN = {
    products: 'brand_id',
    product_categories: 'brand_id',
    product_category_groups: 'brand_id',
    post_categories: 'brand_id',
    users: 'brand_id',
    product_properties: 'brand_id',
    product_property_groups: 'brand_id',
    transactions: 'brand_id',
    seller_products: 'brand_id',
    consignments: 'brand_id',
};

const buildTenantScope = (table, brandId) => {
    if (table === 'brands') return { sql: '', params: [] };
    if (table === 'posts') {
        return {
            sql: ' AND category_id IN (SELECT id FROM post_categories WHERE brand_id=?) ',
            params: [brandId],
        };
    }
    const col = TENANT_COLUMN[table];
    if (!col) return { sql: '', params: [] };
    return { sql: ` AND ${col}=? `, params: [brandId] };
};

// changeStatus 로 바뀐 행이 Redis 에 캐시돼 있으면 지운다.
//
// changeStatus 는 raw UPDATE 만 해서 캐시를 그대로 뒀다. 캐시 TTL 이 300초라
// 관리자가 상품을 품절·비공개로 내려도 고객 화면에는 최대 5분간 그대로 보였고,
// 그동안 장바구니에 담겨 결제까지 갈 수 있었다.
//
// 키 형태(각 컨트롤러에서 만드는 그대로):
//   product:detail:{brandId}:{sellerId}:{userId}:{ret|nor}:{id|code}:{productId}
//   product:list:...  (JSON 안에 "brandId":N 이 들어간다)
//   shop:setting:{brandId}:{userId}
// 캐시 삭제가 실패해도 요청은 성공으로 둔다 — TTL 로 자연 만료되므로
// 여기서 에러를 내면 멀쩡한 상태변경까지 실패로 보이게 된다.
const invalidateStatusCache = async (table, id, brandId) => {
    if (!redisClient?.isOpen) return;
    try {
        if (table === 'products') {
            await deleteKeys(redisClient, `product:detail:${brandId}:*`, (key) => key.endsWith(`:${id}`));
            await deleteKeys(redisClient, `product:list:*`,
                (key) => key.includes(`"brandId":${brandId}`) || key.includes(`"brandId": ${brandId}`));
        } else if (table === 'brands') {
            // 브랜드 노출/상태가 바뀌면 스토어프론트 설정 캐시도 낡는다.
            await deleteKeys(redisClient, `shop:setting:${id}:*`);
        }
    } catch (e) {
        console.error('Redis cache invalidation error (changeStatus):', e);
    }
};

const utilCtrl = {
    sort: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            let { source_id, source_sort_idx, dest_id, dest_sort_idx } = req.body;
            const { table } = req.params;
            // product_properties/product_property_groups 누락으로 특성관리의 순서 이동 버튼이
            // 항상 '허용되지 않은 테이블입니다' 로 실패했다(pages/manager/products/properties/[id].js:248).
            const ALLOWED_SORT_TABLES = ['products', 'product_categories', 'product_category_groups', 'post_categories', 'posts', 'brands', 'users', 'product_properties', 'product_property_groups'];
            if (!ALLOWED_SORT_TABLES.includes(table)) {
                return response(req, res, -200, "허용되지 않은 테이블입니다.", false);
            }
            // 로그인 검사가 없었다. checkLevel 결과를 담아만 두고 아무도 보지 않았다.
            if (!decode_user || decode_user?.level < 10) {
                return lowLevelException(req, res);
            }
            // brands 정렬은 브랜드로 좁힐 수 없다(자기 id 가 테넌트 키다). 개발사만 허용한다.
            if (table === 'brands' && decode_user?.level < 50) {
                return lowLevelException(req, res);
            }
            const scope = buildTenantScope(table, decode_dns?.id ?? 0);

            let update_sql = ` UPDATE ${table} SET `
            source_id = parseInt(source_id);
            source_sort_idx = parseInt(source_sort_idx);
            dest_id = parseInt(dest_id);
            dest_sort_idx = parseInt(dest_sort_idx);
            if (source_sort_idx >= dest_sort_idx) {//드래그한게 더 클때
                update_sql += ` sort_idx=sort_idx+1 WHERE sort_idx < ? AND sort_idx >= ? AND id!=? `;
            } else {//드래그한게 더 작을때
                update_sql += ` sort_idx=sort_idx-1 WHERE sort_idx > ? AND sort_idx <= ? AND id!=? `;
            }
            update_sql += scope.sql;
            let update_result = await writePool.query(update_sql, [source_sort_idx, dest_sort_idx, source_id, ...scope.params]);

            // 옮기려는 행도 이 브랜드 소유여야 한다.
            let result = await writePool.query(
                `UPDATE ${table} SET sort_idx=? WHERE id=? ${scope.sql}`,
                [dest_sort_idx, source_id, ...scope.params]
            );

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    changeStatus: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 10);
            const decode_dns = checkDns(req.cookies.dns);
            const { table, column_name } = req.params;
            const { value, id } = req.body;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            // 같은 이유로 특성관리의 노출/숨김(눈 아이콘)도 실패했다(properties/[id].js:271).
            const ALLOWED_STATUS_TABLES = ['products', 'product_categories', 'product_category_groups', 'post_categories', 'posts', 'brands', 'users', 'transactions', 'seller_products', 'product_properties', 'product_property_groups', 'consignments'];
            // is_confirm: 위탁 목록의 '처리여부' 스위치. 테이블·컬럼 모두 누락돼 항상 거부됐다
            //   (pages/manager/products/consignments/list/[type].js:144 → util/consignments/is_confirm)
            const ALLOWED_COLUMNS = ['status', 'is_delete', 'is_show', 'is_active', 'is_show_header_menu', 'trx_status', 'seller_price', 'is_confirm'];
            if (!ALLOWED_STATUS_TABLES.includes(table)) {
                return response(req, res, -200, "허용되지 않은 테이블입니다.", false);
            }
            if (!ALLOWED_COLUMNS.includes(column_name)) {
                return response(req, res, -200, "허용되지 않은 컬럼입니다.", false);
            }
            // 로그인은 위에서 봤지만 브랜드 조건이 없었다 — 레벨 10 계정 하나면
            // 다른 가맹점의 임의 행 상태(노출/삭제/주문상태 등)를 바꿀 수 있었다.
            if (table === 'brands' && decode_user?.level < 50) {
                return lowLevelException(req, res);
            }
            const scope = buildTenantScope(table, decode_dns?.id ?? 0);
            let result = await writePool.query(
                `UPDATE ${table} SET ${column_name}=? WHERE id=? ${scope.sql}`,
                [value, id, ...scope.params]
            );
            // ── 캐시 무효화 ─────────────────────────────────────────────────
            // 이 핸들러는 raw UPDATE 만 하고 Redis 를 건드리지 않았다.
            // 그런데 관리자 상품목록의 상태 <Select>(판매중단·품절·비공개)가 여기로 온다
            // (front: pages/manager/products/list.js:624 → apiUtil('products/status','update')).
            // 상세·목록 캐시 TTL 이 300초라, 비공개로 내린 상품이 고객 화면에서 최대 5분간
            // 그대로 보이고 그동안 장바구니에 담겨 결제까지 갈 수 있었다.
            // product.controller 의 update/remove 와 같은 방식으로 지운다.
            await invalidateStatusCache(table, id, decode_dns?.id ?? 0);
            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    unipass: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { name, code, phone_num } = req.body;

            /*const payload = new URLSearchParams({
                action_type: 'query',
                chk_data: `${decode_user?.name}/${code}/${decode_user?.phone_num}`
            }).toString()*/

            const payload = new URLSearchParams({
                action_type: 'query',
                chk_data: `${name}/${code}/${phone_num}/`
            }).toString()

            const result = await axios.post("https://www.gsiexpress.com/pcc_chk.php", payload, {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            });

            let data = result.data ?? {}
            const $ = cheerio.load(data);

            const resultDiv = $("div.panel-heading").filter(function () {
                return $(this).text().includes("검증결과");
            }).next("div.panel-body");

            const resultMessage1 = resultDiv.find("tbody tr td:nth-child(5)").text().trim();
            const resultMessage2 = resultDiv.find("tbody tr td:nth-child(6)").text().trim();


            data = { message: `${resultMessage1} : ${resultMessage2}` }

            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    copy: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 50);
            const decode_dns = checkDns(req.cookies.dns);

            const {
                sender_brand_id = 0,
                dns = "",
                is_copy_brand_setting = 0,
                is_copy_main_obj = 0,//메인페이지(배너)·블로그 구성 복사 여부. 명시적으로 1일때만 덮어씀
                is_copy_product = 0,
                is_copy_post = 0,
                is_use_tikitaka = 0,
                is_selected_categories = [],
            } = req.body;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let dns_data = await readPool.query(`SELECT * FROM brands WHERE dns=?`, [dns]);
            dns_data = dns_data[0][0];
            if (!dns_data) {
                return response(req, res, -100, "받을 도메인이 존재하지 않습니다.", false)
            }
            let sender_brand = await readPool.query(`SELECT * FROM brands WHERE id=?`, [sender_brand_id])
            sender_brand = sender_brand[0][0];
            if (!sender_brand) {
                return response(req, res, -100, "복사할 도메인이 존재하지 않습니다.", false)
            }
            if (dns_data?.id == sender_brand?.id) {
                return response(req, res, -100, "같은 도메인은 복사할 수 없습니다.", false)
            }
            let manager = await readPool.query(`SELECT * FROM users WHERE brand_id=? AND level=40`, [dns_data?.id]);
            manager = manager[0][0];
            if (!manager) {
                return response(req, res, -100, "관리자 계정이 없는 브랜드입니다.", false);
            }
            let brand_setting_obj = {};
            if (is_copy_brand_setting == 1) {//브랜드 기본세팅 복사 원할시
                brand_setting_obj = {
                    ...brand_setting_obj,
                    name: sender_brand?.name,
                    logo_img: sender_brand?.logo_img,
                    dark_logo_img: sender_brand?.dark_logo_img,
                    favicon_img: sender_brand?.favicon_img,
                    og_img: sender_brand?.og_img,
                    og_description: sender_brand?.og_description,
                    theme_css: sender_brand?.theme_css,
                    //slider_css: sender_brand?.slider_css,
                    brand_type: sender_brand?.brand_type,
                }
            }
            if (is_copy_main_obj == 1) {//메인페이지(배너)·블로그 구성 복사 원할시에만 덮어씀 (대상 몰의 기존 배너가 사라지는것 방지)
                brand_setting_obj = {
                    ...brand_setting_obj,
                    blog_obj: sender_brand?.blog_obj,
                    shop_obj: sender_brand?.shop_obj,
                }
            }
            if (Object.keys(brand_setting_obj).length > 0) {
                let result = await updateQuery('brands', brand_setting_obj, dns_data?.id)
            }
            if (is_copy_product == 1) {//상품 복사 원할시

                let product_category_group_columns = ['category_group_name', 'max_depth', 'id'];
                let product_category_groups = await readPool.query(`SELECT ${product_category_group_columns.join()} FROM product_category_groups WHERE brand_id=? AND is_delete=0`, [sender_brand?.id]);
                product_category_groups = product_category_groups[0];
                let product_category_group_connect_ids = {};
                for (var i = product_category_groups.length; i >= 1; i--) {
                    let obj = { ...product_category_groups[i - 1] };
                    delete obj['id'];
                    let result = await insertQuery('product_category_groups', {
                        ...obj,
                        brand_id: dns_data?.id,
                    })
                    product_category_group_connect_ids[product_category_groups[i - 1]?.id] = result?.insertId;
                }
                //console.log(product_category_groups)

                let product_category_columns = ['product_category_group_id', 'parent_id', 'category_type', 'category_name', 'category_img', 'category_description', 'id'];
                let product_category_group_ids = product_category_groups.map(item => item?.id);
                let product_categories = await readPool.query(`SELECT ${product_category_columns.join()} FROM product_categories WHERE product_category_group_id IN (${product_category_group_ids.map(() => '?').join(',')})`, product_category_group_ids);
                product_categories = product_categories[0];
                let product_category_connect_ids = {};
                for (var i = product_categories.length; i >= 1; i--) {
                    product_categories[i - 1].depth = await findParents(product_categories, product_categories[i - 1]);
                    product_categories[i - 1].depth = product_categories[i - 1].depth.length;
                }
                //console.log(product_categories)

                for (var i = 0; i < 10; i++) {
                    let product_category_depth_list = product_categories.filter(item => parseInt(item?.depth) == parseInt(i));
                    if (product_category_depth_list.length > 0) {
                        for (var j = product_category_depth_list.length; j >= 1; j--) {
                            let obj = { ...product_category_depth_list[j - 1] };
                            delete obj['id'];
                            delete obj['depth'];
                            let result = await insertQuery('product_categories', {
                                ...obj,
                                brand_id: dns_data?.id,
                                product_category_group_id: product_category_group_connect_ids[product_category_depth_list[j - 1]?.product_category_group_id],
                                parent_id: product_category_connect_ids[product_category_depth_list[j - 1]?.parent_id] ?? -1,
                            })
                            product_category_connect_ids[product_category_depth_list[j - 1]?.id] = result?.insertId;
                        }
                    }
                }


                let product_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'another_id', 'id',];
                let product_sub_img_columns = ['product_sub_img'];

                let products = await readPool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=? AND is_delete=0 ORDER BY id DESC`, [sender_brand?.id]);
                products = products[0];
                let product_connect_ids = {};
                let first_insert_product_idx = 0;
                let first_insert_product_sub_img_idx = 0;

                for (var i = 0; i < parseInt(products.length / 1000) + 1; i++) {
                    let insert_data = [];
                    let insert_sub_img_data = [];
                    let product_list = products.slice(i * 1000, (i + 1) * 1000);

                    for (var j = 0; j < product_list.length; j++) {
                        let product_price = product_list[j]?.product_price;
                        let product_sale_price = product_list[j]?.product_sale_price;
                        if (is_use_tikitaka == 1) {
                            product_price = ((parseInt(product_price) + 10000) / 10000).toFixed(0) * 10000;
                            product_sale_price = ((parseInt(product_sale_price) + 10000) / 10000).toFixed(0) * 10000;
                        }
                        insert_data.push([
                            product_category_connect_ids[product_list[j]?.category_id0],
                            product_category_connect_ids[product_list[j]?.category_id1],
                            product_category_connect_ids[product_list[j]?.category_id2],
                            product_list[j]?.product_name,
                            product_price,
                            product_sale_price,
                            product_list[j]?.product_img,
                            product_list[j]?.product_comment,
                            product_list[j]?.product_description,
                            product_list[j]?.another_id,
                            dns_data?.id,
                            manager?.id
                        ])
                    }
                    if (insert_data.length > 0) {
                        let result = await writePool.query('INSERT INTO products (category_id0,category_id1,category_id2,product_name,product_price,product_sale_price,product_img,product_comment,product_description,another_id,brand_id,user_id) VALUES ?', [insert_data])
                        if (i == 0) {
                            first_insert_product_idx = result[0]?.insertId
                        }

                        for (let j = 0; j < product_list.length; j++) {
                            product_connect_ids[product_list[j].id] = result[0].insertId + j;
                        }
                    }
                    for (var j = 0; j < product_list.length; j++) {
                        let sub_images = await readPool.query(`SELECT ${product_sub_img_columns.join()} FROM product_images WHERE product_id=? AND is_delete=0 ORDER BY id DESC`, [product_list[j]?.id]);
                        sub_images = sub_images[0];

                        for (var k = sub_images.length; k >= 1; k--) {
                            insert_sub_img_data.push([
                                product_connect_ids[product_list[j].id], // 새로운 상품 ID 사용
                                sub_images[k - 1]['product_sub_img']
                            ]);
                        }
                    }
                    if (insert_sub_img_data.length > 0) {
                        let result = await writePool.query('INSERT INTO product_images (product_id, product_sub_img) VALUES ?', [insert_sub_img_data]);
                        if (i == 0) {
                            first_insert_product_sub_img_idx = result[0]?.insertId;
                        }
                    }
                }
                let update_sort_idx = await writePool.query(`UPDATE products SET sort_idx=id WHERE brand_id=? AND id>=?`, [dns_data?.id, first_insert_product_idx]);
                let new_products = await readPool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=? AND is_delete=0 AND id>=? ORDER BY id DESC`, [sender_brand?.id, first_insert_product_idx]);
                new_products = new_products[0];

                for (var i = 0; i < products.length; i++) {
                    product_connect_ids[products[i]?.id] = new_products[i]?.id;
                }

                // let product_option_group_columns = ['id', 'product_id', 'is_able_duplicate_select', 'group_name', 'group_description', 'group_img'];
                // let product_option_groups = await readPool.query(`SELECT ${product_option_group_columns.join()} FROM product_option_groups WHERE product_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_option_groups = product_option_groups[0];

                // let product_option_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                // let product_options = await readPool.query(`SELECT ${product_option_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_options = product_options[0];

                // let product_character_columns = ['category_id0', 'category_id1', 'category_id2', 'product_name', 'product_price', 'product_sale_price', 'product_img', 'product_comment', 'product_description', 'id'];
                // let product_characters = await readPool.query(`SELECT ${product_columns.join()} FROM products WHERE brand_id=${sender_brand?.id} AND is_delete=0 ORDER BY id DESC`);
                // product_characters = product_characters[0];
            }
            if (is_copy_post == 1) {//게시글 복사 원할시
                let post_category_columns = ['id', 'parent_id', 'post_category_title', 'post_category_type', 'post_category_read_type', 'is_able_user_add'];
                let post_categories = await readPool.query(`SELECT ${post_category_columns.join()} FROM post_categories WHERE brand_id=? AND is_delete=0`, [sender_brand?.id]);
                post_categories = post_categories[0];
                let post_category_connect_ids = {};
                for (var i = 0; i < post_categories.length; i++) {
                    post_categories[i].depth = await findParents(post_categories, post_categories[i]);
                    post_categories[i].depth = post_categories[i].depth.length;
                }
                for (var i = 0; i < 10; i++) {
                    let post_category_depth_list = post_categories.filter(item => parseInt(item?.depth) == parseInt(i));
                    if (post_category_depth_list.length > 0) {
                        for (var j = 0; j < post_category_depth_list.length; j++) {
                            let obj = { ...post_category_depth_list[j] };
                            delete obj['id'];
                            delete obj['depth'];
                            let result = await insertQuery('post_categories', {
                                ...obj,
                                brand_id: dns_data?.id,
                                parent_id: post_category_connect_ids[post_category_depth_list[j]?.parent_id] ?? -1,
                            })
                            post_category_connect_ids[post_category_depth_list[j]?.id] = result?.insertId;
                        }
                    }
                }

                let first_insert_post_idx = 0;
                let posts = await readPool.query(`SELECT posts.* FROM posts LEFT JOIN post_categories ON posts.category_id=post_categories.id WHERE post_categories.brand_id=? AND post_categories.is_delete=0 AND posts.is_delete=0 AND posts.parent_id=-1`, [sender_brand?.id]);
                posts = posts[0];
                for (var i = 0; i < parseInt(posts.length / 1000) + 1; i++) {
                    let insert_data = [];
                    let post_list = posts.slice(i * 1000, (i + 1) * 1000);
                    for (var j = 0; j < post_list.length; j++) {
                        insert_data.push([
                            post_category_connect_ids[post_list[j]?.category_id],
                            manager?.id,
                            post_list[j]?.post_title,
                            post_list[j]?.post_content,
                            post_list[j]?.post_title_img,
                            post_list[j]?.is_reply,
                        ])
                    }
                    if (insert_data.length > 0) {
                        let result = await writePool.query('INSERT INTO posts (category_id,user_id,post_title,post_content,post_title_img,is_reply) VALUES ?', [insert_data])
                        if (i == 0) {
                            first_insert_post_idx = result[0]?.insertId
                        }
                    }
                }
            }


            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err)
            logger.error(JSON.stringify(err?.response?.data || err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

export default utilCtrl;
