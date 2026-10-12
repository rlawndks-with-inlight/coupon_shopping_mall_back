import express from 'express';
import validate from 'express-validation';
import { sellerProductsCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(sellerProductsCtrl.list)
    .post(sellerProductsCtrl.create)
// '/:id' 보다 먼저 둔다(뒤에 두면 id='impact' 로 잡힌다).
router
    .route('/impact')
    .get(sellerProductsCtrl.impact)
router
    .route('/all')
    .post(sellerProductsCtrl.all)
router
    .route('/:id')
    .get(sellerProductsCtrl.get)
    .put(sellerProductsCtrl.update)
    .delete(sellerProductsCtrl.remove)

export default router;