/**
 * ============================================================================
 *  森林冰火人 · 多人联机配置 (Multiplayer Config)
 * ----------------------------------------------------------------------------
 *  这是唯一需要普通用户修改的文件。改完刷新页面即可生效。
 *  部署自己的信令 / 中转服务器请看 docs/SELF-HOSTING.md
 * ============================================================================
 */
(function () {
    'use strict';

    var CONFIG = {
        // ── 是否启用联机入口(大厅按钮) ────────────────────────────────
        enabled: true,

        // ── 连接方式 (transport) ───────────────────────────────────────
        //   'webrtc'   : P2P 直连(低延迟,推荐)。需要信令交换一次握手。
        //                直连失败时可自动回退到中转(见 fallbackToRelay)。
        //   'ws-relay' : 全程 WebSocket 中转(一定连得上,延迟略高,消耗服务器带宽)。
        //                需要自建服务器(serverUrl)。
        transport: 'webrtc',

        // WebRTC 直连失败(严格 NAT 且无 TURN)时,是否自动回退到 ws-relay。
        // 需要同时配置 serverUrl。
        fallbackToRelay: false,

        // ── WebRTC 的信令方式 (signaling) ──────────────────────────────
        //   'peerjs' : 使用 PeerJS broker(零后端最省事;默认用官方公共 broker)。
        //   'ws'     : 使用你自建的 WebSocket 信令服务器(server/signal-server.js)。
        signaling: 'peerjs',

        // ── 自建服务器地址 ─────────────────────────────────────────────
        //   signaling:'ws' 或 transport:'ws-relay' 时使用。
        //   本地测试:'ws://localhost:8080'
        //   线上(需 HTTPS 页面配 wss):'wss://your-server.example.com'
        serverUrl: '',

        // ── PeerJS broker 配置 ─────────────────────────────────────────
        //   signaling:'peerjs' 时使用。null = 官方公共 broker(0.peerjs.com)。
        //   自建 peerjs-server 示例:
        //     { host:'your.host', port:443, path:'/fbwg', secure:true }
        peerjs: null,

        // 房间号前缀(避免与公共 PeerJS broker 上其他人的房间号冲突)
        roomPrefix: 'fbwg-',

        // ── ICE 服务器:STUN 打洞 + 可选 TURN 中继兜底 ───────────────────
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
            // 自建 coturn 的 TURN 示例(直连失败时兜底):
            // { urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' }
        ],

        // ── 同步模型 (syncMode) ────────────────────────────────────────
        //   'state'    : 主机权威 + 状态同步(推荐,跨浏览器稳定)。
        //   'lockstep' : 确定性锁步(仅同步输入,实验性,用于对比)。
        syncMode: 'state',

        // 状态/输入发送频率(Hz)。0 = 跟随渲染帧率(每帧发)。
        sendRateHz: 0,

        // 客户端对"自己控制的角色"做本地预测,降低自身操作延迟(仅 state 模式)。
        predictLocal: true,

        // 客户端追赶主机状态的插值系数(0~1,越大越快贴合,越小越平滑)。
        interpFactor: 0.35,

        // 锁步模式的输入缓冲帧数(越大越抗抖动但延迟越高)。
        lockstepDelay: 3,

        // ── 调试 HUD(左下角显示 RTT / 帧率 / 带宽 / 漂移) ───────────────
        debugHud: true,

        // 控制台详细日志
        verbose: false
    };

    // 允许通过 URL 覆盖部分参数,便于本地双标签页 A/B 测试:
    //   ?mp_mode=lockstep  ?mp_transport=ws-relay  ?mp_server=ws://localhost:8080
    try {
        var q = new URLSearchParams(location.search);
        if (q.has('mp_mode'))      CONFIG.syncMode  = q.get('mp_mode');
        if (q.has('mp_transport')) CONFIG.transport = q.get('mp_transport');
        if (q.has('mp_signaling')) CONFIG.signaling = q.get('mp_signaling');
        if (q.has('mp_server'))    CONFIG.serverUrl = q.get('mp_server');
        if (q.has('mp_hud'))       CONFIG.debugHud  = q.get('mp_hud') !== '0';
        if (q.has('mp_verbose'))   CONFIG.verbose   = q.get('mp_verbose') !== '0';
    } catch (e) {}

    window.NET_CONFIG = CONFIG;
})();
