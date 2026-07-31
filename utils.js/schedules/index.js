import schedule from "node-schedule";
import { returnMoment } from "../function.js";
import { langProcess } from "./lang-process.js";
import { getArfighterItems } from '../corps/arfighter.js'
import { cleanupAbandonedPending } from "./cleanup-abandoned.js";

// 대표 인스턴스에서만 실행(멀티인스턴스 중복 방지). env 미설정(단일 인스턴스)이면 실행.
const isLeaderInstance = () => {
  const iid = parseInt(process.env.INSTANCE_ID);
  const total = parseInt(process.env.instances);
  return Number.isNaN(iid) || Number.isNaN(total) || iid === total - 1;
};

const scheduleIndex = () => {
  schedule.scheduleJob("0 0/1 * * * *", async function () {
    if (parseInt(process.env.INSTANCE_ID) != parseInt(process.env.instances) - 1) {
      return;
    }
    let return_moment = returnMoment();
    //langProcess();
    if (return_moment.includes('00:00:')) {
      //getArfighterItems();
    }
  });

  // 버려진 포스페이/페이레터 결제대기(승인 안 됨) + 자식 라인 자동 정리 — 30분마다
  schedule.scheduleJob("0 0/30 * * * *", async function () {
    if (!isLeaderInstance()) return;
    await cleanupAbandonedPending({ olderThanMinutes: 60, batch: 2000 });
  });
};

export default scheduleIndex;
