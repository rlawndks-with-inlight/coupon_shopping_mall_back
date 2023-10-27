import express from 'express';
import validate from 'express-validation';
import { userCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

router
    .route('/')
    .get(userCtrl.list)
    .post(userCtrl.create)
router
    .route('/organizational-chart')
    .get(userCtrl.organizationalChart)
router
    .route('/:id')
    .get(userCtrl.get)
    .put(userCtrl.update)
    .delete(userCtrl.remove)

router
    .route('/change-pw/:id')
    .put(userCtrl.changePassword)
router
    .route('/change-status/:id')
    .put(userCtrl.changeStatus)

export default router;
