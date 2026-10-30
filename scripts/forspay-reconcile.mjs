// 포스페이 상위(PG/포스페이) 취소 대사(reconcile).
//
//   node scripts/forspay-reconcile.mjs          (또는 npm run forspay-reconcile)
//   node scripts/forspay-reconcile.mjs --all    오래된 결제 건(8~21일)까지 지금 바로 확인
//   보통은 서버 크론이 3시간마다 돌린다.
//
// 왜 필요한가:
//   우리가 취소를 안 눌렀는데 상위에서 취소된 거래(포스페이 관리 화면에서 직접 취소, 테스트키 자동취소 등)를
//   우리는 웹훅(noti_url)으로만 알 수 있다. 그런데 noti_url 이 등록되지 않아 웹훅이 한 번도 안 왔다.
//   그래서 상위에서 취소돼도 우리 DB 엔 결제완료로 남는다(2026-10-30 실제 6건 — 다음 회차에 맞춰졌다).
//   이 배치가 그 사각지대를 메운다. 웹훅을 붙인 뒤에도 '유실 대비 안전망'으로 계속 유효.
//
// ── 부하: 포스페이 조회 한도(App key 당 분당 60회) ────────────────────────────────
//   예전엔 0.25초 간격으로 연달아 불러 한 회차에 100회 넘게 몰렸다. 한도를 넘긴 조회는 포스페이가
//   429 가 아니라 500 으로 돌려줘(2026-10-30 확인: 같은 주문을 2초 간격으로 물으면 정상) 매 회차 3~12건을
//   건너뛰었고, 그 1~2분 동안은 같은 키를 쓰는 손님 흐름(결과 화면 확인·주문서 결제수단 확인)도 한도에 걸렸다.
//   그리고 결제 건이 늘수록 21일치를 매번 다시 보는 구조라 회차마다 조회가 불어난다.
//   그래서:
//     · 조회와 조회 사이를 최소 2초(분당 30회) — 키 한도의 절반만 쓰고 나머지는 손님 몫으로 남긴다
//     · 500·429 를 받으면 1분 쉬고 그 건만 한 번 더. 그래도 안 되면 건너뛴다(다음 회차 재시도)
//     · 취소 확인: 최근 7일 결제 건은 매 회차, 8~21일 건은 하루 한 번(09:05 KST 회차)만
//     · 승인 복구: 결제창 세션이 24시간이면 만료되므로 최근 2일만 본다(예전 3일)
//     · 회차가 길어져 다음 크론과 겹치면 뒤의 것은 그냥 끝낸다(잠금 파일)
//
// 안전:
//   - 포스페이가 '명시적으로 cancelled' 라고 할 때만 markCanceled 한다(fail-closed).
//     조회 실패·모호하면 건드리지 않고 넘긴다. 다음 회차에 자연 재시도.
//   - markCanceled 는 PG 를 다시 부르지 않는다(이중환불 없음). 재고·포인트·원장 모두 멱등.
//     즉 웹훅 경로와 완전히 같은 처리다.
//   - 조회 한 건이 실패해도 배치를 멈추지 않는다.
//
// ⚠ 쓰기: markCanceled · settleForspayTransaction 만(이미 상위에서 끝난 취소·승인을 우리 장부에 반영).
//    .env 의 DB 를 그대로 본다 — 운영 DB 를 향할 수 있다.

import { readPool } from '../config/db-pool.js';
import { markCanceled } from '../utils.js/cancel.js';
import { getCancelRecords as forspayGetCancelRecords, getTransaction as forspayGetTransaction } from '../utils.js/payments/forspay.js';
import { settleForspayTransaction } from '../controllers/pay.controller.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const 최근일수   = parseInt(process.env.FORSPAY_RECONCILE_DAYS  ?? '21')  || 21;  // 취소 확인을 하는 가장 오래된 결제
const 매번일수   = parseInt(process.env.FORSPAY_RECONCILE_RECENT_DAYS ?? '7') || 7; // 이보다 최근 결제는 매 회차
const 최대건수   = parseInt(process.env.FORSPAY_RECONCILE_LIMIT ?? '300') || 300;
const 호출간격ms   = parseInt(process.env.FORSPAY_RECONCILE_CALL_GAP_MS ?? '2000') || 2000;
const 한도쉼ms     = 60_000;
const 건당타임아웃ms = 8000;
const 하루한번UTC시 = 0; // 크론 '5 */3 * * *' 중 00:05 UTC(= 09:05 KST) 회차
const 오래된것도 = process.argv.includes('--all') || new Date().getUTCHours() === 하루한번UTC시;

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[forspay-reconcile ${now()}]`, ...a);

// ── 겹침 방지 ───────────────────────────────────────────────────────────────
const 잠금 = join(tmpdir(), 'forspay-reconcile.lock');
if (existsSync(잠금)) {
    const pid = Number(readFileSync(잠금, 'utf8')) || 0;
    let 살아있음 = false;
    try { if (pid) { process.kill(pid, 0); 살아있음 = true; } } catch (e) { 살아있음 = false; }
    if (살아있음) { log(`앞 회차(pid ${pid})가 아직 도는 중 — 이번 회차는 건너뜀`); process.exit(0); }
}
writeFileSync(잠금, String(process.pid));
const 끝 = (code = 0) => { try { unlinkSync(잠금); } catch (e) { /* 이미 없음 */ } process.exit(code); };

// ── 포스페이 조회 속도 조절 ──────────────────────────────────────────────────
// 모든 조회(취소 레코드의 회차별 조회 포함)가 이 문을 지난다 — 직전 조회에서 호출간격ms 가 지나야 나간다.
let 마지막호출 = 0, 호출수 = 0;
const 천천히 = async () => {
    const 남음 = 마지막호출 + 호출간격ms - Date.now();
    if (남음 > 0) await sleep(남음);
    마지막호출 = Date.now();
    호출수++;
};
// 한도 초과(포스페이는 500, 문서상 429)면 1분 쉬고 한 번만 더. 409(거래 없음) 같은 정상 응답은 그대로 던진다.
const 한도걸림 = (e) => [429, 500, 502, 503].includes(Number(e?.response?.status));
const 조회 = async (fn) => {
    try { return await fn(); }
    catch (e) {
        if (!한도걸림(e)) throw e;
        log(`포스페이 ${e?.response?.status} — 1분 쉬고 다시 시도`);
        await sleep(한도쉼ms);
        return await fn();
    }
};

// 브랜드별 app_key 캐시(payment_modules trx_type=41 의 pay_key). 같은 브랜드는 한 번만 조회.
const keyCache = new Map();
async function getAppKey(brand_id) {
    if (keyCache.has(brand_id)) return keyCache.get(brand_id);
    const [rows] = await readPool.query(
        `SELECT pay_key FROM payment_modules WHERE brand_id=? AND trx_type=41 ORDER BY id DESC LIMIT 1`,
        [brand_id]
    );
    const key = rows?.[0]?.pay_key || null;
    keyCache.set(brand_id, key);
    return key;
}

const 시작 = Date.now();

// ── 1부: 상위 취소 반영 ──────────────────────────────────────────────────────
// trx_status: 5=결제완료, 1=취소요청(고객이 요청했으나 우리 실행 전/실패). 둘 다 대상 —
//   전자는 '조용히 상위 취소된 결제완료 건', 후자는 '취소요청인데 상위가 이미 취소해 완결이 필요한 건'.
//   어느 경우든 포스페이가 명시적으로 cancelled 라 할 때만 반영한다(아래 fail-closed).
const 이번일수 = 오래된것도 ? 최근일수 : Math.min(매번일수, 최근일수);
const [candidates] = await readPool.query(
    `SELECT id, ord_num, brand_id, amount FROM transactions
      WHERE trx_method=41 AND trx_status IN (1, 5) AND (is_cancel_trans=0 OR is_cancel_trans IS NULL)
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY id DESC
      LIMIT ?`,
    [이번일수, 최대건수]
);

log(`대상 ${candidates.length}건 (최근 ${이번일수}일${오래된것도 ? ' — 하루 한 번 오래된 결제까지' : ''}, 상한 ${최대건수}, 조회 간격 ${호출간격ms}ms)`);

let 확인 = 0, 취소반영 = 0, 스킵 = 0;

for (const t of candidates) {
    확인++;
    try {
        const app_key = await getAppKey(t.brand_id);
        if (!app_key) {
            스킵++;
            log(`skip id=${t.id} (app_key 없음, brand=${t.brand_id})`);
            continue;
        }

        // 포스페이는 취소를 cxl_seq=1,2,… 별도 레코드로 넣는다(원승인 cxl_seq=0 은 취소돼도 approved 그대로 —
        // 2026-09-03 협력사 답변). 그래서 취소 레코드를 1부터 읽어 합계로 판단한다.
        let cancelledTotal;
        try {
            ({ cancelledTotal } = await 조회(() => forspayGetCancelRecords({ app_key, ord_num: t.ord_num, timeout: 건당타임아웃ms, beforeEach: 천천히 })));
        } catch (e) {
            // 조회 실패는 '취소'가 아니다. 절대 취소로 처리하지 않는다(fail-closed). 다음 회차 재시도.
            스킵++;
            log(`skip id=${t.id} ord=${t.ord_num} (조회실패: ${e?.response?.status || e?.code || e?.message})`);
            continue;
        }

        const orderAmount = Math.abs(Number(t.amount) || 0);
        if (orderAmount > 0 && cancelledTotal >= orderAmount) {
            await markCanceled(t.id); // 웹훅과 동일 경로: 취소표시 + 원장 + 재고/포인트(멱등, PG 재호출 없음)
            취소반영++;
            log(`★ 상위 전액취소 반영 id=${t.id} ord=${t.ord_num} brand=${t.brand_id} amount=${orderAmount} 취소합계=${cancelledTotal}`);
        } else if (cancelledTotal > 0) {
            // 부분취소: 우리가 실행한 것이면 이미 원장에 있다. 상위(OMS)에서 한 것이면 어느 줄인지 알 수 없어 자동 반영하지 않는다.
            log(`△ 부분취소 존재 id=${t.id} ord=${t.ord_num} 취소합계=${cancelledTotal}/${orderAmount} — 자동 반영 안 함(확인 필요)`);
        }
    } catch (e) {
        // 한 건의 예외가 배치 전체를 멈추게 두지 않는다.
        스킵++;
        log(`skip id=${t.id} (예외: ${e?.message})`);
    }
}

log(`완료 — 확인 ${확인} / 취소반영 ${취소반영} / 스킵 ${스킵}`);

// ── 2부: 승인 복구 ──────────────────────────────────────────────────────────
// 포스페이에서는 승인됐는데 우리 장부는 결제대기(0)·미완료(-1)로 남은 주문을 살린다.
// 손님 브라우저가 복귀하지 못하고(창 닫힘·통신 끊김) 웹훅도 안 오면(noti_url 미등록) 아무도 확정하지 않는다 —
// 돈은 나갔는데 가맹점 화면엔 결제대기라 발송도 안 되고, 1시간 반 뒤엔 미완료(-1)로 내려간다.
// (2026-10-19 오픈 전 점검)
//
// 안전:
//   - 확정은 settleForspayTransaction 하나로만 한다 — status=approved + 주문번호 같음 + 금액 같음일 때만,
//     0·-1 인 행만 원자적으로 5 로 바꾼다(웹훅·결과페이지와 같은 규칙). 늦은 승인의 재고는 늦은승인정리가 다시 잡는다.
//   - 조회 실패·없음(409)은 건드리지 않는다. 방금 결제창을 연 주문과 겹치지 않게 15분 지난 것만 본다.
//   - 결제창 세션은 24시간 뒤 만료된다(포스페이 문서) — 그보다 늦은 승인은 없으니 2일이면 넉넉하다.
const 복구일수 = parseInt(process.env.FORSPAY_RECOVER_DAYS ?? '2') || 2;
const [pendings] = await readPool.query(
    `SELECT id, ord_num, brand_id FROM transactions
      WHERE trx_method=41 AND trx_status IN (0, -1)
        AND IFNULL(is_cancel,0)=0 AND IFNULL(is_cancel_trans,0)=0 AND IFNULL(is_delete,0)=0
        AND ord_num IS NOT NULL AND ord_num <> ''
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        AND created_at <= DATE_SUB(NOW(), INTERVAL 15 MINUTE)
      ORDER BY id DESC
      LIMIT ?`,
    [복구일수, 최대건수]
);
log(`승인 복구 대상 ${pendings.length}건 (결제대기·미완료, 최근 ${복구일수}일)`);
let 복구 = 0, 미승인 = 0, 복구스킵 = 0;
for (const t of pendings) {
    try {
        const app_key = await getAppKey(t.brand_id);
        if (!app_key) { 복구스킵++; continue; }
        let txn = null;
        try {
            txn = await 조회(async () => { await 천천히(); return forspayGetTransaction({ app_key, ord_num: t.ord_num, timeout: 건당타임아웃ms }); });
        } catch (e) {
            const st = e?.response?.status;
            if (st === 409 || st === 404) { 미승인++; } else { 복구스킵++; log(`skip(복구) id=${t.id} (조회실패: ${st || e?.code || e?.message})`); }
            continue;
        }
        if (txn?.status === 'approved') {
            const 됨 = await settleForspayTransaction(t.id, txn);
            if (됨) { 복구++; log(`★ 승인 복구 id=${t.id} ord=${t.ord_num} brand=${t.brand_id}`); }
            else log(`△ 승인됐지만 확정 거부(주문번호·금액 불일치 등) id=${t.id} ord=${t.ord_num} — 확인 필요`);
        } else {
            미승인++;
        }
    } catch (e) {
        복구스킵++;
        log(`skip(복구) id=${t.id} (예외: ${e?.message})`);
    }
}
log(`승인 복구 완료 — 복구 ${복구} / 미승인 ${미승인} / 스킵 ${복구스킵}`);
log(`회차 끝 — 포스페이 조회 ${호출수}회, ${Math.round((Date.now() - 시작) / 1000)}초`);
끝(0);
