import express from 'express';
import validate from 'express-validation';
import { phoneRegistrationCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(phoneRegistrationCtrl.list)
    .post(phoneRegistrationCtrl.create);
router
    .route('/:id')
    .get(phoneRegistrationCtrl.get)
    .put(phoneRegistrationCtrl.update)
    .delete(phoneRegistrationCtrl.remove)

export default router;