import express from "express";
import brandRoutes from "./brand.route.js";
import authRoutes from "./auth.route.js";
import domainRoutes from "./domain.route.js";
import productRoutes from "./product.route.js";
import productCategoryRoutes from "./product_category.route.js";
import productPropertyRoutes from "./product_property.route.js";
import productCategoryGroupRoutes from "./product_category_group.route.js";
import productPropertyGroupRoutes from "./product_property_group.route.js";
import uploadRoutes from "./upload.route.js";
import logRoutes from "./log.route.js";
import shopRoutes from "./shop.route.js";
import userRoutes from "./user.route.js";
import userAddressRoutes from "./user_address.route.js";
import postRoutes from "./post.route.js";
import postCategorRoutes from "./post_category.route.js";
import utilRoutes from "./util.route.js";
import productReviewRoutes from "./product_review.route.js";
import popupRoutes from "./popup.route.js";
import paymentModuleRoutes from "./payment_module.route.js";
import transactionRoutes from "./transaction.route.js";
import sellerRoutes from "./seller.route.js";
import payRoutes from "./pay.route.js";
import userWishRoutes from "./user_wish.route.js";
import pointRoutes from "./point.route.js";
import columnRoutes from "./column.route.js";
import consignmentRoutes from "./consignment.route.js";

const router = express.Router(); // eslint-disable-line new-cap

/** GET /health-check - Check service health */

// tables
router.use("/brands", brandRoutes);
router.use("/products", productRoutes);
router.use("/product-categories", productCategoryRoutes);
router.use("/product-properties", productPropertyRoutes);
router.use("/product-reviews", productReviewRoutes);
router.use("/product-category-groups", productCategoryGroupRoutes);
router.use("/product-property-groups", productPropertyGroupRoutes);
router.use("/logs", logRoutes);
router.use("/users", userRoutes);
router.use("/user-addresses", userAddressRoutes);
router.use("/post-categories", postCategorRoutes);
router.use("/posts", postRoutes);
router.use("/popups", popupRoutes);
router.use("/payment-modules", paymentModuleRoutes);
router.use("/transactions", transactionRoutes);
router.use("/user-wishs", userWishRoutes);
router.use("/points", pointRoutes);
router.use("/consignments", consignmentRoutes);

//auth
router.use("/auth", authRoutes);

//util
router.use("/domain", domainRoutes);
router.use("/upload", uploadRoutes);
router.use("/util", utilRoutes);
router.use("/sellers", sellerRoutes);
router.use("/pays", payRoutes);
router.use("/column", columnRoutes);

//user
router.use("/shop", shopRoutes);

export default router;
