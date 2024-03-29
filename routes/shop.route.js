import express from 'express';
import validate from 'express-validation';
import { shopCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(shopCtrl.setting)
router
    .route('/main')
    .get(shopCtrl.main)
router
    .route('/product/:id')
    .get(shopCtrl.item)
router
    .route('/product')
    .get(shopCtrl.items)
router
    .route('/post/:id')
    .get(shopCtrl.post.get)
    .put(shopCtrl.post.update)
    .delete(shopCtrl.post.remove)

router
    .route('/post')
    .get(shopCtrl.post.list)
    .post(shopCtrl.post.create)
router
    .route('/user-info')
    .get(shopCtrl.userInfo)

router
    .route('/product-faq/:id')
    .get(shopCtrl.productFaq.get)
    .put(shopCtrl.productFaq.update)
    .delete(shopCtrl.productFaq.remove)
router
    .route('/product-faq')
    .get(shopCtrl.productFaq.list)
    .post(shopCtrl.productFaq.create)
    
export default router;
