import express from 'express';
import validate from 'express-validation';
import { payCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/hand')
    .post(payCtrl.hand);
router
    .route('/auth')
    .post(payCtrl.auth);
router
    .route('/cancel')
    .post(payCtrl.cancel);

export default router;
