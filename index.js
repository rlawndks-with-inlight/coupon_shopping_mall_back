'use strict';

import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import path from "path";
import 'dotenv/config';
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import compression from "compression";
import rateLimit from "express-rate-limit";
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

app.use(compression());
app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));
app.use(cookieParser());

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { result: -429, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.', data: false },
});
app.use('/api', apiLimiter);
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

const HTTP_PORT = 8000;
const HTTPS_PORT = 8443;

async function bootstrap() {
  try {

    await initRedis();

    let server;

    if (process.env.NODE_ENV === 'development') {
      server = http.createServer(app).listen(HTTP_PORT, function () {
        console.log("**-------------------------------------**");
        console.log(`====      Server is On ${HTTP_PORT}...!!!    ====`);
        console.log("**-------------------------------------**");
        // scheduleIndex();
      });
    } else {
      const options = {
        ca: fs.readFileSync("/etc/letsencrypt/live/purplevery22.cafe24.com/fullchain.pem"),
        key: fs.readFileSync("/etc/letsencrypt/live/purplevery22.cafe24.com/privkey.pem"),
        cert: fs.readFileSync("/etc/letsencrypt/live/purplevery22.cafe24.com/cert.pem"),
      };
      server = https.createServer(options, app).listen(HTTPS_PORT, function () {
        console.log("**-------------------------------------**");
        console.log(`====      Server is On ${HTTPS_PORT}...!!!    ====`);
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
