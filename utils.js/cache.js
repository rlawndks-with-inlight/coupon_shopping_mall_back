import { redisClient } from "../config/redis-client.js";

// 스토어프론트 설정 캐시(shop:setting:{brandId}:{userId}) 무효화.
//
// shop.controller 의 setting 응답에는 팝업·게시판 카테고리·상품 카테고리 등이 함께 실리고
// TTL 이 180초다(고객에게만 캐시된다 — 레벨10 미만). 그래서 관리자가 팝업을 띄우거나
// 게시판을 만들어도 고객 화면에는 최대 3분간 반영되지 않았다.
// 쓰기 핸들러 끝에서 이걸 불러 그 브랜드 캐시를 지운다.
//
// 실패는 삼킨다 — TTL 로 어차피 만료되므로, 캐시 삭제 실패 때문에 멀쩡한 저장이
// 실패로 보이면 안 된다.
export const invalidateShopSettingCache = async (brandId) => {
    const id = Number(brandId) || 0;
    if (!id || !redisClient?.isOpen) return;
    try {
        const keys = await redisClient.keys(`shop:setting:${id}:*`);
        if (keys.length > 0) await redisClient.del(keys);
    } catch (e) {
        console.error('Redis cache invalidation error (shop:setting):', e?.message ?? e);
    }
};
