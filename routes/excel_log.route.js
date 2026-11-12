import express from 'express';
import { excelLogCtrl } from '../controllers/index.js';

// 엑셀 내려받기 기록 — 남기기는 관리자 누구나, 보기는 최상위 관리자만(excel_log.controller).
const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(excelLogCtrl.list)
    .post(excelLogCtrl.create);

export default router;
