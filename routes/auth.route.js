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

export default router;
