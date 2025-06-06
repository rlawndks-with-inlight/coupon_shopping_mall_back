import express from 'express';
import validate from 'express-validation';
import { sellerProductsCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(sellerProductsCtrl.list)
    .post(sellerProductsCtrl.create)
router
    .route('/all')
    .post(sellerProductsCtrl.all)
router
    .route('/:id')
    .get(sellerProductsCtrl.get)
    .put(sellerProductsCtrl.update)
    .delete(sellerProductsCtrl.remove)

export default router;