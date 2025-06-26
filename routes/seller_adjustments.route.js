import express from 'express';
import validate from 'express-validation';
import { sellerAdjustmentsCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(sellerAdjustmentsCtrl.list)

export default router;