import express from 'express';
import validate from 'express-validation';
import { productFaq } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(productFaq.list)
    .post(productFaq.create);
router
    .route('/:id')
    .get(productFaq.get)
    .put(productFaq.update)
    .delete(productFaq.remove)

export default router;