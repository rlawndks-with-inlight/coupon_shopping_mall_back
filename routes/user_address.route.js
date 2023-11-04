import express from 'express';
import validate from 'express-validation';
import { userAddressCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(userAddressCtrl.list)
    .post(userAddressCtrl.create);
router
    .route('/:id')
    .get(userAddressCtrl.get)
    .put(userAddressCtrl.update)
    .delete(userAddressCtrl.remove)

export default router;
