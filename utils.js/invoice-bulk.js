// 송장 엑셀 일괄 등록의 판정 규칙(2026-11-12 가맹점 요청 「엑셀에도 송장번호를 입력할 수 있게」).
// DB 를 부르지 않는다 — 검사(front scripts/checks/invoice-bulk.mjs)가 이 파일을 node 로 직접 불러 돌린다.
//
// 흐름: 관리자가 내려받은 주문 엑셀의 「송장번호」 칸에 번호를 적어 올린다 → 주문번호로 주문을 찾는다
//       → 미리 확인(무엇이 등록·변경·건너뜀인지) → 확정하면 저장, 주문마다 이력(kind=invoice)에 「(엑셀)」로 남긴다.
// 저장 모양은 한 건씩 저장하는 화면과 같다: `택배사-송장번호`(택배사를 모르면 번호만).

// 택배사 이름 — front src/data/couriers.js 의 COURIER_LIST 와 같아야 한다(검사가 비교한다).
export const 택배사목록 = [
    'CJ대한통운', '우체국택배', '한진택배', '롯데택배', '로젠택배',
    '경동택배', 'GS Postbox', 'CU 편의점택배', '대신택배', '일양로지스', '기타',
];

export const 최대줄 = 1000;

// 한 칸의 값을 저장할 모양으로. { 값 } 또는 { 오류 } 또는 { 빈칸: true }
//   · 「CJ대한통운-123456」처럼 알려진 택배사가 앞에 붙어 있으면 그대로(내려받은 엑셀에 이미 이 모양으로 나간다)
//   · 번호만 있으면 「택배사」 칸 값 → 없으면 몰의 기본 택배사 → 그것도 없으면 번호만
export const 송장정리 = ({ invoice, courier } = {}, 기본택배사 = '') => {
    const 원문 = String(invoice ?? '').trim();
    if (!원문) return { 빈칸: true };
    // 엑셀이 긴 숫자를 지수로 바꾼 값(6.40012E+11) — 뒷자리가 이미 사라졌다. 저장하면 틀린 송장이 손님에게 간다.
    if (/^[\d.]+e\+\d+$/i.test(원문)) return { 오류: '엑셀이 번호를 6.4E+11 처럼 바꿨습니다. 칸 서식을 「텍스트」로 바꾸고 다시 적어 주세요.' };
    if (원문.includes(',')) return { 오류: '한 칸에 송장번호를 하나만 적어 주세요.' };
    let 택배사 = '';
    let 번호 = 원문;
    const 줄표 = 원문.indexOf('-');
    const 앞 = 줄표 > 0 ? 원문.slice(0, 줄표).trim() : '';
    if (앞 && 택배사목록.includes(앞)) {
        택배사 = 앞;
        번호 = 원문.slice(줄표 + 1).trim();
    } else {
        const 칸 = String(courier ?? '').trim();
        if (칸) {
            if (!택배사목록.includes(칸)) return { 오류: `택배사 이름을 알 수 없습니다(${칸.slice(0, 20)}). 목록에 있는 이름으로 적어 주세요.` };
            택배사 = 칸;
        } else {
            택배사 = 택배사목록.includes(기본택배사) ? 기본택배사 : '';
        }
    }
    번호 = 번호.replace(/\s+/g, '');
    // 한글이 남아 있으면 모르는 택배사 이름이 붙은 것이다(「CJ택배-123」 같은)
    if (/[가-힣]/.test(번호)) return { 오류: '택배사 이름을 알 수 없습니다. 「CJ대한통운-123456」처럼 목록에 있는 이름으로 적어 주세요.' };
    if (!/^[0-9A-Za-z-]{6,30}$/.test(번호)) return { 오류: '송장번호 형식을 확인해 주세요(숫자 6~30자리).' };
    return { 값: 택배사 ? `${택배사}-${번호}` : 번호 };
};

// 주문 한 건에 넣어도 되는가 — 한 건씩 저장하는 화면이 입력칸을 감추는 조건 + 취소요청(한 건씩 확인) + 결제 전
export const 주문판정 = (주문) => {
    if (!주문) return '이 몰의 주문번호가 아닙니다.';
    if (Number(주문.is_cancel_trans) === 1) return '취소된 주문입니다.';
    if (Number(주문.trx_status) === 1) return '취소요청 중인 주문입니다. 한 건씩 확인해 주세요.';
    if (!(Number(주문.trx_status) >= 5)) return '결제가 끝나지 않은 주문입니다.';
    return null;
};

// 올린 줄 전체를 판정한다. 주문목록 = Map(ord_num → { id, invoice_num, trx_status, is_cancel_trans })
// 돌려주는 줄: { 줄, ord_num, 결과: '등록'|'변경'|'같음'|'오류', 사유?, 이전?, 새값?, id? } — 송장 칸이 빈 줄은 세기만 한다.
export const 일괄판정 = (rows, 주문목록, 기본택배사 = '') => {
    const 결과 = [];
    let 빈칸 = 0;
    const 본것 = new Map(); // ord_num → 처음 본 값
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i] ?? {};
        const 줄 = Number(r.row) || i + 2;
        const ord_num = String(r.ord_num ?? '').trim();
        const 정리 = 송장정리(r, 기본택배사);
        if (정리.빈칸) { 빈칸++; continue; }
        if (!ord_num) { 결과.push({ 줄, ord_num, 결과: '오류', 사유: '주문번호 칸이 비어 있습니다.' }); continue; }
        if (정리.오류) { 결과.push({ 줄, ord_num, 결과: '오류', 사유: 정리.오류 }); continue; }
        if (본것.has(ord_num)) {
            결과.push({ 줄, ord_num, 결과: '오류', 사유: 본것.get(ord_num) === 정리.값 ? '같은 주문번호 줄이 위에 또 있습니다(건너뜀).' : '같은 주문번호에 다른 송장이 두 번 적혀 있습니다. 하나만 남겨 주세요.' });
            continue;
        }
        본것.set(ord_num, 정리.값);
        const 주문 = 주문목록.get(ord_num);
        // 내려받은 엑셀을 고치지 않고 다시 올린 줄(이미 있던 송장 그대로)은 상태와 상관없이 「같음」 — 저장할 게 없다.
        //   취소된 주문에 예전 송장이 남아 있는 줄이 오류로 쏟아지지 않게 상태 검사보다 먼저 본다.
        const 이전 = String(주문?.invoice_num ?? '').trim();
        if (주문 && 이전 === 정리.값) { 결과.push({ 줄, ord_num, 결과: '같음', 이전, 새값: 정리.값, id: 주문.id }); continue; }
        const 막힘 = 주문판정(주문);
        if (막힘) { 결과.push({ 줄, ord_num, 결과: '오류', 사유: 막힘 }); continue; }
        결과.push({ 줄, ord_num, 결과: 이전 ? '변경' : '등록', 이전, 새값: 정리.값, id: 주문.id });
    }
    // 같은 주문번호가 두 번 나왔는데 값이 달랐으면 먼저 나온 줄도 저장하지 않는다(어느 쪽이 맞는지 모른다)
    const 충돌 = new Set(결과.filter((x) => x.사유?.startsWith('같은 주문번호에 다른 송장')).map((x) => x.ord_num));
    for (const x of 결과) {
        if (충돌.has(x.ord_num) && x.결과 !== '오류') { x.결과 = '오류'; x.사유 = '같은 주문번호에 다른 송장이 두 번 적혀 있습니다. 하나만 남겨 주세요.'; delete x.id; }
    }
    const 셈 = (k) => 결과.filter((x) => x.결과 === k).length;
    return { 결과, 요약: { 등록: 셈('등록'), 변경: 셈('변경'), 같음: 셈('같음'), 오류: 셈('오류'), 빈칸 } };
};
