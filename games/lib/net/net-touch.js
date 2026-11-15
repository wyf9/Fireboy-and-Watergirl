/**
 * ============================================================================
 *  net-touch.js  —  多人模式下的触屏适配
 * ----------------------------------------------------------------------------
 *  单机同屏时 touch-controls.js 会同时显示两套摇杆(火人 + 冰人)。
 *  联机时每台设备只控制一个角色,这里在确定角色后隐藏"对方"的摇杆,
 *  并把本方摇杆居中,避免误触对方按键(对方角色由网络驱动)。
 *
 *  touch-controls.js 的 DOM:
 *    .tc-pad-left  = 冰人 WATERGIRL (wg)
 *    .tc-pad-right = 火人 FIREBOY  (fb)
 * ============================================================================
 */
(function () {
    'use strict';

    var css = document.createElement('style');
    css.textContent = [
        // 联机 + 火人:隐藏冰人(左)摇杆,火人摇杆居中偏右
        'body.mp-solo.mp-role-fb .tc-pad-left  { display:none !important; }',
        'body.mp-solo.mp-role-wg .tc-pad-right { display:none !important; }',
        // 保留的一侧摇杆水平居中,方便单手/双手操作
        'body.mp-solo .tc-pad { left:50% !important; right:auto !important; transform:translateX(-50%); }'
    ].join('\n');
    document.head.appendChild(css);

    window.NET_TOUCH = {
        applyRole: function (localChar) {
            var b = document.body;
            b.classList.add('mp-solo');
            b.classList.remove('mp-role-fb', 'mp-role-wg');
            b.classList.add('mp-role-' + localChar);
        },
        clear: function () {
            var b = document.body;
            b.classList.remove('mp-solo', 'mp-role-fb', 'mp-role-wg');
        }
    };
})();
