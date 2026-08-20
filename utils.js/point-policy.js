// 포인트 규칙 — 서버 쪽 사본.
//
// 프론트(src/data/point-policy.js)와 **같은 규칙**이어야 한다. 두 벌인 이유는 하나다:
// 화면 계산은 검증이 아니다. 요청은 화면을 거치지 않고도 들어올 수 있으므로 서버가
// 스스로 다시 판단해야 한다. 대신 두 벌이 어긋나면 '화면에서는 되는데 결제가 막히는'
// 사고가 나므로, 프론트 검사(scripts/checks/point-policy.mjs)가 두 파일을 대조한다.
//
// 설정 값(brands.setting_obj):
//   use_point_min_price 주문금액이 이 값 이상이어야 쓸 수 있다   (0 = 조건 없음)
//   point_use_min       보유 포인트가 이 값 이상이어야 쓸 수 있다 (0 = 조건 없음)
//   max_use_point       한 주문에 쓸 수 있는 최대 포인트
//   point_rate          적립비율(%)
//
// 두 조건(최소 주문금액·최소 보유)은 택일이 아니라 둘 다 건다 — 이유는 프론트 사본 주석 참고.
// (point_policy_type 은 더 이상 읽지 않는다)

const 수 = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};

// setting_obj 는 DB 에서 문자열로 나올 수 있다.
const 설정 = (dns) => {
    let s = dns?.setting_obj ?? {};
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = {}; } }
    return s ?? {};
};

export const 포인트정책 = (dns) => {
    const s = 설정(dns);
    return {
        최소주문금액: Math.max(0, 수(s.use_point_min_price)),
        최소보유: Math.max(0, 수(s.point_use_min)),
        최대사용: Math.max(0, 수(s.max_use_point)),
        적립률: Math.max(0, 수(s.point_rate)),
    };
};

export const 포인트쓰는몰 = (dns) => {
    const p = 포인트정책(dns);
    return p.최대사용 > 0 || p.적립률 > 0;
};

// 이번 주문에서 쓸 수 있는 최대 포인트와, 못 쓸 때의 사유 문구.
export const 포인트사용상한 = ({ dns, 보유 = 0, 주문금액 = 0 }) => {
    const p = 포인트정책(dns);
    const 잔액 = Math.max(0, 수(보유));
    const 금액 = Math.max(0, 수(주문금액));

    if (p.최대사용 <= 0) return { 상한: 0, 사유: '이 쇼핑몰은 포인트를 사용하지 않습니다.' };
    if (잔액 <= 0) return { 상한: 0, 사유: '사용할 포인트가 없습니다.' };
    if (p.최소보유 > 0 && 잔액 < p.최소보유) {
        return { 상한: 0, 사유: `포인트는 ${p.최소보유}P 이상 모였을 때 사용할 수 있습니다.` };
    }
    if (p.최소주문금액 > 0 && 금액 < p.최소주문금액) {
        return { 상한: 0, 사유: `포인트는 ${p.최소주문금액}원 이상 주문할 때 사용할 수 있습니다.` };
    }
    return { 상한: Math.floor(Math.min(잔액, p.최대사용, 금액)), 사유: '' };
};

// 이번 주문으로 쌓일 포인트. 소수점은 버린다 — 원장에 소수가 들어가면 합계가 지저분해진다.
export const 적립예정 = ({ dns, 결제금액 = 0 }) => {
    const p = 포인트정책(dns);
    if (p.적립률 <= 0) return 0;
    return Math.floor(Math.max(0, 수(결제금액)) * (p.적립률 / 100));
};

export default { 포인트정책, 포인트쓰는몰, 포인트사용상한, 적립예정 };
