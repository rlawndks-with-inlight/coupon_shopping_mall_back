'use strict';
import { redisClient } from "../../config/redis-client.js";
import { getAvailability, FORSPAY_METHODS } from "./forspay.js";
import { invalidateShopSettingCache } from "../cache.js";
import logger from "../winston/index.js";
import { getPayType } from "../util.js";

// 포스페이 계정이 지금 쓸 수 있는 결제 '대분류'(0 카드 · 1 계좌이체 · 3 간편결제 · 5 해외결제) 저장값.
// shop.controller 가 주문서 결제수단을 거를 때 읽고, pay.controller 가 결제창 열기에 실패하면 다시 확인한다.
//
// 보관 시간 5분 — 예전엔 1시간이었다. 포스페이에서 대분류를 꺼도 최대 1시간 동안 손님 화면에 남아
// 누르면 결제가 실패했다(2026-10-15 사장님 지적). 조회는 0.4~0.7초짜리 외부 호출이지만,
// 몰 설정 응답이 이미 3분 캐시라 이 조회는 몰마다 몇 분에 한 번뿐이다 — 줄여도 체감 속도는 그대로다.
// 2026-10-26 포스페이 API 변경으로 ping 이 세부 수단(간편결제 지갑·해외결제 수단)별 사용 가능 여부도 준다.
// 저장값은 { ids: 대분류, sub: 세부수단 } — 예전 저장값(대분류 배열)도 읽는다(5분 안에 자연히 바뀐다).
export const 대분류보관초 = 300;
// 저장값·조회값을 { ids, sub } 로 맞춘다. 예전 배열 저장값 → 세부 수단 정보 없음.
const 맞춤 = (v) => (Array.isArray(v) ? { ids: v, sub: null } : (v && Array.isArray(v.ids) ? v : null));
// 이 결제수단이 지금 결제 가능한가. 모르면(조회 실패·정보 없음) 막지 않는다.
export const 결제가능 = (allowed, m) => {
    const a = 맞춤(allowed);
    if (!a || !m) return true;
    if (!a.ids.includes(Number(m.pg_method_id))) return false;
    const 목록 = a.sub?.[String(m.pg_method_id)];
    if (!Array.isArray(목록)) return true;
    if (Number(m.pg_method_id) === 3) return m.route !== undefined && m.route !== null && 목록.includes(Number(m.route));
    if (Number(m.pg_method_id) === 5) return !!m.foreign_method && 목록.includes(String(m.foreign_method));
    return true;
};
const 키 = (brandId) => `forspay:allowed_methods:${Number(brandId) || 0}`;

// 저장값이 있으면 그것을, 없으면 포스페이에 물어 저장한다. 조회 실패면 null(→ 거르지 않고 전부 보여준다).
export const 대분류읽기 = async (brandId, app_key) => {
    if (!app_key) return null;
    try {
        const cached = redisClient?.isOpen ? await redisClient.get(키(brandId)) : null;
        if (cached) return 맞춤(JSON.parse(cached));
        const ids = await getAvailability({ app_key });
        if (redisClient?.isOpen && ids) {
            await redisClient.set(키(brandId), JSON.stringify(ids), { EX: 대분류보관초 });
        }
        return ids;
    } catch (e) {
        return null;
    }
};

// 결제창 열기가 실패했을 때 부른다. 포스페이에 **새로** 묻고 저장값을 갈아 끼운다.
// 고른 수단(대분류 또는 세부 수단 — 예: 꺼진 토스페이는 PV433)이 실제로 빠져 있으면
// 그 몰의 설정 캐시까지 지워 **다음 손님부터 바로** 숨겨지게 한다.
// 포스페이의 '미지원 수단' 오류 문구는 확인된 적이 없어 문구로 판정하지 않는다 — 다시 물어본 결과로 판정한다.
// 손님 응답을 늦추지 않도록 호출측은 기다리지 않는다(fire-and-forget). 실패는 삼킨다.
export const 실패후대분류다시확인 = async (brandId, app_key, method) => {
    try {
        const fresh = await getAvailability({ app_key });
        if (!fresh) return false;
        if (redisClient?.isOpen) await redisClient.set(키(brandId), JSON.stringify(fresh), { EX: 대분류보관초 });
        if (!결제가능(fresh, method)) {
            await invalidateShopSettingCache(brandId);
            logger.info(`[forspay] 결제 실패 뒤 다시 확인 — brand_id=${brandId} ${method?.key} 이(가) 지금 결제 불가라 주문서에서 숨김 (대분류 ${fresh.ids.join(',')})`);
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
};


// ── 주문서용 '지금 확인' ─────────────────────────────────────────────────────
// 주문서를 열 때마다 포스페이에 다시 묻는다(2026-10-15 사장님 제안: 「결제창 들어갈 때마다 확인」).
// 같은 몰에 손님이 몰려도 포스페이를 두드리지 않게 30초는 직전 결과를 쓴다.
// 포스페이가 2.5초 안에 답하지 않으면 기다리지 않고 5분 저장값으로 대신한다 — 포스페이 장애로 주문서가 막히면 안 된다.
const 지금키 = (brandId) => `forspay:allowed_methods_now:${Number(brandId) || 0}`;
const 지금보관초 = 30;
const 기다림한도 = 2500;
export const 대분류지금확인 = async (brandId, app_key) => {
    if (!app_key) return null;
    try {
        const cached = redisClient?.isOpen ? await redisClient.get(지금키(brandId)) : null;
        if (cached) return 맞춤(JSON.parse(cached));
    } catch (e) { /* 저장소 실패는 그냥 묻는다 */ }
    const 시간초과 = Symbol('timeout');
    const ids = await Promise.race([
        getAvailability({ app_key }).catch(() => null),
        new Promise((r) => setTimeout(() => r(시간초과), 기다림한도)),
    ]);
    if (ids && ids !== 시간초과) {
        try {
            if (redisClient?.isOpen) {
                await redisClient.set(지금키(brandId), JSON.stringify(ids), { EX: 지금보관초 });
                await redisClient.set(키(brandId), JSON.stringify(ids), { EX: 대분류보관초 }); // 5분 저장값도 새 것으로
            }
        } catch (e) { /* 무시 */ }
        return ids;
    }
    if (ids === 시간초과) logger.info(`[forspay] 주문서 결제수단 확인이 ${기다림한도}ms 넘게 걸려 저장값으로 대신 — brand_id=${brandId}`);
    try {
        const old = redisClient?.isOpen ? await redisClient.get(키(brandId)) : null;
        return old ? 맞춤(JSON.parse(old)) : null; // 저장값도 없으면 null → 거르지 않고 전부 보여준다
    } catch (e) {
        return null;
    }
};

// ── 결제모듈 행 → 손님에게 보일 결제수단 목록 ─────────────────────────────────────
// 몰 설정 응답(shop.controller setting)과 주문서용 API(paymentMethods)가 같은 규칙을 쓴다.
// 순서는 FORSPAY_METHODS 배열 순서다(포스페이는 순서를 주지 않는다).
export const 결제수단목록 = (rows = [], allowedIds = null) => (rows || []).flatMap((item) => {
    if (item?.trx_type != 41) {
        // ⚠ 여기서 pay_key·mid·tid 가 비로그인 방문자에게도 그대로 내려간다
        //   (localStorage.themeDnsData 에도 저장된다).
        //   한 번 제거해 봤으나 프론트가 이 값을 결제 요청에 되실어 보내는 구조라
        //   포스페이 외 결제수단(무통장입금·수기결제 등)이 죽는다 — 되돌렸다.
        //   올바른 순서는 pay.controller 가 페이레터·포스페이에서 하듯
        //   brand_id + trx_method 로 DB 에서 자격증명을 읽는 경로를 먼저 만들고,
        //   그 다음 응답에서 제거하는 것이다.
        //   ShopGo 산하는 결제모듈이 포스페이(41)뿐이라(DB 확인) 실노출이 없다.
        return [{ ...item, ...getPayType(item?.trx_type) }];
    }
    // 수단별 노출 설정(enabled) 파싱. 설정 없으면 pending(삼성페이) 제외 전부 노출.
    let methodsCfg = {};
    try {
        const cfg = item?.forspay_config ? JSON.parse(item.forspay_config) : {};
        methodsCfg = cfg?.methods || {};
    } catch (e) { methodsCfg = {}; }
    const base = getPayType(item?.trx_type); // type: 'auth_forspay'
    // 비밀값(App key 등)은 프론트로 내보내지 않는다 — 화이트리스트 필드만 구성
    return FORSPAY_METHODS
        .filter((m) => {
            // 포스페이(계정)가 지금 결제할 수 없는 대분류·세부 수단은 무조건 숨김 (조회 성공 시).
            // 세부 수단: 간편결제는 route, 해외결제는 foreign_method 가 sub_methods.available 에 있어야 한다.
            if (!결제가능(allowedIds, m)) return false;
            const mc = methodsCfg[m.key];
            if (mc && typeof mc.enabled !== 'undefined') return !!mc.enabled;
            return !m.pending;
        })
        .map((m) => ({
            id: item?.id,
            trx_type: item?.trx_type,
            is_old_auth: item?.is_old_auth,
            sort_idx: item?.sort_idx,
            ...base,
            title: m.label,                                   // 접두어 없이 수단명만
            description: m.desc || '포스페이로 결제합니다.',   // 수단별 안내 문구
            pay_method: m.key,
        }));
});
