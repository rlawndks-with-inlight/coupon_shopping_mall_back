import express from 'express';
import validate from 'express-validation';
import { customerCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(customerCtrl.list)
    .post(customerCtrl.create)
router
    .route('/:id')
    .get(customerCtrl.get)
    .put(customerCtrl.update)
    .delete(customerCtrl.remove)


export default router;
