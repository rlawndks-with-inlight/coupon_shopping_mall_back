import express from 'express';
import validate from 'express-validation';
import { contractCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(contractCtrl.list)
    .post(contractCtrl.create);

router
    .route('/:id')
    .get(contractCtrl.get)
    .put(contractCtrl.update)
    .delete(contractCtrl.remove)


export default router;
