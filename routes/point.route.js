import express from 'express';
import validate from 'express-validation';
import { pointCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(pointCtrl.list)
    .post(pointCtrl.create);
router
    .route('/:id')
    .get(pointCtrl.get)
    .put(pointCtrl.update)
    .delete(pointCtrl.remove)

export default router;
