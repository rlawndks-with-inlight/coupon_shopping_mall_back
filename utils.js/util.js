import crypto from 'crypto';
import util from 'util';
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { readSync } from 'fs';
import when from 'when';
import _ from 'lodash';
import logger from './winston/index.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { deleteQuery, insertQuery, updateQuery } from './query-util.js';
import { writePool } from '../config/db-pool.js';

const randomBytesPromise = util.promisify(crypto.randomBytes);
const pbkdf2Promise = util.promisify(crypto.pbkdf2);

const createSalt = async () => {
    const buf = await randomBytesPromise(64);
    return buf.toString("base64");
};
export const createHashedPassword = async (password, salt_) => {
    let salt = salt_;
    if (!salt) {
        salt = await createSalt();
    }
    const key = await pbkdf2Promise(password, salt, 104906, 64, "sha512");
    const hashedPassword = key.toString("base64");
    return { hashedPassword, salt };
};
export const makeUserToken = (obj) => {
    let token = jwt.sign({ ...obj },
        process.env.JWT_SECRET,
        {
            expiresIn: '180m',
            issuer: 'fori',
        });
    return token
}
export const checkLevel = (token, level, res) => { //유저 정보 뿌려주기
    try {
        if (token == undefined)
            return false

        //const decoded = jwt.decode(token)
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user_level = decoded?.level
        if (level > user_level)
            return false
        else
            return decoded
    }
    catch (err) {
        return false
    }
}
export const checkDns = (token) => { //dns 정보 뿌려주기
    try {
        if (token == undefined)
            return false

        //const decoded = jwt.decode(token)
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (decoded?.id)
            return decoded
        else
            return false
    }
    catch (err) {
        console.log(err)
        logger.error(JSON.stringify(err?.response?.data || err))
        return false
    }
}
const logRequestResponse = async (req, res, decode_user, decode_dns) => {//로그찍기
    let requestIp = getReqIp(req);

    let request = {
        url: req.originalUrl,
        headers: req.headers,
        query: req.query,
        params: req.params,
        body: req.body,
        method: req.method,
        file: req.file || req.files || null
    }
    if (request.url.includes('/logs')) {
        return true;
    }
    request = JSON.stringify(request)
    let user_id = 0;
    if (decode_user && !isNaN(parseInt(decode_user?.id))) {
        user_id = decode_user?.id;
    } else {
        user_id = -1;
    }
    let brand_id = -1;
    if (decode_dns) {
        brand_id = decode_dns?.id;
    } else {
        brand_id = -1;
    }
    let result = await writePool.query(
        "INSERT INTO logs (request, response_data, response_result, response_message, request_ip, user_id, brand_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [request, JSON.stringify(res?.data), res?.result, res?.message, requestIp, user_id, brand_id]
    )
}
export const response = async (req, res, code, message, data) => { //응답 포맷
    let resDict = {
        'result': code,
        'message': message,
        'data': data,
    }
    const decode_user = checkLevel(req.cookies.token, 0, res)
    const decode_dns = checkDns(req.cookies.dns, 0)
    //let save_log = await logRequestResponse(req, resDict, decode_user, decode_dns);
    if (req?.IS_RETURN) {
        return resDict;
    } else {
        if (code < 0) {
            // 실패 코드는 지금까지 전부 HTTP 500 이었다. '권한이 없습니다'(-150)도 마찬가지라,
            // 로그인 전에 화면이 부르는 조회 하나하나가 서버 오류로 잡혀 5xx 지표를 오염시켰다.
            // 권한 거부는 서버 잘못이 아니므로 403 으로 내린다.
            //
            // 프론트 동작은 그대로다 — axios 는 2xx 가 아니면 어느 코드든 reject 하고,
            // 인터셉터가 응답 본문을 그대로 넘기므로 화면에 뜨는 메시지도 같다(utils/axios.js).
            // 나머지 실패 코드는 이번 범위가 아니라 500 그대로 둔다.
            res.status(code === -150 ? 403 : 500).send(resDict)
        } else {
            res.status(200).send(resDict)
        }
    }
}
// 예외를 사람이 읽을 수 있는 한 줄로 만든다.
//
// 예전엔 여기저기서 JSON.stringify(err?.response?.data || err) 를 썼다.
// axios 오류(응답 본문이 있는 것)는 잘 남지만, 그냥 Error 는 '{}' 로 찍힌다 —
// Error 의 message·stack 이 열거 가능한 속성이 아니기 때문이다.
// 실제로 결제 실패 하나가 로그에 '{}' 한 줄만 남겨서 원인을 못 찾았다(2026-08-21).
//
// 순서: PG 응답 본문 > SQL 메시지 > message + stack > 통째로 문자열화.
export const errText = (err) => {
    if (!err) return '(빈 오류)';
    try {
        if (err?.response?.data) {
            const 상태 = err?.response?.status ? `HTTP ${err.response.status} ` : '';
            return 상태 + (typeof err.response.data === 'string'
                ? err.response.data
                : JSON.stringify(err.response.data));
        }
        if (err?.sqlMessage) return `SQL ${err.code ?? ''} ${err.sqlMessage}`;
        if (err?.message) return err.message + (err.stack ? ' | ' + String(err.stack).split('\n').slice(1, 4).join(' ').trim() : '');
        return typeof err === 'string' ? err : JSON.stringify(err);
    } catch (e) {
        return String(err);
    }
};

export const lowLevelException = (req, res) => {
    return response(req, res, -150, "권한이 없습니다.", false);
}
export const isItemBrandIdSameDnsId = (decode_dns, item) => {
    return decode_dns?.id == item?.brand_id
}
export const settingFiles = (obj = {}) => {
    let keys = Object.keys(obj);
    let result = {};
    for (var i = 0; i < keys.length; i++) {
        let file = obj[keys[i]][0];
        if (!file) {
            continue;
        }
        let is_multiple = false;

        if (obj[keys[i]].length > 1) {
            is_multiple = true;
        }
        if (is_multiple) {
            let files = obj[keys[i]];
            result[`${keys[i].split('_file')[0]}_imgs`] = files.map(item => {
                return (process.env.NODE_ENV == 'development' ? process.env.BACK_URL_TEST : process.env.BACK_URL) + '/' + item.destination + item.filename;
            }).join(',')
            files = `[${files}]`;

        } else {
            file.destination = 'files/' + file.destination.split('files/')[1];
            result[`${keys[i].split('_file')[0]}_img`] = (process.env.NODE_ENV == 'development' ? process.env.BACK_URL_TEST : process.env.BACK_URL) + '/' + file.destination + file.filename;
        }
    }
    return result;
}

export const imageFieldList = [
    'logo_file',
    'dark_logo_file',
    'favicon_file',
    'og_file',
    'group_file',
    'profile_file',
    'option_file',
    'post_title_file',
    'product_file',
    'category_file',
    'upload_file',
    'post_file',
    'background_file',
    'contract_file',
    'passbook_file',
    'bsin_lic_file',
    'shareholder_file',
    'register_file',
    'id_file',

].map(field => {
    return {
        name: field
    }
})

// ── 다국어 번역 ────────────────────────────────────────────────────────────
// 엔진은 두 가지다. **환경변수 GOOGLE_TRANSLATE_API_KEY 가 있으면 공식 API,
// 없으면 예전처럼 무료 gtx 엔드포인트**를 쓴다.
//
// [왜 바꿨나]
// gtx(translate.googleapis.com/translate_a/single?client=gtx)는 API 키가 없는 비공식 경로다.
// 한 IP 가 분당 수십 건을 넘기면 429 를 주고 이후 요청은 google.com/sorry/ 로 튕긴다.
// 실제로 대기열 백필을 돌리자마자 차단당해 그동안 신규 상품 번역까지 멈췄다.
// 공식 Cloud Translation API 는 **월 50만 자가 영구 무료**다(체험 크레딧과 별개).
// 운영 데이터 실측: 미번역분 전체가 464,639자 — 한 달 무료 한도로 백필이 끝나고,
// 이후 신규 등록분은 월 수천 자 수준이라 계속 무료 범위다.
//
// 키가 없으면 아무것도 깨지지 않고 예전 동작 그대로다(하위호환).

// 공식 API 키. 없으면 gtx 폴백.
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';
export const usingOfficialTranslateApi = () => !!GOOGLE_TRANSLATE_API_KEY;

// 지원 언어(gtx 코드). ko 는 원문이라 번역 대상이 아니다.
export const LANG_TARGETS = [
    { value: 'en', use_value: 'en' },
    { value: 'ja', use_value: 'ja' },
    { value: 'cn', use_value: 'zh-CN' },
    { value: 'es', use_value: 'es' },
];

// 본문이 HTML 인 컬럼. 태그를 보존하고 텍스트 노드만 번역해야 한다.
// (Quill 에디터가 만든 마크업이라 통째로 번역기에 넣으면 태그가 깨진다)
export const HTML_LANG_COLUMNS = {
    posts: ['post_content'],
    // 상품 상세설명도 Quill 이 만든 HTML 이다. 태그를 보존하고 텍스트 노드만 번역해야 한다.
    products: ['product_description'],
    // 혜택 안내 팝업의 탭 본문. 카드사 로고 <img> 가 섞여 있어 태그 보존이 특히 중요하다.
    benefit_notice_tabs: ['tab_content'],
    // 팝업 본문도 Quill HTML 이다.
    popups: ['popup_content'],
};

// 호출량 관측 — 스케줄러가 한 틱의 요청 예산을 지키는 데 쓴다.
// rate_limited_at: 무료 gtx 엔드포인트가 429(또는 /sorry/ 차단 페이지)를 돌려준 마지막 시각.
//   차단된 상태에서 계속 두드리면 차단만 길어지고, 그동안 대기열은 '번역 없음'으로
//   소진돼 버린다. 스케줄러가 이 값을 보고 틱을 통째로 건너뛴다.
// chars: 무료 한도(월 50만 자)를 얼마나 썼는지 눈으로 보기 위한 누계. 재기동하면 0 으로 돌아간다.
export const LANG_STATS = { calls: 0, fails: 0, htmlGiveUps: 0, rate_limited_at: 0, chars: 0 };

// 이 오류가 '요청 과다로 막힌 것'인지.
//  · gtx  : 429, 또는 google.com/sorry/ 차단 페이지로의 302
//  · 공식 : 429, 또는 403 + rateLimitExceeded/quotaExceeded (무료 한도 초과)
// 어느 쪽이든 계속 두드려 봐야 소용없으므로 쿨다운을 건다.
export const isRateLimited = (err) => {
    const status = err?.response?.status;
    if (status === 429) return true;
    const location = String(err?.response?.headers?.location ?? '');
    if (status === 302 && location.includes('/sorry/')) return true;
    if (status === 403) {
        const reason = JSON.stringify(err?.response?.data ?? '');
        if (reason.includes('rateLimitExceeded') || reason.includes('quotaExceeded')
            || reason.includes('userRateLimitExceeded')) return true;
    }
    return String(err?.message ?? '').includes('429');
};

const GTRANS_MIN_GAP_MS = parseInt(process.env.LANG_MIN_GAP_MS || '150') || 150;
const GTRANS_CHUNK = parseInt(process.env.LANG_CHUNK_SIZE || '1200') || 1200;
let gtransLastAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 문장/줄 경계에서 끊어 청크로 나눈다. 경계가 없으면 강제로 자른다.
const splitChunks = (text, limit = GTRANS_CHUNK) => {
    const out = [];
    let rest = String(text ?? '');
    while (rest.length > limit) {
        let cut = -1;
        for (const sep of ['\n', '. ', '! ', '? ', '。', ' ']) {
            const i = rest.lastIndexOf(sep, limit);
            if (i > limit * 0.5) { cut = i + sep.length; break; }
        }
        if (cut <= 0) cut = limit;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
};

// 평문 번역.
// 예전엔 본문을 GET 쿼리스트링에 통째로 실었다 — 상품명은 짧아서 괜찮았지만
// 게시글 본문 길이에서는 URL 한계에 걸려 조용히 실패했다(예외를 삼켜 번역만 비었다).
// POST(form-urlencoded)로 보내고, 그래도 긴 것은 청크로 나눠 이어붙인다.
// 청크 하나를 번역한다. 엔진 선택은 여기 한 곳에서만 갈린다.
const translateChunk = async (chunk, target) => {
    if (GOOGLE_TRANSLATE_API_KEY) {
        // 공식 Cloud Translation v2. format:'text' 로 보내야 &amp; 같은 엔티티가 안 섞인다.
        const { data } = await axios.post(
            `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(GOOGLE_TRANSLATE_API_KEY)}`,
            { q: chunk, source: 'ko', target, format: 'text' },
            { timeout: 20000 }
        );
        return data?.data?.translations?.[0]?.translatedText ?? '';
    }
    const { data } = await axios.post(
        'https://translate.googleapis.com/translate_a/single',
        new URLSearchParams({ client: 'gtx', sl: 'auto', tl: target, dt: 't', q: chunk }).toString(),
        { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return (data?.[0] || []).map((s) => s?.[0]).filter(Boolean).join('');
};

export const gtransText = async (text, target) => {
    const src = String(text ?? '');
    if (!src.trim()) return src;
    let out = '';
    for (const chunk of splitChunks(src)) {
        // 공식 API 는 분당 한도가 넉넉해 간격을 둘 이유가 없다. gtx 만 텀을 둔다.
        if (!GOOGLE_TRANSLATE_API_KEY) {
            const gap = Date.now() - gtransLastAt;
            if (gap < GTRANS_MIN_GAP_MS) await sleep(GTRANS_MIN_GAP_MS - gap);
            gtransLastAt = Date.now();
        }
        LANG_STATS.calls++;
        LANG_STATS.chars += chunk.length;
        out += await translateChunk(chunk, target);
    }
    return out;
};

// HTML 번역 — 태그·속성은 그대로 두고 텍스트 노드만 바꾼다.
// 텍스트 노드를 줄바꿈으로 이어 한 번에 번역한 뒤 다시 나눠 넣는다.
// 조각 수가 안 맞으면 본문이 깨지므로 그 언어는 통째로 포기한다(null 반환 → 원문 유지).
// 깨진 번역보다 번역이 없는 편이 낫다.
export const gtransHtml = async (html, target) => {
    const src = String(html ?? '');
    if (!src.trim()) return src;
    const $ = cheerio.load(src, null, false);
    const nodes = [];
    const walk = (els) => {
        els.each((idx, el) => {
            if (el.type === 'text') {
                if (String(el.data).trim()) nodes.push(el);
            } else if (el.children) {
                walk($(el).contents());
            }
        });
    };
    walk($.root().contents());
    if (nodes.length === 0) return src;

    const texts = nodes.map((n) => String(n.data).replace(/\s+/g, ' ').trim());
    const translated = await gtransText(texts.join('\n'), target);
    const parts = String(translated).split('\n');
    if (parts.length !== texts.length) {
        LANG_STATS.htmlGiveUps++;
        logger.info(`[lang] html 조각수 불일치로 번역 생략 target=${target} 원본=${texts.length} 번역=${parts.length}`);
        return null;
    }
    nodes.forEach((n, i) => { n.data = parts[i]; });
    return $.html();
};

export const settingLangs = async (columns = [], obj = {}, decode_dns = {}, table_name = "", item_id, is_process) => {
    if (decode_dns?.setting_obj?.is_use_lang != 1) {
        return;
    }
    if (is_process) {
        let result = {
            lang_obj: {}
        };
        try {
            const html_columns = HTML_LANG_COLUMNS[table_name] ?? [];
            if (columns.length > 0 && decode_dns?.setting_obj?.is_use_lang == 1) {
                for (var i = 0; i < columns.length; i++) {
                    const column = columns[i];
                    if (!obj[column]) {
                        continue;
                    }
                    const is_html = html_columns.includes(column);
                    // 원문은 ko 슬롯에 보관
                    result.lang_obj[column] = { ko: obj[column] };
                    for (var j = 0; j < LANG_TARGETS.length; j++) {
                        const langCfg = LANG_TARGETS[j];
                        // 브랜드가 켠 언어만 (lang_list 설정 없으면 전체 번역)
                        const enabled = !decode_dns?.setting_obj?.lang_list
                            || decode_dns?.setting_obj?.lang_list?.includes(langCfg.value);
                        if (!enabled) continue;
                        try {
                            const translated = is_html
                                ? await gtransHtml(obj[column], langCfg.use_value)
                                : await gtransText(obj[column], langCfg.use_value);
                            // null 은 '번역 포기'(HTML 조각수 불일치). 그 언어 슬롯을 비워 두면
                            // 화면에서는 formatLang 이 원문으로 폴백한다.
                            if (translated !== null && translated !== undefined) {
                                result.lang_obj[column][langCfg.value] = translated;
                            }
                        } catch (err) {
                            LANG_STATS.fails++;
                            // 요청 과다로 막힌 것이면 이 항목의 남은 언어까지 두드려 봐야
                            // 전부 같은 실패다 — 차단 시각을 남기고 즉시 빠져나온다.
                            // (예전엔 막힌 상태에서도 항목마다 언어 수만큼 계속 호출해
                            //  차단을 연장시키면서 대기열만 축냈다)
                            if (isRateLimited(err)) {
                                LANG_STATS.rate_limited_at = Date.now();
                                logger.error(`[lang] 요청이 차단됨(429/sorry) — 이번 처리 중단 table=${table_name} id=${item_id}`);
                                result.lang_obj = JSON.stringify(result.lang_obj);
                                result.rate_limited = true;
                                return result;
                            }
                            logger.error(`[lang] 번역 실패 table=${table_name} id=${item_id} col=${column} lang=${langCfg.value} :: ${err?.message || err}`);
                        }
                    }
                }
            }
            result.lang_obj = JSON.stringify(result.lang_obj);
            return result;
        } catch (err) {
            logger.error(`[lang] settingLangs 실패 table=${table_name} id=${item_id} :: ${err?.message || err}`);
            result.lang_obj = JSON.stringify(result.lang_obj);
            return result;
        }
    } else {
        try {
            let delete_result = await deleteQuery('lang_processes', {
                table_name: table_name,
                item_id,
            }, true)
            let result = await insertQuery('lang_processes', {
                table_name,
                item_id,
                brand_id: decode_dns?.id,
                obj: JSON.stringify(obj),
            })
            return true;
        } catch (err) {
            console.log(err);
            return false;
        }
    }

}

export const getPayType = (num) => {
    if (num == 1) {
        return {
            title: '카드결제',
            description: 'Mastercard, Visa 등을 지원합니다.',
            type: 'card',
        }
    } else if (num == 2) {
        return {
            title: '인증결제',
            description: '구매를 안전하게 완료하기 위해 인증결제 웹사이트로 리디렉션됩니다.',
            type: 'certification',
        }
    } else if (num == 3) {
        return {
            title: `카드결제test`,
            description: 'Mastercard, Visa 등을 지원합니다.',
            type: 'card_fintree',
        }
    } else if (num == 4) {
        return {
            title: `인증결제test`,
            description: '구매를 안전하게 완료하기 위해 인증결제 웹사이트로 리디렉션됩니다.',
            type: 'certification_fintree',
        }
    } else if (num == 5) {
        return {
            title: `카드결제`,
            description: 'Mastercard, Visa 등을 지원합니다.',
            type: 'hand_oleuda',
        }
    } else if (num == 10) {
        return {
            title: '무통장입금',
            description: '무통장입금 이외의 결제 수단으로 결제하시는 경우 포인트를 적립해드리지 않습니다.',
            type: 'virtual_account',
        }
    } else if (num == 11) {
        return {
            title: '상품권결제',
            description: '실물상품권, 모바일상품권 등을 지원합니다.',
            type: 'gift_certificate',
        }
    } /*else if (num == 20) {
        return {
            title: `카드결제test2`,
            description: 'Mastercard, Visa 등을 지원합니다.',
            type: 'card_weroute',
        }
    }*/ else if (num == 21) {
        return {
            title: `인증결제`,
            description: '구매를 안전하게 완료하기 위해 인증결제 웹사이트로 리디렉션됩니다.',
            type: 'certification_weroute',
        }
    } else if (num == 30) {
        return {
            title: `인증결제`,
            description: '카드결제 등을 지원합니다.',
            type: 'card_hecto',
        }
    } else if (num == 31) {
        return {
            title: `휴대폰결제`,
            description: '휴대폰결제창으로 이동합니다.',
            type: 'phone_hecto',
        }
    } else if (num == 40) {
        return {
            title: `카드결제(페이레터)`,
            description: '신용카드로 결제합니다. (페이레터 테스트 모듈)',
            type: 'card_payletter',
        }
    } else if (num == 41) {
        return {
            title: `인증결제(포스페이)`,
            description: '카드 인증결제를 진행합니다. (포스페이)',
            type: 'auth_forspay',
        }
    } else if (num == 50) {
        return {
            title: 'SMS결제',
            description: '이름과 핸드폰번호를 입력하시면 결제 안내가 전송됩니다.',
            type: 'sms_pay',
        }
    }

    return {
        title: '',
        description: '',
    }
}
export const categoryDepth = 3;

export const makeObjByList = (key, list = []) => {
    let obj = {};
    for (var i = 0; i < list.length; i++) {
        if (!obj[list[i][key]]) {
            obj[list[i][key]] = [];
        }
        obj[list[i][key]].push(list[i]);
    }
    return obj;
}
export const makeChildren = (data_, parent_obj) => {
    let data = data_;
    data.children = parent_obj[data?.id] ?? [];
    if (data.children.length > 0) {
        for (var i = 0; i < data.children.length; i++) {
            data.children[i] = makeChildren(data.children[i], parent_obj);
        }
    }
    return data;
}

export const makeTree = (list_ = [], item = {}) => {// 트리만들기
    let list = list_;
    let parent_obj = makeObjByList('parent_id', list);
    let result = [...(parent_obj[item?.parent_id ?? '-1'] ?? [])];
    for (var i = 0; i < result.length; i++) {
        result[i] = makeChildren(result[i], parent_obj);
    }
    return result;
}

export function findChildIds(data, id) {
    const children = data.filter(item => item.parent_id == id).map(item => item.id);
    children.forEach(child => {
        children.push(...findChildIds(data, child));
    });
    return children;
}
export function findParent(data, item) {
    if (!(item?.parent_id > 0)) {
        return item;
    } else {
        let result = data.filter(itm => itm.id == item.parent_id);
        return findParent(data, result[0]);
    }
}
export function findParents(data, item) {
    if (!(item?.parent_id > 0)) {
        return [];
    } else {
        const parent = data.filter(itm => itm.id == item.parent_id);
        return [...findParents(data, parent[0]), ...parent]
    }
}
export const isParentCheckByUsers = (children, parent, user_list, user_obj_) => {//두 유저가 상하위 관계인지
    let user_obj = user_obj_ || makeObjByList('id', user_list);
    let is_parent = false;
    let user = children;
    let parent_id = user?.parent_id;
    while (true) {
        if (parent_id == -1) {
            break;
        }
        if (parent_id == parent?.id) {
            is_parent = true;
            break;
        }
        user = user_obj[parent_id];
        parent_id = user?.parent_id;
    }
    return is_parent;
}

export const makeUserChildrenList = (user_list_ = [], decode_user) => {// 자기 하위 유저들 자기포함 리스트로 불러오기
    let user_list = user_list_;
    let user_parent_obj = makeObjByList('parent_id', user_list);
    let user_obj = makeObjByList('id', user_list);
    let result = [];
    let start_idx = result.length;
    result = [...result, ...user_obj[decode_user?.id]];
    let result_length = result.length;
    while (true) {
        for (var i = start_idx; i < result_length; i++) {
            if (user_parent_obj[result[i]?.id]) {
                result = [...result, ...user_parent_obj[result[i]?.id]];
            }
        }
        start_idx = result_length;
        result_length = result.length;
        if (start_idx == result_length) {
            break;
        }
    }
    return result;
}

export const homeItemsSetting = (column_, products) => {
    let column = column_;

    let item_list = column?.list ?? [];
    item_list = item_list.map(item_id => {
        return { ...item_id, ..._.find(products, { id: parseInt(item_id) }) }
    })
    column.list = item_list;
    return column;
}
export const homeItemsWithCategoriesSetting = (column_, products) => {
    let column = column_;
    for (var i = 0; i < column?.list.length; i++) {
        let item_list = column?.list[i]?.list;
        item_list = item_list.map(item_id => {
            return { ...item_id, ..._.find(products, { id: parseInt(item_id) }) }
        })
        column.list[i].list = item_list;
    }
    return column;
}
export const getReqIp = (req) => {
    let requestIp;
    try {
        requestIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip || '0.0.0.0'
    } catch (err) {
        requestIp = '0.0.0.0'
    }
    requestIp = requestIp.replaceAll('::ffff:', '');
    return requestIp;
}

// multipart/form-data 로 온 '불리언'을 제대로 해석한다.
//
// 프론트는 apiManager 가 FormData 로 보내므로 모든 값이 문자열로 도착한다.
// 그래서 체크 해제(false)가 문자열 "false" 로 오는데 그건 JS 에서 truthy 다.
// `value ? 1 : 0` 같은 코드는 항상 1 이 되어, 끄려는 설정이 영영 안 꺼진다.
// 같은 이유로 "0" 도 truthy 다.
export const isTruthyFlag = (v) => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = String(v).trim().toLowerCase();
    if (s === '' || s === 'false' || s === '0' || s === 'null' || s === 'undefined') return false;
    return true;
};

// ── 테넌트(브랜드) 경계 가드 ──────────────────────────────────────
// 신원의 근거는 로그인 토큰(token 쿠키)뿐이다. dns 쿠키는 GET /api/domain 으로
// 누구나 발급받으므로 '쓰기 권한' 판단에 써서는 안 된다.
// checkLevel 은 실패 시 false 를 반환할 뿐 throw 하지 않으므로 !decode_user 를 먼저 본다.
export const canWriteBrand = (decode_user, target_brand_id) => {
    if (!decode_user) return false;
    if (Number(decode_user.level) >= 50) return true;      // 개발사만 교차 브랜드 허용
    return Number(decode_user.brand_id) === Number(target_brand_id);
};
// 쓰기에 쓸 brand_id 를 확정한다. body/query 의 brand_id 는 신뢰하지 않는다.
export const resolveWriteBrandId = (decode_user, requested, decode_dns) => {
    // 레벨50(마스터 관리자)은 어느 브랜드에도 속하지 않고 모든 브랜드를 설정할 수 있다.
    // 그래서 토큰의 brand_id 를 쓰면 안 된다 — 비어 있어서 0 으로 저장돼 버린다.
    // 요청에 실린 brand_id 를 그대로 쓰고, 없으면 지금 보고 있는 브랜드(dns)로 둔다.
    if (Number(decode_user?.level) >= 50) {
        if (Number(requested) > 0) return Number(requested);
        return Number(decode_dns?.id ?? 0);
    }
    // 그 외에는 자기 브랜드로 고정한다. body/query 의 brand_id 는 신뢰하지 않는다.
    return Number(decode_user?.brand_id ?? 0);
};
// 대상 행이 호출자 브랜드 소속인지 DB 로 확인한다. 아니면 null.
export const loadOwnedRow = async (pool, table, id, decode_user) => {
    const rows = await pool.query(`SELECT id, brand_id FROM ${table} WHERE id=? LIMIT 1`, [id]);
    const row = rows[0][0];
    if (!row) return null;
    return canWriteBrand(decode_user, row.brand_id) ? row : null;
};
