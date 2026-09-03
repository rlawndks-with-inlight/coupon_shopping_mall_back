// 포스페이 상위(PG/포스페이) 취소 대사(reconcile).
//
//   node scripts/forspay-reconcile.mjs      (또는 npm run forspay-reconcile)
//   보통은 서버 크론이 3시간마다 돌린다.
//
// 왜 필요한가:
//   우리가 취소를 안 눌렀는데 상위에서 취소된 거래(예: 테스트키 자동취소)를 우리는
//   지금 감지하지 못한다. 원래는 noti_url 웹훅(forspayCallback)이 is_cancel=1 을 받아
//   markCanceled 로 반영해야 하는데, 세션 생성 시 noti_url 을 넘긴 적이 없어 웹훅이
//   한 번도 안 왔다(로그 'webhook body keys' 0건). 그래서 고객 브라우저 return 없이
//   상위 자동취소가 나면 우리 DB 엔 결제완료로 남아 실제와 어긋난다.
//   이 배치가 그 사각지대를 메운다. 웹훅을 붙인 뒤에도 '유실 대비 안전망'으로 계속 유효.
//
// 부하(설계상 무시 수준):
//   대상 = trx_method=41 AND trx_status=5 AND is_cancel_trans=0 AND 최근 N일. 십수 건.
//   순차 처리 + 건당 텀 + 건당 타임아웃 + 상한(LIMIT). 하루 몇 번. DB·포스페이 모두 부담 없음.
//
// 안전:
//   - 포스페이가 '명시적으로 cancelled' 라고 할 때만 markCanceled 한다(fail-closed).
//     조회 실패·모호하면 건드리지 않고 넘긴다. 다음 회차에 자연 재시도.
//   - markCanceled 는 PG 를 다시 부르지 않는다(이중환불 없음). 재고·포인트·원장 모두 멱등.
//     즉 웹훅 경로와 완전히 같은 처리다.
//   - 조회 한 건이 실패해도 배치를 멈추지 않는다.
//
// ⚠ 쓰기: markCanceled 만(이미 상위에서 끝난 취소를 우리 장부에 반영). .env 의 DB 를
//    그대로 본다 — 운영 DB 를 향할 수 있다.

import { readPool } from '../config/db-pool.js';
import { markCanceled } from '../utils.js/cancel.js';
import { getCancelRecords as forspayGetCancelRecords } from '../utils.js/payments/forspay.js';

const 최근일수   = parseInt(process.env.FORSPAY_RECONCILE_DAYS  ?? '21')  || 21;
const 최대건수   = parseInt(process.env.FORSPAY_RECONCILE_LIMIT ?? '300') || 300;
const 건당텀ms     = parseInt(process.env.FORSPAY_RECONCILE_GAP_MS ?? '250') || 250;
const 건당타임아웃ms = 8000;

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[forspay-reconcile ${now()}]`, ...a);

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

// trx_status: 5=결제완료, 1=취소요청(고객이 요청했으나 우리 실행 전/실패). 둘 다 대상 —
//   전자는 '조용히 상위 취소된 결제완료 건', 후자는 '취소요청인데 상위가 이미 취소해 완결이 필요한 건'.
//   어느 경우든 포스페이가 명시적으로 cancelled 라 할 때만 반영한다(아래 fail-closed).
const [candidates] = await readPool.query(
    `SELECT id, ord_num, brand_id, amount FROM transactions
      WHERE trx_method=41 AND trx_status IN (1, 5) AND (is_cancel_trans=0 OR is_cancel_trans IS NULL)
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY id DESC
      LIMIT ?`,
    [최근일수, 최대건수]
);

log(`대상 ${candidates.length}건 (최근 ${최근일수}일, 상한 ${최대건수})`);

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
            ({ cancelledTotal } = await forspayGetCancelRecords({ app_key, ord_num: t.ord_num, timeout: 건당타임아웃ms }));
        } catch (e) {
            // 조회 실패는 '취소'가 아니다. 절대 취소로 처리하지 않는다(fail-closed). 다음 회차 재시도.
            스킵++;
            log(`skip id=${t.id} ord=${t.ord_num} (조회실패: ${e?.response?.status || e?.code || e?.message})`);
            await sleep(건당텀ms);
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
    await sleep(건당텀ms);
}

log(`완료 — 확인 ${확인} / 취소반영 ${취소반영} / 스킵 ${스킵}`);
process.exit(0);
