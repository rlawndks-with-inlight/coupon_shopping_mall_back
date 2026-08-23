'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import { deleteQuery, getSelectQueryList, insertQuery, selectQuerySimple, updateQuery } from "../utils.js/query-util.js";
import { checkDns, checkLevel, isItemBrandIdSameDnsId, loadOwnedRow, lowLevelException, response, settingFiles, errText } from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import XLSX from 'xlsx';
import fs from 'fs';
import { readPool, writePool } from "../config/db-pool.js";
import { decRow, decRows, decListContent, blindIndex, encForSave, decField } from "../utils.js/pii.js";
import { PII_FIELD_TYPES } from "../utils.js/order-form.js";
import { orderPasswordCandidates, matchesOrderPassword } from "../utils.js/order-password.js";
const table_name = 'transactions';

const transactionCtrl = {
    list: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies?.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);

            const { trx_status, cancel_status, is_confirm, cancel_type, type } = req.query;
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let columns = [
                `${table_name}.*`,
                //`sellers.user_name AS seller_user_name`,
            ]
            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;

            //console.log(req.query)

            // 회원 아이디(user_name)로 주문검색하기 위해 users JOIN은 항상 포함(seller 모드 무관).
            sql += `LEFT JOIN users AS users ON ${table_name}.user_id=users.id `;
            if (decode_dns?.setting_obj?.is_use_seller == 1) {
                columns.push(`sellers.user_name AS seller_user_name`);
                columns.push(`sellers.dns AS seller_dns`);
                sql += `LEFT JOIN users AS sellers ON ${table_name}.seller_id=sellers.id `;
                columns.push(`users.unipass AS user_unipass`);
            }
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(decode_dns?.id ?? 0);
            //console.log(decode_dns)

            if (type != 'user' && decode_user?.level == 15) { //영업자 관리자
                sql += ` AND transactions.seller_id IN (SELECT id FROM users WHERE oper_id=?) `;
                params.push(decode_user?.id);
            }

            if (decode_dns?.seller_id > 0) {
                sql += ` AND transactions.seller_id=? `;
                params.push(decode_dns?.seller_id);
            } else if (decode_user?.level == 10) {
                sql += ` AND transactions.seller_id=? `;
                params.push(decode_user?.id);
            }
            // 본인 주문만 보이도록 스코프.
            // 기존 조건은 `(type=='user' && ...) || !decode_user || type=='user'` 였는데
            // !decode_user 는 위 21행 early return 때문에 도달 불가라 사실상 `type=='user'` 하나였다.
            // 그런데 쇼핑몰 주문내역 화면 9개 중 8개가 type을 안 보내서,
            // 로그인한 일반 고객이 '브랜드의 모든 주문'을 복호화된 이름·연락처·주소까지 그대로 받고 있었다.
            // → 프론트가 무엇을 보내든 서버에서 고객 등급(level<10)은 항상 본인 것만 보도록 강제한다.
            //   판매자(10)·영업자(15)·관리자(40+)의 기존 동작은 그대로 둔다.
            const isCustomer = !(decode_user?.level >= 10);
            if (type == 'user' || isCustomer) {
                sql += ` AND user_id=? `;
                params.push(decode_user?.id ?? -1);
            }
            if (trx_status) {
                sql += ` AND trx_status=? `;
                params.push(trx_status);
            }
            if (is_confirm) {
                // 고객의 '주문/배송조회' 목록. 취소 목록(cancel_status)과 구분하려는 필터다.
                //
                // 예전엔 `trx_status>=1` 이었는데 그러면 결제대기(0)가 통째로 빠진다.
                // 무통장입금(10)·상품권(11)·수기결제(1)는 입금/확인 전까지 trx_status 가 0 이므로,
                // 방금 주문한 고객이 자기 주문을 내역에서 아예 볼 수 없었다.
                // (같은 화면의 취소요청 버튼도 0 을 취소가능으로 보는데 그 행이 목록에 없어 죽은 분기였다)
                //
                // 의도대로 '취소 원장 행(is_cancel=1, 금액이 음수인 별도 행)'만 제외한다.
                // 취소된 원주문(is_cancel_trans=1)은 고객이 상태를 확인해야 하므로 남긴다.
                sql += ` AND is_cancel=0 `;
            }
            if (cancel_status) {
                if (cancel_status == 1) {
                    // ⚠ is_cancel_trans=0 이 빠지면 '취소요청' 탭에서 영영 안 사라진다.
                    // 취소를 실행해도 trx_status 는 1 그대로고 is_cancel 도 0 이라
                    // 이 조건에 계속 맞는다. 실제로 취소된 6건 중 4건이 여기 박혀 있었다.
                    sql += ` AND trx_status=1 AND is_cancel=0 AND is_cancel_trans=0 `;
                } else if (cancel_status == 2) {
                    sql += ` AND is_cancel=1 `;
                } else if (cancel_status == 5) {
                    // 고객 '반품/환불조회' — 취소요청(trx_status=1) + 취소완료(is_cancel/is_cancel_trans) 전부.
                    // 프론트(shop demo-4·5·9 history.js)가 예전부터 5를 보내왔는데 여기 분기가 없었다.
                    // if(cancel_status)가 참이라 아래 else의 기본 필터도 건너뛰어, 결과적으로
                    // 필터가 통째로 사라져 '주문/배송조회'와 똑같이 전체 주문이 나오고 있었다.
                    // ⚠ is_cancel=0 을 함께 걸어야 한다.
                    // 취소가 확정되면 원주문(is_cancel_trans=1)과 취소 원장 행(is_cancel=1)이
                    // 둘 다 생긴다. 조건에 둘 다 넣으면 손님에게 **같은 취소가 두 줄로** 보인다.
                    // 손님에게 뜻이 있는 것은 원주문 쪽이다(금액이 양수고 주문 정보가 그대로 있다).
                    sql += ` AND (trx_status=1 OR is_cancel_trans=1) AND is_cancel=0 `;
                } else if (cancel_status == 0) {
                    sql += ` AND is_cancel=0 AND is_cancel_trans=0 `;
                } else {
                    // 알 수 없는 값이 와도 필터가 사라지지 않게 기본값으로 되돌린다.
                    sql += ` AND is_cancel=0 AND is_cancel_trans=0 `;
                }
            } else {
                sql += ` AND is_cancel=0 AND is_cancel_trans=0 `;
            }
            if (cancel_type) {
                sql += ` AND cancel_type=? `;
                params.push(cancel_type);
            }

            //console.log(sql)

            let data = await getSelectQueryList(sql, columns, req.query, [], params);
            let trx_ids = data?.content.map(trx => {
                return trx?.is_cancel == 1 ? (trx?.transaction_id ?? 0) : trx?.id
            })

            if (trx_ids?.length > 0) {
                let transaction_orders_column = [
                    `transaction_orders.*`,
                    `products.product_img`,
                    `products.product_code`,
                    `products.product_name`,
                    `products.lang_obj`,
                    `sellers.user_name AS seller_user_name`,
                ]
                let order_sql = `SELECT ${transaction_orders_column.join()} FROM transaction_orders `
                order_sql += ` LEFT JOIN products ON transaction_orders.product_id=products.id `
                order_sql += ` LEFT JOIN users AS sellers ON transaction_orders.seller_id=sellers.id `
                let trx_placeholders = trx_ids.map(() => '?').join(',');
                order_sql += ` WHERE transaction_orders.trans_id IN (${trx_placeholders}) `;
                order_sql += ` ORDER BY transaction_orders.id DESC `
                let order_data = await readPool.query(order_sql, trx_ids);

                order_data = order_data[0];

                for (var i = 0; i < order_data.length; i++) {
                    order_data[i].groups = JSON.parse(order_data[i]?.order_groups ?? "[]");
                    order_data[i].lang_obj = JSON.parse(order_data[i]?.lang_obj ?? "{}");
                    delete order_data[i].order_groups
                }
                let transactions_order_obj = {};
                let transactions_id_obj = {};
                for (var i = 0; i < data?.content.length; i++) {
                    transactions_id_obj[data?.content[i]?.id] = i;
                    transactions_order_obj[data?.content[i]?.id] = [];
                    transactions_order_obj[data?.content[i]?.transaction_id] = [];
                }

                for (var i = 0; i < order_data.length; i++) {
                    transactions_order_obj[order_data[i]?.trans_id].push(order_data[i]);
                }

                for (var i = 0; i < data?.content.length; i++) {
                    data.content[i].orders = transactions_order_obj[data?.content[i]?.is_cancel == 1 ? data?.content[i]?.transaction_id : data?.content[i]?.id];
                }

                // 주문서 추가 입력항목(행사일·행사장소 등). 서식이 걸린 가맹점 주문에만 값이 있다.
                // 전화·주소 유형은 암호화돼 있어 여기서 되돌린다.
                //
                // ⚠ 실패해도 주문 목록 자체는 뜨게 한다 — 마이그레이션 전에 코드가 먼저 배포되면
                //   테이블이 없어 여기서 터지고, 그러면 관리자가 주문을 아예 못 본다.
                const form_obj = {};
                try {
                    const form_rows = await readPool.query(
                        `SELECT * FROM transaction_order_forms WHERE trans_id IN (${trx_placeholders}) ORDER BY sort ASC, id ASC`,
                        trx_ids
                    );
                    for (const r of form_rows[0]) {
                        if (!form_obj[r.trans_id]) form_obj[r.trans_id] = [];
                        form_obj[r.trans_id].push({
                            ...r,
                            value: PII_FIELD_TYPES.includes(r.field_type) ? decField(r.value) : r.value,
                        });
                    }
                } catch (e) {
                    console.error('order_form 값 조회 실패(무시하고 진행):', e?.sqlMessage || e?.message || e);
                }
                for (var i = 0; i < data?.content.length; i++) {
                    data.content[i].order_forms = form_obj[data?.content[i]?.id] ?? [];
                }
            }
            //console.log(data)
            decListContent('transactions', data); // 읽기 복호화(주문자명·전화·주소)
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    get: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id, } = req.params;
            const { ord_num, password, buyer_phone } = req.query;
            const brandId = decode_dns?.id ?? 0;

            // 라인아이템(orders[]) 첨부 헬퍼
            const attachOrders = async (row) => {
                if (!row) return row;
                let od = await readPool.query(`SELECT * FROM transaction_orders WHERE trans_id=? ORDER BY id DESC`, [row?.id ?? 0]);
                od = od[0];
                for (var i = 0; i < od.length; i++) {
                    od[i].groups = JSON.parse(od[i]?.groups ?? "[]");
                }
                row.orders = od;
                return row;
            };

            // 비회원 조회: 전화번호 + 주문비밀번호 → 현재 브랜드로 스코프, 여러 건 배열 반환.
            // 전화번호는 형식차(하이픈/공백/점) 흡수 위해 숫자만 비교.
            if (buyer_phone) {
                if (!password) {
                    return response(req, res, -100, "주문 비밀번호를 입력해 주세요.", [])
                }
                const phoneDigits = String(buyer_phone).replace(/[^0-9]/g, '');
                // 비밀번호는 해시로 저장된다(order-password.js). 이 기능 이전 주문은 평문이라
                // 두 형태를 모두 후보로 넣어 기존 주문 조회가 깨지지 않게 한다.
                const pwCandidates = orderPasswordCandidates(password);
                const pwPlaceholders = pwCandidates.map(() => '?').join(',');
                let list = await readPool.query(
                    `SELECT * FROM ${table_name}
                     WHERE (REPLACE(REPLACE(REPLACE(buyer_phone,'-',''),' ',''),'.','') = ? OR buyer_phone_idx = ?)
                       AND password IN (${pwPlaceholders}) AND brand_id=? ORDER BY id DESC LIMIT 50`,
                    [phoneDigits, blindIndex(buyer_phone), ...pwCandidates, brandId]
                );
                list = list[0];
                for (const row of list) {
                    await attachOrders(row);
                }
                decRows('transactions', list); // 읽기 복호화
                return response(req, res, 100, "success", list) // 배열
            }

            // ⚠ 여기부터는 '주문 한 건'을 직접 지목해 가져오는 경로다.
            //   기존엔 인증·브랜드 스코프·소유자 확인이 하나도 없어서
            //   GET /api/transactions/1,2,3... 로 순번만 훑으면 브랜드 구분 없이 모든 주문의
            //   복호화된 이름·연락처·주소·품목을 누구나 받아갈 수 있었다(decRow 로 복호화까지 됨).
            //   → 모든 경로에 brand_id 스코프를 걸고, 아래 세 가지 중 하나를 만족할 때만 반환한다.
            //     (a) 주문번호 + 주문비밀번호가 맞는 비회원 조회
            //     (b) 본인(user_id) 주문
            //     (c) 그 브랜드의 운영자(level>=10)
            let sql;
            let queryParams;
            if (ord_num) {
                if (!password) {
                    return response(req, res, -100, "주문 비밀번호를 입력해 주세요.", {})
                }
                // 위와 같은 이유로 해시/평문 두 형태를 후보로 둔다.
                const pwCandidates2 = orderPasswordCandidates(password);
                const pwPlaceholders2 = pwCandidates2.map(() => '?').join(',');
                sql = `SELECT * FROM ${table_name} WHERE ord_num=? AND password IN (${pwPlaceholders2}) AND brand_id=?`;
                queryParams = [ord_num, ...pwCandidates2, brandId];
            } else {
                if (!id) {
                    return response(req, res, -100, "존재하지 않는 주문입니다.", false)
                }
                sql = `SELECT * FROM ${table_name} WHERE id=? AND brand_id=?`;
                queryParams = [id, brandId];
            }
            let data = await readPool.query(sql, queryParams)
            data = data[0][0];
            if (!data) {
                return response(req, res, -100, "존재하지 않는 주문번호 입니다.", {})
            }
            // id 로 직접 지목한 경우엔 소유자이거나 운영자여야 한다.
            // (ord_num 경로는 주문비밀번호 일치로 이미 본인 확인이 끝났다)
            if (!ord_num) {
                const isStaff = decode_user?.level >= 10;
                const isOwner = decode_user?.id && data?.user_id && data.user_id == decode_user.id;
                if (!isStaff && !isOwner) {
                    return lowLevelException(req, res);
                }
            }
            await attachOrders(data);

            decRow('transactions', data); // 읽기 복호화
            return response(req, res, 100, "success", data)
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    create: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
            } = req.body;
            let files = settingFiles(req.files);
            let obj = {
                brand_id, name, note, price, category_id
            };

            obj = { ...obj, ...files };

            //console.log(11)

            let result = await insertQuery(`${table_name}`, obj);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    noti: async (req, res, next) => {
        try {

            //const decode_user = checkLevel(req.cookies.token, 0, res);
            //const decode_dns = checkDns(req.cookies.dns);

            //console.log(req)

            return res.status(200).send("SUCCESS");
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return res.status(200).send("FAIL");
        } finally {

        }
    },
    update: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            // 주문 수정은 관리자 전용이다(프론트 호출부는 pages/manager/orders/** 뿐).
            // 검사가 없어서 무인증으로 남의 주문 금액·상태·승인번호를 바꿀 수 있었다.
            // (고객의 취소요청은 cancelRequest 가 따로 처리하며 본인·브랜드 검증이 들어 있다)
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            const {
                id,
                trx_dt,
                trx_tm,
                appr_num,
                buyer_name,
                buyer_phone,
                //check_img
            } = req.body;
            // 레벨40 검사만으로는 '어느 가맹점의 관리자인지'가 걸러지지 않는다.
            // updateQuery 는 WHERE id=? 만 걸어 브랜드 스코프가 없어서
            // A 가맹점 관리자가 id 만 바꿔 B 가맹점 주문의 금액·승인번호·주문자정보를 고칠 수 있었다.
            // (레벨50 마스터는 canWriteBrand 에서 전 브랜드 허용)
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let files = settingFiles(req.files);
            let obj = {
                trx_dt,
                trx_tm,
                appr_num,
                buyer_name,
                buyer_phone,
                //check_img
            };
            obj = { ...obj, ...files };
            obj = encForSave('transactions', obj); // 주문자명·전화 암호화 + blind-index(어드민 수정)

            let result = await updateQuery(`${table_name}`, obj, id);

            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    remove: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            // 검사 없이 삭제로 직행했다 — id 만 알면 남의 주문이 지워졌다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            // deleteQuery 도 WHERE id=? 만 걸어 브랜드 스코프가 없다 —
            // 다른 가맹점 주문을 지울 수 있어 소유 검증을 먼저 한다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let result = await deleteQuery(`${table_name}`, {
                id
            })
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    changeInvoice: async (req, res, next) => {
        try {

            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            const { invoice_num } = req.body;
            // 송장번호 변경도 관리자 전용이다. 검사가 없어 아무나 남의 주문 송장을 바꿀 수 있었다.
            if (!decode_user || decode_user?.level < 40) {
                return lowLevelException(req, res);
            }
            // 송장변경도 id 만으로 동작해 다른 가맹점 주문의 송장번호를 덮어쓸 수 있었다.
            const target = await loadOwnedRow(readPool, table_name, id, decode_user);
            if (!target) return lowLevelException(req, res);
            let result = await updateQuery(`${table_name}`, {
                invoice_num
            }, id)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
    cancelRequest: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;
            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id]);
            data = data[0][0];
            if (!data) {
                return response(req, res, -100, "주문을 찾을 수 없습니다.", false)
            }
            // 브랜드 스코프가 먼저다 — 다른 몰의 주문은 비밀번호가 맞아도 건드릴 수 없다.
            if (decode_dns?.id && data?.brand_id != decode_dns?.id) {
                return lowLevelException(req, res);
            }
            // 본인 확인은 두 갈래다.
            //   (a) 회원   : 로그인 user_id 가 주문의 user_id 와 같을 때
            //   (b) 비회원 : 주문비밀번호가 맞을 때 — 조회(get)가 쓰는 것과 똑같은 확인이다
            //
            // 예전엔 (a) 뿐이었다. 그런데 비회원 주문은 user_id 가 0 으로 저장되므로
            // (pay.controller.js: "비회원 주문은 user_id=0 이 정상") 어떤 값과도 맞지 않아
            // 취소요청이 늘 "권한이 없습니다" 로 막혔다. 전체 주문의 99.98% 가 이 경우라
            // 대부분의 손님은 스스로 취소할 길이 아예 없었고 그 부담이 가맹점 전화로 갔다.
            // (2026-08-21 가맹점이 겪은 「권한없음」이 이것이다)
            const 회원본인 = Number(decode_user?.id) > 0 && data?.user_id == decode_user?.id;
            // 판정은 order-password.js 에 둔다 — 검사(guest-cancel.mjs)가 그 함수를
            // 그대로 불러 빈 값·해시·평문 경우를 실제로 돌려 본다.
            const 비회원본인 = matchesOrderPassword(req.body?.password, data?.password);
            if (!회원본인 && !비회원본인) {
                // 왜 막혔는지 알려준다. 예전엔 회원·비회원 가리지 않고 "권한이 없습니다" 뿐이라
                // 손님은 무엇을 해야 하는지 알 수 없었다.
                if (!(Number(decode_user?.id) > 0) && !req.body?.password) {
                    return response(req, res, -100, "주문 비밀번호를 입력해 주세요.", false)
                }
                return lowLevelException(req, res);
            }
            // 취소 요청이 가능한 상태만. 출고 이후(15·20·25)는 취소가 아니라 반품 절차로 가야 하고,
            // 이미 취소요청(1)이거나 취소완료된 건은 중복 요청을 막는다.
            // 0=결제대기, 1=취소요청, 5=결제완료, 10=입고, 15=출고, 20=배송중, 25=배송완료
            // 결제대기(0)는 뺀다 — 아직 승인되지 않은 주문이라 돌려줄 돈이 없다.
            // 예전엔 여기 0 이 있어서, 결제도 안 된 주문에 취소요청이 쌓이고
            // 가맹점은 환불할 것도 없는 건을 처리해야 했다(2026-08-21 지적).
            const CANCELABLE_STATUS = [5, 10];
            if (data?.is_cancel == 1 || data?.is_cancel_trans == 1) {
                return response(req, res, -100, "이미 취소 처리된 주문입니다.", false)
            }
            if (data?.trx_status == 1) {
                return response(req, res, -100, "이미 취소 요청된 주문입니다.", false)
            }
            // 왜 안 되는지는 상태마다 다르다. 한 문장으로 뭉뚱그리면 결제도 안 한 주문에까지
            // "출고된 주문" 이라고 답하게 된다.
            if (Number(data?.trx_status) === 0) {
                return response(req, res, -100, "아직 결제가 완료되지 않은 주문입니다. 결제하지 않으시면 주문이 진행되지 않습니다.", false)
            }
            if (!CANCELABLE_STATUS.includes(Number(data?.trx_status))) {
                return response(req, res, -100, "출고된 주문은 취소할 수 없습니다. 반품/환불은 판매자에게 문의해 주세요.", false)
            }
            // 어느 상품을 몇 개 취소하고 싶은지 남긴다.
            //
            // 예전엔 trx_status 를 1 로 바꾸는 게 전부였다. 무엇을 취소하고 싶은지
            // 적을 자리가 없어서 관리자는 주문 전체를 취소하거나 고객에게 따로 물어야 했다.
            // items 를 안 보내면 예전처럼 '주문 전체' 요청으로 본다(옛 화면 호환).
            const { items, reason } = req.body ?? {};
            try {
                const [lines] = await readPool.query(
                    `SELECT id, order_count, cancel_count FROM transaction_orders WHERE trans_id=?`, [id]);
                const 요청 = (Array.isArray(items) ? items : [])
                    .map((x) => ({ order_id: Number(x?.order_id) || 0, qty: Math.max(0, Number(x?.qty) || 0) }))
                    .filter((x) => x.order_id && x.qty);
                // 아무것도 안 고르면 남은 수량 전부를 요청한 것으로 본다.
                const 대상 = 요청.length ? 요청 : lines.map((l) => ({
                    order_id: l.id,
                    qty: Math.max(0, (Number(l.order_count) || 0) - (Number(l.cancel_count) || 0)),
                })).filter((x) => x.qty > 0);

                for (const t of 대상) {
                    const line = lines.find((l) => Number(l.id) === t.order_id);
                    if (!line) continue; // 이 주문에 없는 줄은 무시한다
                    const 남은 = Math.max(0, (Number(line.order_count) || 0) - (Number(line.cancel_count) || 0));
                    const qty = Math.min(t.qty, 남은);
                    if (qty <= 0) continue;
                    await writePool.query(
                        `INSERT INTO transaction_cancel_requests (trans_id, order_id, req_count, reason, user_id)
                         VALUES (?,?,?,?,?)`,
                        [id, t.order_id, qty, reason ?? null, decode_user?.id ?? null]);
                }
            } catch (e) {
                // 요청 내역을 못 남겨도 '취소요청' 자체는 접수되게 한다 —
                // 여기서 막으면 고객은 취소를 아예 못 한다. 관리자가 물어보면 되는 문제다.
                console.error('취소요청 상세 저장 실패(요청은 접수됨):', e?.sqlMessage || e?.message || e);
            }

            let result = await updateQuery(`${table_name}`, {
                trx_status: 1,
            }, id)
            return response(req, res, 100, "success", {})
        } catch (err) {
            console.log(err)
            logger.error(errText(err))
            return response(req, res, -200, "서버 에러 발생", false)
        } finally {

        }
    },
};

const asdsadsad = async () => {
    try {
        let result = await transactionCtrl.list({
            query: {
                is_confirm: true,
                s_dt: '2024-03-13'
            }
        })
        let data = [
            ['승인번호', '구매자명', '구매자휴대폰번호', '구매금액', '구매상품', '구매시간', '주소', '결제타입'],
        ];
        console.log(result.content.length)
        for (var i = 0; i < result.content.length; i++) {
            let order_item = result.content[i];
            data.push([
                order_item?.appr_num,
                order_item?.buyer_name,
                order_item?.buyer_phone,
                order_item?.amount,
                order_item?.orders.map(itm => {
                    return `상품주문명:${itm?.order_name} 상품가:${itm?.order_amount} 배달가:${itm?.delivery_fee}`
                }).join(' / '),
                `${order_item?.trx_dt} ${order_item?.trx_tm}`,
                `${order_item?.addr} ${order_item?.detail_addr}`,
                `무통장입금`
            ])
        }


        // 새 워크북 생성
        const wb = XLSX.utils.book_new();
        // 새 워크시트 생성
        const ws = XLSX.utils.aoa_to_sheet(data);

        // 워크북에 워크시트 추가
        XLSX.utils.book_append_sheet(wb, ws, "데이터");

        // 엑셀 파일로 저장
        XLSX.writeFile(wb, '데이터.xlsx', { bookSST: true });

    } catch (err) {
        console.log(err);
    }
}
export default transactionCtrl;
