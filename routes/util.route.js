import express from 'express';
import validate from 'express-validation';
import { utilCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/:table/sort')
    .post(utilCtrl.sort);

export default router;
