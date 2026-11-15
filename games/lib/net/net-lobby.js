/**
 * ============================================================================
 *  net-lobby.js  —  联机大厅 UI + 诊断 HUD
 * ----------------------------------------------------------------------------
 *  提供:右上角"多人联机"按钮 / 建房·加入面板 / 选角 / 同步模型切换 /
 *        左下角诊断 HUD(RTT、FPS、带宽、漂移)。
 * ============================================================================
 */
(function () {
    'use strict';

    var CFG = window.NET_CONFIG || {};
    if (CFG.enabled === false) return;

    var statusEl, hudEl, panel, opened = false, started = false;

    // ── 样式 ─────────────────────────────────────────────────────────
    var css = document.createElement('style');
    css.textContent = [
        '#mp-fab{position:fixed;top:0;right:64px;z-index:10000;padding:6px 12px;',
        '  font:13px sans-serif;background:rgba(0,0,0,.55);color:rgba(255,255,255,.75);',
        '  border:none;border-radius:0 0 6px 6px;cursor:pointer;user-select:none;}',
        '#mp-fab:hover{background:rgba(0,0,0,.85);color:#fff;}',
        '#mp-panel{position:fixed;top:36px;right:8px;z-index:10000;width:260px;',
        '  background:rgba(20,20,26,.96);color:#eee;border:1px solid #33333f;border-radius:12px;',
        '  font:13px/1.5 sans-serif;padding:14px;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;}',
        '#mp-panel h3{margin:0 0 10px;font-size:15px;background:linear-gradient(45deg,#ff4d4d,#33ccff);',
        '  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}',
        '#mp-panel label{display:block;margin:8px 0 3px;color:#aaa;font-size:12px;}',
        '#mp-panel input,#mp-panel select{width:100%;padding:6px 8px;border-radius:6px;border:1px solid #333;',
        '  background:#15151b;color:#fff;font-size:13px;}',
        '#mp-panel .row{display:flex;gap:8px;}',
        '#mp-panel .row>*{flex:1;}',
        '#mp-panel button.act{width:100%;margin-top:10px;padding:8px;border:none;border-radius:6px;',
        '  background:#2a6;color:#fff;font-weight:bold;cursor:pointer;font-size:14px;}',
        '#mp-panel button.act.join{background:#2196F3;}',
        '#mp-panel button.act:hover{filter:brightness(1.15);}',
        '#mp-status{margin-top:10px;font-size:12px;color:#8bd;min-height:18px;word-break:break-all;}',
        '#mp-seg{display:flex;gap:0;margin-top:6px;border-radius:6px;overflow:hidden;border:1px solid #333;}',
        '#mp-seg button{flex:1;padding:6px;background:#15151b;color:#aaa;border:none;cursor:pointer;font-size:12px;}',
        '#mp-seg button.on{background:#3a3a4a;color:#fff;}',
        '#mp-hud{position:fixed;left:6px;bottom:6px;z-index:10000;font:11px/1.45 monospace;',
        '  color:#6f6;background:rgba(0,0,0,.5);padding:6px 8px;border-radius:6px;pointer-events:none;',
        '  white-space:pre;display:none;}'
    ].join('');
    document.head.appendChild(css);

    // ── FAB 按钮 ─────────────────────────────────────────────────────
    var fab = document.createElement('button');
    fab.id = 'mp-fab';
    fab.textContent = '👥 联机';
    fab.onclick = function () { opened = !opened; panel.style.display = opened ? 'block' : 'none'; };

    // ── 面板 ─────────────────────────────────────────────────────────
    panel = document.createElement('div');
    panel.id = 'mp-panel';
    panel.innerHTML =
        '<h3>森林冰火人 · 联机</h3>' +
        '<label>房间号</label>' +
        '<input id="mp-room" placeholder="任意字母数字,如 abc123" autocomplete="off">' +
        '<label>我要控制</label>' +
        '<div id="mp-seg">' +
        '  <button data-char="fb" class="on">🔥 火人 (方向键)</button>' +
        '  <button data-char="wg">💧 冰人 (WAD)</button>' +
        '</div>' +
        '<label>同步模型(A/B 对比)</label>' +
        '<select id="mp-mode">' +
        '  <option value="state">主机权威·状态同步(推荐)</option>' +
        '  <option value="lockstep">确定性锁步(实验)</option>' +
        '</select>' +
        '<div class="row">' +
        '  <button class="act" id="mp-host">创建房间</button>' +
        '  <button class="act join" id="mp-join">加入房间</button>' +
        '</div>' +
        '<div id="mp-status">未连接</div>';

    // ── HUD ──────────────────────────────────────────────────────────
    hudEl = document.createElement('div');
    hudEl.id = 'mp-hud';

    function mount() {
        document.body.appendChild(fab);
        document.body.appendChild(panel);
        document.body.appendChild(hudEl);
        wire();
    }

    var chosenChar = 'fb';

    function wire() {
        statusEl = panel.querySelector('#mp-status');
        // 选角分段控件
        panel.querySelectorAll('#mp-seg button').forEach(function (b) {
            b.onclick = function () {
                panel.querySelectorAll('#mp-seg button').forEach(function (x) { x.classList.remove('on'); });
                b.classList.add('on');
                chosenChar = b.getAttribute('data-char');
            };
        });
        // 默认模式跟随配置
        panel.querySelector('#mp-mode').value = CFG.syncMode || 'state';

        panel.querySelector('#mp-host').onclick = function () { begin('host'); };
        panel.querySelector('#mp-join').onclick = function () { begin('guest'); };
    }

    function begin(role) {
        if (started) { setStatus('已在连接中,如需重来请刷新页面'); return; }
        var room = (panel.querySelector('#mp-room').value || '').trim();
        if (!room) { setStatus('请先输入房间号'); return; }
        var mode = panel.querySelector('#mp-mode').value;
        started = true;
        // 客机的角色由主机分配,这里 host 用所选角色,guest 先用相反(会被 role 消息覆盖)
        var char = role === 'host' ? chosenChar : (chosenChar === 'fb' ? 'wg' : 'fb');
        setStatus('正在建立连接…');
        window.NET.start({ role: role, room: room, char: char, mode: mode });
        if (CFG.debugHud) hudEl.style.display = 'block';
    }

    function setStatus(text) { if (statusEl) statusEl.textContent = text; }
    window.NET_LOBBY = { setStatus: setStatus };

    // ── HUD 刷新 ─────────────────────────────────────────────────────
    setInterval(function () {
        if (!CFG.debugHud || !window.NET || !started) return;
        var s = window.NET.getStats();
        if (!s.connected) { hudEl.textContent = '● 连接中…'; return; }
        hudEl.textContent =
            '● ' + s.role + ' / ' + (s.localChar === 'fb' ? '🔥' : '💧') + ' / ' + s.mode + '\n' +
            'RTT   ' + s.rtt + ' ms\n' +
            'FPS   ' + Math.round(s.fps) + '\n' +
            'net   ↓' + s.kbpsIn + ' ↑' + s.kbpsOut + ' kbps\n' +
            (s.role === 'guest' ? ('drift ' + s.drift.toFixed(2) + ' u\nsnap  ' + s.snapAge + ' ms') : '');
    }, 250);

    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
})();
