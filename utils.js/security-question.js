'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 보안질문(본인확인 질문) 공용 헬퍼 — 질문목록 / 답변정규화 / 해시 / 검증 / 응답필드제거.
//
// SMS 없이 아이디찾기·비밀번호 재설정을 하기 위한 기능. shopgo 본사(id=98) 및 하위 가맹점(parent_id=98) 전용
// (isShopgoBrand(decode_dns) === true 인 브랜드에서만 호출할 것. isShopgoMerchant 는 본사를 제외하므로 쓰지 말 것).
// 그 외 브랜드는 기존 SMS 플로우(auth/code, auth/code/check, auth/change-password)를 그대로 쓴다.
//
// 저장 컬럼(users):
//   security_question_id   TINYINT UNSIGNED NULL   -- 아래 SECURITY_QUESTIONS 의 id. NULL=미설정
//   security_answer_hash   VARCHAR(255) NULL       -- PBKDF2-SHA512 104906회 64바이트 base64(88자)
//   security_answer_salt   VARCHAR(255) NULL       -- 답변 전용 salt (user_salt 와 분리)
//   security_fail_count    INT NOT NULL DEFAULT 0  -- 연속 오답 횟수 (5회 → 30분 잠금)
//   security_locked_until  DATETIME NULL           -- 잠금 해제 시각. 판정/설정은 반드시 DB NOW() 기준
//   security_set_at        DATETIME NULL           -- 최초/최종 설정 시각
//
// ⚠ 답변 평문은 어떤 경우에도 DB/로그/응답에 남기지 말 것.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'crypto';
import { createHashedPassword } from './util.js';
// ↑ 순환참조 없음: util.js 는 이 파일을 import 하지 않는다.
//   createHashedPassword(password, salt_) → { hashedPassword, salt }
//   (salt_ 를 넘기면 그 salt 로 재해시 → 검증용. 안 넘기면 랜덤 salt 생성 → 저장용.)

// ⚠ id 는 users.security_question_id 에 저장되는 '영구 값'이다.
//   - 재사용 금지 / 순서 재배치 금지 / 문구를 다른 질문으로 바꾸는 것 금지.
//   - 질문을 늘릴 때는 반드시 배열 끝에 새 id(9, 10 …)로 추가만 할 것.
//   - 기존 id 의 의미가 바뀌면 이미 가입한 회원의 답변이 '다른 질문의 답'이 되어 영구 불일치가 된다.
export const SECURITY_QUESTIONS = [
    { id: 1, label: '어릴 적 살던 동네 이름은?' },
    { id: 2, label: '어머니의 고향은?' },
    { id: 3, label: '초등학교 때 가장 친했던 친구의 이름은?' },
    { id: 4, label: '어릴 적 별명은?' },
    { id: 5, label: '처음 키운 반려동물의 이름은?' },
    { id: 6, label: '처음 일한 곳(아르바이트 포함)의 이름은?' },
    { id: 7, label: '기억에 남는 선생님의 성함은?' },
    { id: 8, label: '어릴 때 가장 좋아했던 만화·게임 제목은?' },
];

// multipart/form-data 로 들어오므로 body 값은 전부 문자열 → 반드시 parseInt 후 검사.
export const isValidSecurityQuestionId = (v) => {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 1 && n <= SECURITY_QUESTIONS.length;
};

// 답변 정규화. 저장(가입/설정)과 검증(재설정) 양쪽에서 오직 이 함수만 사용한다.
// ⚠ 배포 후 이 규칙을 바꾸면 이미 저장된 해시와 영구 불일치 → 전 회원 재설정 필요. 절대 변경 금지.
//   NFC        : 자소분리(NFD) 한글 흡수 (macOS/iOS 입력 대응)
//   \s 제거    : 반각 공백·전각 공백(U+3000)·NBSP 등 모든 공백 제거
//   toLowerCase: 영문 대소문자 무시
export const normalizeAnswer = (s) =>
    String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

// 저장용. → { hashedPassword, salt } 를 각각 security_answer_hash / security_answer_salt 에 넣는다.
export const hashAnswer = async (answer) => createHashedPassword(normalizeAnswer(answer));

// 검증용. 저장된 salt 로 재해시 후 timing-safe 비교(문자열 === 비교는 조기종료로 타이밍 누설).
export const verifyAnswer = async (answer, hash, salt) => {
    if (!hash || !salt) return false;
    const { hashedPassword } = await createHashedPassword(normalizeAnswer(answer), salt);
    const a = Buffer.from(hashedPassword, 'utf8');
    const b = Buffer.from(String(hash), 'utf8');
    // timingSafeEqual 은 길이가 다르면 throw → 길이 먼저 비교(길이 자체는 비밀이 아니다).
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ─────────────────────────────────────────────────────────────────────────────
// SELECT * / users.* 로 읽은 users 행에서 '자격증명 필드'를 제거 — 응답을 내보내기 직전 '필수'.
//
// 제거 대상(5개)과 이유:
//   user_pw               비밀번호 PBKDF2 해시. 나가면 오프라인 무차별 대입 대상이 된다.
//   user_salt             비밀번호 salt.       해시+salt 가 함께 나가면 사전공격 비용이 사실상 0이 된다.
//                         (또한 salt 를 알면 임의 비밀번호의 해시를 직접 계산할 수 있다)
//   otp_token             TOTP base32 시크릿.  나가면 누구나 유효한 6자리 OTP 를 생성할 수 있어 2단계 인증이 무력화된다.
//   security_answer_hash  보안질문 답변 해시.  엔트로피 낮은 한글 답변이라 오프라인 대입이 특히 쉽다.
//   security_answer_salt  보안질문 답변 salt.  위와 동일.
//
// ⚠ 왜 '응답 직전'인가: users 를 SELECT * 하는 조회 핸들러는 로그인만 하면 누구나 호출할 수 있어서,
//    이 제거가 없으면 아무 회원이나 남의 비밀번호 해시·salt·OTP 시크릿을 그대로 읽을 수 있었다.
// ⚠ 반드시 '서버가 그 값을 다 쓴 뒤'에 호출할 것. (예: auth signIn 은 비밀번호 비교와 토큰 발급을
//    끝낸 다음에 호출한다. 토큰 payload(makeUserTokenPayload)에는 이 5개 필드가 들어가지 않는다.)
// ⚠ 이 필드들이 응답에서 빠져도 어떤 화면도 깨지지 않는다: 프론트의 비밀번호 입력칸은 전부
//    '새로 입력받는 칸'이고(조회값을 다시 보내지 않는다), OTP 시크릿은 가입 시 POST /api/brands/otp 로
//    새로 발급받아 쓴다. 수정 저장 API 들도 값이 없으면 비밀번호를 건드리지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
export const stripUserSecrets = (row) => {
    if (!row) return row;
    delete row.user_pw;
    delete row.user_salt;
    delete row.otp_token;
    delete row.security_answer_hash;
    delete row.security_answer_salt;
    return row;
};

// 배열(목록 응답)용. 원소를 그 자리에서 수정하고 같은 배열을 돌려준다.
export const stripUserSecretsList = (rows) => {
    if (Array.isArray(rows)) rows.forEach(stripUserSecrets);
    return rows;
};
