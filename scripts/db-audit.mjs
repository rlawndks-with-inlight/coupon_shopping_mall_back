// SQL 이 '실제로는 없는 컬럼/테이블' 을 건드리는 곳을 눌러 보기 전에 찾는다.
//
//   npm run db-audit
//
// 왜 필요한가:
//   부분취소가 죽어 있던 이유가 정확히 이것이었다. getCancelState 가
//   transactions.delivery_fee 를 골랐는데 그 컬럼은 옆 테이블에만 있었다.
//   한 칼럼 때문에 조회가 통째로 죽어 '주문 정보를 불러오지 못했습니다' 만 떴고,
//   실행 경로도 같은 함수를 쓰므로 부분취소는 **한 번도 동작한 적이 없었다**.
//   화면·금액계산·PG 연동은 전부 멀쩡했다.
//
//   SQL 은 문자열이다. 편집기도 빌드도 타입검사도 아무 말을 안 한다.
//   DB 에 물어봐야만 드러나고, 그래서 사람이 그 화면을 누를 때까지 조용하다.
//
// ⚠ 이 스크립트는 **읽기만 한다**(information_schema 조회 + 소스 파싱).
//    .env 의 DB 를 그대로 보므로 운영 DB 를 향할 수 있다 — 쓰기 구문을 넣지 말 것.
//    DB 가 필요해서 프론트의 npm test 에는 넣지 않는다. 배포 전에 손으로 돌린다.
//
// 판정은 보수적으로 한다. 조인·별칭·서브쿼리가 섞인 쿼리는 건너뛴다 —
// 잘못 울리면 아무도 안 보게 된다. 놓치더라도 조용한 오탐보다 낫다.
//
// 알려진 잔소리:
//   utils.js/util.js  INSERT INTO logs — logs 테이블은 없다. 부르는 곳이 통째로
//   주석 처리된 죽은 코드다(logRequestResponse). 지우기 전까지는 계속 뜬다.
import { readPool } from '../config/db-pool.js';
import { readdirSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// 어디서 실행하든 저장소 뿌리를 본다(cd 위치에 기대지 않는다).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 실제 스키마 ────────────────────────────────────────────────────────────
const [rows] = await readPool.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`);
const 스키마 = new Map();
for (const r of rows) {
    if (!스키마.has(r.TABLE_NAME)) 스키마.set(r.TABLE_NAME, new Set());
    스키마.get(r.TABLE_NAME).add(r.COLUMN_NAME);
}

// ── 소스 훑기 ──────────────────────────────────────────────────────────────
const 훑기 = (d, out = []) => {
    for (const f of readdirSync(d)) {
        if (f === 'node_modules' || f === '.git' || f.startsWith('_tmp')) continue;
        const p = d + '/' + f;
        if (statSync(p).isDirectory()) 훑기(p, out);
        else if (/\.js$/.test(f)) out.push(p);
    }
    return out;
};

const 식별자 = /^[a-z_][a-z0-9_]*$/i;
const 문제 = [];
const 본표 = new Set();

const 확인 = (파일, 표, 컬럼들, 종류) => {
    if (!스키마.has(표)) {
        // 동적 테이블명(${table_name})은 리터럴이 아니므로 여기 안 온다.
        문제.push(`${파일}  [${종류}] 테이블 없음: ${표}`);
        return;
    }
    본표.add(표);
    const 있는것 = 스키마.get(표);
    const 없는것 = 컬럼들.filter((c) => !있는것.has(c));
    if (없는것.length) 문제.push(`${파일}  [${종류}] ${표} → 없는 컬럼: ${없는것.join(', ')}`);
};

// 주석 안의 SQL 은 안 돈다 — 세면 죽은 코드가 살아 있는 것처럼 보인다.
const 주석뺀 = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

for (const p of 훑기(ROOT)) {
    const 파일 = p.replace(ROOT + '/', '').replace(/\\/g, '/');
    const src = 주석뺀(readFileSync(p, 'utf8'));

    // INSERT INTO t (a, b, c)
    for (const m of src.matchAll(/INSERT\s+(?:IGNORE\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
        const 컬럼들 = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        if (!컬럼들.every((c) => 식별자.test(c))) continue;   // ${} 나 함수가 섞이면 건너뛴다
        확인(파일, m[1], 컬럼들, 'INSERT');
    }

    // UPDATE t SET a=?, b=?   (조인·${} 없는 단순한 것만)
    for (const m of src.matchAll(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([^`;]*?)\s+WHERE/gi)) {
        if (/\$\{|JOIN|SELECT/i.test(m[2])) continue;
        const 컬럼들 = m[2].split(',')
            .map((s) => s.split('=')[0].trim())
            .filter(Boolean);
        if (!컬럼들.every((c) => 식별자.test(c))) continue;
        확인(파일, m[1], 컬럼들, 'UPDATE');
    }

    // SELECT a, b, c FROM t   (별칭·조인·함수 없는 것만)
    for (const m of src.matchAll(/SELECT\s+([^`]*?)\s+FROM\s+([a-z_][a-z0-9_]*)\s+WHERE/gi)) {
        const 목록 = m[1];
        if (/\*|\$\{|\(|\bAS\b|\bJOIN\b|\./i.test(목록)) continue;
        const 컬럼들 = 목록.split(',').map((s) => s.trim()).filter(Boolean);
        if (!컬럼들.length || !컬럼들.every((c) => 식별자.test(c))) continue;
        확인(파일, m[2], 컬럼들, 'SELECT');
    }
}

console.log(`검사한 테이블 ${본표.size}개 · 스키마 테이블 ${스키마.size}개`);
if (문제.length) {
    console.log(`\n⚠ 어긋난 곳 ${문제.length}건`);
    for (const x of [...new Set(문제)].sort()) console.log('  ' + x);
} else {
    console.log('\n어긋난 곳 없음');
}
process.exit(0);
