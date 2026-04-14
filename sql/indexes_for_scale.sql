-- ====================================
-- 동접 2000명 대응 복합 인덱스
-- 서버 DB에서 직접 실행 필요
-- 실행 전 반드시 백업할 것
-- ====================================

-- PRODUCTS (가장 빈번한 조회 테이블)
CREATE INDEX idx_products_brand_status_delete_sort ON products (brand_id, status, is_delete, sort_idx DESC);
CREATE INDEX idx_products_brand_category ON products (brand_id, category_id0, category_id1, is_delete);
CREATE INDEX idx_products_code_brand ON products (product_code, brand_id, is_delete);
CREATE INDEX idx_products_userid_brand ON products (user_id, brand_id, is_delete);

-- TRANSACTIONS (결제/주문 처리)
CREATE INDEX idx_transactions_brand_cancel_status ON transactions (brand_id, is_cancel, trx_status);
CREATE INDEX idx_transactions_user_status ON transactions (user_id, trx_status, is_delete, created_at DESC);
CREATE INDEX idx_transactions_seller_status ON transactions (seller_id, trx_status, created_at);
CREATE INDEX idx_transactions_brand_created ON transactions (brand_id, created_at, trx_status);

-- TRANSACTION_ORDERS (주문 상세)
CREATE INDEX idx_transaction_orders_transid ON transaction_orders (trans_id);
CREATE INDEX idx_transaction_orders_productid ON transaction_orders (product_id, trans_id);
CREATE INDEX idx_transaction_orders_sellerid ON transaction_orders (seller_id, product_id);

-- SELLER_PRODUCTS (셀러 상품 가격)
CREATE INDEX idx_seller_products_seller_delete ON seller_products (seller_id, is_delete);
CREATE INDEX idx_seller_products_product_seller ON seller_products (product_id, seller_id, is_delete);

-- USERS (인증/계층 조회)
CREATE INDEX idx_users_username_brand ON users (user_name, brand_id, is_delete);
CREATE INDEX idx_users_brand_level ON users (brand_id, level, is_delete);
CREATE INDEX idx_users_operid ON users (oper_id, level, is_delete);

-- PRODUCT_REVIEWS (리뷰 집계)
CREATE INDEX idx_product_reviews_product ON product_reviews (product_id, is_delete);
CREATE INDEX idx_product_reviews_brand ON product_reviews (brand_id, is_delete);

-- PRODUCT_IMAGES (이미지 벌크 로딩)
CREATE INDEX idx_product_images_product ON product_images (product_id, is_delete, id);

-- PRODUCT_CATEGORIES (카테고리 트리)
CREATE INDEX idx_product_categories_brand ON product_categories (brand_id, is_delete, sort_idx DESC);
CREATE INDEX idx_product_categories_group ON product_categories (product_category_group_id, is_delete);

-- PRODUCTS_AND_PROPERTIES (속성 필터링)
CREATE INDEX idx_products_and_properties_property ON products_and_properties (property_id, product_id);
CREATE INDEX idx_products_and_properties_product ON products_and_properties (product_id, property_id);

-- BRANDS (도메인 조회)
CREATE INDEX idx_brands_dns ON brands (dns, is_delete);

-- POSTS (게시물)
CREATE INDEX idx_posts_brand_category ON posts (brand_id, category_id, is_delete);
