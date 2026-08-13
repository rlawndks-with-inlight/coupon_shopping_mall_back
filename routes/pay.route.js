import express from 'express';
import validate from 'express-validation';
import { payCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap


router
    .route('/result')
    .post(payCtrl.result);
router
    .route('/cancel')
    .post(payCtrl.cancel);
// 부분취소 — 주문 '줄' 단위. 조회(GET)로 남은 수량을 보고, 실행(POST)으로 취소한다.
// ⚠ '/:trx_type' 보다 먼저 둔다. 뒤에 두면 trx_type='cancel-partial' 로 잡혀 결제 시도가 된다.
router
    .route('/cancel-partial/:id')
    .get(payCtrl.cancelState)
    .post(payCtrl.cancelPartial);
router
    .route('/payletter/callback')
    .post(payCtrl.payletterCallback);
router
    .route('/payletter/return')
    .get(payCtrl.payletterReturn)
    .post(payCtrl.payletterReturn);
router
    .route('/forspay/callback')
    .post(payCtrl.forspayCallback);
router
    .route('/forspay/return')
    .get(payCtrl.forspayReturn)
    .post(payCtrl.forspayReturn);
router
    .route('/:trx_type')
    .post(payCtrl.ready);

export default router;
