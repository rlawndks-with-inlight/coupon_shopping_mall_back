import express from 'express';
import validate from 'express-validation';
import { productReviewCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(productReviewCtrl.list)
    .post(productReviewCtrl.create);
router
    .route('/:id')
    .get(productReviewCtrl.get)
    .put(productReviewCtrl.update)
    .delete(productReviewCtrl.remove)

export default router;
