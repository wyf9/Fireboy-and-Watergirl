# 自部署指南 · 信令 / 中转服务器

本项目的多人联机默认使用 **PeerJS 公共 broker**(零后端,开箱即用)。
如果你想要更高的连通率、更好的隐私,或不依赖第三方,可以自建服务器。

本指南覆盖三种自建方案,按投入从低到高:

| 方案 | 作用 | 你需要 | 连通率 | 服务器带宽 |
|------|------|--------|--------|-----------|
| A. 自建信令(WebSocket) | 只转发握手(SDP/ICE),之后 P2P 直连 | 一台小服务器 | 高(多数 NAT) | 极低 |
| B. 自建 TURN(coturn) | 直连失败时中继媒体 | 一台有公网 IP 的服务器 | 极高 | 中(仅兜底流量) |
| C. 纯 WebSocket 中转 | 全程转发游戏数据 | 一台小服务器 | 100% | 中(全部流量) |

> 只做 **A** 就能覆盖绝大多数玩家;对严格 NAT(如部分校园网/移动网络)再加 **B** 或 **C** 兜底。

---

## 一、服务器代码

服务器只有一个文件:`server/signal-server.js`(零框架,仅依赖 `ws`)。
它**同时**支持"WebRTC 信令"和"纯 WebSocket 中转"两种用途,按客户端配置自动区分。

### 本地运行

```bash
cd server
npm install
PORT=8080 node signal-server.js
# 健康检查:浏览器打开 http://localhost:8080/health
```

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8080` | 监听端口 |
| `WS_PATH` | `/` | 限定 WebSocket 路径(如 `/ws`) |

---

## 二、生产部署

前端页面若是 HTTPS(如 GitHub Pages),浏览器**要求** WebSocket 使用 `wss://`(加密)。
因此生产环境需要在服务器前面放一个带 TLS 的反向代理。

### 方式 1:Caddy(最简单,自动 HTTPS)

`Caddyfile`:

```
mp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
# 后台常驻(推荐用 systemd / pm2)
PORT=8080 node server/signal-server.js &
caddy run
```

前端 `net-config.js` 里填:`serverUrl: 'wss://mp.example.com'`

### 方式 2:Nginx

```nginx
server {
    listen 443 ssl;
    server_name mp.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 升级
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 600s;
    }
}
```

### 方式 3:一键 PaaS(Fly.io / Railway / Render 等)

这些平台自带 HTTPS。把 `server/` 目录作为 Node 服务部署即可:

- 启动命令:`node signal-server.js`
- 平台会注入 `PORT`,代码已自动读取。
- 拿到平台给的域名后,前端填 `wss://<平台域名>`。

### 用 systemd 常驻(裸机/VPS)

`/etc/systemd/system/fbwg-signal.service`:

```ini
[Unit]
Description=FBWG signal server
After=network.target

[Service]
WorkingDirectory=/opt/fbwg/server
Environment=PORT=8080
ExecStart=/usr/bin/node signal-server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now fbwg-signal
```

---

## 三、前端配置对照

编辑 `games/lib/net/net-config.js`,按你选的方案填写:

### 方案 A:自建信令 + WebRTC 直连(推荐)

```js
transport: 'webrtc',
signaling: 'ws',
serverUrl: 'wss://mp.example.com',   // ← 你的服务器
```

### 方案 C:纯 WebSocket 中转(一定连得上)

```js
transport: 'ws-relay',
serverUrl: 'wss://mp.example.com',   // ← 你的服务器
```

### 仍用 PeerJS(零后端,默认)

```js
transport: 'webrtc',
signaling: 'peerjs',
peerjs: null,   // 官方公共 broker;或填自建 peerjs-server
```

自建 PeerJS broker 示例:

```js
peerjs: { host: 'mp.example.com', port: 443, path: '/peerjs', secure: true }
```

---

## 四、方案 B:自建 TURN(coturn)提升连通率

WebRTC 直连在"对称 NAT"下会失败(约 5–15% 用户)。加一个 TURN 中继即可兜底。

### 安装 coturn

```bash
sudo apt install coturn
```

`/etc/turnserver.conf`(最简):

```
listening-port=3478
fingerprint
lt-cred-mech
user=fbwg:yourpassword
realm=mp.example.com
# 有公网 IP 时建议显式指定:
# external-ip=YOUR_PUBLIC_IP
```

```bash
sudo systemctl enable --now coturn
```

### 前端配置(在 iceServers 里加 TURN)

```js
iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:mp.example.com:3478', username: 'fbwg', credential: 'yourpassword' }
],
```

加了 TURN 后,`transport` 保持 `'webrtc'` 即可;直连不通时会自动走 TURN 中继。
你也可以设 `fallbackToRelay: true` 再叠加纯 WS 中转作为二次兜底。

---

## 五、安全与运维建议

- **限流 / 房间号**:公共部署建议给房间号加随机后缀,或在服务器加简单鉴权,避免被撞房。
- **TURN 凭证**:生产环境建议用 coturn 的"时限凭证"(REST API),不要硬编码长期密码。
- **带宽**:方案 A/B 几乎不耗服务器带宽;方案 C 会承载全部游戏流量(每对玩家约 20–60 kbps),按人数评估。
- **健康检查**:`GET /health` 返回房间数与运行时长,可接入监控。

---

## 六、快速自测(无需浏览器)

仓库里 `server/` 目录可以用两个 WebSocket 客户端脚本联调,验证房间配对与转发。
最简单的浏览器端验证:开两个标签页,一个建房、一个用同房间号加入,看左下角 HUD 的 RTT 是否正常跳动。

更多玩法与架构说明见 [MULTIPLAYER.md](./MULTIPLAYER.md)。
