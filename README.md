# lucas-test-webhook

들어오는 webhook 요청을 캡처해서 데이터가 제대로 오는지 확인하는 Express 테스트 서비스.
어떤 경로/메서드로 오는 요청이든 헤더·쿼리·바디를 전부 기록하고, 브라우저에서 확인할 수 있습니다.

## 기능

- 아무 경로로나 요청을 보내면 캡처됨 (`POST /webhook`, `POST /hook/anything` 등)
- JSON / form-urlencoded / text / XML / raw(binary) 바디 모두 파싱
- 최근 요청을 **`data.json` 파일에 저장** → 재시작해도 유지 (기본 100개, `MAX_HISTORY`로 조정)
- 브라우저 뷰어: `GET /_inspect` (2초마다 자동 새로고침)
- JSON API: `GET /_inspect/data`, 초기화: `POST /_inspect/clear`
- 헬스체크: `GET /_health`

> 예약 경로는 `/_inspect`, `/_health` 로 시작합니다. 실제 webhook은 그 외 아무 경로나 사용하세요.

## 로컬 실행

```bash
npm install
npm start            # PORT=3000 기본
PORT=8080 npm start  # 포트 변경
```

확인:

```bash
curl -X POST http://localhost:3000/webhook -H 'Content-Type: application/json' -d '{"hello":"world"}'
# 브라우저에서 http://localhost:3000/_inspect
```

## EC2 배포

### 1. 서버 준비 (Amazon Linux 2023 기준)

```bash
sudo dnf install -y nodejs git        # Ubuntu: sudo apt install -y nodejs npm git
git clone <이-저장소-URL> lucas-test-webhook
cd lucas-test-webhook
npm install --omit=dev
```

### 2. 보안 그룹 (Security Group)

- 인바운드 규칙에 사용할 포트(예: TCP 80 또는 3000)를 webhook 발신 측 IP에 열어줍니다.
- 80/443 포트를 쓰려면 아래 systemd 방식에서 `PORT=80` 지정(권한 필요) 또는 Nginx 리버스 프록시 권장.

### 3. systemd 로 상시 실행 (재부팅 후 자동 시작)

`/etc/systemd/system/webhook.service`:

```ini
[Unit]
Description=lucas-test-webhook
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/home/ec2-user/lucas-test-webhook
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webhook
sudo systemctl status webhook      # 상태 확인
journalctl -u webhook -f           # 실시간 로그 (캡처된 요청이 여기 찍힘)
```

### 4. (선택) Nginx 리버스 프록시로 80 포트 노출

```nginx
server {
    listen 80;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 리슨 포트 |
| `MAX_HISTORY` | `100` | 보관할 최근 요청 수 |
| `DATA_FILE` | `data.json` | 캡처된 요청을 저장할 파일 경로 |

## 데이터 저장 방식

- 요청이 들어올 때마다 `DATA_FILE`(기본 `data.json`)에 저장됩니다. 서버를 재시작하면 이 파일을 다시 읽어와 이전 요청이 유지됩니다.
- 임시 파일에 쓴 뒤 `rename` 하는 방식이라 쓰기 도중 크래시가 나도 파일이 깨지지 않습니다.
- `POST /_inspect/clear` 를 호출하면 메모리와 파일이 모두 비워집니다.
