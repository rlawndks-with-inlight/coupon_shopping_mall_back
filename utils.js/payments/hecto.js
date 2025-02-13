import crypto from 'crypto'
import 'dotenv/config'

const apiHost = 'https://tbgw.settlebank.co.kr';
const mid = 'pgSettle30y739r82jtd709yOfZ2yK5K'; // 테스트 MID
const apiKey = 'ST1009281328226982205'; // 테스트 API 키

// ✅ 환경 변수에서 암호화 키 및 IV 값을 가져오기 (또는 기본값 설정)
const encryptionKey = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; // 32바이트 키
const iv = process.env.IV || '1234567890123456'; // 16바이트 IV

const encryptParams = (params) => {
    if (!encryptionKey || !iv) {
        throw new Error("Encryption key or IV is missing!"); // 오류 발생 시 명확한 메시지 출력
    }

    return Object.entries(params).reduce((acc, [key, value]) => {
        if (value === null) return acc;
        try {
            // ✅ Buffer 변환 후 사용
            const keyBuffer = Buffer.from(encryptionKey, 'utf8');
            const ivBuffer = Buffer.from(iv, 'utf8');

            const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, ivBuffer);
            let encrypted = cipher.update(String(value), 'utf8', 'base64');
            encrypted += cipher.final('base64');
            acc[key] = encrypted;
        } catch (err) {
            console.error(`Encryption error for key ${key}:`, err);
            acc[key] = ''; // 실패 시 빈 문자열 반환
        }
        return acc;
    }, {});
};

const generateHash = (mid, method, ordNum, ymd, his, amount) => {
    const data = `${mid}${method}${ordNum}${ymd}${his}${amount}${apiKey}`;
    return crypto.createHash('sha256').update(data).digest('hex');
};


const index = async () => {
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const his = new Date().toTimeString().slice(0, 8).replace(/:/g, '');

    const encParams = paymentController.encryptParams({
        trdAmt: amount,
        mchtCustNm: buyer_name,
        cphoneNo: buyer_phone,
        email: null,
        taxAmt: null,
        vatAmt: null,
        taxFreeAmt: null,
        svcAmt: null,
        clipCustNm: null,
        clipCustCi: null,
        clipCustPhoneNo: null
    });

    const settleParams = {
        ...encParams,
        mchtId: process.env.SETTLE_MERCHANT_ID,
        method: 'card',
        trdDt: ymd,
        trdTm: his,
        mchtTrdNo: ord_num,
        mchtName: process.env.SETTLE_MERCHANT_ID,
        mchtEName: process.env.SETTLE_MERCHANT_ID,
        pmtPrdtNm: item_name,
        instmtMon: "00", // 일시불
        custIp: req.ip,
        skipCd: 'Y',
        multiPay: '',
        autoPayType: '',
    };



    settleParams.pktHash = paymentController.generateHash(
        process.env.SETTLE_MERCHANT_ID,
        'card',
        ord_num,
        ymd,
        his,
        amount
    );

    req.body.settleParams = settleParams;
}
index()
