/**
 * ============================================================================
 *  net-bridge.js  —  游戏集成桥 (Game Integration Bridge)
 * ----------------------------------------------------------------------------
 *  把网络层(NetCore)接到森林冰火人引擎上,提供两种同步模型:
 *    - 'state'    : 主机权威 + 状态同步(推荐)
 *    - 'lockstep' : 确定性锁步(仅同步输入,实验对比)
 *
 *  引擎接入点(通过 Phaser.GAMES 拿到游戏实例,均为运行时挂钩,不改 game.js):
 *    - game.level.pers1 = 火人(fb), game.level.pers2 = 冰人(wg)
 *    - 角色输入:char.cursors.{up,left,right}.isDown  (每 tick 读取驱动物理)
 *    - 刚体:char.body.data  (box2d b2Body: GetPosition/GetAngle/Get/SetLinearVelocity/
 *            SetTransformXYRadians/SetAngularVelocity)
 *    - 每帧主循环:包裹 game.update 注入 beforeUpdate/afterUpdate
 * ============================================================================
 */
(function () {
    'use strict';

    var CFG = window.NET_CONFIG || {};

    function log() {
        if (CFG.verbose) console.log.apply(console, ['[bridge]'].concat([].slice.call(arguments)));
    }

    // ── 全局状态 ─────────────────────────────────────────────────────
    var B = {
        net: null,
        connected: false,
        isHost: false,
        localChar: 'fb',          // 本机控制的角色
        mode: CFG.syncMode || 'state',

        game: null,
        level: null,
        LevelClass: null,

        localCharObj: null,
        remoteCharObj: null,
        wrappedGame: null,        // 已包裹 update 的 game 实例

        remoteInput: { u: false, l: false, r: false },
        lastLocalInput: null,
        seq: 0,

        // 状态同步
        pendingSnapshot: null,
        lastSnapshotTime: 0,
        lastSendTime: 0,

        // 锁步
        inputBuffer: {},          // tick -> remote input
        localTick: 0,

        // 诊断
        diag: { drift: 0, snapshotsIn: 0, snapshotAgeMs: 0 }
    };
    window.NET_BRIDGE = B;

    // ── 工具 ─────────────────────────────────────────────────────────
    function getGame() {
        if (B.game && B.game.isBooted) return B.game;
        var G = window.Phaser && Phaser.GAMES;
        if (!G) return null;
        for (var i = 0; i < G.length; i++) {
            if (G[i] && G[i].isBooted && G[i].state) { B.game = G[i]; return G[i]; }
        }
        return null;
    }

    function angDiff(a, b) {
        var d = a - b;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    // 读一个刚体状态 -> 紧凑数组 [x, y, angle, vx, vy, av]
    function readBody(entity) {
        try {
            var body = entity.body && entity.body.data;
            if (!body) return null;
            var p = body.GetPosition(); var px = p.x, py = p.y;
            var a = body.GetAngle();
            var v = body.GetLinearVelocity(); var vx = v.x, vy = v.y;
            var av = body.GetAngularVelocity();
            return [r4(px), r4(py), r4(a), r4(vx), r4(vy), r4(av)];
        } catch (e) { return null; }
    }
    function r4(n) { return Math.round(n * 1e3) / 1e3; }

    // 把数组状态写回刚体(带插值/吸附)
    function writeBody(entity, s, k, snapDist) {
        try {
            var body = entity.body && entity.body.data;
            if (!body || !s) return;
            var p = body.GetPosition(); var cx = p.x, cy = p.y;
            var dx = s[0] - cx, dy = s[1] - cy;
            var dist2 = dx * dx + dy * dy;
            var nx, ny, na;
            if (snapDist && dist2 > snapDist * snapDist) {
                nx = s[0]; ny = s[1]; na = s[2];       // 误差过大:直接吸附
            } else {
                nx = cx + dx * k; ny = cy + dy * k;
                na = body.GetAngle() + angDiff(s[2], body.GetAngle()) * k;
            }
            body.SetTransformXYRadians(nx, ny, na);
            body.SetLinearVelocity({ x: s[3], y: s[4] });
            body.SetAngularVelocity(s[5]);
            body.SetAwake(true);
        } catch (e) {}
    }

    // 需要同步状态的动态物体(可推箱子/升降台/推板等,凡是带刚体的 device)
    function syncableObjects(level) {
        var out = [];
        var arr = level.objects || [];
        for (var i = 0; i < arr.length; i++) {
            var o = arr[i];
            if (o && o.body && o.body.data && !o.__destroyed) out.push(o);
        }
        return out;
    }

    // ── 角色/关卡绑定 ─────────────────────────────────────────────────
    function bindLevel(level) {
        if (!level || level === B.level) return;
        if (!level.pers1 || !level.pers2) return;   // 尚未创建角色
        B.level = level;
        B.LevelClass = level.constructor;
        B.localCharObj = (B.localChar === 'fb') ? level.pers1 : level.pers2;
        B.remoteCharObj = (B.localChar === 'fb') ? level.pers2 : level.pers1;

        // 把远端角色的输入从本机键盘/触屏解绑,改由网络驱动
        var rc = B.remoteCharObj.cursors;
        if (rc) {
            rc.up = { isDown: false };
            rc.left = { isDown: false };
            rc.right = { isDown: false };
            rc.updateDowns = function () {};       // 关掉触屏对远端角色的写入
            if (rc.buttons) { try { rc.buttons.visible = false; } catch (e) {} }
        }
        log('level bound; localChar=', B.localChar);

        // 隐藏"角色切换"提示(单人同屏才需要)
        try { window.NET_TOUCH && window.NET_TOUCH.applyRole(B.localChar); } catch (e) {}
    }

    // ── 每帧:注入远端输入(在 state.update 之前) ─────────────────────
    function beforeUpdate() {
        var g = getGame(); if (!g) return;
        bindLevel(g.level);
        if (!B.remoteCharObj) return;
        var rc = B.remoteCharObj.cursors; if (!rc) return;

        if (B.mode === 'lockstep') {
            // 锁步:优先用缓冲区里对应 tick 的输入,缺失时回退到最近一次远端输入
            var t = B.localTick - (CFG.lockstepDelay || 3);
            var inp = B.inputBuffer[t] || B.remoteInputLatest;
            if (inp) { rc.up.isDown = !!inp.u; rc.left.isDown = !!inp.l; rc.right.isDown = !!inp.r; }
        } else {
            rc.up.isDown = !!B.remoteInput.u;
            rc.left.isDown = !!B.remoteInput.l;
            rc.right.isDown = !!B.remoteInput.r;
        }
    }

    // ── 每帧:发送本地输入 + (主机)状态,(客机)应用状态 ─────────────
    function afterUpdate() {
        var g = getGame(); if (!g || !B.connected) return;
        if (!B.localCharObj) return;

        var now = performance.now();
        var throttle = CFG.sendRateHz > 0 ? (1000 / CFG.sendRateHz) : 0;
        var shouldSend = !throttle || (now - B.lastSendTime >= throttle);

        // 1) 读取并发送本地输入
        var lc = B.localCharObj.cursors;
        var li = { u: !!(lc && lc.up && lc.up.isDown), l: !!(lc && lc.left && lc.left.isDown), r: !!(lc && lc.right && lc.right.isDown) };
        var changed = !B.lastLocalInput || li.u !== B.lastLocalInput.u || li.l !== B.lastLocalInput.l || li.r !== B.lastLocalInput.r;

        if (B.mode === 'lockstep') {
            B.localTick++;
            // 锁步每 tick 都发(带 tick 号)
            B.net.send({ t: 'in', u: li.u, l: li.l, r: li.r, tick: B.localTick });
            B.lastLocalInput = li;
        } else {
            if (changed || shouldSend) { B.net.send({ t: 'in', u: li.u, l: li.l, r: li.r }); B.lastLocalInput = li; }
        }

        // 2) 状态同步
        if (B.mode === 'state') {
            if (B.isHost) {
                if (shouldSend) { sendSnapshot(); B.lastSendTime = now; }
            } else {
                applySnapshot();
            }
        }
    }

    // 主机:采集并发送状态快照
    function sendSnapshot() {
        var lv = B.level; if (!lv) return;
        var objs = syncableObjects(lv);
        var snap = {
            t: 'st',
            c1: readBody(lv.pers1),
            c2: readBody(lv.pers2),
            o: objs.map(readBody)
        };
        B.net.send(snap);
    }

    // 客机:把最近快照应用到本地世界
    function applySnapshot() {
        var snap = B.pendingSnapshot; if (!snap) return;
        var lv = B.level; if (!lv) return;
        var k = (CFG.interpFactor != null) ? CFG.interpFactor : 0.35;
        var SNAP = 2.5;  // 误差>2.5(物理单位)直接吸附

        // 角色:本地角色若开启预测则仅在误差过大时吸附
        var localIsC1 = (B.localChar === 'fb');
        var predict = CFG.predictLocal;

        applyCharSnap(lv.pers1, snap.c1, localIsC1 && predict, k, SNAP);
        applyCharSnap(lv.pers2, snap.c2, !localIsC1 && predict, k, SNAP);

        // 动态物体
        if (snap.o) {
            var objs = syncableObjects(lv);
            for (var i = 0; i < objs.length && i < snap.o.length; i++) {
                writeBody(objs[i], snap.o[i], k, SNAP);
            }
        }
    }

    function applyCharSnap(charObj, s, isPredictedLocal, k, snapDist) {
        if (!charObj || !s) return;
        if (isPredictedLocal) {
            // 预测的本地角色:只在明显偏差时纠正
            try {
                var body = charObj.body.data;
                var p = body.GetPosition();
                var dx = s[0] - p.x, dy = s[1] - p.y;
                if (dx * dx + dy * dy > snapDist * snapDist) writeBody(charObj, s, 1, 0);
            } catch (e) {}
        } else {
            writeBody(charObj, s, k, snapDist);
        }
    }

    // ── 关卡进度同步(主机驱动) ───────────────────────────────────────
    function pollLevelChange() {
        if (!B.isHost || !B.connected) return;
        var g = getGame(); if (!g || !g.level || !g.level.levelData) return;
        var ld = g.level.levelData;
        var key = ld.filename || ld.id;
        if (key && key !== B._lastLevelKey) {
            B._lastLevelKey = key;
            B.net.sendReliable({ t: 'lvl', data: ld });
            log('broadcast level', key);
        }
    }

    function loadLevelOnClient(levelData) {
        var g = getGame(); if (!g) return;
        try {
            if (g.level && g.level.levelData &&
                (g.level.levelData.filename === levelData.filename)) return; // 已在同一关
            if (B.LevelClass) {
                if (!g.state.states['level']) g.state.add('level', B.LevelClass);
                g.state.start('level', true, false, levelData);
                log('client loading level', levelData.filename);
            } else {
                B.pendingLevelData = levelData;   // 还没捕获到 Level 类,等玩家进入任意关卡
                setStatus('请在同一个游戏里点开任意关卡以同步(等待主机: ' + (levelData.filename || '') + ')');
            }
        } catch (e) { console.error('loadLevelOnClient', e); }
    }

    // ── 消息处理 ─────────────────────────────────────────────────────
    function onData(msg) {
        if (msg.t === 'role') {
            B.localChar = msg.localChar;
            B.mode = msg.mode || B.mode;
            B.level = null; B.localCharObj = null; B.remoteCharObj = null; // 重新绑定
            setStatus('已就位:你是 ' + (B.localChar === 'fb' ? '火人(方向键)' : '冰人(WAD)'));
        } else if (msg.t === 'in') {
            B.remoteInputLatest = { u: msg.u, l: msg.l, r: msg.r };
            if (B.mode === 'lockstep') {
                if (msg.tick != null) {
                    B.inputBuffer[msg.tick] = msg;
                    // 清理过老的缓冲,避免无限增长
                    var cutoff = msg.tick - 240;
                    if (cutoff > 0 && (msg.tick % 120 === 0)) {
                        for (var kk in B.inputBuffer) { if (+kk < cutoff) delete B.inputBuffer[kk]; }
                    }
                }
            } else {
                B.remoteInput = B.remoteInputLatest;
            }
        } else if (msg.t === 'st') {
            B.pendingSnapshot = msg;
            B.diag.snapshotsIn++;
            B.lastSnapshotTime = performance.now();
        } else if (msg.t === 'lvl') {
            if (!B.isHost) loadLevelOnClient(msg.data);
        } else if (msg.t === 'hello') {
            log('peer hello', msg);
        }
    }

    // ── 连接建立 ─────────────────────────────────────────────────────
    function onOpen() {
        B.connected = true;
        wrapGameLoop();
        if (B.isHost) {
            // 主机分配角色:自己保留 localChar,客机取相反角色
            var clientChar = (B.localChar === 'fb') ? 'wg' : 'fb';
            B.net.sendReliable({ t: 'role', localChar: clientChar, mode: B.mode });
            B.net.sendReliable({ t: 'hello', role: 'host' });
            // 立刻把当前关卡广播给客机
            setTimeout(pollLevelChange, 300);
        }
        setStatus('已连接! ' + (B.isHost ? '(主机)' : '(客机)') + ' 模式: ' + B.mode);
        startDiag();
    }

    function onClose() {
        B.connected = false;
        setStatus('连接已断开');
    }

    // ── 包裹主循环 ────────────────────────────────────────────────────
    function wrapGameLoop() {
        var g = getGame();
        if (!g) { setTimeout(wrapGameLoop, 200); return; }
        if (B.wrappedGame === g) return;
        B.wrappedGame = g;
        var orig = g.update.bind(g);
        g.update = function (time) {
            try { beforeUpdate(); } catch (e) { if (CFG.verbose) console.error(e); }
            orig(time);
            try { afterUpdate(); } catch (e) { if (CFG.verbose) console.error(e); }
        };
        // 关卡进度轮询
        if (!B._lvlTimer) B._lvlTimer = setInterval(pollLevelChange, 500);
        // 若之前有等待中的关卡数据,尝试加载
        if (B.pendingLevelData && B.LevelClass) { var d = B.pendingLevelData; B.pendingLevelData = null; loadLevelOnClient(d); }
        log('game loop wrapped');
    }

    // 客机进入任意关卡后,补上 Level 类捕获并加载等待中的关卡
    setInterval(function () {
        var g = getGame(); if (!g || !g.level) return;
        if (!B.LevelClass && g.level.constructor) B.LevelClass = g.level.constructor;
        if (!B.isHost && B.pendingLevelData && B.LevelClass) {
            var d = B.pendingLevelData; B.pendingLevelData = null; loadLevelOnClient(d);
        }
    }, 500);

    // ── 诊断值更新 ────────────────────────────────────────────────────
    function startDiag() {
        if (B._diagTimer) return;
        B._diagTimer = setInterval(function () {
            var lv = B.level; if (!lv || !lv.pers1 || !lv.pers2) return;
            // 计算本地角色与快照的漂移(仅客机 state 模式有意义)
            if (!B.isHost && B.pendingSnapshot) {
                try {
                    var c = (B.localChar === 'fb') ? lv.pers1 : lv.pers2;
                    var s = (B.localChar === 'fb') ? B.pendingSnapshot.c1 : B.pendingSnapshot.c2;
                    if (c && s) {
                        var p = c.body.data.GetPosition();
                        B.diag.drift = Math.sqrt(Math.pow(p.x - s[0], 2) + Math.pow(p.y - s[1], 2));
                    }
                } catch (e) {}
            }
            B.diag.snapshotAgeMs = performance.now() - B.lastSnapshotTime;
        }, 250);
    }

    // ── 状态提示回调(交给 lobby 显示) ────────────────────────────────
    function setStatus(text) {
        if (window.NET_LOBBY && window.NET_LOBBY.setStatus) window.NET_LOBBY.setStatus(text);
        log('status:', text);
    }

    // ── 对外接口(供 lobby 调用) ──────────────────────────────────────
    var Bridge = {
        start: function (opts) {
            // opts: { role:'host'|'guest', room, char:'fb'|'wg', mode }
            B.isHost = opts.role === 'host';
            B.localChar = opts.char || (B.isHost ? 'fb' : 'wg');
            B.mode = opts.mode || CFG.syncMode || 'state';

            // 锁步模式:强制固定时间步长,尽量提升两端确定性(仍不保证跨浏览器逐位一致)
            if (B.mode === 'lockstep') {
                try {
                    var GC = window.GameConfig;
                    if (GC && GC.ticking) {
                        GC.ticking.minTPS = 60;
                        GC.ticking.maxTPS = 60;
                        GC.ticking.ensureTickEveryFrame = true;
                        if (GC.refreshRate) GC.refreshRate.referenceFPS = 60;
                        log('lockstep: forced fixed timestep 60TPS');
                    }
                } catch (e) {}
            }
            try {
                B.net = window.NetCore.create(CFG);
            } catch (e) { setStatus('配置错误: ' + e.message); return; }
            B.net.on('status', setStatus);
            B.net.on('open', onOpen);
            B.net.on('data', onData);
            B.net.on('close', onClose);
            B.net.on('error', function (e) { setStatus('错误: ' + (e && (e.message || e.type) || e)); });
            if (B.isHost) B.net.host(opts.room); else B.net.join(opts.room);
        },
        stop: function () {
            try { B.net && B.net.close(); } catch (e) {}
            B.connected = false;
        },
        getStats: function () {
            var s = (B.net && B.net.stats) || {};
            var g = getGame();
            return {
                rtt: s.rttMs || 0,
                kbpsIn: s.kbpsIn || 0,
                kbpsOut: s.kbpsOut || 0,
                fps: (g && g.time && g.time.fps) || 0,
                drift: B.diag.drift,
                snapAge: B.diag.snapshotAgeMs | 0,
                mode: B.mode,
                role: B.isHost ? 'host' : 'guest',
                localChar: B.localChar,
                connected: B.connected
            };
        }
    };
    window.NET = Bridge;
})();
