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
router
    .route('/:trx_type')
    .post(payCtrl.ready);
router
    .route('/virtual-acct/noti')
    .post(payCtrl.virtualAcctNoti);

export default router;
