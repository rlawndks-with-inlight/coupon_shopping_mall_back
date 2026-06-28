import express from 'express';
import { merchantApplicationCtrl } from '../controllers/index.js';

const router = express.Router(); // eslint-disable-line new-cap

// 공개
router.route('/').post(merchantApplicationCtrl.create);
router.route('/check-slug').get(merchantApplicationCtrl.checkSlug);
router.route('/shops').get(merchantApplicationCtrl.searchShops);

// 매니저 전용
router.route('/list').get(merchantApplicationCtrl.list);
router.route('/status').put(merchantApplicationCtrl.updateStatus);
router.route('/:id').get(merchantApplicationCtrl.get).delete(merchantApplicationCtrl.remove);

export default router;
