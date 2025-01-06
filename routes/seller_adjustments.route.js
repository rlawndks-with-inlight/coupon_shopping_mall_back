import express from 'express';
import validate from 'express-validation';
import { sellerAdjustmentsCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(sellerAdjustmentsCtrl.list)
    .post(sellerAdjustmentsCtrl.create);
router
    .route('/:id')
    .get(sellerAdjustmentsCtrl.get)
    .put(sellerAdjustmentsCtrl.update)
    .delete(sellerAdjustmentsCtrl.remove)

export default router;