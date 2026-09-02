'use strict';

import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import path from "path";
import 'dotenv/config';
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import compression from "compression";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import http from 'http';
import https from 'https';
import scheduleIndex from "./utils.js/schedules/index.js";
import upload, { sanitizeSvgMiddleware } from "./config/multerConfig.js";
import { imageFieldList } from "./utils.js/util.js";
import { fileURLToPath } from 'url';
import fs from 'fs';
import { uploadMultipleFiles } from "./utils.js/api-util.js";
import { initRedis } from "./config/redis-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by'); // 프레임워크 노출(X-Powered-By: Express) 제거 — 나머지 보안 헤더는 nginx 가 붙인다

app.use(compression());
app.use(cors());
// 본문 한도. 예전 100mb 는 모든 API 에 대용량 본문을 허용해 메모리 소진 공격면이었다.
// 디자인관리 저장(blog_obj/shop_obj JSON, 이미지는 URL) 도 수백 KB 수준이라 5mb 면 충분하다. 파일은 multer 가 따로 받는다.
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

// 한 IP 가 분당 300건을 넘기면 막는다. `trust proxy` 를 켜 두었으므로 손님은 각자
// 자기 IP 로 계산된다 — 사람 한 명이 몰을 둘러보는 정도로는 걸리지 않는다.
//
// ⚠ [2026-08-31] 그런데 **프론트 서버만은 예외로 두어야 한다.**
//   프론트는 페이지를 그릴 때마다 `_app.js` 의 getInitialProps 에서 `/api/domain` 을 한 번 부른다.
//   그 호출은 손님 한 명이 아니라 **모든 손님의 페이지 요청이 한 IP(13.125.9.31)로 모인 것**이다.
//   그래서 분당 300건 = **몰 전체가 초당 5페이지**에서 막혔다.
//   넘으면 API 가 429 를 주고, 프론트는 그 응답을 '없는 몰' 로 읽어 **손님에게 404 를 띄웠다**
//   (실측: 동시 20명이면 거의 모든 요청이 404). 오픈 후 사람이 몰리면 몰이 통째로 안 보인다.
//
//   손님별 보호는 그대로 두고 내부 서버만 뺀다. 주소는 환경변수로 바꿀 수 있게 한다.
const 제한제외IP = String(process.env.RATE_LIMIT_SKIP_IPS ?? '13.125.9.31,127.0.0.1,::1,::ffff:127.0.0.1')
    .split(',').map((s) => s.trim()).filter(Boolean);
// 손님의 실제 IP 를 구한다.
//   브라우저 → 프론트 nginx(XFF 에 손님 IP 추가) → Next 프록시(/api rewrite) → 백엔드 nginx(XFF 에 프론트 IP 추가) → 여기.
//   그래서 req.ip 는 늘 프론트 서버(13.125.9.31)다. 예전엔 그 IP 를 통째로 제외해 **브라우저 트래픽엔 리밋이 하나도 안 걸렸다**
//   (실측: 420회 연속 요청 전부 200). 손님 IP 는 XFF 의 '오른쪽에서 두 번째'(프론트 nginx 가 붙인 값)다 —
//   손님이 XFF 를 위조해도 그건 더 왼쪽에 놓이므로 이 값은 못 바꾼다. 그 값이 없으면(프록시가 XFF 를 안 넘긴 경우) 예전대로 제외한다.
const 손님IP = (req) => {
    if (!제한제외IP.includes(req.ip)) return req.ip;
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return xff.length >= 2 ? xff[xff.length - 2] : null;
};
const 리밋공통 = {
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(손님IP(req) ?? req.ip), // IPv6 는 /56 단위로 묶어 키를 만든다(라이브러리 권장)
    skip: (req) => 손님IP(req) === null,
};
const apiLimiter = rateLimit({
    ...리밋공통,
    windowMs: 60 * 1000,
    max: 300,
    message: { result: -429, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.', data: false },
});
app.use('/api', apiLimiter);
// 민감 경로는 더 촘촘히: 로그인·인증문자·비밀번호변경·아이디찾기(무차별 대입), 가맹점 신청(메일 발송 남용).
const authLimiter = rateLimit({
    ...리밋공통, windowMs: 10 * 60 * 1000, max: 30,
    message: { result: -429, message: '시도가 너무 많습니다. 10분 뒤에 다시 시도해주세요.', data: false },
});
app.use(['/api/auth/sign-in', '/api/auth/code', '/api/auth/change-password', '/api/auth/find-id'], authLimiter);
const merchantAppLimiter = rateLimit({
    ...리밋공통, windowMs: 60 * 60 * 1000, max: 5,
    skip: (req) => req.method !== 'POST' || 손님IP(req) === null,
    message: { result: -429, message: '신청이 너무 많습니다. 잠시 후 다시 시도해주세요.', data: false },
});
app.use('/api/merchant-application', merchantAppLimiter);
// 비회원 주문조회(전화번호+주문비밀번호 추측 방지): 조회 파라미터가 있을 때만 센다.
const guestLookupLimiter = rateLimit({
    ...리밋공통, windowMs: 10 * 60 * 1000, max: 30,
    skip: (req) => !(req.query?.buyer_phone || req.query?.ord_num) || 손님IP(req) === null,
    message: { result: -429, message: '조회 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.', data: false },
});
app.use('/api/transactions', guestLookupLimiter);
// express.json() 제거됨 - bodyParser.json()이 동일 역할 수행

// 한글 자소 분리(NFD) → 조합형(NFC) 정규화 미들웨어
const normalizeNFC = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].normalize('NFC');
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      normalizeNFC(obj[key]);
    }
  }
  return obj;
};
app.use((req, res, next) => {
  if (req.body) normalizeNFC(req.body);
  if (req.query) normalizeNFC(req.query);
  next();
});

// SVG 파일을 브라우저에서 직접 실행하지 못하도록 Content-Security-Policy 적용
app.use('/files', (req, res, next) => {
  if (req.path.toLowerCase().endsWith('.svg')) {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  next();
});
app.use('/files', express.static(__dirname + '/files'));
//app.post('/api/upload/multiple', upload.array('post_file'), uploadMultipleFiles);

app.use('/api', upload.fields(imageFieldList), sanitizeSvgMiddleware, routes);

app.get('/', (req, res) => {
  console.log("back-end initialized")
  res.send('back-end initialized')
});

/*app.use((req, res, next) => {
  const err = new APIError('API not found', httpStatus.NOT_FOUND);
  return next(err);
});*/

const HTTP_PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const HTTPS_PORT = 8443;

// SSL을 이 서버가 직접 물고 https로 뜰지 여부.
//  - 기존 cafe24 운영: .env 에 SSL_ENABLED=true (+선택 SSL_CERT_DIR) → letsencrypt 인증서로 https 8443 (기존 동작 유지)
//  - AWS(nginx 리버스 프록시 뒤): SSL_ENABLED 미설정 → http로 뜨고 SSL 종료는 nginx가 담당
const SSL_ENABLED = process.env.SSL_ENABLED === 'true';
const SSL_CERT_DIR = process.env.SSL_CERT_DIR || '/etc/letsencrypt/live/purplevery22.cafe24.com';


// 개인정보 암호화 키가 있는지 뜰 때 한 번 크게 확인한다.
//
// [왜 필요한가]
// crypto-util 의 encField 는 키가 없으면 **평문을 그대로 돌려준다**(`if (!key) return plaintext`).
// 롤아웃 중 깨지지 않게 한 의도된 설계지만, 뒤집어 말하면 .env 에서 그 한 줄이 사라져도
// 오류도 경고도 없이 회원 이름·전화·주소가 평문으로 쌓인다는 뜻이다. 겉으로는 아무 증상이 없다.
// 그래서 여기서 소리를 낸다. 서버를 못 뜨게 막지는 않는다 — 그건 더 큰 사고다.
const 개인정보키확인 = () => {
    const 키 = process.env.DB_ENCRYPTION_KEY || '';
    const 길이맞나 = /^[A-Fa-f0-9]{64}$/.test(키)
        || Buffer.from(키, 'base64').length === 32
        || Buffer.from(키, 'utf8').length === 32;
    if (키 && 길이맞나) return;
    const 이유 = 키 ? '길이가 32바이트가 아니다' : '.env 에 없다';
    console.error('');
    console.error('****************************************************************');
    console.error('*  DB_ENCRYPTION_KEY 를 쓸 수 없다 — ' + 이유);
    console.error('*  회원 이름·전화·주소가 **평문으로** 저장된다. 지금 .env 를 확인할 것.');
    console.error('*  (hex 64자 / base64 44자 / 원문 32자 중 하나여야 한다)');
    console.error('****************************************************************');
    console.error('');
};

async function bootstrap() {
  try {

    개인정보키확인();
    await initRedis();

    let server;

    if (process.env.NODE_ENV === 'development') {
      // 로컬 개발: HTTP, 스케줄러 off
      server = http.createServer(app).listen(HTTP_PORT, function () {
        console.log("**-------------------------------------**");
        console.log(`====      Server is On ${HTTP_PORT} (dev/http)...!!!    ====`);
        console.log("**-------------------------------------**");
        // scheduleIndex();
      });
    } else if (SSL_ENABLED) {
      // 운영(자체 HTTPS): letsencrypt 인증서로 https listen (기존 cafe24 동작)
      const options = {
        ca: fs.readFileSync(`${SSL_CERT_DIR}/fullchain.pem`),
        key: fs.readFileSync(`${SSL_CERT_DIR}/privkey.pem`),
        cert: fs.readFileSync(`${SSL_CERT_DIR}/cert.pem`),
      };
      server = https.createServer(options, app).listen(HTTPS_PORT, function () {
        console.log("**-------------------------------------**");
        console.log(`====      Server is On ${HTTPS_PORT} (https)...!!!    ====`);
        console.log("**-------------------------------------**");
        scheduleIndex();
      });
    } else {
      // 운영(리버스 프록시 뒤): HTTP로 뜨고 SSL은 nginx가 종료. 스케줄러 on.
      server = http.createServer(app).listen(HTTP_PORT, function () {
        console.log("**-------------------------------------**");
        console.log(`====      Server is On ${HTTP_PORT} (prod/http behind proxy)...!!!    ====`);
        console.log("**-------------------------------------**");
        scheduleIndex();
      });
    }

    return server;
  } catch (err) {
    console.error("서버 시작 중 에러 발생:", err);
    process.exit(1);
  }
}

bootstrap();
