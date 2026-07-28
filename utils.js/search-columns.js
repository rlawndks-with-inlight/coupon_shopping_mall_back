
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
    // 주문검색 축 추가: 주문번호(ord_num) + 회원 아이디(users.user_name).
    // 암호화(Phase 4)로 이름·전화 부분검색이 사라지는 것을 대체하는 평문 검색축.
    // ※ users.user_name은 transactions list 쿼리가 users를 항상 JOIN해야 유효(transaction.controller.js).
    'transactions': ['transactions.ord_num', 'users.user_name'],
}
