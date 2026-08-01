
export const searchColumns = {
    'products': ['product_name', 'product_comment', 'product_code', `product_categories0.category_name`, `product_categories1.category_en_name`],
    'transactions': ['buyer_name', 'appr_num', 'buyer_phone',],
    'users': ['user_name', 'name', 'nickname', 'phone_num'],
    'seller_adjustments': ['brands.name', 'users.name', 'users.nickname'],
    'product_categories': ['category_name', 'category_en_name'],
    'phone_registration': ['phone_num'],
}

// FULLTEXT 인덱스가 있는 같은 테이블 컬럼 (MATCH AGAINST 사용)
// ※ transactions(buyer_name·buyer_phone), users(name·phone_num) 은 PII 암호화(Phase 4) 대상이라
//    ① 값이 암호문이라 FULLTEXT 부분검색이 무의미하고,
//    ② PII 컬럼 폭 확장 마이그레이션으로 collation이 달라져 MATCH 시
//       'Illegal mix of collations'(ER_CANT_AGGREGATE_3COLLATIONS, 1270) 오류가 발생함.
//    → 두 테이블을 FULLTEXT 대상에서 제외하고, 아래 likeOnlyColumns 평문 축으로 검색한다.
export const fulltextColumns = {
    'products': ['product_name', 'product_comment', 'product_code'],
}

// FULLTEXT 대상이 아닌 컬럼 (LIKE 사용) — 암호화되지 않은 '평문' 검색축.
export const likeOnlyColumns = {
    'products': [`product_categories0.category_name`, `product_categories1.category_en_name`],
    'seller_adjustments': ['brands.name', 'users.name', 'users.nickname'],
    // 주문검색 평문축: 주문번호(ord_num) · 회원 아이디(users.user_name) · 승인번호(appr_num).
    //  이름·전화는 암호화되어 부분검색이 불가하므로 평문 축으로 대체한다.
    //  ※ users.user_name 은 transactions list 쿼리가 users를 항상 JOIN해야 유효(transaction.controller.js).
    'transactions': ['transactions.ord_num', 'users.user_name', 'transactions.appr_num'],
    // 회원검색 평문축: 아이디(user_name) · 닉네임(nickname). 이름·전화는 암호화되어 부분검색 불가.
    'users': ['users.user_name', 'users.nickname'],
}
