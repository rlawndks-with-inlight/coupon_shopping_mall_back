import express from 'express';
import validate from 'express-validation';
import { utilCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/copy')
    .post(utilCtrl.copy);

router
    .route('/:table/sort')
    .post(utilCtrl.sort);
router
    .route('/:table/:column_name')
    .post(utilCtrl.changeStatus);

export default router;
