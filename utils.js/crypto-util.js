import crypto from 'crypto';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────────────────────
// DB 민감정보(개인정보) 필드 암호화 유틸.
// - 저장: AES-256-GCM(인증 암호화) + 랜덤 IV. 결과는 `enc:v1:<iv>:<tag>:<ct>` (모두 base64).
// - 프리픽스(enc:v1:)로 "이미 암호화됨"을 식별 → 마이그레이션 멱등 + 롤아웃 중 평문/암호문 혼재 허용.
// - 읽기(decField): 평문이면 그대로 통과, 암호문이면 복호화 → 마이그레이션 전/후 모두 안전.
// - blindIndex: 정확일치 조회/JOIN이 필요한 필드(전화번호 등)용 결정적 인덱스(HMAC-SHA256).
//
// 필요한 env (백엔드 .env, 사장님 관리):
//   DB_ENCRYPTION_KEY : 32바이트 키 (hex 64자 / base64 44자 / 원문 32자 중 택1). 필수.
//   DB_INDEX_KEY      : 블라인드 인덱스용 HMAC 키(임의 문자열). 없으면 DB_ENCRYPTION_KEY 사용.
// 키가 없으면 encField는 평문을 그대로 반환(서비스 중단 방지). 배포 시 키 설정 필수.
// ─────────────────────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

let cachedKey; // null=키없음, undefined=미확인
const getKey = () => {
    if (cachedKey !== undefined) return cachedKey;
    const raw = process.env.DB_ENCRYPTION_KEY || '';
    let key = null;
    if (raw) {
        try {
            if (/^[A-Fa-f0-9]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
            else {
                const b = Buffer.from(raw, 'base64');
                key = (b.length === 32) ? b : Buffer.from(raw, 'utf8');
            }
        } catch (e) {
            key = Buffer.from(raw, 'utf8');
        }
        if (!key || key.length !== 32) key = null;
    }
    cachedKey = key;
    return key;
};

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

// 평문 → 암호문. 빈 값/이미 암호화된 값/키 없음은 그대로 반환(멱등·안전).
export const encField = (plaintext) => {
    if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
    if (isEncrypted(plaintext)) return plaintext;
    const key = getKey();
    if (!key) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
};

// 암호문 → 평문. 평문(프리픽스 없음)은 그대로 통과 → 롤아웃 중 안전.
export const decField = (value) => {
    if (!isEncrypted(value)) return value;
    const key = getKey();
    if (!key) return value;
    try {
        const parts = value.split(':'); // ['enc','v1',iv,tag,ct]
        const iv = Buffer.from(parts[2], 'base64');
        const tag = Buffer.from(parts[3], 'base64');
        const ct = Buffer.from(parts[4], 'base64');
        const decipher = crypto.createDecipheriv(ALGO, key, iv);
        decipher.setAuthTag(tag);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString('utf8');
    } catch (e) {
        return value;
    }
};

// 객체의 지정 키들을 암호화/복호화한 사본 반환 (얕은 복사).
export const encFields = (obj, keys = []) => {
    if (!obj) return obj;
    const out = { ...obj };
    for (const k of keys) if (k in out) out[k] = encField(out[k]);
    return out;
};
export const decFields = (obj, keys = []) => {
    if (!obj) return obj;
    const out = { ...obj };
    for (const k of keys) if (k in out) out[k] = decField(out[k]);
    return out;
};

// 정확일치 조회/JOIN용 블라인드 인덱스. 숫자/영문만 남기고 소문자화 후 HMAC-SHA256(hex).
// 부분(LIKE) 검색은 불가 — 정확일치만 지원.
export const blindIndex = (plaintext) => {
    if (plaintext === null || plaintext === undefined || plaintext === '') return '';
    const key = process.env.DB_INDEX_KEY || process.env.DB_ENCRYPTION_KEY || '';
    const norm = String(plaintext).replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    return crypto.createHmac('sha256', key).update(norm).digest('hex');
};

export default { encField, decField, encFields, decFields, isEncrypted, blindIndex };
