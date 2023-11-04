import express from 'express';
import validate from 'express-validation';
import { userWishCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(userWishCtrl.list)
    .post(userWishCtrl.create);
router
    .route('/:id')
    .get(userWishCtrl.get)
    .put(userWishCtrl.update)
    .delete(userWishCtrl.remove)

export default router;
