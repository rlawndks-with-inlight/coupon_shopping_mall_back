import express from 'express';
import validate from 'express-validation';
import { authCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(authCtrl.checkSign);
router
    .route('/sign-in')
    .post(authCtrl.signIn);
router
    .route('/sign-up')
    .post(authCtrl.signUp);
router
    .route('/sign-out')
    .post(authCtrl.signOut);
router
    .route('/code')
    .post(authCtrl.sendPhoneVerifyCode);
router
    .route('/code/check')
    .post(authCtrl.checkPhoneVerifyCode);
router
    .route('/change-password')
    .post(authCtrl.changePassword);

export default router;
