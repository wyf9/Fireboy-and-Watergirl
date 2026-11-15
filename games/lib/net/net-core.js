/**
 * ============================================================================
 *  net-core.js  —  传输层 (Transport)
 * ----------------------------------------------------------------------------
 *  统一封装三种连接方式,对上层暴露一致的接口:
 *    - webrtc + peerjs  : P2P 直连,PeerJS 做信令(零后端)
 *    - webrtc + ws      : P2P 直连,自建 WebSocket 做信令(双数据通道:可靠/快速)
 *    - ws-relay         : 全程 WebSocket 中转(经服务器转发)
 *
 *  接口:
 *    var net = NetCore.create(NET_CONFIG);
 *    net.on('status'|'open'|'data'|'close'|'error', cb);
 *    net.host(roomCode);   // 或 net.join(roomCode);
 *    net.send(obj);          // 快速通道(可能不可靠/无序)
 *    net.sendReliable(obj);  // 可靠有序通道
 *    net.isHost, net.stats {rttMs, bytesIn, bytesOut, kbpsIn, kbpsOut}
 *    net.close();
 * ============================================================================
 */
(function () {
    'use strict';

    function log() {
        if (window.NET_CONFIG && window.NET_CONFIG.verbose)
            console.log2 ? console.log2.apply(console, ['[net]'].concat([].slice.call(arguments)))
                         : console.log.apply(console, ['[net]'].concat([].slice.call(arguments)));
    }

    // ── 极简事件总线 ──────────────────────────────────────────────────
    function Emitter() { this._h = {}; }
    Emitter.prototype.on = function (ev, cb) { (this._h[ev] = this._h[ev] || []).push(cb); return this; };
    Emitter.prototype.emit = function (ev) {
        var args = [].slice.call(arguments, 1);
        (this._h[ev] || []).forEach(function (cb) { try { cb.apply(null, args); } catch (e) { console.error(e); } });
    };

    // ── 动态加载脚本(用于 PeerJS CDN) ───────────────────────────────
    function loadScript(src) {
        return new Promise(function (res, rej) {
            var s = document.createElement('script');
            s.src = src; s.onload = res; s.onerror = function () { rej(new Error('加载失败: ' + src)); };
            document.head.appendChild(s);
        });
    }

    // ==========================================================================
    //  基类:统计 / 心跳 / 消息分发
    // ==========================================================================
    function Base(config) {
        Emitter.call(this);
        this.config = config;
        this.isHost = false;
        this.opened = false;
        this.stats = { rttMs: 0, bytesIn: 0, bytesOut: 0, kbpsIn: 0, kbpsOut: 0 };
        this._pingTimer = null;
        this._rateTimer = null;
        this._lastBytesIn = 0; this._lastBytesOut = 0;
    }
    Base.prototype = Object.create(Emitter.prototype);

    Base.prototype._onOpen = function () {
        if (this.opened) return;
        this.opened = true;
        var self = this;
        // RTT 心跳
        this._pingTimer = setInterval(function () {
            self._sendRaw({ __ping: Date.now() }, true);
        }, 1000);
        // 带宽速率统计
        this._rateTimer = setInterval(function () {
            self.stats.kbpsIn = ((self.stats.bytesIn - self._lastBytesIn) * 8 / 1000) | 0;
            self.stats.kbpsOut = ((self.stats.bytesOut - self._lastBytesOut) * 8 / 1000) | 0;
            self._lastBytesIn = self.stats.bytesIn;
            self._lastBytesOut = self.stats.bytesOut;
        }, 1000);
        this.emit('open');
    };

    Base.prototype._onMessage = function (str) {
        this.stats.bytesIn += (str && str.length) || 0;
        var msg;
        try { msg = JSON.parse(str); } catch (e) { return; }
        if (msg.__ping != null) { this._sendRaw({ __pong: msg.__ping }, true); return; }
        if (msg.__pong != null) { this.stats.rttMs = Date.now() - msg.__pong; return; }
        this.emit('data', msg);
    };

    Base.prototype._teardownTimers = function () {
        clearInterval(this._pingTimer); clearInterval(this._rateTimer);
    };

    Base.prototype.send = function (obj) { this._sendRaw(obj, false); };
    Base.prototype.sendReliable = function (obj) { this._sendRaw(obj, true); };

    // ==========================================================================
    //  实现 A:PeerJS(WebRTC + 公共/自建 broker)
    //  单一可靠有序通道承载所有消息(实现简单,状态包很小)。
    // ==========================================================================
    function PeerJSTransport(config) { Base.call(this, config); this.peer = null; this.conn = null; }
    PeerJSTransport.prototype = Object.create(Base.prototype);

    PeerJSTransport.prototype._ensureLib = function () {
        if (window.Peer) return Promise.resolve();
        return loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js');
    };

    PeerJSTransport.prototype._makePeer = function (id) {
        var opts = { debug: this.config.verbose ? 2 : 0 };
        if (this.config.peerjs) opts = Object.assign(opts, this.config.peerjs);
        if (this.config.iceServers) opts.config = { iceServers: this.config.iceServers };
        return id ? new window.Peer(id, opts) : new window.Peer(opts);
    };

    PeerJSTransport.prototype._bindConn = function (conn) {
        var self = this;
        this.conn = conn;
        conn.on('open', function () { self._onOpen(); });
        conn.on('data', function (data) {
            // PeerJS 已反序列化为对象;为统一走 _onMessage,这里直接分发
            var str = typeof data === 'string' ? data : JSON.stringify(data);
            self._onMessage(str);
        });
        conn.on('close', function () { self.emit('close'); });
        conn.on('error', function (e) { self.emit('error', e); });
    };

    PeerJSTransport.prototype.host = function (room) {
        var self = this; this.isHost = true;
        this.emit('status', '正在连接信令服务器…');
        this._ensureLib().then(function () {
            self.peer = self._makePeer(self.config.roomPrefix + room);
            self.peer.on('open', function () { self.emit('status', '房间已创建,等待队友加入…(房间号: ' + room + ')'); });
            self.peer.on('connection', function (conn) { self.emit('status', '队友已加入,正在建立数据通道…'); self._bindConn(conn); });
            self.peer.on('error', function (e) { self.emit('error', e); self.emit('status', '错误: ' + (e.type || e.message)); });
        }).catch(function (e) { self.emit('error', e); });
    };

    PeerJSTransport.prototype.join = function (room) {
        var self = this; this.isHost = false;
        this.emit('status', '正在连接信令服务器…');
        this._ensureLib().then(function () {
            self.peer = self._makePeer(null);
            self.peer.on('open', function () {
                self.emit('status', '正在加入房间 ' + room + ' …');
                var conn = self.peer.connect(self.config.roomPrefix + room, { reliable: true, serialization: 'json' });
                self._bindConn(conn);
            });
            self.peer.on('error', function (e) { self.emit('error', e); self.emit('status', '错误: ' + (e.type || e.message)); });
        }).catch(function (e) { self.emit('error', e); });
    };

    PeerJSTransport.prototype._sendRaw = function (obj) {
        if (!this.conn || !this.conn.open) return;
        var str = JSON.stringify(obj);
        this.stats.bytesOut += str.length;
        try { this.conn.send(obj); } catch (e) {}
    };

    PeerJSTransport.prototype.close = function () {
        this._teardownTimers();
        try { this.conn && this.conn.close(); } catch (e) {}
        try { this.peer && this.peer.destroy(); } catch (e) {}
    };

    // ==========================================================================
    //  实现 B:原生 WebRTC + 自建 WebSocket 信令
    //  双数据通道:'rel'(可靠有序)+ 'fast'(无序不可靠,承载高频状态/输入)
    // ==========================================================================
    function RawWebRTCTransport(config) {
        Base.call(this, config);
        this.pc = null; this.ws = null;
        this.chRel = null; this.chFast = null;
        this.room = null;
        this._remoteSet = false;
        this._pendingCandidates = [];
    }
    RawWebRTCTransport.prototype = Object.create(Base.prototype);

    RawWebRTCTransport.prototype._connectSignaling = function (room, role) {
        var self = this; this.room = room;
        var ws = this.ws = new WebSocket(this.config.serverUrl);
        ws.onopen = function () { ws.send(JSON.stringify({ type: 'join', room: room, role: role })); };
        ws.onmessage = function (ev) { self._onSignal(JSON.parse(ev.data)); };
        ws.onerror = function (e) { self.emit('error', new Error('信令服务器连接失败')); };
        ws.onclose = function () { log('signaling ws closed'); };
    };

    RawWebRTCTransport.prototype._sigSend = function (obj) {
        if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    };

    RawWebRTCTransport.prototype._createPC = function () {
        var self = this;
        var pc = this.pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
        pc.onicecandidate = function (e) { if (e.candidate) self._sigSend({ type: 'signal', data: { candidate: e.candidate } }); };
        pc.onconnectionstatechange = function () {
            self.emit('status', 'WebRTC: ' + pc.connectionState);
            if (pc.connectionState === 'failed') self.emit('error', new Error('WebRTC 连接失败(可能需要 TURN)'));
        };
        return pc;
    };

    RawWebRTCTransport.prototype._bindChannel = function (ch) {
        var self = this;
        if (ch.label === 'rel') this.chRel = ch; else this.chFast = ch;
        ch.onopen = function () { if (self.chRel && self.chRel.readyState === 'open') self._onOpen(); };
        ch.onmessage = function (e) { self._onMessage(e.data); };
        ch.onclose = function () { self.emit('close'); };
    };

    RawWebRTCTransport.prototype.host = function (room) {
        var self = this; this.isHost = true;
        this.emit('status', '连接信令服务器…');
        this._connectSignaling(room, 'host');
    };
    RawWebRTCTransport.prototype.join = function (room) {
        var self = this; this.isHost = false;
        this.emit('status', '连接信令服务器…');
        this._connectSignaling(room, 'guest');
    };

    RawWebRTCTransport.prototype._onSignal = function (msg) {
        var self = this;
        if (msg.type === 'status') { this.emit('status', msg.text); return; }
        if (msg.type === 'peer-joined' && this.isHost) {
            // 主机作为 offerer,建通道
            var pc = this._createPC();
            this.chRel = pc.createDataChannel('rel', { ordered: true });
            this.chFast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
            this._bindChannel(this.chRel); this._bindChannel(this.chFast);
            pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
              .then(function () { self._sigSend({ type: 'signal', data: { sdp: pc.localDescription } }); });
            this.emit('status', '队友已加入,建立 P2P…');
            return;
        }
        if (msg.type === 'signal') {
            var data = msg.data;
            // 客机首次收到信令时惰性建立 PeerConnection,并准备接收数据通道
            if (!this.pc && !this.isHost) {
                var pc = this._createPC();
                pc.ondatachannel = function (e) { self._bindChannel(e.channel); };
            }
            var pc2 = this.pc;
            if (!pc2) return;
            if (data.sdp) {
                pc2.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(function () {
                    self._remoteSet = true;
                    // 补充在 remoteDescription 就绪前排队的 ICE candidate
                    self._pendingCandidates.forEach(function (c) {
                        pc2.addIceCandidate(new RTCIceCandidate(c)).catch(function () {});
                    });
                    self._pendingCandidates = [];
                    if (data.sdp.type === 'offer')
                        return pc2.createAnswer().then(function (a) { return pc2.setLocalDescription(a); })
                                  .then(function () { self._sigSend({ type: 'signal', data: { sdp: pc2.localDescription } }); });
                }).catch(function (e) { self.emit('error', e); });
            } else if (data.candidate) {
                if (self._remoteSet) pc2.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () {});
                else self._pendingCandidates.push(data.candidate);   // 先排队,等 remoteDescription
            }
        }
    };

    RawWebRTCTransport.prototype._sendRaw = function (obj, reliable) {
        var str = JSON.stringify(obj);
        var ch = reliable ? this.chRel : (this.chFast && this.chFast.readyState === 'open' ? this.chFast : this.chRel);
        if (!ch || ch.readyState !== 'open') return;
        this.stats.bytesOut += str.length;
        try { ch.send(str); } catch (e) {}
    };

    RawWebRTCTransport.prototype.close = function () {
        this._teardownTimers();
        try { this.pc && this.pc.close(); } catch (e) {}
        try { this.ws && this.ws.close(); } catch (e) {}
    };

    // ==========================================================================
    //  实现 C:纯 WebSocket 中转(经服务器转发,一定连得上)
    // ==========================================================================
    function WSRelayTransport(config) { Base.call(this, config); this.ws = null; this.room = null; }
    WSRelayTransport.prototype = Object.create(Base.prototype);

    WSRelayTransport.prototype._connect = function (room, role) {
        var self = this; this.room = room;
        var ws = this.ws = new WebSocket(this.config.serverUrl);
        ws.onopen = function () {
            ws.send(JSON.stringify({ type: 'join', room: room, role: role }));
            self.emit('status', role === 'host' ? '房间已创建,等待队友…' : '正在加入房间…');
        };
        ws.onmessage = function (ev) {
            var msg = JSON.parse(ev.data);
            if (msg.type === 'status') { self.emit('status', msg.text); return; }
            if (msg.type === 'peer-joined' || msg.type === 'peer-ready') { self._onOpen(); return; }
            if (msg.type === 'relay') { self._onMessage(msg.payload); return; }
            if (msg.type === 'peer-left') { self.emit('close'); return; }
        };
        ws.onerror = function () { self.emit('error', new Error('中转服务器连接失败')); };
        ws.onclose = function () { self.emit('close'); };
    };

    WSRelayTransport.prototype.host = function (room) { this.isHost = true; this.emit('status', '连接中转服务器…'); this._connect(room, 'host'); };
    WSRelayTransport.prototype.join = function (room) { this.isHost = false; this.emit('status', '连接中转服务器…'); this._connect(room, 'guest'); };

    WSRelayTransport.prototype._sendRaw = function (obj) {
        if (!this.ws || this.ws.readyState !== 1) return;
        var payload = JSON.stringify(obj);
        this.stats.bytesOut += payload.length;
        this.ws.send(JSON.stringify({ type: 'relay', payload: payload }));
    };
    WSRelayTransport.prototype.close = function () { this._teardownTimers(); try { this.ws && this.ws.close(); } catch (e) {} };

    // ==========================================================================
    //  工厂
    // ==========================================================================
    var NetCore = {
        create: function (config) {
            if (config.transport === 'ws-relay') {
                if (!config.serverUrl) throw new Error('ws-relay 需要在 net-config.js 里配置 serverUrl');
                return new WSRelayTransport(config);
            }
            // webrtc
            if (config.signaling === 'ws') {
                if (!config.serverUrl) throw new Error('signaling:ws 需要在 net-config.js 里配置 serverUrl');
                return new RawWebRTCTransport(config);
            }
            return new PeerJSTransport(config);
        }
    };

    window.NetCore = NetCore;
})();
