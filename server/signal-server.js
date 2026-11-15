/**
 * ============================================================================
 *  signal-server.js  —  森林冰火人联机:信令 / 中转服务器
 * ----------------------------------------------------------------------------
 *  一个文件、零框架(仅依赖 ws)。同时支持两种用途:
 *
 *   1) WebRTC 信令 (net-config.js: transport=webrtc, signaling=ws)
 *        - 只转发 SDP / ICE,建立 P2P 后不再经过本服务器(省带宽)。
 *   2) 纯 WebSocket 中转 (net-config.js: transport=ws-relay)
 *        - 全程转发游戏数据,一定连得上(适合严格 NAT / 无 TURN 场景)。
 *
 *  房间模型:每个房间最多 2 人(host + guest),用房间号配对。
 *
 *  运行:
 *      npm install
 *      PORT=8080 node signal-server.js
 *  生产环境请放在 HTTPS 反向代理后面(nginx/caddy),前端用 wss:// 连接。
 *  详见 docs/SELF-HOSTING.md
 * ============================================================================
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PATH = process.env.WS_PATH || '/';        // 可选:限定 WebSocket 路径
const MAX_PER_ROOM = 2;

// rooms: Map<roomId, Set<ws>>
const rooms = new Map();

// 简单健康检查 / 首页
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Fireboy & Watergirl multiplayer signaling/relay server is running.\n' +
            'Rooms active: ' + rooms.size + '\n');
});

const wss = new WebSocketServer({ server, path: PATH });

function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function peersOf(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return [];
    return [...room].filter((p) => p !== ws);
}

function leaveRoom(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    peersOf(ws).forEach((p) => send(p, { type: 'peer-left' }));
    if (room.size === 0) rooms.delete(ws.roomId);
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        if (msg.type === 'join') {
            const roomId = String(msg.room || '').slice(0, 64);
            if (!roomId) return send(ws, { type: 'status', text: '无效房间号' });

            let room = rooms.get(roomId);
            if (!room) { room = new Set(); rooms.set(roomId, room); }
            if (room.size >= MAX_PER_ROOM) {
                return send(ws, { type: 'status', text: '房间已满(最多 2 人)' });
            }
            room.add(ws);
            ws.roomId = roomId;
            ws.role = msg.role || (room.size === 1 ? 'host' : 'guest');

            if (room.size === 1) {
                send(ws, { type: 'status', text: '房间已创建,等待队友…' });
            } else {
                // 第二人进入:通知双方
                peersOf(ws).forEach((p) => send(p, { type: 'peer-joined' }));  // 通知先到的一方(host 发起 offer)
                send(ws, { type: 'peer-ready' });                              // 通知后到的一方
            }
            return;
        }

        // 转发信令(WebRTC 的 SDP/ICE)或中转数据(ws-relay)
        if (msg.type === 'signal' || msg.type === 'relay') {
            peersOf(ws).forEach((p) => send(p, msg));
            return;
        }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
});

// 心跳:清理死连接
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
    console.log(`[signal] listening on :${PORT}  (path: ${PATH})`);
    console.log(`[signal] health check: http://localhost:${PORT}/health`);
});
