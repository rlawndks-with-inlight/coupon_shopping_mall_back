import mysql from 'mysql2';
import 'dotenv/config';

// 풀 하나가 잡을 수 있는 커넥션 수.
//
// [왜 낮췄나 — 2026-08-27]
// 예전 값은 100 이었다. 그런데 pm2 가 cluster 모드로 **2 인스턴스**를 띄우고,
// 인스턴스마다 읽기·쓰기 풀을 따로 두므로 최대치는
//     2 인스턴스 × (읽기 100 + 쓰기 100) = 400
// 이다. MySQL 의 max_connections 는 500 이라 여유가 100 밖에 없었다.
// 관리자 도구·배치·다른 클라이언트가 그 100 을 나눠 쓰다 넘기면
// 'Too many connections' 로 **몰 전체가 멈춘다**.
//
// 실측(134.7일 가동): 동시 접속 최대기록 105, 평소 37. 쿼리 왕복은 2.4ms 라
// 커넥션 하나가 초당 수백 건을 처리한다 — 50 이면 지금 부하의 몇 배도 감당한다.
//     2 × (50 + 50) = 200  → max_connections 500 중 300 을 남긴다.
//
// ⚠ 이 값은 **고갈을 막는 것**이지 커넥션이 죽는 문제를 고치지 못한다. 헷갈리지 말 것.
//   실측 시점의 커넥션은 37개(전부 이 앱)라 상한을 100 → 50 으로 낮춰도 지금 노는 수는 그대로다.
//   풀은 필요할 때 만들고 한번 만들면 줄이지 않으므로, 상한은 '몰릴 때 어디까지 벌어지나' 만 정한다.
//
//   커넥션이 죽는 문제는 따로였다: mysql2 가 **2.3.3** 이라 idleTimeout·maxIdle 이 없었다(3.x 부터).
//   놀던 커넥션이 중간 장비에 끊겨도 풀이 그대로 들고 있다가 다시 꺼내 썼다.
//   그 자국이 'packets out of order'(운영 로그 91건)·Aborted_clients 5,504건(하루 ~41건)이다.
//   → 2026-08-27 mysql2 를 3.24.2 로 올리고 아래 두 옵션을 켰다.
const 커넥션상한 = parseInt(process.env.DB_POOL_SIZE ?? '50') || 50;
// 놀고 있는 커넥션을 언제 닫을 것인가 (mysql2 3.x 부터).
//
// [왜 필요한가]
// DB 는 AWS 밖의 공인 IP(다른 데이터센터)에 있고 백엔드는 EC2 에 있다. 즉 커넥션이
// 인터넷을 건너간다 — 중간의 NAT·방화벽은 오래 논 TCP 흐름을 **말없이** 버린다.
// 풀은 그걸 모르고 죽은 소켓을 다시 꺼내 쓰고, 그때 'packets out of order' 가 난다.
// 먼저 우리가 깔끔하게 닫아 버리면 그런 소켓이 애초에 남지 않는다.
//
// 노는시간: 3분. 중간 장비가 보통 5~10분에 버리므로 그보다 짧아야 의미가 있다.
//   새로 여는 값은 실측 23ms 라, 닫았다 다시 열어도 사람이 느낄 만한 비용이 아니다.
// 놀리는수: 10. 실측 정상상태가 풀 하나당 9개쯤이었다 — 평소 쓰는 만큼은 따뜻하게 두고,
//   몰려서 벌어진 나머지는 일이 끝나는 즉시 닫는다.
const 노는시간 = parseInt(process.env.DB_IDLE_TIMEOUT ?? '180000') || 180000;
const 놀리는수 = parseInt(process.env.DB_MAX_IDLE ?? '10') || 10;


const writeDB = mysql.createPool({
    host: process.env.DB_HOST,
    password: process.env.DB_PASSWORD,
    user: process.env.DB_USER,
    database: process.env.DB_DATABASE,
    port: 3306,
    charset: 'utf8mb4',
    connectionLimit: 커넥션상한,
    idleTimeout: 노는시간,
    maxIdle: 놀리는수,
    queueLimit: 200,
    waitForConnections: true,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
});

const readDB = mysql.createPool({
    host: process.env.READ_DB_HOST,
    password: process.env.READ_DB_PASSWORD,
    user: process.env.READ_DB_USER,
    database: process.env.READ_DB_DATABASE,
    port: 3306,
    charset: 'utf8mb4',
    connectionLimit: 커넥션상한,
    idleTimeout: 노는시간,
    maxIdle: 놀리는수,
    queueLimit: 200,
    waitForConnections: true,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    dateStrings: true
});

const writePool = writeDB.promise();
const readPool = readDB.promise();

// mysql2 는 실패한 쿼리 오류(err)에 '값이 박힌 완성 SQL'(err.sql) 을 실어 준다.
// 컨트롤러 catch 블록 대부분이 JSON.stringify(err) / console.log(err) 로 통째로 찍으므로,
// users/transactions/payment_modules 저장이 실패하면 비밀번호 해시·암호화 PII·pay_key 가
// 로그(logs/error 30일 + pm2 out)에 남는다. 풀 단계에서 err.sql 을 떼어 모든 호출처를 한 번에 막는다.
// (진단에는 err.code / err.sqlMessage 로 충분하다)
const stripSqlFromError = (pool) => {
    const origQuery = pool.query.bind(pool);
    const origExecute = pool.execute.bind(pool);
    const wrap = (fn) => async (...args) => {
        try {
            return await fn(...args);
        } catch (e) {
            if (e && typeof e === 'object' && 'sql' in e) { try { delete e.sql; } catch (_) { /* noop */ } }
            throw e;
        }
    };
    pool.query = wrap(origQuery);
    pool.execute = wrap(origExecute);
    return pool;
};
stripSqlFromError(writePool);
stripSqlFromError(readPool);

// 뜰 때 DB 에 한 번 닿아 본다.
//
// ⚠ 예전 이 자리는 `readPool.getConnection((err, conn) => ...)` 였다. readPool 은
//   **promise 풀**이라 콜백을 받지 않는다 — 그래서 이 콜백은 한 번도 불리지 않았고
//   'DB connected' 도 'DB CONNECT ERROR' 도 로그에 뜬 적이 없다. 죽은 코드였다.
//   로그에 아무것도 없는 것을 '조용히 잘 돌고 있다'로 읽으면 안 된다.
readPool
    .getConnection()
    .then((conn) => {
        console.log('DB connected');
        conn.release();
    })
    .catch((err) => {
        console.error('DB CONNECT ERROR:', {
            code: err.code,
            errno: err.errno,
            syscall: err.syscall,
            address: err.address,
            port: err.port,
            fatal: err.fatal,
        });
    });

export {
    writePool,
    readPool,
};