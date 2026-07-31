'use strict';
import { writePool } from "../../config/db-pool.js";
import logger from "../winston/index.js";

// 버려진 포스페이/페이레터 결제대기(승인 안 된 채 방치) 거래 + 자식(transaction_orders) 자동 정리.
//
// 안전범위(이 조건 전부 만족해야 삭제):
//   - trx_method IN (40,41)  : 페이레터·포스페이(결제창 리다이렉트형)만. 무통장(10)·상품권(11) 등은 제외.
//   - trx_status = 0          : 결제대기(승인/완료 안 됨). 결제완료(5) 등은 절대 안 건드림.
//   - is_cancel=0, is_cancel_trans=0
//   - created_at < N분 전      : 진행 중(최근) 결제는 보호.
//
// 처리: 부모 ID를 배치로 뽑아 → 자식(transaction_orders) 먼저 삭제 → 부모(transactions) 삭제(고아 없음).
//       큰 테이블 락 회피를 위해 배치(LIMIT) + 반복. 한 번 실행에 과도 삭제 방지로 배치 횟수 상한.
export const cleanupAbandonedPending = async ({ olderThanMinutes = 60, batch = 2000, maxBatches = 20 } = {}) => {
  try {
    let totalT = 0, totalO = 0;
    for (let i = 0; i < maxBatches; i++) {
      const [rows] = await writePool.query(
        `SELECT id FROM transactions
         WHERE trx_method IN (40,41) AND trx_status = 0
           AND is_cancel = 0 AND is_cancel_trans = 0
           AND created_at < (NOW() - INTERVAL ? MINUTE)
         LIMIT ?`,
        [olderThanMinutes, batch]
      );
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) break;
      const [childRes] = await writePool.query(`DELETE FROM transaction_orders WHERE trans_id IN (?)`, [ids]);
      const [parentRes] = await writePool.query(`DELETE FROM transactions WHERE id IN (?)`, [ids]);
      totalO += childRes?.affectedRows ?? 0;
      totalT += parentRes?.affectedRows ?? 0;
      if (ids.length < batch) break;
    }
    if (totalT || totalO) {
      logger.info(`[cleanup] 버려진 결제대기 정리: transactions=${totalT}, transaction_orders=${totalO}`);
    }
    return { transactions: totalT, transaction_orders: totalO };
  } catch (e) {
    logger.error(`[cleanup] 실패: ${e?.message || e}`);
    return null;
  }
};

export default cleanupAbandonedPending;
