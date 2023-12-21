import express from 'express';
import validate from 'express-validation';
import { dashboardCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(dashboardCtrl.all)


export default router;
