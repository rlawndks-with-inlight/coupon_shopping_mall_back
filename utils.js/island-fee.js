// 제주·도서산간 추가배송비 — 판정과 금액(사장님 결정 2026-11-12).
//
// · 몰마다 지역(제주 / 제주 외 도서산간)별로 「추가비 없음(기본) · 추가비 받기(금액) · 배송 안 함」 중 고른다.
//   설정은 brands.setting_obj.island_fee = { jeju: { mode, amount }, island: { mode, amount }, rules: [...] }.
//   설정하지 않은 몰은 둘 다 「추가비 없음」이라 예전과 똑같다.
// · 지역 기준은 SHOPGO 기본 기준표(island-zips.js)에 몰이 직접 고친 규칙(rules)을 먼저 적용한다.
// · 무료배송 주문에도 붙는다. 주문(배송 한 번)당 한 번.
// · 확실하지 않으면 받지 않는다 — 기본표는 두 공개 기준표가 같이 섬으로 본 번호만, 공정위 연륙도서 번호는 뺐다.
//
// DB 를 부르지 않는다. 같은 파일이 화면(src/utils/island-fee.js)에도 있고, 검사(island-fee.mjs)가 둘을 같은 입력으로 돌려 비교한다.
// ⚠ 화면과 서버가 다르게 계산하면 결제가 「결제금액이 변경되었습니다」로 막힌다. 고칠 땐 두 파일을 같이 고친다.
import { 제주범위, 제주섬, 도서산간, 연륙도서 } from './island-zips.js';

export const 추가비상한 = 50000;   // 「넉넉하게」(사장님) — 쿠팡은 8,000원까지. 냉동·대형 상품 몰을 생각해 넉넉히 둔다
// 직접 고친 지역 개수 상한. 몰 정보 저장이 multipart 라 칸 수 제한(multerConfig parts 500)에 걸린다 —
//   우편번호 규칙 하나가 4칸이고, 설정 30칸 + 다른 칸 20칸이면 110개까지 저장되고 120개부터 저장 전체가 실패했다(11/12 실측).
//   다른 설정이 늘어날 여유를 두고 80개로 둔다. 구간(시작~끝)으로 넣으면 80개로 충분하다.
export const 규칙최대 = 80;
export const 지역이름 = { jeju: '제주', island: '제주 외 도서산간' };
export const 방식들 = ['none', 'charge', 'block'];

const 도서산간집합 = new Set(도서산간);
const 제주섬집합 = new Set(제주섬);
const 연륙집합 = new Set(연륙도서);

// 공정위가 연륙도서로 짚은 시·군·구 — 몰이 시·군 단위로 더할 때 경고에 쓴다
export const 연륙도서지역 = ['충남 보령시', '전북 군산시', '전남 신안군', '전남 여수시', '전남 고흥군', '전남 완도군', '전남 목포시', '경남 사천시', '인천 중구', '인천 강화군'];

// 주소 첫 낱말(시·도)을 짧은 이름으로 — 주소 검색은 「전남 신안군…」, 행정명은 「전라남도 신안군…」으로 온다
const 시도약칭 = {
    서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천', 광주광역시: '광주', 대전광역시: '대전',
    울산광역시: '울산', 세종특별자치시: '세종', 경기도: '경기', 강원특별자치도: '강원', 강원도: '강원', 충청북도: '충북',
    충청남도: '충남', 전북특별자치도: '전북', 전라북도: '전북', 전라남도: '전남', 경상북도: '경북', 경상남도: '경남',
    제주특별자치도: '제주', 제주도: '제주',
};
const 시도들 = new Set(Object.values(시도약칭));
export const 주소정리 = (s) => {
    const 낱말 = String(s ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!낱말.length) return '';
    낱말[0] = 시도약칭[낱말[0]] ?? 낱말[0];
    return 낱말.join(' ');
};
export const 우편번호 = (v) => {
    const s = String(v ?? '').trim();
    return /^\d{5}$/.test(s) ? s : '';
};

const 규칙맞음 = (r, zip, addr) => {
    if (r?.type === 'area') {
        const a = 주소정리(addr);
        const t = 주소정리(r.text);
        return !!a && !!t && (a === t || a.startsWith(t + ' '));
    }
    return !!zip && zip >= r?.from && zip <= r?.to;
};

// 해외로 표시됐지만 실제로는 국내 주소인지 — 나라 이름이 한국이거나, 주소가 국내 시·도 이름으로 시작하면 국내.
//   해외배송을 고르고 나라에 「대한민국」, 주소에 「제주특별자치도 …」를 적으면 해외로 판정돼
//   추가비와 「배송 안 함」을 그대로 피할 수 있었다(11/12 점검). 우편번호는 보지 않는다 — 프랑스 63000 같은 해외 번호와 겹친다.
const 한국이름 = /^(대한민국|한국|남한|korea|southkorea|republicofkorea|rok|kr|韓国|韩国|大韓民国|大韩民国|corea|coreadelsur)$/i;
const 국내주소같음 = (addr, country_name) => {
    if (한국이름.test(String(country_name ?? '').replace(/[\s.,()\-]/g, ''))) return true;
    const 첫말 = 주소정리(addr).split(' ')[0] || '';
    return 시도들.has(첫말) || 첫말.startsWith('제주');
};

// 배송지 → 'jeju' | 'island' | 'normal' | 'overseas'
//   ① 해외 주소는 대상 아님(해외로 표시돼도 국내 주소 꼴이면 국내로 본다) ② 몰이 「일반으로 뺀」 규칙
//   ③ 몰이 「도서산간에 더한」 규칙 ④ 기본 기준표
//   제주는 우편번호(63000~63644)와 주소(「제주…」) 중 하나라도 제주면 제주 — 우편번호만 바꿔 추가비를 피하지 못하게.
export const 지역판정 = ({ zonecode, addr, country_code, country_name } = {}, 규칙 = []) => {
    const cc = String(country_code ?? '').trim().toUpperCase();
    if (cc && cc !== 'KR' && !국내주소같음(addr, country_name)) return 'overseas';
    const zip = 우편번호(zonecode);
    const rules = Array.isArray(규칙) ? 규칙 : [];
    if (rules.some((r) => r?.kind === 'remove' && 규칙맞음(r, zip, addr))) return 'normal';
    if (rules.some((r) => r?.kind === 'add' && 규칙맞음(r, zip, addr))) return 'island';
    if (zip && 제주섬집합.has(zip)) return 'island';
    if (zip && 도서산간집합.has(zip)) return 'island';
    if (zip && zip >= 제주범위[0] && zip <= 제주범위[1]) return 'jeju';
    if (주소정리(addr).startsWith('제주')) return 'jeju';
    return 'normal';
};

const 정수 = (v) => {
    const t = String(v ?? '').replace(/,/g, '').trim();
    return /^\d+$/.test(t) ? parseInt(t, 10) : NaN;
};

// 저장된 설정을 계산에 쓸 모양으로(잘못된 값은 「추가비 없음」으로) — 계산은 이 결과만 쓴다
export const 섬설정 = (setting_obj) => {
    const raw = setting_obj?.island_fee ?? {};
    const 지역 = (v) => {
        const mode = 방식들.includes(v?.mode) ? v.mode : 'none';
        const amount = 정수(v?.amount);
        const 금액 = Number.isInteger(amount) ? Math.min(Math.max(amount, 0), 추가비상한) : 0;
        if (mode === 'charge' && !(금액 > 0)) return { mode: 'none', amount: 0 };
        return { mode, amount: mode === 'charge' ? 금액 : 0 };
    };
    const rules = (Array.isArray(raw?.rules) ? raw.rules : []).slice(0, 규칙최대).filter((r) =>
        (r?.kind === 'add' || r?.kind === 'remove')
        && ((r?.type === 'zip' && 우편번호(r?.from) && 우편번호(r?.to) && r.from <= r.to)
            || (r?.type === 'area' && 주소정리(r?.text).split(' ').length >= 2)));
    return { jeju: 지역(raw?.jeju), island: 지역(raw?.island), rules };
};

// 배송지와 몰 설정 → { region, fee, blocked }
export const 추가배송비 = (배송지, setting_obj) => {
    const 설정 = 섬설정(setting_obj);
    const region = 지역판정(배송지, 설정.rules);
    if (region !== 'jeju' && region !== 'island') return { region, fee: 0, blocked: false };
    const c = 설정[region];
    if (c.mode === 'block') return { region, fee: 0, blocked: true };
    return { region, fee: c.mode === 'charge' ? c.amount : 0, blocked: false };
};

// 상품 상세·장바구니 안내 한 줄에 쓸 값 — 설정을 안 한 몰은 빈 배열
export const 섬안내 = (setting_obj) => {
    const 설정 = 섬설정(setting_obj);
    return ['jeju', 'island']
        .filter((k) => 설정[k].mode !== 'none')
        .map((k) => ({ region: k, mode: 설정[k].mode, amount: 설정[k].amount }));
};

// 저장 전 검사(관리자 화면에서 보낸 값). { 값 } 또는 { 오류 }
export const 섬설정검사 = (raw) => {
    if (raw === undefined || raw === null) return { 값: undefined };
    if (typeof raw !== 'object') return { 오류: '제주·도서산간 설정이 올바르지 않습니다.' };
    const 지역 = (v, 이름) => {
        const mode = v?.mode ?? 'none';
        if (!방식들.includes(mode)) return { 오류: `${이름} 설정이 올바르지 않습니다.` };
        if (mode !== 'charge') return { 값: { mode, amount: 0 } };
        const n = 정수(v?.amount);
        if (!Number.isInteger(n) || n <= 0) return { 오류: `${이름} 추가배송비 금액을 넣어 주세요.` };
        if (n > 추가비상한) return { 오류: `${이름} 추가배송비는 ${추가비상한.toLocaleString('ko-KR')}원까지 넣을 수 있습니다.` };
        return { 값: { mode, amount: n } };
    };
    const j = 지역(raw.jeju, '제주'); if (j.오류) return j;
    const i = 지역(raw.island, '제주 외 도서산간'); if (i.오류) return i;
    const rules = Array.isArray(raw.rules) ? raw.rules : [];
    if (rules.length > 규칙최대) return { 오류: `직접 고친 지역은 ${규칙최대}개까지 넣을 수 있습니다.` };
    const 정리 = [];
    for (const r of rules) {
        const kind = r?.kind === 'remove' ? 'remove' : r?.kind === 'add' ? 'add' : null;
        if (!kind) return { 오류: '직접 고친 지역의 구분이 올바르지 않습니다.' };
        if (r?.type === 'area') {
            const text = 주소정리(r?.text).slice(0, 40);
            const 낱말 = text.split(' ');
            if (낱말.length < 2 || !시도들.has(낱말[0])) return { 오류: '지역은 「전남 신안군」처럼 시·도와 시·군·구를 함께 적어 주세요.' };
            정리.push({ kind, type: 'area', text });
        } else {
            const from = 우편번호(r?.from);
            const to = 우편번호(r?.to || r?.from);
            if (!from || !to) return { 오류: '우편번호는 숫자 5자리로 적어 주세요.' };
            if (from > to) return { 오류: '우편번호 구간의 앞 번호가 뒤 번호보다 큽니다.' };
            if (Number(to) - Number(from) > 999) return { 오류: '우편번호 구간은 한 번에 1,000개까지 넣을 수 있습니다.' };
            정리.push({ kind, type: 'zip', from, to });
        }
    }
    return { 값: { jeju: j.값, island: i.값, rules: 정리 } };
};

// 몰이 「도서산간에 더하기」로 넣은 규칙이 공정위 연륙도서와 겹치는지 — 막지 않고 알린다
export const 연륙겹침 = (r) => {
    if (r?.kind !== 'add') return [];
    if (r?.type === 'area') {
        const t = 주소정리(r?.text);
        return 연륙도서지역.filter((a) => a === t || a.startsWith(t + ' ') || t.startsWith(a + ' ') || t === a);
    }
    const from = 우편번호(r?.from), to = 우편번호(r?.to || r?.from);
    if (!from || !to) return [];
    return [...연륙집합].filter((z) => z >= from && z <= to);
};

// 주문의 줄들에 추가비를 얹을 자리 — 첫 본상품 줄(추가상품 줄 말고). 없으면 첫 줄.
export const 추가비줄 = (lines) => {
    const i = (Array.isArray(lines) ? lines : []).findIndex((l) => Number(l?.addon_line) !== 1);
    return i >= 0 ? i : 0;
};
