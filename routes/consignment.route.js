import express from 'express';
import validate from 'express-validation';
import { consignmentCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(consignmentCtrl.list)
    .post(consignmentCtrl.create);
router
    .route('/:id')
    .get(consignmentCtrl.get)
    .put(consignmentCtrl.update)
    .delete(consignmentCtrl.remove)

export default router;
