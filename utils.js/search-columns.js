
export const searchColumns = {
    'products': ['product_name', 'product_comment', 'product_code', `product_categories0.category_name`, `product_categories1.category_en_name`],
    'transactions': ['buyer_name', 'appr_num', 'buyer_phone',],
    'users': ['user_name', 'name', 'nickname', 'phone_num'],
    'seller_adjustments': ['brands.name', 'users.name', 'users.nickname'],
    'product_categories': ['category_name', 'category_en_name'],
    'phone_registration': ['phone_num'],
}

// FULLTEXT 인덱스가 있는 같은 테이블 컬럼 (MATCH AGAINST 사용)
export const fulltextColumns = {
    'products': ['product_name', 'product_comment', 'product_code'],
    'transactions': ['buyer_name', 'appr_num', 'buyer_phone'],
    'users': ['user_name', 'name', 'nickname', 'phone_num'],
}

// FULLTEXT 대상이 아닌 JOIN 테이블 컬럼 (LIKE 유지)
export const likeOnlyColumns = {
    'products': [`product_categories0.category_name`, `product_categories1.category_en_name`],
    'seller_adjustments': ['brands.name', 'users.name', 'users.nickname'],
}
