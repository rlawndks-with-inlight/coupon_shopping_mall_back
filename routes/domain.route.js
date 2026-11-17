import express from 'express';
import { domainCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(domainCtrl.get)

router
    .route('/search-brands')
    .get(domainCtrl.searchBrands)

export default router;
