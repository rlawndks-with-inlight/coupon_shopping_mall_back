import express from 'express';
import validate from 'express-validation';
import { sellerCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(sellerCtrl.list)
    .post(sellerCtrl.create);
router
    .route('/:id')
    .get(sellerCtrl.get)
    .put(sellerCtrl.update)
    .delete(sellerCtrl.remove)
router
    .route('/change-pw/:id')
    .put(sellerCtrl.changePassword)
    
export default router;
