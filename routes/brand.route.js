import express from 'express';
import validate from 'express-validation';
import { brandCtrl } from '../controllers/index.js';
import upload from '../config/multerConfig.js';
const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(brandCtrl.list)
    .post(brandCtrl.create);

router
    .route('/:id')
    .get(brandCtrl.get)
    .put(brandCtrl.update)
    .delete(brandCtrl.remove);
router
    .route('/designs/:id')
    .get(brandCtrl.design.get)
    .put(brandCtrl.design.update);

export default router;
