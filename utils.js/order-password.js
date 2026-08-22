'use strict';
import crypto from 'crypto';

// 비회원 주문조회 비밀번호 해시.
//
// [왜 이 파일이 따로 있나]
//  · createHashedPassword(PBKDF2 + 랜덤 솔트)는 행마다 솔트가 달라 SQL 에서 `WHERE password=?` 비교가 불가능하다.
//    주문조회는 '전화번호 + 비밀번호' 또는 '주문번호 + 비밀번호' 로 DB 를 직접 거르므로 결정적 해시가 필요하다.
//    (솔트 방식으로 가려면 transactions 에 솔트 컬럼 추가 + 전체 행 조회 후 앱에서 비교 → 과함)
//  · blindIndex(pii)는 `[\s.\-()]` 를 제거하고 소문자화한다. 전화번호엔 맞지만 비밀번호엔 치명적이다
//    ("Ab-12cd" 와 "ab12cd" 가 같아져 사실상 문자셋이 줄어든다). 그래서 정규화 없는 별도 함수를 둔다.
//
// [형식] "h1:" + HMAC-SHA256(key, password) hex   → 총 67자 (varchar(255) 안에 충분)
//  · 접두사를 붙여 평문(레거시)과 한눈에 구분되고, 나중에 알고리즘을 바꿀 때 h2 로 올릴 수 있다.
//
// [한계] HMAC 은 빠르기 때문에 DB 가 통째로 유출되면 6~16자 비밀번호는 대입 공격에 취약하다.
//  다만 키(DB_INDEX_KEY)는 DB 가 아니라 서버 환경변수에 있어 DB 유출만으로는 계산할 수 없다.
//  회원 계정 비밀번호가 아니라 '주문 1건 조회용' 이라는 점도 감안한 선택이다.

const ORDER_PW_PREFIX = 'h1:';

const getKey = () => process.env.DB_INDEX_KEY || process.env.DB_ENCRYPTION_KEY || '';

/** 이미 해시된 값인가 */
export const isHashedOrderPassword = (value) =>
    typeof value === 'string' && value.startsWith(ORDER_PW_PREFIX);

/**
 * 저장·조회에 쓸 해시를 만든다. 빈 값은 그대로 '' 를 돌려준다.
 * (회원 주문은 password 가 빈 값이라 해시하지 않는다)
 */
export const hashOrderPassword = (password) => {
    if (password === null || password === undefined || password === '') return '';
    if (isHashedOrderPassword(password)) return password; // 이중 해시 방지
    const hmac = crypto.createHmac('sha256', getKey()).update(String(password)).digest('hex');
    return `${ORDER_PW_PREFIX}${hmac}`;
};

/**
 * 조회 시 대조할 후보 값들.
 * 신규 주문은 해시로 저장되지만, 이 기능 이전에 쌓인 주문은 평문으로 남아 있다.
 * 둘 다 후보로 넣어 기존 주문 조회가 깨지지 않게 한다(무중단 전환).
 * → SQL 에서 `password IN (?, ?)` 형태로 쓴다.
 */
export const orderPasswordCandidates = (password) => {
    if (password === null || password === undefined || password === '') return [];
    const plain = String(password);
    const hashed = hashOrderPassword(plain);
    return hashed === plain ? [plain] : [hashed, plain];
};

/**
 * 입력한 주문비밀번호가 저장된 값과 맞는가 — 비회원 본인 확인.
 *
 * 조회(get)는 SQL 의 `password IN (?, ?)` 로 걸러서 이 함수가 필요 없지만,
 * 취소요청은 주문을 id 로 먼저 집어 온 뒤 앱에서 대조해야 한다.
 *
 * 빈 값은 절대 통과시키지 않는다. 회원 주문은 password 가 '' 로 저장되므로,
 * 빈 값끼리 맞아떨어지게 두면 비밀번호 없이 남의 회원 주문을 취소할 수 있게 된다.
 */
export const matchesOrderPassword = (input, stored) => {
    if (!stored) return false;
    const 후보 = orderPasswordCandidates(input);
    if (!후보.length) return false;
    return 후보.includes(String(stored));
};

export default { hashOrderPassword, isHashedOrderPassword, orderPasswordCandidates, matchesOrderPassword };
