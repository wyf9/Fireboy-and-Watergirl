# CONTEXT

> 给后续接手的 agent / 开发者的现状说明。最后更新:2026-11-15。
> 详细玩法与架构见 [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md),服务器部署见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。

## 项目

森林冰火人全系列(1–6)HTML5 静态站点,部署在 GitHub Pages(`waterfire.p.wyf9.top`)。
每个游戏是一个 Phaser 2 + Box2D 引擎(`games/<n>/js/game.js` 约 2.2MB / 5.4 万行,未压缩带注释)。
游戏本身**已支持同屏双人**(冰人 WAD / 火人方向键)。

## 本次工作:异地双人联机

在**不改动 game.js 主体**的前提下,用运行时挂钩加上了联机。当前在分支 `feat/multiplayer`。

### 目录

```
games/lib/net/           联机模块(全部新增)
  multiplayer.js         加载器 —— 每个游戏 index.html 唯一新增的一行
  net-config.js          用户可编辑的配置(唯一普通用户需要动的文件)
  net-core.js            传输层:PeerJS / 原生 WebRTC+自建信令 / 纯 WS 中转
  net-touch.js           联机时只显示本方虚拟摇杆
  net-bridge.js          游戏集成桥 + 两种同步模型
  net-lobby.js           大厅 UI(👥 联机按钮)+ 诊断 HUD
server/                  可选的自建服务器(单文件,仅依赖 ws)
  signal-server.js       同时支持 WebRTC 信令与纯 WS 中转
docs/
  MULTIPLAYER.md         玩法 / 架构 / A-B 对比 / 本地测试 / 已知限制
  SELF-HOSTING.md        信令 / 中转 / TURN 自部署指南
```

六个 `games/*/index.html` 都在 `touch-controls.js` 之后加了一行
`<script src="../lib/net/multiplayer.js"></script>`。game6 的加载结构不同(根目录 `game.js` + `addScript` 引导),但同样适用。

### 引擎接入点(关键事实)

- 通过 `Phaser.GAMES[]` 取游戏实例;`game.level.pers1` = 火人(fb),`pers2` = 冰人(wg)。
- 角色输入只有 3 个布尔量:`char.cursors.{up,left,right}.isDown`,每个物理 tick 读取。
  `settings.controls` 被引擎强制为 `"keyboard"`(`game.js:54075`),所以 cursors 恒为键盘 Key 对象。
- 刚体:`char.body.data`(box2d `b2Body`)。读写用 `GetPosition/GetAngle/GetLinearVelocity/
  SetLinearVelocity/SetAngularVelocity/SetTransformXYRadians/SetAwake`。
- 每帧主循环:包裹 `game.update`(`RequestAnimationFrame.updateRAF` 以实例属性调用,可安全替换)。
  顺序为 `plugins.preUpdate → state.update(角色读输入施力)→ physics.update(步进)→ plugins.update → stage.postUpdate`。
  桥接在 `orig()` 前注入远端输入、后收发状态。
- 渲染是**刚体驱动精灵**:`Box2D.Body.postUpdate` 里 `sprite.x = mpx(-data.GetPosition().x)`,
  且 `preUpdate` 不回写刚体 → 客机直接覆盖 b2Body 能被正确渲染。
- 动态物体:`level.objects`(带 `body.data` 的 device)。胜利判定:`checkEndGame`(两角色各自进门)。

### 与旧实现的关系

历史提交里曾有 `multiplayer.js`(PeerJS + 重放 `KeyboardEvent` + 客机全局拦截键盘),因**阻塞键盘**被移除
(commit `d4e9506`)。新实现改为**直接替换远端角色的 `cursors` 为普通对象、由网络驱动**,不再重放键盘事件,
也不拦截本地键盘。若重新引入类似做法,注意不要重蹈覆辙。

### 同步模型

- `state`(默认,推荐):主机权威跑物理,客机上报 3-bool 输入;主机广播角色+动态物体状态快照;
  客机插值应用(可对自己角色做预测)。不依赖浮点确定性,跨浏览器稳定。
- `lockstep`(实验对比):强制固定 60TPS,仅同步输入+tick。带宽极小但会因 `double`/`sqrt`/`trig`
  跨浏览器 1ULP 差异而**漂移**。仅用于对比演示。
- 切换:大厅下拉框,或 URL `?mp_mode=state|lockstep`。

### 传输

`net-config.js` 三选一:`peerjs`(零后端默认,公共 broker)/ `ws`(自建信令 + WebRTC 直连,双数据通道 rel+fast)/
`ws-relay`(纯中转,100% 连通)。`iceServers` 可加 STUN/TURN。所有参数可用 URL 覆盖
(`?mp_signaling=`、`?mp_server=`、`?mp_transport=`、`?mp_hud=0`、`?mp_verbose=1`)。

## 已验证

自动化(无需浏览器,均已跑通):

- `server/signal-server.js`:房间配对、`peer-joined`/`peer-ready`、信令与 relay 双向转发。
- `net-core.js` 的 `ws-relay` 端到端:双向收发、RTT 心跳、字节统计。
- 全部 `games/lib/net/*.js` 与服务器 `node --check` 通过;六个页面注入各 1 处。

本地复现测试的方式见 `docs/MULTIPLAYER.md`「本地测试」一节。

## 尚未验证 / 待办

- **浏览器内实际联机**尚未人工验证(overnight 无法开浏览器)。需两个标签页实测:
  角色互相驱动、HUD 的 RTT/drift、`state` vs `lockstep` 漂移差异。
- **原生 WebRTC(`signaling:'ws'`)** 路径只做了代码加固(ICE candidate 排队、`ondatachannel`),
  未在真实浏览器对连测试。
- **关卡进度**:主机驱动(换关轮询广播 `lvl`),客机自动跟随;客机通关瞬间可能短暂闪结算画面再被覆盖。
- **动态物体同步**:按 `level.objects` 顺序索引对齐(依赖两端加载同一关卡 JSON 顺序一致);门/钻石/液体靠位置镜像自然涌现,未逐一显式同步。
- **断线重连**:未实现,断开后刷新重连。
- 序列化用 JSON,后续可换二进制/定点量化压带宽。
- 锁步若真要正式用,需加状态校验 + 定期重同步。

## 约定

- 不修改 `games/<n>/js/game.js`(2.2MB 引擎),一切通过 `Phaser.GAMES` 运行时挂钩。
- 普通用户只应改 `games/lib/net/net-config.js`;`server/` 与 `docs/SELF-HOSTING.md` 面向自部署者。
- `server/node_modules` 已加入 `.gitignore`,不提交。
