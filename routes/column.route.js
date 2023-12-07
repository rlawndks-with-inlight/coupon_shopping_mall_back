import express from 'express';
import { columnCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(columnCtrl.tables)
router
    .route('/:table')
    .get(columnCtrl.columns)
    .post(columnCtrl.onChangeUseColumn)

export default router;
