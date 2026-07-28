'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// PII 백필: 기존 행의 평문 PII를 암호화 + blind-index 채움. 멱등(이미 암호화된 행 skip).
//
// 선행: (1) 서버 .env 에 DB_ENCRYPTION_KEY / DB_INDEX_KEY,
//       (2) blind-index 컬럼 DDL 실행(2026-07-28_pii_blind_index.sql).
//
// 사용:
//   node scripts/pii-backfill.js --limit 100          # 소량 시험(전 테이블 각 100행)
//   node scripts/pii-backfill.js --table users        # 특정 테이블만
//   node scripts/pii-backfill.js                       # 전체
//
// 안전: 원문이 이미 암호문이면 건너뜀 → 여러 번 돌려도 안전. 배치 단위 커밋.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { readPool, writePool } from '../config/db-pool.js';
import { encField, isEncrypted, blindIndex } from '../utils.js/crypto-util.js';
import { PII_FIELDS } from '../utils.js/pii.js';

const BATCH = 500;
const argVal = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};
const LIMIT = argVal('--limit') ? Number(argVal('--limit')) : Infinity;

const backfillTable = async (table) => {
    const conf = PII_FIELDS[table];
    if (!conf) { console.log(`[${table}] 설정 없음 — skip`); return; }
    const cols = ['id', ...conf.enc, ...Object.values(conf.idx)];
    let lastId = 0, processed = 0, updated = 0;
    while (processed < LIMIT) {
        const take = Math.min(BATCH, LIMIT - processed);
        const [rows] = await readPool.query(
            `SELECT ${cols.join(',')} FROM ${table} WHERE id > ? ORDER BY id ASC LIMIT ?`,
            [lastId, take]
        );
        if (!rows.length) break;
        for (const row of rows) {
            lastId = row.id;
            processed++;
            const set = {};
            for (const f of conf.enc) {
                const v = row[f];
                if (v === null || v === undefined || v === '') continue;
                if (isEncrypted(v)) continue; // 이미 암호화 → 멱등 skip
                if (conf.idx[f]) set[conf.idx[f]] = blindIndex(v); // 원문 기준 인덱스
                set[f] = encField(v);
            }
            if (Object.keys(set).length > 0) {
                const setSql = Object.keys(set).map((k) => `${k}=?`).join(',');
                await writePool.query(`UPDATE ${table} SET ${setSql} WHERE id=?`, [...Object.values(set), row.id]);
                updated++;
            }
        }
        console.log(`[${table}] processed=${processed} updated=${updated} lastId=${lastId}`);
        if (rows.length < take) break;
    }
    console.log(`[${table}] DONE processed=${processed} updated=${updated}`);
};

const run = async () => {
    if (!process.env.DB_ENCRYPTION_KEY) {
        console.error('중단: DB_ENCRYPTION_KEY 가 설정되지 않았습니다. (키 없이 백필하면 암호화가 안 됨)');
        process.exit(1);
    }
    const one = argVal('--table');
    const tables = one ? [one] : Object.keys(PII_FIELDS);
    for (const t of tables) {
        console.log(`=== backfill ${t} ===`);
        await backfillTable(t);
    }
    console.log('ALL DONE');
    process.exit(0);
};

run().catch((e) => { console.error(e); process.exit(1); });
