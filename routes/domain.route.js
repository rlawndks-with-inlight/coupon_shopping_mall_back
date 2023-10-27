import express from 'express';
import { domainCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(domainCtrl.get)

export default router;
