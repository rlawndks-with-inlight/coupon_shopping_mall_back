import express from 'express';
import validate from 'express-validation';
import { productPropertyGroupCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(productPropertyGroupCtrl.list)
    .post(productPropertyGroupCtrl.create);
router
    .route('/:id')
    .get(productPropertyGroupCtrl.get)
    .put(productPropertyGroupCtrl.update)
    .delete(productPropertyGroupCtrl.remove)

export default router;
