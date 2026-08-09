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
// 비회원 1:1문의 조회 — 연락처 + 글비밀번호로 본인 글을 찾는다.
// ⚠ '/post/:id' 보다 **위에** 둬야 한다. 아래에 두면 :id 가 'guest-check' 를 삼킨다.
// GET 이 아니라 POST 인 이유: 비밀번호가 URL·서버 접근로그·브라우저 기록에 남으면 안 된다.
router
    .route('/post/guest-check')
    .post(shopCtrl.post.guestCheck)
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
