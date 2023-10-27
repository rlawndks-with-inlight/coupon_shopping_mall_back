import express from 'express';
import validate from 'express-validation';
import { logCtrl } from '../controllers/index.js';
import upload from '../config/multerConfig.js';
const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(logCtrl.list)

    router
    .route('/:id')
    .delete(logCtrl.remove);
export default router;
