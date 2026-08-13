import express from 'express';
import { orderFormCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

// 주문서 추가 입력항목 서식 — 본사 마스터 전용.
// 고객 화면은 이 경로를 쓰지 않는다. shop.controller 의 setting 묶음에 order_form 으로 함께 내려간다.
//
// ⚠ '/merchants' 를 '/:id' 보다 먼저 둔다. 뒤에 두면 id='merchants' 로 잡혀 404 가 난다.
router.route('/merchants').get(orderFormCtrl.merchants);
// 가맹점 상품등록 화면의 '서식 불러오기' — 본사가 만든 템플릿 목록(읽기 전용).
// 여기만 마스터가 아니어도 읽을 수 있다. 만들고 고치는 건 여전히 마스터뿐이다.
router.route('/templates').get(orderFormCtrl.templates);
router
    .route('/')
    .get(orderFormCtrl.list)
    .post(orderFormCtrl.create);
router
    .route('/:id')
    .put(orderFormCtrl.update)
    .delete(orderFormCtrl.remove)

export default router;
