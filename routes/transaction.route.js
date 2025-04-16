import express from 'express';
import validate from 'express-validation';
import { transactionCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(transactionCtrl.list)
    .post(transactionCtrl.create);
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
router
    .route('/fintree')
    .post(transactionCtrl.fintree)

export default router;
