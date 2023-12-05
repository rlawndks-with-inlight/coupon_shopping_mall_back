import express from 'express';
import validate from 'express-validation';
import { productPropertyCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(productPropertyCtrl.list)
    .post(productPropertyCtrl.create);
router
    .route('/:id')
    .get(productPropertyCtrl.get)
    .put(productPropertyCtrl.update)
    .delete(productPropertyCtrl.remove)

export default router;
