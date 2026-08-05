import express from 'express';
import validate from 'express-validation';
import { authCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(authCtrl.checkSign);
router
    .route('/sign-in')
    .post(authCtrl.signIn);
router
    .route('/sign-up')
    .post(authCtrl.signUp);
router
    .route('/sign-out')
    .post(authCtrl.signOut);
router
    .route('/code')
    .post(authCtrl.sendPhoneVerifyCode);
router
    .route('/code/check')
    .post(authCtrl.checkPhoneVerifyCode);
router
    .route('/change-password')
    .put(authCtrl.changePassword);
// ── 보안질문 기반(SMS 없음) 아이디찾기·비밀번호 재설정 : shopgo 하위 가맹점 전용 ──
// 위 /code, /code/check, /change-password (SMS 플로우)는 전 브랜드 공용으로 그대로 유지된다.
router
    .route('/find-id')                  // POST : 이름+휴대폰번호로 아이디 찾기
    .post(authCtrl.findId);
router
    .route('/security-question')        // POST : 질문 조회(비로그인) / PUT : 질문·답변 설정(로그인)
    .post(authCtrl.getSecurityQuestion)
    .put(authCtrl.setSecurityQuestion);
router
    .route('/reset-password-by-answer') // POST : 답변 검증 후 비밀번호 재설정
    .post(authCtrl.resetPasswordByAnswer);
router
    .route('/resign')
    .put(authCtrl.resign);
router
    .route('/change-info')
    .put(authCtrl.changeInfo);

export default router;
