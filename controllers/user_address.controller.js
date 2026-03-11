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

            // 조회 대상 유저
            const targetUserId = user_id ? Number(user_id) : loginUserId;

            // 권한 체크
            if (!targetUserId) {
                return lowLevelException(req, res);
            }
            // user_id가 없는 경우: 로그인한 유저 본인만 허용 (level < 10 이면 남의 주소는 당연히 안 됨)
            if (!user_id && loginLevel < 1) {
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

            // ✅ Redis 캐시 키 생성
            const canUseCache = !!redisClient?.isOpen && brandId > 0 && targetUserId > 0;
            const baseKey = `user_addresses:list:${brandId}:${targetUserId}`;
            const cacheKey = `${baseKey}:${JSON.stringify(req.query || {})}`;

            if (canUseCache) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) {
                        const data = JSON.parse(cached);
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

            const canUseCache = !!redisClient?.isOpen && brandId > 0;
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
                user_id
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

            // 권한: 관리자(레벨>=10) or 본인
            if (!(loginLevel >= 10 || loginUserId == user_id)) {
                return lowLevelException(req, res);
            }

            obj = { ...obj, ...files };

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

            // 권한: 관리자(레벨>=10) or 본인
            if (!(loginLevel >= 10 || loginUserId == targetUserId)) {
                return lowLevelException(req, res);
            }

            obj = { ...obj, ...files };

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

            // 삭제 전에 user_id 가져와서 캐시 무효화에 사용
            let targetUserId = null;
            try {
                const [rows] = await readPool.query(
                    `SELECT user_id FROM ${table_name} WHERE id = ?`,
                    [id]
                );
                if (rows?.[0]) {
                    targetUserId = rows[0].user_id;
                }
            } catch (e) {
                console.error("fetch user_id before delete error:", e);
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
