import express from 'express';
import validate from 'express-validation';
import { paymentModuleCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(paymentModuleCtrl.list)
    .post(paymentModuleCtrl.create);
router
    .route('/:id')
    .get(paymentModuleCtrl.get)
    .put(paymentModuleCtrl.update)
    .delete(paymentModuleCtrl.remove)

export default router;
