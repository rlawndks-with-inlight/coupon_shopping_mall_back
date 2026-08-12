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
// 전 브랜드의 스토어프론트 설정 캐시 무효화.
//
// 본사에서 한 번 고치면 전 가맹점 화면에 나가는 데이터(상품상세 혜택 안내)가 있다.
// 그런 것은 브랜드 하나만 지워 봐야 소용이 없다 — 나머지 가맹점은 TTL(180초)이
// 지날 때까지 옛 내용을 보여준다. 저장했는데 몰마다 다른 내용이 보이는 상황이 된다.
export const invalidateAllShopSettingCache = async () => {
    if (!redisClient?.isOpen) return;
    try {
        const keys = await redisClient.keys(`shop:setting:*`);
        if (keys.length > 0) await redisClient.del(keys);
    } catch (e) {
        console.error('Redis cache invalidation error (shop:setting:*):', e?.message ?? e);
    }
};

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
