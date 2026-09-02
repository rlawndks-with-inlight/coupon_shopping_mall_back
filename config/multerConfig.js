import multer from 'multer';
import sharp from 'sharp';
import { checkDns, checkLevel } from '../utils.js/util.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { returnMoment } from '../utils.js/function.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import fs from 'fs';

const storage = multer.diskStorage({
        destination: function (req, file, cb) {
                // fieldname에서 경로 조작 문자 제거
                const safeFieldname = file.fieldname.split('_file')[0].replace(/[^a-zA-Z0-9_-]/g, '');
                let destination = __dirname + `/../files/${safeFieldname}/`;
                let full_destination = `${destination}${returnMoment().slice(0, 10).replaceAll(' ', '').replaceAll('-', '')}/`;
                let is_exist_destination = fs.existsSync(destination);
                if (!is_exist_destination) {
                        fs.mkdirSync(destination);
                }
                let is_exist_full_destination = fs.existsSync(full_destination);
                if (!is_exist_full_destination) {
                        fs.mkdirSync(full_destination);
                }
                cb(null, `${full_destination}`);
        },
        filename: function (req, file, cb) {
                const decode_user = checkLevel(req.cookies.token, 0);
                const decode_dns = checkDns(req.cookies.dns);
                let user_id = "";
                if (decode_user) {
                        user_id = `${decode_user?.id}`;
                }
                let file_type = "";
                if (file.mimetype.includes('pdf')) {
                        file_type = 'pdf';
                } else if (file.mimetype.includes('svg')) {
                        file_type = 'svg';
                } else {
                        file_type = 'jpeg';
                }
                const safeFieldname = file.fieldname.split('_file')[0].replace(/[^a-zA-Z0-9_-]/g, '');
                cb(null, Date.now() + user_id + `-${safeFieldname}${decode_dns?.id}.` + file_type)
        }
})
const fileFilter = (req, file, cb) => {
        let typeArray = file.mimetype.split('/')
        let filetype = typeArray[1]
        if (
                filetype == 'jpg' ||
                filetype == 'png' ||
                filetype == 'gif' ||
                filetype == 'jpeg' ||
                filetype == 'bmp' ||
                filetype == 'mp4' ||
                filetype == 'avi' ||
                filetype == 'webp' ||
                filetype == 'ico' ||
                filetype == 'pdf' ||
                filetype == 'svg' ||
                filetype == 'svg+xml' ||
                filetype == 'haansoftpdf'
        )
                return cb(null, true)

        console.log('확장자 제한: ', filetype)
        req.fileValidationError = "파일 형식이 올바르지 않습니다(.jpg, .png, .gif 만 가능)"
        cb(null, false, new Error("파일 형식이 올바르지 않습니다(.jpg, .png, .gif 만 가능)"))
}
// SVG 파일에서 스크립트 및 위험 요소 제거
function sanitizeSvg(filePath) {
        try {
                let content = fs.readFileSync(filePath, 'utf8');
                // script 태그 제거
                content = content.replace(/<script[\s\S]*?<\/script>/gi, '');
                content = content.replace(/<script[^>]*\/>/gi, '');
                // on* 이벤트 핸들러 제거 (onclick, onload, onerror 등)
                content = content.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
                content = content.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
                // javascript: URI 제거
                content = content.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""');
                content = content.replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, 'xlink:href=""');
                // foreignObject 태그 제거 (HTML 삽입 가능)
                content = content.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
                fs.writeFileSync(filePath, content, 'utf8');
        } catch (e) {
                console.error('SVG sanitize error:', e.message);
        }
}

const upload = multer({
        storage: storage,
        fileFilter: fileFilter,
        // 이 multer 는 /api 전체에 걸려 있어(index.js) 인증 전 익명 요청도 파일을 디스크에 받는다.
        // 예전 한도(100MB × 무제한 개수)면 익명 요청 몇 번으로 디스크·메모리를 채울 수 있었다.
        // 실제 이미지는 Cloudinary 로 가므로(이 경로는 레거시) 넉넉하되 제한된 값으로 내린다.
        limits: {
                fileSize: 20 * 1024 * 1024,   // 파일 1개 20MB
                fieldSize: 5 * 1024 * 1024,   // 텍스트 필드 5MB
                files: 20,                    // 요청당 파일 20개
                parts: 500,                   // 필드+파일 합계
        }
});

// SVG 업로드 후처리 미들웨어
export function sanitizeSvgMiddleware(req, res, next) {
        if (req.files) {
                const allFiles = Object.values(req.files).flat();
                for (const file of allFiles) {
                        if (file.mimetype && file.mimetype.includes('svg')) {
                                sanitizeSvg(file.path);
                        }
                }
        }
        next();
}

export default upload