import express from 'express';
import { uploadCtrl } from '../controllers/index.js';
import upload from '../config/multerConfig.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/single')
    .post(uploadCtrl.single)
// router
//     .route('/multiple')
//     .post(upload.array('post_file', 1000), uploadCtrl.muiltiple)

export default router;
