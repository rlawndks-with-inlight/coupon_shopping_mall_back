import express from 'express';
import { productReviewCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

// ⚠ 고정 경로(summary·writable·manage)는 '/:id' 보다 앞에 둔다 — 뒤에 두면 :id 가 먹어 버린다.
router
    .route('/')
    .get(productReviewCtrl.list)
    .post(productReviewCtrl.create);
router.route('/summary').get(productReviewCtrl.summary);     // 평균·별점 분포·사진
router.route('/writable').get(productReviewCtrl.writable);   // 내 주문 줄별 작성 가능 여부
router.route('/manage').get(productReviewCtrl.manage);       // 관리자 목록(전 상품)
router.route('/:id/reply').put(productReviewCtrl.reply);     // 판매자 답글
router.route('/:id/hide').put(productReviewCtrl.hide);       // 숨김/해제
router.route('/:id/best').put(productReviewCtrl.best);       // BEST 지정/해제
router.route('/:id/helpful').put(productReviewCtrl.helpful); // 도움돼요 누르기/취소(회원)
router
    .route('/:id')
    .get(productReviewCtrl.get)
    .put(productReviewCtrl.update)
    .delete(productReviewCtrl.remove)

export default router;
