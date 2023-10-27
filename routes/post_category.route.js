import express from 'express';
import validate from 'express-validation';
import { postCategoryCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(postCategoryCtrl.list)
    .post(postCategoryCtrl.create);
router
    .route('/:id')
    .get(postCategoryCtrl.get)
    .put(postCategoryCtrl.update)
    .delete(postCategoryCtrl.remove)

export default router;
