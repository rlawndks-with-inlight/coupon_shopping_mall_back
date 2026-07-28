# PII 암호화 배포 런북 (Phase 4)

회원 실명·전화, 주문자명·전화·주소, 주소록, 전화 허용목록을 AES-256-GCM으로 암호화한다.
`crypto-util`은 **키 없으면 평문 통과(무해)** 이며, `decField`는 평문/암호문을 자동 판별하므로
평문·암호문 **혼재 상태에서 무중단 롤아웃**이 가능하다.

## 암호화 대상 (utils.js/pii.js)
| 테이블 | 암호화 컬럼 | blind-index |
|---|---|---|
| users | name, phone_num | name_idx, phone_idx |
| transactions | buyer_name, buyer_phone, addr, detail_addr, receiver, receiver_phone | buyer_name_idx, buyer_phone_idx |
| user_addresses | addr, detail_addr, receiver, phone | (없음 — 검색 안 함) |
| phone_registration | phone_number | phone_idx |

## 선행조건
- [x] 서버 `.env`에 `DB_ENCRYPTION_KEY`, `DB_INDEX_KEY` (완료) — 로컬과 동일 값, `pm2 restart back --update-env` 완료.
- [ ] (권장) DB 백업. ※백필은 원문→암호문 **일방향**이라, 키 분실/버그 시 복구 불가. 백업 5분 = 보험.

## 배포 순서 (반드시 이 순서)

### 1) blind-index 컬럼 DDL — **코드 배포보다 먼저**
```
mysql -h 211.45.163.83 -u inuk -p comagain_shop < migrations/2026-07-28_pii_blind_index.sql
```
⚠ 이 컬럼이 없는 채로 새 코드가 배포되면 `encForSave`가 `Unknown column 'phone_idx'` 로 **모든 회원/주문 저장 실패**.
(`1681 Integer display width deprecated` 경고는 기존 정수컬럼 때문 — 무시)

### 2) 백엔드 코드 배포 (이중기록 + 읽기 복호화 + 전환기 안전조회)
```
git pull && npm install && pm2 restart back --update-env
```
- 이 시점부터 **신규 저장분은 암호화** + blind-index 기록. 기존 행은 평문 유지(백필 전).
- 읽기는 `decField`가 평문/암호문 자동 처리 → 화면 정상.
- 전화 조회(로그인 아이디/비번찾기, phone_registration, 비회원 주문조회)는 `(평문=? OR idx=?)` 라 **기존 평문행·신규 암호행 모두 매칭**.

### 3) 배포 직후 검증 (백필 전, 아직 되돌리기 쉬움)
- [ ] 회원가입 → 로그인 → 마이페이지 이름·전화 정상 표시
- [ ] 아이디찾기 / 비번찾기 (전화 인증) 동작
- [ ] 주문(결제) → 주문내역·주문상세 이름·전화·주소 정상
- [ ] **비회원 주문조회(전화번호+비번)** 동작
- [ ] 어드민: 회원목록·주문목록·셀러목록·정산 이름/전화 정상 표시(암호문 아님)
- [ ] (seller 모드) 전화 허용목록·JOIN 정상
- DB에서 새로 만든 회원 `name`이 `enc:v1:...` 인지 확인.

### 4) 백필 (기존 행 암호화 + 인덱스)
```
node scripts/pii-backfill.js --limit 100      # 먼저 소량 시험(전 테이블 각 100행)
```
→ 검증(위 항목 + 백필된 행 조회) 후 전체:
```
node scripts/pii-backfill.js                   # 전체(멱등 — 여러 번 안전)
```
- 멱등: 이미 암호화된 행은 skip. 배치(500)·id 페이지네이션.

### 5) (선택, 나중) 검색 축 정리
- 이름·전화 **부분검색**은 암호화로 불가(설계상 수용). 대체축: 주문검색=주문번호·아이디·승인번호, 회원검색=아이디·닉네임.
- 원하면 추후 이름/전화 **정확일치 검색**을 blind-index로 추가 가능(현재 미적용).

## 롤백
- 백필 전: 코드 revert + 신규 암호행은 `decField`가 계속 읽어줌(무해). 필요시 컬럼 DROP(migrations 파일 하단).
- 백필 후: 백업 복원.

## 알려진 한계 (수용)
- 어드민 이름/전화 **부분검색** 불가(정확일치도 검색엔 미적용) → 주문번호·아이디 등으로 대체.
- `products.consignment_none_user_name/phone`(위탁 비회원 정보)은 암호화 범위 밖(그대로 평문).
- `search-columns.js`가 여전히 암호화 컬럼을 FULLTEXT로 참조 → 그 컬럼 검색은 신규 암호행을 못 잡음(에러는 아님).
