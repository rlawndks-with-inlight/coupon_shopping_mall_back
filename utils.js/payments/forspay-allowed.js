'use strict';
import { redisClient } from "../../config/redis-client.js";
import { getAvailableMethodIds } from "./forspay.js";
import { invalidateShopSettingCache } from "../cache.js";
import logger from "../winston/index.js";

// 포스페이 계정이 지금 쓸 수 있는 결제 '대분류'(0 카드 · 1 계좌이체 · 3 간편결제 · 5 해외결제) 저장값.
// shop.controller 가 주문서 결제수단을 거를 때 읽고, pay.controller 가 결제창 열기에 실패하면 다시 확인한다.
//
// 보관 시간 5분 — 예전엔 1시간이었다. 포스페이에서 대분류를 꺼도 최대 1시간 동안 손님 화면에 남아
// 누르면 결제가 실패했다(2026-10-15 사장님 지적). 조회는 0.4~0.7초짜리 외부 호출이지만,
// 몰 설정 응답이 이미 3분 캐시라 이 조회는 몰마다 몇 분에 한 번뿐이다 — 줄여도 체감 속도는 그대로다.
// 포스페이는 세부 수단(카카오·네이버·라인, 해외카드·위챗·알리)별 정보를 주지 않는다. 대분류까지만 거른다.
export const 대분류보관초 = 300;
const 키 = (brandId) => `forspay:allowed_methods:${Number(brandId) || 0}`;

// 저장값이 있으면 그것을, 없으면 포스페이에 물어 저장한다. 조회 실패면 null(→ 거르지 않고 전부 보여준다).
export const 대분류읽기 = async (brandId, app_key) => {
    if (!app_key) return null;
    try {
        const cached = redisClient?.isOpen ? await redisClient.get(키(brandId)) : null;
        if (cached) return JSON.parse(cached);
        const ids = await getAvailableMethodIds({ app_key });
        if (redisClient?.isOpen && Array.isArray(ids)) {
            await redisClient.set(키(brandId), JSON.stringify(ids), { EX: 대분류보관초 });
        }
        return ids;
    } catch (e) {
        return null;
    }
};

// 결제창 열기가 실패했을 때 부른다. 포스페이에 **새로** 묻고 저장값을 갈아 끼운다.
// 고른 대분류가 실제로 빠져 있으면 그 몰의 설정 캐시까지 지워 **다음 손님부터 바로** 숨겨지게 한다.
// 포스페이의 '미지원 수단' 오류 문구는 확인된 적이 없어 문구로 판정하지 않는다 — 다시 물어본 결과로 판정한다.
// 손님 응답을 늦추지 않도록 호출측은 기다리지 않는다(fire-and-forget). 실패는 삼킨다.
export const 실패후대분류다시확인 = async (brandId, app_key, pg_method_id) => {
    try {
        const fresh = await getAvailableMethodIds({ app_key });
        if (!Array.isArray(fresh)) return false;
        if (redisClient?.isOpen) await redisClient.set(키(brandId), JSON.stringify(fresh), { EX: 대분류보관초 });
        if (!fresh.includes(Number(pg_method_id))) {
            await invalidateShopSettingCache(brandId);
            logger.info(`[forspay] 결제 실패 뒤 다시 확인 — brand_id=${brandId} 대분류 ${pg_method_id} 이(가) 빠져 있어 주문서에서 숨김 (지금 가능: ${fresh.join(',')})`);
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
};
