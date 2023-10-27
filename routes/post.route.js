import express from 'express';
import validate from 'express-validation';
import { postCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(postCtrl.list)
    .post(postCtrl.create);
router
    .route('/:id')
    .get(postCtrl.get)
    .put(postCtrl.update)
    .delete(postCtrl.remove)

export default router;
