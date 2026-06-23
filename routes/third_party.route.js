import express from 'express';
import validate from 'express-validation';
import { thirdPartyCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/translate-naver')
    .post(thirdPartyCtrl.translate_naver);

router
    .route('/translate-google')
    .post(thirdPartyCtrl.translate_google);

export default router;
