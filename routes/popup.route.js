import express from 'express';
import validate from 'express-validation';
import { popupCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(popupCtrl.list)
    .post(popupCtrl.create);
router
    .route('/:id')
    .get(popupCtrl.get)
    .put(popupCtrl.update)
    .delete(popupCtrl.remove)

export default router;
