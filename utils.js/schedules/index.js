import schedule from "node-schedule";
import { returnMoment } from "../function.js";
import { langProcess } from "./lang-process.js";
import { getArfighterItems } from '../corps/arfighter.js'
import { cleanupAbandonedPending } from "./cleanup-abandoned.js";

// 대표 인스턴스에서만 실행(멀티인스턴스 중복 방지). env 미설정(단일 인스턴스)이면 실행.
//
// ⚠ 예전 판정은 `iid === parseInt(process.env.instances) - 1` 이었다.
//    pm2.config.cjs 는 `instances: 0`(=CPU 수만큼 자동 생성)인데, pm2 는 **그 리터럴 0 을 그대로**
//    env 에 넣는다(실제로 뜬 개수가 아니다). 운영 서버 실측: INSTANCE_ID=0,1 / instances=0.
//    그래서 조건이 `iid === -1` 이 되어 **어떤 인스턴스도 리더가 아니었다.**
//    결과적으로 이 파일의 모든 정기작업이 한 번도 실행되지 않았다 —
//      · 번역 대기열 소비(langProcess) → 카테고리·상품 번역본이 영영 안 생겼다
//      · 버려진 결제대기 정리(cleanupAbandonedPending) → 미승인 pending 이 계속 쌓였다
//    총 개수를 몰라도 항상 존재하는 0번을 리더로 삼는다.
const isLeaderInstance = () => {
  const raw = process.env.INSTANCE_ID ?? process.env.NODE_APP_INSTANCE;
  const iid = parseInt(raw);
  return !Number.isFinite(iid) || iid === 0;
};

const scheduleIndex = () => {
  schedule.scheduleJob("0 0/1 * * * *", async function () {
    // 가드를 공용 헬퍼로 통일한다. 예전엔 이 줄에 같은 계산식이 직접 박혀 있어
    // isLeaderInstance 를 고쳐도 여기만 남는다(같은 이유로 이 작업도 안 돌았다).
    if (!isLeaderInstance()) return;
    let return_moment = returnMoment();
    // 번역 대기열 소비는 아래 별도 작업으로 옮겼다.
    if (return_moment.includes('00:00:')) {
      //getArfighterItems();
    }
  });

  // 다국어 번역 대기열 소비 — 1분마다.
  // 한 틱에 처리할 건수와 번역 요청 수는 langProcess 내부에서 제한한다.
  // (무료 gtx 엔드포인트라 한꺼번에 몰아치면 차단될 수 있다)
  schedule.scheduleJob("0 0/1 * * * *", async function () {
    if (!isLeaderInstance()) return;
    await langProcess();
  });

  // 버려진 포스페이/페이레터 결제대기(승인 안 됨) + 자식 라인 자동 정리 — 30분마다
  schedule.scheduleJob("0 0/30 * * * *", async function () {
    if (!isLeaderInstance()) return;
    await cleanupAbandonedPending({ olderThanMinutes: 60, batch: 2000 });
  });
};

export default scheduleIndex;
