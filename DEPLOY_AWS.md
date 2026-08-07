# 백엔드 AWS 이전 런북 — 최종 (api.shopgo.co.kr)

> **확정 구성**: 만료된 백엔드를 **새 AWS EC2 하나**(공유 멀티테넌트 백엔드)로 이전.
> 공개 도메인 **`api.shopgo.co.kr`** + nginx/certbot HTTPS. DB(211.45.163.83)·프론트(shopgo.co.kr, AWS 13.125.9.31)는 유지.

## 왜 공개 도메인인가 (결정 근거)
- 백엔드는 **여러 브랜드가 공유**하는 API(DB `comagain_shop` 하나에 88개 브랜드).
- **외부 결제사가 백엔드로 인바운드 POST**: `POST /api/pay/payletter/callback`, `GET|POST /api/transactions/noti/`(끝 슬래시 필수) → 고정 공개 HTTPS URL 필수. 사설IP 불가.
- 라이브 이미지는 대부분 클라우드(Naver Object Storage/Cloudinary/S3) → 백엔드 이전과 무관. **대규모 DB URL 치환 불필요.**

## 아키텍처
```
브라우저/결제사 ─HTTPS─▶ nginx(443, certbot) [새 백엔드 EC2, Elastic IP]  api.shopgo.co.kr
                          └─ proxy → node HTTP 127.0.0.1:8000 (pm2 cluster) + Redis
                                          │ 3306
                                          ▼
                            211.45.163.83  MySQL comagain_shop (유지)

프론트들(shopgo.co.kr 등) ── BACK_URL=https://api.shopgo.co.kr ──▶ 위 백엔드
```

---

## 1. EC2 생성 (콘솔)
| 항목 | 값 |
|---|---|
| Name | `shopgo-back` |
| AMI | Ubuntu Server 22.04 LTS |
| Type | t3.medium(2vCPU/4GB)↑ (여유 t3.large) |
| VPC | 아무거나(default OK) — 공개라 무관 |
| Auto-assign public IP | Enable |
| Storage | 30 GiB↑ (gp3) |
| Key pair | SSH용 생성/선택(.pem 저장) |

**Elastic IP**: 할당 후 이 인스턴스에 연결(고정 공개 IP — DNS/ DB화이트리스트가 재부팅에 안 깨지게).

**보안그룹 인바운드:**
| Port | Source | 용도 |
|---|---|---|
| 22 | My IP | SSH |
| 80 | 0.0.0.0/0 | certbot 발급/갱신 + 443 리다이렉트 |
| 443 | 0.0.0.0/0 | API·이미지·결제 웹훅 |
> 8000은 열지 않음(nginx가 localhost로만 프록시).

## 2. DNS 레코드
`shopgo.co.kr` DNS 관리 콘솔(Route53 등)에서:
```
A   api.shopgo.co.kr   →   <Elastic IP>
```
전파 확인: `nslookup api.shopgo.co.kr` → EIP 나오면 진행. (certbot 전에 반드시 전파 완료)

## 3. 서버 프로비저닝 (SSH 후)
```bash
sudo apt update && sudo apt -y upgrade
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential libvips-dev redis-server nginx
sudo systemctl enable --now redis-server
sudo snap install --classic certbot && sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo npm install -g pm2
node -v && redis-cli ping   # v20.x / PONG
```

## 4. 코드 배포 (git clone + config/.env 별도 전송)
> ⚠️ `config/`와 `.env`는 `.gitignore`라 **clone에 없다.** 반드시 로컬에서 따로 올려야 함. index.js HTTP모드 수정은 이미 `rladlsdnr`에 커밋됨.

서버(SSH)에서:
```bash
cd ~
git clone https://github.com/rlawndks-with-inlight/coupon_shopping_mall_back back
cd back && git checkout rladlsdnr      # 운영 브랜치 (index.js HTTP모드 포함)
```
로컬(Windows PowerShell)에서 config/.env 전송:
```powershell
scp -i <키.pem> -r "C:\Users\user\Desktop\project24\shop\coupon_shopping_mall_back-master\config" ubuntu@3.37.241.122:~/back/
scp -i <키.pem> "C:\Users\user\Desktop\project24\shop\coupon_shopping_mall_back-master\.env" ubuntu@3.37.241.122:~/back/.env
```
서버에서:
```bash
cd ~/back && npm install
```

## 5. `.env` prod값 수정 + DB 화이트리스트
`~/back/.env`에서 아래 2줄을 prod로 수정(로컬은 dev값이라 반드시 변경):
```dotenv
NODE_ENV=production              # development 아님 (secure 쿠키·스케줄러 on)
# SSL_ENABLED 넣지 않음           # nginx가 SSL 종료 → node는 HTTP 8000
BACK_URL=https://api.shopgo.co.kr # 이미지/og/신규업로드 절대 URL 접두어
```
DB 시크릿(`DB_HOST=211.45.163.83` 등)은 기존값 유지.
```bash
curl -s https://checkip.amazonaws.com   # = Elastic IP → cafe24 DB 허용목록에 등록
mysql -h 211.45.163.83 -u inuk -p comagain_shop -e "SELECT 1;"   # 접속 확인
```

## 6. 기동 (pm2)
```bash
cd ~/back
pm2 start pm2.config.cjs
pm2 logs back --lines 50    # "Server is On 8000 (prod/http behind proxy)" + "DB connected"
pm2 save && pm2 startup     # 출력되는 sudo 명령 실행
curl -i http://127.0.0.1:8000/     # "back-end initialized"
```

## 7. nginx + HTTPS
`/etc/nginx/sites-available/api.conf`:
```nginx
server {
    listen 80;
    server_name api.shopgo.co.kr;
    client_max_body_size 256M;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -sf /etc/nginx/sites-available/api.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.shopgo.co.kr      # 443 블록·리다이렉트 자동 구성
curl -i https://api.shopgo.co.kr/             # 200 back-end initialized
```

## 8. 프론트 배선
각 프론트 서버 `.env`:
```dotenv
BACK_URL=https://api.shopgo.co.kr
```
```bash
cd <프론트경로> && npm run build && pm2 restart front
```

## 9. 결제 콜백 URL 갱신 (필수)
결제사(PayLetter/payvery 등) 관리자에서 등록된 콜백 URL을 새 도메인으로:
- `https://api.shopgo.co.kr/api/pay/payletter/callback`
- `https://api.shopgo.co.kr/api/transactions/noti/`  (끝 슬래시 유지)
> 옛 `api.asapmall.kr`이 죽어 지금 결제 알림이 이미 안 들어오는 중일 수 있으니 우선 점검.

## 10. 검증
1. `https://shopgo.co.kr` 및 다른 라이브 브랜드 → 홈/상품/이미지/로그인 정상.
2. DevTools Network: `/api/*` 200, 이미지 200.
3. 결제 1건 테스트 → 콜백 수신·주문 상태 반영 확인.
4. `pm2 logs back` 에러 없는지, 스케줄러 정상.

## 11. 롤백
프론트 `BACK_URL`을 기존 백엔드 주소로 되돌리고 `pm2 restart front`(구 백엔드 생존 시). DNS는 api.shopgo.co.kr만 새로 잡으므로 프론트 롤백이 빠름.

---

## 코드 변경 (이미 반영됨 ✅)
`index.js` — 리버스 프록시 뒤 HTTP 운영 모드:
| 조건 | 리슨 | 스케줄러 |
|---|---|---|
| `NODE_ENV=development` | HTTP 8000 | off |
| `NODE_ENV=production`, `SSL_ENABLED` 미설정 | **HTTP 8000** (nginx가 SSL) | on |
| `NODE_ENV=production`, `SSL_ENABLED=true` | HTTPS 8443(letsencrypt 직접) | on |

## 주의 (HANDOVER 함정)
- **NODE_ENV=production 유지**(지우면 secure 쿠키 안 붙어 로그인 실패).
- **SSL_ENABLED 넣지 말 것**(nginx가 SSL 종료하므로) — 넣으면 node가 letsencrypt 경로 읽다 크래시.
- `BACK_URL` 비우지 말 것 — `arfighter` 스케줄 연동이 이 값을 씀.
- DB read/write 풀 같은 IP(211.45.163.83) — 화이트리스트 1개면 충분.
- 잔존 정리(선택): 죽은 `api.asapmall.kr` ~340행 + `product_description` 임베드 `cafe24` 92행은 필요 시 일괄 UPDATE. shopgo 라이브 영향 적음.
