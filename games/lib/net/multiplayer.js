/**
 * ============================================================================
 *  multiplayer.js  —  联机模块加载器 (Loader)
 * ----------------------------------------------------------------------------
 *  这是每个游戏页面唯一需要引入的一行:
 *      <script src="../lib/net/multiplayer.js"></script>
 *  它会按顺序加载所有联机模块。普通用户只需修改 net-config.js。
 * ============================================================================
 */
(function () {
    'use strict';

    // 计算本文件所在目录,保证相对路径在 6 个游戏下都正确
    var base = 'lib/net/';
    try {
        var cur = document.currentScript && document.currentScript.src;
        if (cur) base = cur.substring(0, cur.lastIndexOf('/') + 1);
    } catch (e) {
        // 回退:games/<x>/index.html 相对 lib
        base = '../lib/net/';
    }

    var modules = [
        'net-config.js',   // 配置(用户可编辑)
        'net-core.js',     // 传输层
        'net-touch.js',    // 触屏适配
        'net-bridge.js',   // 游戏集成桥
        'net-lobby.js'     // 大厅 UI + HUD
    ];

    function loadSeq(i) {
        if (i >= modules.length) return;
        var s = document.createElement('script');
        s.src = base + modules[i];
        s.onload = function () { loadSeq(i + 1); };
        s.onerror = function () { console.error('[multiplayer] 加载失败:', s.src); loadSeq(i + 1); };
        document.body.appendChild(s);
    }
    loadSeq(0);
})();
