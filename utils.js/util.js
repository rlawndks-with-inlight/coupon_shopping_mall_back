import crypto from 'crypto';
import util from 'util';
import { pool } from "../config/db.js";
import jwt from 'jsonwebtoken';
import 'dotenv/config';
import { readSync } from 'fs';
import when from 'when';
import _ from 'lodash';
import logger from './winston/index.js';
import axios from 'axios';
import { deleteQuery, insertQuery, updateQuery } from './query-util.js';

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
    let result = await pool.query(
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
            res.status(500).send(resDict)
        } else {
            res.status(200).send(resDict)
        }
    }
}
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
    'id_file',

].map(field => {
    return {
        name: field
    }
})

export const settingLangs = async (columns = [], obj = {}, decode_dns = {}, table_name = "", item_id, is_process) => {
    if (decode_dns?.setting_obj?.is_use_lang != 1) {
        return;
    }
    if (is_process) {
        let result = {
            lang_obj: {}
        };
        try {
            let lang_list = [
                {
                    value: 'en',
                    use_value: 'en'
                },
                {
                    value: 'ja',
                    use_value: 'ja'
                },
                {
                    value: 'vi',
                    use_value: 'vi'
                },
                {
                    value: 'cn',
                    use_value: 'zh-CN'
                },
                {
                    value: 'fr',
                    use_value: 'fr'
                },
                {
                    value: 'ko',
                    use_value: 'ko'
                },
            ]
            let headers = {
                'X-NCP-APIGW-API-KEY-ID': 'thsalld8dc',
                'X-NCP-APIGW-API-KEY': 'aNKVtzTITy7NlbLWqORg3Zt0dI3yMHXTQN22Kx7w',
                'Content-Type': 'application/json; charset=UTF-8',
            }
            let lang_when_list = [];
            if (columns.length > 0 && decode_dns?.setting_obj?.is_use_lang == 1) {
                for (var i = 0; i < columns.length; i++) {
                    if (!obj[columns[i]]) {
                        continue;
                    }
                    let { data: detect } = await axios.post(`https://naveropenapi.apigw.ntruss.com/langs/v1/dect`, {
                        'query': obj[columns[i]],
                    }, {
                        headers
                    })
                    let detect_lang_code = detect?.langCode;
                    let detect_lang = undefined;
                    if (detect_lang_code != 'ko') {
                        detect_lang = await axios.post(`https://naveropenapi.apigw.ntruss.com/nmt/v1/translation`, {
                            'source': detect_lang_code,
                            'target': 'ko',
                            'text': obj[columns[i]],
                        }, {
                            headers
                        })
                        detect_lang_code = 'ko';
                    }
                    result.lang_obj[columns[i]] = {
                        ko: detect_lang?.data?.message?.result?.translatedText || obj[columns[i]]
                    };
                    for (var j = 0; j < lang_list.length; j++) {

                        if (decode_dns?.setting_obj?.lang_list && decode_dns?.setting_obj?.lang_list?.includes(lang_list[j].value) && obj[columns[i]]) {

                            if (detect_lang_code != lang_list[j].use_value && detect?.langCode != lang_list[j].use_value) {
                                try {
                                    lang_when_list.push({
                                        column: columns[i],
                                        lang: lang_list[j].value,
                                        func: await axios.post(`https://naveropenapi.apigw.ntruss.com/nmt/v1/translation`, {
                                            'source': detect_lang_code,
                                            'target': lang_list[j].use_value,
                                            'text': result.lang_obj[columns[i]][detect_lang_code],
                                        }, {
                                            headers
                                        })
                                    })
                                } catch (err) {
                                    console.log(err)
                                }

                            }
                        }
                    }
                }
                for (var i = 0; i < lang_when_list.length; i++) {
                    await lang_when_list[i];
                }
                let when_result = (await when(lang_when_list));
                for (var i = 0; i < when_result.length; i++) {
                    if (!result.lang_obj[when_result[i].column]) {
                        result.lang_obj[when_result[i].column] = {};
                    }
                    result.lang_obj[when_result[i].column] = {
                        ...result.lang_obj[when_result[i].column],
                        [`${when_result[i].lang}`]: when_result[i].func?.data?.message?.result?.translatedText
                    }
                }
            }
            result.lang_obj = JSON.stringify(result.lang_obj);
            return result;
        } catch (err) {
            console.log(err)
            result.lang_obj = JSON.stringify(result.lang_obj);
            return result;
        }
    } else {
        try {
            let delete_result = await deleteQuery('lang_processes', {
                table_name: `'${table_name}'`,
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
    } else if (num == 10) {
        return {
            title: '가상계좌',
            description: '무통장입금 이외의 결제 수단으로 결제하시는 경우 포인트를 적립해드리지 않습니다.',
            type: 'virtual_account',
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
export const setProductPriceByLang = (product_ = {}, price_column = 'product_sale_price', from_lang_ = 'ko', to_lang_ = 'ko') => {
    let product = product_;
    if (typeof product?.price_lang_obj == 'string') {
        product.price_lang_obj = JSON.parse(product?.price_lang_obj ?? '{}');
    }
    let amount = parseFloat(product[price_column] ?? 0);
    let from_lang = from_lang_;
    let to_lang = to_lang_;
    let multiply_obj = {
        'en': 0.00074,
        'cn': 0.0054,
        'vi': 18.42,
        'ja': 0.11,
        'ko': 1,
    }
    if (!Object.keys(multiply_obj).includes(to_lang)) {
        to_lang = 'ko';
    }

    if (from_lang == to_lang) {
        return amount;
    }
    if (from_lang == 'ko') {
        amount = amount * multiply_obj[to_lang]
    } else {
        let decimal_count = countDecimalPlaces(multiply_obj[from_lang]);
        let ten_zekop = Math.pow(10, decimal_count);
        let brother = multiply_obj[from_lang] * ten_zekop;
        amount = (amount * ten_zekop) / brother * multiply_obj[to_lang]
    }
    if (to_lang == 'ko') {
        amount = parseInt(amount);
    }
    return amount;
}
function countDecimalPlaces(number) {
    const numberString = number.toString();
    const decimalIndex = numberString.indexOf('.');

    if (decimalIndex === -1) {
        return 0;
    }

    return numberString.length - decimalIndex - 1;
}