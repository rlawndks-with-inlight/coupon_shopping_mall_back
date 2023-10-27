import express from 'express';
import validate from 'express-validation';
import { productCategoryGroupCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(productCategoryGroupCtrl.list)
    .post(productCategoryGroupCtrl.create);
router
    .route('/:id')
    .get(productCategoryGroupCtrl.get)
    .put(productCategoryGroupCtrl.update)
    .delete(productCategoryGroupCtrl.remove)

export default router;
