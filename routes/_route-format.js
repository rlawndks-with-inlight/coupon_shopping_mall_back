import express from 'express';
import validate from 'express-validation';
import { productCategoryCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(productCategoryCtrl.list)
    .post(productCategoryCtrl.create);
router
    .route('/:id')
    .get(productCategoryCtrl.get)
    .put(productCategoryCtrl.update)
    .delete(productCategoryCtrl.remove)

export default router;
