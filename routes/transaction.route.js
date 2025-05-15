import express from 'express';
import validate from 'express-validation';
import { transactionCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(transactionCtrl.list)
    .post(transactionCtrl.create);
router
    .route('/noti/') //클플에서 /noti로 보낼 시 자동으로 뒤에 /를 붙이면서 308 redirect가 발생해 nginx에 도달하기 전에 차단됨
    .get(transactionCtrl.noti)
    .post(transactionCtrl.noti);
router
    .route('/:id')
    .get(transactionCtrl.get)
    .put(transactionCtrl.update)
    .delete(transactionCtrl.remove)
router
    .route('/:id/invoice')
    .post(transactionCtrl.changeInvoice)
router
    .route('/:id/cancel-request')
    .post(transactionCtrl.cancelRequest)

export default router;
