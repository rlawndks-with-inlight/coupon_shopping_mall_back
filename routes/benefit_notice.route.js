import express from 'express';
import { benefitNoticeCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

// 상품상세 '혜택 안내' — 본사 관리자 전용(레벨50).
// 고객 화면은 이 경로를 쓰지 않는다. shop.controller 의 setting 묶음으로 함께 내려간다.
router
    .route('/')
    .get(benefitNoticeCtrl.list)
    .post(benefitNoticeCtrl.create);
router
    .route('/:id')
    .get(benefitNoticeCtrl.get)
    .put(benefitNoticeCtrl.update)
    .delete(benefitNoticeCtrl.remove)

export default router;
