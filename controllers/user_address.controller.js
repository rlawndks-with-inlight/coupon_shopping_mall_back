'use strict';
import { checkIsManagerUrl } from "../utils.js/function.js";
import {
    deleteQuery,
    getSelectQueryList,
    insertQuery,
    selectQuerySimple,
    updateQuery
} from "../utils.js/query-util.js";
import {
    checkDns,
    checkLevel,
    isItemBrandIdSameDnsId,
    lowLevelException,
    response,
    settingFiles
} from "../utils.js/util.js";
import 'dotenv/config';
import logger from "../utils.js/winston/index.js";
import { readPool } from "../config/db-pool.js";
import { redisClient } from "../config/redis-client.js";
import { encForSave, decRow, decListContent } from "../utils.js/pii.js";

const table_name = 'user_addresses';

// ✅ 유저 주소 관련 캐시 무효화 헬퍼
const invalidateUserAddressCache = async (brandId, userId) => {
    try {
        if (!redisClient?.isOpen || !brandId || !userId) return;

        const pattern = `user_addresses:list:${brandId}:${userId}:*`;

        // redis v4의 scanIterator 사용
        for await (const key of redisClient.scanIterator({ MATCH: pattern })) {
            await redisClient.del(key);
        }

        // 단건 조회 캐시도 제거
        const detailPattern = `user_addresses:get:${brandId}:*`;
        for await (const key of redisClient.scanIterator({ MATCH: detailPattern })) {
            await redisClient.del(key);
        }
    } catch (e) {
        console.error("Redis invalidateUserAddressCache error:", e);
    }
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
            } = req.body;

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
            if (is_default !== undefined) obj.is_default = is_default ? 1 : 0;

            // 권한: 관리자(레벨>=10) or 본인
            if (!(loginLevel >= 10 || loginUserId == user_id)) {
                return lowLevelException(req, res);
            }

            obj = { ...obj, ...files };
            obj = encForSave(table_name, obj); // PII(주소·받는사람·연락처) 암호화

            let result = await insertQuery(`${table_name}`, obj);

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
            } = req.body;

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
            if (is_default !== undefined) obj.is_default = is_default ? 1 : 0;

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
