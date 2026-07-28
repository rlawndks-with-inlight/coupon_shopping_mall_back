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
