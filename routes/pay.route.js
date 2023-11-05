import express from 'express';
import validate from 'express-validation';
import { payCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/hand')
    .post(payCtrl.hand.ready);
router
    .route('/auth')
    .post(payCtrl.auth.ready);
router
    .route('/result')
    .post(payCtrl.result);
router
    .route('/cancel')
    .post(payCtrl.cancel);

export default router;
