'use strict';
import { writePool } from "../../config/db-pool.js";
import logger from "../winston/index.js";
import { restoreStock } from "../product-options.js";
import { logTrx } from "../trx-log.js";

// 버려진 포스페이/페이레터 결제대기(승인 안 된 채 방치) 거래를 「결제실패/미완료」(trx_status -1)로 정리한다.
//
// [2026-09-14 까지는 지웠다] 부모·자식 행을 통째로 DELETE 했다. 그래서 가맹점이 "결제실패 내역을 따로 보여 달라"
// (요청서 2026-09-11 ①) 해도 보여줄 것이 없었다 — 한 시간 뒤면 흔적이 사라졌고, 그 전에는 결제대기와 섞여 있었다.
// 이제는 지우지 않고 표시만 바꾼다. 관리자 목록의 「결제실패/미완료」 탭(kind=failed)이 이 건들을 보여 준다.
//   · 손님 화면은 trx_status>=0 만 보므로(transaction.controller list) 여전히 안 보인다.
//   · 매출·정산은 trx_status>=5 만 세므로 섞이지 않는다.
//   · 뒤늦게 PG 승인 통지가 오면 확정 쿼리(`WHERE trx_status<>5`)가 -1 도 5 로 올린다 —
//     예전엔 행이 없어 돈만 빠지고 주문이 사라졌으니 이쪽이 낫다. (그때 재고는 이미 돌려놨으므로 다시 차감되진 않는다.)
//
// 안전범위(이 조건 전부 만족해야 정리):
//   - trx_method IN (40,41)  : 페이레터·포스페이(결제창 리다이렉트형)만. 무통장(10)·상품권(11) 등은 제외.
//   - trx_status = 0          : 결제대기(승인/완료 안 됨). 결제완료(5) 등은 절대 안 건드림.
//   - is_cancel=0, is_cancel_trans=0
//   - created_at < N분 전      : 진행 중(최근) 결제는 보호.
export const cleanupAbandonedPending = async ({ olderThanMinutes = 60, batch = 2000, maxBatches = 20 } = {}) => {
  try {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const [rows] = await writePool.query(
        `SELECT id, brand_id FROM transactions
         WHERE trx_method IN (40,41) AND trx_status = 0
           AND is_cancel = 0 AND is_cancel_trans = 0
           AND created_at < (NOW() - INTERVAL ? MINUTE)
         LIMIT ?`,
        [olderThanMinutes, batch]
      );
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) break;

      // ⚠ 표시를 바꾸기 **전에** 재고를 놓아준다.
      //
      // 재고는 주문을 만들 때 미리 잡는다(결제창을 띄운 사이 남이 사가지 못하게).
      // 손님이 결제창을 닫고 사라지면 잡아둔 재고를 안 돌려놓으면 **팔지도 못한 채 영영 잠긴다**.
      // 원장(product_stock_moves)을 먼저 지우면 무엇을 되돌릴지 알 수 없으므로 순서가 중요하다.
      // 실패해도 정리는 계속한다 — 재고는 사람이 고칠 수 있지만 쌓인 결제대기는 그렇지 않다.
      for (const id of ids) {
        try { await restoreStock(id); } catch (e) {
          logger.error(`[cleanup] 재고 복구 실패 trans_id=${id}: ${e?.sqlMessage || e?.message || e}`);
        }
      }
      // 되돌린 원장은 지운다 — 남겨 두면 나중에 취소 부수처리가 같은 재고를 한 번 더 되돌린다.
      await writePool.query(`DELETE FROM product_stock_moves WHERE trans_id IN (?)`, [ids]);

      // 결제대기(0) 인 행만 -1 로. 그 사이 승인된 건(5)은 건드리지 않는다.
      const [res] = await writePool.query(
        `UPDATE transactions SET trx_status = -1 WHERE id IN (?) AND trx_status = 0`, [ids]);
      total += res?.affectedRows ?? 0;
      for (const r of rows) {
        await logTrx({ trans_id: r.id, brand_id: r.brand_id, kind: 'failed', from_status: 0, to_status: -1,
          actor: { type: 'system' }, note: `결제창만 열고 ${olderThanMinutes}분 넘게 승인이 없어 결제실패/미완료로 정리` });
      }
      if (ids.length < batch) break;
    }
    if (total) {
      logger.info(`[cleanup] 버려진 결제대기 → 결제실패/미완료: ${total}건`);
    }
    return { transactions: total };
  } catch (e) {
    logger.error(`[cleanup] 실패: ${e?.message || e}`);
    return null;
  }
};

export default cleanupAbandonedPending;
