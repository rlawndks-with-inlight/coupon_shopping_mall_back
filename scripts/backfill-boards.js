'use strict';
// 1회성: 마스터 하위 가맹점(forsmall 등) 중 기본 게시판(공지사항 / 1:1문의)이 없는 곳에 일괄 시드.
// 멱등(이미 있으면 건너뜀)하므로 여러 번 실행해도 안전.
// 실행: 백엔드 루트에서  node scripts/backfill-boards.js
import 'dotenv/config';
import { backfillDefaultBoards } from '../controllers/merchant_application.controller.js';

const run = async () => {
    try {
        const n = await backfillDefaultBoards();
        console.log(`기본 게시판 일괄 시드 완료: 하위 가맹점 ${n}곳 확인/처리`);
        process.exit(0);
    } catch (e) {
        console.error('일괄 시드 실패:', e?.message || e);
        process.exit(1);
    }
};
run();
