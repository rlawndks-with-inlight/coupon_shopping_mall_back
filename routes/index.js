import express from 'express';
import customerRoutes from './customer.route.js';
import brandRoutes from './brand.route.js';
import authRoutes from './auth.route.js';
import domainRoutes from './domain.route.js';
import productRoutes from './product.route.js';
import productCategoryRoutes from './product_category.route.js';
import productCategoryGroupRoutes from './product_category_group.route.js';
import uploadRoutes from './upload.route.js';
import logRoutes from './log.route.js';
import shopRoutes from './shop.route.js';
import contractRoutes from './contract.route.js';
import userRoutes from './user.route.js';
import postRoutes from './post.route.js'
import postCategorRoutes from './post_category.route.js';

const router = express.Router(); // eslint-disable-line new-cap

/** GET /health-check - Check service health */

// tables
router.use('/customers', customerRoutes);
router.use('/brands', brandRoutes);
router.use('/products', productRoutes);
router.use('/product-categories', productCategoryRoutes);
router.use('/product-category-groups', productCategoryGroupRoutes);
router.use('/logs', logRoutes);
router.use('/contracts', contractRoutes);
router.use('/users', userRoutes);
router.use('/post-categories', postCategorRoutes);
router.use('/posts', postRoutes);

//auth
router.use('/auth', authRoutes);

//util
router.use('/domain', domainRoutes);
router.use('/upload', uploadRoutes);

//user
router.use('/shop', shopRoutes);


export default router;
