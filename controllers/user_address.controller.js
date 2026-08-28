'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import {
    deleteQuery,
    getSelectQueryList,
    insertQuery,
    selectQuerySimple,
    updateQuery, hasColumn } from "../utils.js/query-util.js";
import {
    checkDns,
    checkLevel,
    isItemBrandIdSameDnsId,
    isTruthyFlag,
    lowLevelException,
    response,
    settingFiles
} from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool, writePool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { deleteKeys } from "../utils.js/redis-scan.js";
import { encForSave, decRow, decListContent } from "../utils.js/pii.js";

const table_name = 'user_addresses';

// ✅ 유저 주소 관련 캐시 무효화 헬퍼
const invalidateUserAddressCache = async (brandId, userId) => {
    try {
        if (!redisClient?.isOpen || !brandId || !userId) return;

        // scanIterator 를 직접 부르지 않는다 — 라이브러리가 v5 로 올라가면서
        // 키를 하나씩이 아니라 묶음으로 내놓게 바뀌었다(utils.js/redis-scan.js 주석 참고).
        await deleteKeys(redisClient, `user_addresses:list:${brandId}:${userId}:*`);

        // 단건 조회 캐시도 제거
        await deleteKeys(redisClient, `user_addresses:get:${brandId}:*`);
    } catch (e) {
        console.error("Redis invalidateUserAddressCache error:", e);
    }
};

// 배송지는 물건이 실제로 가는 곳이다. 받는사람·연락처가 비면 배송이 막히고,
// 연락처에 글자가 섞이면 택배사 연동에서 그대로 실패한다.
// [확인 2026-08-28] 운영 API 로 받는사람 빈 값과 연락처 'abcdefg' 가 그대로 저장됐다.
// ⚠ 이 값들은 암호화 저장이라 DB 에서 눈으로 찾기 어렵다 — 들어가기 전에 막아야 한다.
// ⚠ 문구는 사전에서 글자 그대로 찾으므로 조립하지 말 것.
const 배송지검사 = (b = {}) => {
    const 주소 = String(b.addr ?? '').trim();
    if (!주소) return '주소를 입력해 주세요.';
    if ([...주소].length > 1024) return '주소가 너무 깁니다. 다시 확인해 주세요.';
    // 받는사람·연락처는 주소록 확장 칸이라 안 보내는 화면도 있다 — 보냈을 때만 본다.
    if (b.receiver !== undefined) {
        const 받는사람 = String(b.receiver ?? '').trim();
        if (!받는사람) return '받는 분 이름을 입력해 주세요.';
        if ([...받는사람].length > 50) return '받는 분 이름은 50자 이내로 입력해 주세요.';
    }
    if (b.phone !== undefined && String(b.phone ?? '').trim() !== '') {
        const 전화 = String(b.phone).replace(/[-\s]/g, '');
        if (!/^[0-9+]{7,20}$/.test(전화)) return '연락처를 숫자로 정확히 입력해 주세요.';
    }
    return null;
};
const userAddressCtrl = {
    list: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { user_id = 0 } = req.query;

            const brandId = decode_dns?.id ?? 0;
            const loginUserId = decode_user?.id ?? 0;
            const loginLevel = decode_user?.level ?? 0;

            // 배송지는 개인정보다. 로그인은 무조건 먼저 요구한다.
            //
            // 예전 검사는 `if (!user_id && loginLevel < 1)` 이었다. 즉 쿼리에 user_id 를
            // 실어 보내면 그 검사 자체가 건너뛰어졌고, 비로그인이라도 임의 회원의 배송지를
            // (아래에서 decListContent 로 복호화까지 해서) 그대로 받아갈 수 있었다.
            if (!decode_user) {
                return lowLevelException(req, res);
            }

            // 조회 대상 유저. user_id 를 안 주면 본인.
            const targetUserId = user_id ? Number(user_id) : loginUserId;
            if (!targetUserId) {
                return lowLevelException(req, res);
            }
            // 남의 주소를 보려면 관리자·셀러여야 한다.
            if (targetUserId !== loginUserId && loginLevel < 10) {
                return lowLevelException(req, res);
            }

            let columns = [
                `${table_name}.*`,
            ];

            let sql = `SELECT ${process.env.SELECT_COLUMN_SECRET} FROM ${table_name} `;
            let params = [];
            sql += ` WHERE ${table_name}.brand_id=? `;
            params.push(brandId);
            sql += ` AND user_id=? `;
            params.push(targetUserId);

            // ✅ Redis 캐시 키 생성 (관리자/셀러는 제외)
            const canUseCache = !!redisClient?.isOpen && brandId > 0 && targetUserId > 0 && loginLevel < 10;
            const baseKey = `user_addresses:list:${brandId}:${targetUserId}`;
            const cacheKey = `${baseKey}:${JSON.stringify(req.query || {})}`;

            if (canUseCache) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);
                        decListContent(table_name, data); // 읽기 복호화
                        return response(req, res, 100, "success(cache)", data);
                    }
                } catch (e) {
                    console.error("Redis get error (user_addresses list):", e);
                }
            }

            // 실제 DB 조회
            let data = await getSelectQueryList(sql, columns, req.query, [], params);

            // ✅ 캐시 저장 (예: 60초)
            if (canUseCache) {
                try {
                    await redisClient.set(cacheKey, JSON.stringify(data), { EX: 60 });
                } catch (e) {
                    console.error("Redis set error (user_addresses list):", e);
                }
            }

            decListContent(table_name, data); // 읽기 복호화(캐시엔 암호문 저장, 응답은 복호화)
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    get: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;

            // 배송지는 개인정보다. 브랜드만 맞으면 통과했기 때문에(아래 isItemBrandIdSameDnsId)
            // 같은 몰의 다른 회원 주소를 id 만 바꿔가며 읽을 수 있었다.
            // 응답 직전 decRow 로 복호화까지 하므로 실명·연락처가 그대로 나갔다.
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            // 본인 것이 아니면 관리자·셀러여야 한다.
            const isStaff = (decode_user?.level ?? 0) >= 10;
            const assertOwner = (row) => isStaff || row?.user_id == decode_user?.id;

            const brandId = decode_dns?.id ?? 0;

            const userLevel = decode_user?.level ?? 0;
            const canUseCache = !!redisClient?.isOpen && brandId > 0 && userLevel < 10;
            const cacheKey = `user_addresses:get:${brandId}:${id}`;

            if (canUseCache) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);

                        // 브랜드 매칭 검증
                        if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                            return lowLevelException(req, res);
                        }
                        if (!assertOwner(data)) {
                            return lowLevelException(req, res);
                        }

                        decRow(table_name, data); // 읽기 복호화
                        return response(req, res, 100, "success(cache)", data);
                    }
                } catch (e) {
                    console.error("Redis get error (user_addresses get):", e);
                }
            }

            let data = await readPool.query(`SELECT * FROM ${table_name} WHERE id=?`, [id]);
            data = data[0][0];

            if (!data) {
                return response(req, res, -404, "데이터를 찾을 수 없습니다.", false);
            }

            if (!isItemBrandIdSameDnsId(decode_dns, data)) {
                return lowLevelException(req, res);
            }
            if (!assertOwner(data)) {
                return lowLevelException(req, res);
            }

            // ✅ 캐시 저장 (예: 300초)
            if (canUseCache) {
                try {
                    await redisClient.set(cacheKey, JSON.stringify(data), { EX: 300 });
                } catch (e) {
                    console.error("Redis set error (user_addresses get):", e);
                }
            }

            decRow(table_name, data); // 읽기 복호화
            return response(req, res, 100, "success", data);
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    create: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                addr,
                detail_addr,
                brand_id,
                user_id,
                receiver,        // 주소록 확장(주문서용): 받는사람
                phone,           // 연락처
                zonecode,        // 우편번호
                address_type,    // 배송지 구분(집/회사 등)
                is_default,      // 기본배송지 여부
                country_code,    // 배송 국가(KR=국내, ZZ=해외). 국내/해외 입력 방식이 여기서 갈린다
                country_name,    // 고객이 직접 적은 나라 이름(코드 컬럼은 VARCHAR(2) 라 이름을 못 담는다)
                city,            // 도시(해외배송)
                state_region,    // 주/지역(해외배송)
            } = req.body;
            const 배송지잘못 = 배송지검사(req.body);
            if (배송지잘못) { return response(req, res, -100, 배송지잘못, false); }

            const brandId = brand_id || decode_dns?.id || 0;
            const loginUserId = decode_user?.id ?? 0;
            const loginLevel = decode_user?.level ?? 0;

            let files = settingFiles(req.files);
            let obj = {
                addr,
                detail_addr,
                brand_id: brandId,
                user_id
            };
            // 확장 필드는 전달된 경우에만 포함(다른 프로젝트/구클라이언트 하위호환 — 미전송 시 컬럼 미포함)
            if (receiver !== undefined) obj.receiver = receiver;
            if (phone !== undefined) obj.phone = phone;
            if (zonecode !== undefined) obj.zonecode = zonecode;
            if (address_type !== undefined) obj.address_type = address_type;
            // 프론트는 multipart/form-data 로 보내므로 값이 전부 '문자열'로 도착한다.
            // 그래서 체크 해제(false)가 문자열 "false" 로 오는데, 그건 truthy 라
            // `is_default ? 1 : 0` 이 항상 1 이 됐다 → 모든 배송지가 '기본배송지'가 되고
            // 주문서에서는 전부 '기본' 뱃지가 붙었다.
            if (is_default !== undefined) obj.is_default = isTruthyFlag(is_default) ? 1 : 0;
            // 해외배송 필드. 컬럼이 없으면(마이그레이션 전) 건너뛴다 —
            // 없는 컬럼을 INSERT/UPDATE 에 넣으면 배송지 저장이 통째로 실패한다.
            // 컬럼이 있으면 국내(KR)도 그대로 저장한다(해외→국내로 되돌리는 수정이 가능해야 한다).
            if (country_code !== undefined && await hasColumn(table_name, 'country_code')) {
                obj.country_code = String(country_code || 'KR').toUpperCase().slice(0, 2);
                // 나라 이름은 고객이 직접 적는다(목록에 없는 나라도 주문할 수 있어야 한다).
                // 이걸 저장하지 않으면 화면에서 입력받은 국가가 통째로 버려진다.
                if (country_name !== undefined && await hasColumn(table_name, 'country_name')) {
                    obj.country_name = String(country_name ?? '').slice(0, 60);
                }
                if (city !== undefined) obj.city = city;
                if (state_region !== undefined) obj.state_region = state_region;
            }

            // 권한: 관리자(레벨>=10) or 본인
            if (!(loginLevel >= 10 || loginUserId == user_id)) {
                return lowLevelException(req, res);
            }

            obj = { ...obj, ...files };
            obj = encForSave(table_name, obj); // PII(주소·받는사람·연락처) 암호화

            let result = await insertQuery(`${table_name}`, obj);

            // 기본배송지는 회원당 하나여야 한다. 나머지를 내려주는 처리가 없어서
            // 배송지를 여러 개 만들면 전부 기본배송지가 됐다(주문서에 '기본' 뱃지가 전부 붙었다).
            if (obj.is_default == 1 && result?.insertId > 0) {
                await writePool.query(
                    `UPDATE ${table_name} SET is_default=0 WHERE user_id=? AND brand_id=? AND id!=? AND is_delete=0`,
                    [user_id, brandId, result.insertId]
                );
            }

            // ✅ 캐시 무효화
            await invalidateUserAddressCache(brandId, user_id);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    update: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const {
                id,
                addr,
                detail_addr,
                user_id, // 프론트에서 같이 보내주면 바로 사용
                receiver,
                phone,
                zonecode,
                address_type,
                is_default,
                country_code,
                country_name,
                city,
                state_region,
            } = req.body;
            const 배송지잘못 = 배송지검사(req.body);
            if (배송지잘못) { return response(req, res, -100, 배송지잘못, false); }

            const loginUserId = decode_user?.id ?? 0;
            const loginLevel = decode_user?.level ?? 0;
            let brandId = decode_dns?.id ?? 0;
            let targetUserId = user_id;

            // user_id가 안 날아온 경우, DB에서 brand_id, user_id 한 번 조회
            if (!targetUserId || !brandId) {
                const [rows] = await readPool.query(
                    `SELECT brand_id, user_id FROM ${table_name} WHERE id = ?`,
                    [id]
                );
                const row = rows?.[0];
                if (row) {
                    brandId = brandId || row.brand_id;
                    targetUserId = targetUserId || row.user_id;
                }
            }

            let files = settingFiles(req.files);
            let obj = {
                addr,
                detail_addr,
            };
            // 확장 필드는 전달된 경우에만 포함(하위호환)
            if (receiver !== undefined) obj.receiver = receiver;
            if (phone !== undefined) obj.phone = phone;
            if (zonecode !== undefined) obj.zonecode = zonecode;
            if (address_type !== undefined) obj.address_type = address_type;
            // 프론트는 multipart/form-data 로 보내므로 값이 전부 '문자열'로 도착한다.
            // 그래서 체크 해제(false)가 문자열 "false" 로 오는데, 그건 truthy 라
            // `is_default ? 1 : 0` 이 항상 1 이 됐다 → 모든 배송지가 '기본배송지'가 되고
            // 주문서에서는 전부 '기본' 뱃지가 붙었다.
            if (is_default !== undefined) obj.is_default = isTruthyFlag(is_default) ? 1 : 0;
            // 해외배송 필드. 컬럼이 없으면(마이그레이션 전) 건너뛴다 —
            // 없는 컬럼을 INSERT/UPDATE 에 넣으면 배송지 저장이 통째로 실패한다.
            // 컬럼이 있으면 국내(KR)도 그대로 저장한다(해외→국내로 되돌리는 수정이 가능해야 한다).
            if (country_code !== undefined && await hasColumn(table_name, 'country_code')) {
                obj.country_code = String(country_code || 'KR').toUpperCase().slice(0, 2);
                // 나라 이름은 고객이 직접 적는다(목록에 없는 나라도 주문할 수 있어야 한다).
                // 이걸 저장하지 않으면 화면에서 입력받은 국가가 통째로 버려진다.
                if (country_name !== undefined && await hasColumn(table_name, 'country_name')) {
                    obj.country_name = String(country_name ?? '').slice(0, 60);
                }
                if (city !== undefined) obj.city = city;
                if (state_region !== undefined) obj.state_region = state_region;
            }

            // 권한 판정은 반드시 '그 주소 행의 실제 주인'으로 한다.
            //
            // 예전엔 body 로 넘어온 user_id(targetUserId)를 그대로 믿었다. 그래서
            // 남의 주소 id 에 자기 user_id 를 실어 보내면 loginUserId == targetUserId 가
            // 성립해 통과했고, 정작 수정은 id 가 가리키는 남의 행에 적용됐다.
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            const [ownerRows] = await readPool.query(
                `SELECT brand_id, user_id FROM ${table_name} WHERE id = ?`,
                [id]
            );
            const ownerRow = ownerRows?.[0];
            if (!ownerRow) {
                return response(req, res, -100, "배송지를 찾을 수 없습니다.", false);
            }
            if (brandId && ownerRow.brand_id != brandId) {
                return lowLevelException(req, res);
            }
            if (!(loginLevel >= 10 || loginUserId == ownerRow.user_id)) {
                return lowLevelException(req, res);
            }
            // 캐시 무효화 대상도 실제 주인 기준으로 맞춘다.
            targetUserId = ownerRow.user_id;
            brandId = brandId || ownerRow.brand_id;

            obj = { ...obj, ...files };
            obj = encForSave(table_name, obj); // PII 암호화(부분 업데이트 — 있는 필드만)

            let result = await updateQuery(`${table_name}`, obj, id);

            // 기본배송지는 회원당 하나. 이 건을 기본으로 올렸으면 나머지를 내린다.
            if (obj.is_default == 1) {
                await writePool.query(
                    `UPDATE ${table_name} SET is_default=0 WHERE user_id=? AND brand_id=? AND id!=? AND is_delete=0`,
                    [targetUserId, brandId, id]
                );
            }

            // ✅ 캐시 무효화
            await invalidateUserAddressCache(brandId, targetUserId);

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },

    remove: async (req, res, next) => {
        try {
            const decode_user = checkLevel(req.cookies.token, 0, res);
            const decode_dns = checkDns(req.cookies.dns);
            const { id } = req.params;

            const brandId = decode_dns?.id ?? 0;

            // 이 함수에는 권한 검사가 아예 없었다. id 만 알면 남의 배송지를 영구 삭제할 수 있었다.
            // (아래 조회는 원래 캐시 무효화용이었는데, 소유자 확인에도 같이 쓴다)
            if (!decode_user) {
                return lowLevelException(req, res);
            }
            let targetUserId = null;
            let targetBrandId = null;
            try {
                const [rows] = await readPool.query(
                    `SELECT brand_id, user_id FROM ${table_name} WHERE id = ?`,
                    [id]
                );
                if (rows?.[0]) {
                    targetUserId = rows[0].user_id;
                    targetBrandId = rows[0].brand_id;
                }
            } catch (e) {
                console.error("fetch user_id before delete error:", e);
            }
            if (!targetUserId) {
                return response(req, res, -100, "배송지를 찾을 수 없습니다.", false);
            }
            if (brandId && targetBrandId != brandId) {
                return lowLevelException(req, res);
            }
            if (!((decode_user?.level ?? 0) >= 10 || (decode_user?.id ?? 0) == targetUserId)) {
                return lowLevelException(req, res);
            }

            let result = await deleteQuery(`${table_name}`, { id }, true);

            // ✅ 캐시 무효화
            if (targetUserId) {
                await invalidateUserAddressCache(brandId, targetUserId);
            }

            return response(req, res, 100, "success", {});
        } catch (err) {
            console.log(err);
            logger.error(JSON.stringify(err?.response?.data || err));
            return response(req, res, -200, "서버 에러 발생", false);
        } finally {

        }
    },
};

export default userAddressCtrl;
