# 多人联机 (Multiplayer)

给森林冰火人全系列(1–6)加的**异地双人合作**联机。
一人控制火人(方向键),一人控制冰人(WAD),各自在自己的设备上一起通关。

> 部署自己的信令 / 中转服务器:见 [SELF-HOSTING.md](./SELF-HOSTING.md)

---

## 快速开始(玩家)

1. 两人都打开**同一个游戏**(如「森林神庙」),进入任意一关。
2. 点右上角 **👥 联机** 按钮。
3. 约定一个房间号(任意字母数字,如 `abc123`)。
4. 一方选好角色后点 **创建房间**;另一方输入同样房间号点 **加入房间**。
5. 连接成功后,左下角出现诊断信息(RTT / 帧率 / 带宽)。之后**主机切换关卡时,队友会自动跟随**。

默认使用 PeerJS 公共 broker,**无需任何服务器**即可联机。

---

## 架构总览

```
┌─────────────── 每个游戏页面(games/*/index.html) ───────────────┐
│  <script src="../lib/net/multiplayer.js">  (唯一新增的一行)      │
│     └─ 按序加载:                                                │
│         net-config.js   用户可编辑的配置                         │
│         net-core.js     传输层(WebRTC/PeerJS/WS 中转)          │
│         net-touch.js    触屏适配(联机时只显示本方摇杆)          │
│         net-bridge.js   游戏集成桥(两种同步模型)               │
│         net-lobby.js    大厅 UI + 诊断 HUD                       │
└─────────────────────────────────────────────────────────────────┘
              │ 只在建立连接时用到                    │ P2P 游戏数据
              ▼                                       ▼
   server/signal-server.js (可选,自建)      对端浏览器 (队友)
```

### 引擎接入点(运行时挂钩,**不修改** 2.2MB 的 game.js)

- 通过 `Phaser.GAMES[]` 拿到游戏实例。
- `game.level.pers1` = 火人(fb),`game.level.pers2` = 冰人(wg)。
- 角色输入是 3 个布尔量:`char.cursors.{up,left,right}.isDown`,每物理 tick 读取。
- 刚体:`char.body.data`(box2d `b2Body`),读写位置/角度/速度。
- 主循环:包裹 `game.update`,在角色读取输入**前**注入远端输入,在物理步进**后**收发状态。

### 输入注入方式

游戏被强制为键盘模式(`settings.controls = "keyboard"`),所以每个角色的
`cursors.{up,left,right}` 都是键盘 Key 对象。桥接会:

- 把**远端角色**的 `cursors` 三个键替换成普通对象,脱离本机键盘,改由网络驱动。
- **本地角色**保持键盘/触屏输入,每帧读取其 `isDown` 发给对端。

这比"重放 KeyboardEvent"更干净,也不会像旧实现那样误伤本地键盘。

---

## 两种同步模型(A/B 对比)

面板里的「同步模型」下拉可切换,便于对比。也可用 URL 参数:`?mp_mode=state` 或 `?mp_mode=lockstep`。

### ① 主机权威 + 状态同步(`state`,默认,推荐)

- 主机跑真实物理模拟;客机上报自己的 3-bool 输入。
- 主机每帧应用双方输入 → 步进 → 广播权威状态快照(两个角色 + 动态物体的
  位置/角度/速度)。
- 客机把快照插值应用到本地世界(可选对自己角色做预测以降低操作延迟)。
- **优点**:跨浏览器稳定,不依赖浮点确定性;合作体验好。
- **代价**:带宽略高(每对玩家约 20–60 kbps),客机自身角色有约 1 个 RTT 的延迟(开启预测后基本无感)。

### ② 确定性锁步(`lockstep`,实验对比用)

- 两端各跑一份完整物理;只交换 3-bool 输入(带 tick 号,带缓冲延迟)。
- 启用时会**强制固定 60 TPS 时间步长**以提升确定性。
- **优点**:带宽极小(每对玩家约 1–2 kbps)。
- **风险**:box2d 的 `double` + `sqrt/trig` 在不同浏览器/OS 间存在最后 1 ULP 差异,
  物理会随时间**逐渐漂移**,两端看到的画面可能不同步。**仅用于对比,不建议正式使用。**

> 想直观感受差异:两端各开一关,分别用 `state` 和 `lockstep` 玩 1–2 分钟,
> 观察 `lockstep` 下角色位置是否慢慢对不上(尤其在弹跳、堆叠箱子等物理密集处)。

---

## 配置项(`games/lib/net/net-config.js`)

| 键 | 默认 | 说明 |
|----|------|------|
| `transport` | `'webrtc'` | `'webrtc'` P2P 直连 / `'ws-relay'` 纯 WS 中转 |
| `signaling` | `'peerjs'` | `'peerjs'` 零后端 / `'ws'` 自建信令 |
| `serverUrl` | `''` | 自建服务器地址(`wss://…`) |
| `iceServers` | STUN×2 | STUN 打洞;可加 TURN 兜底 |
| `syncMode` | `'state'` | `'state'` / `'lockstep'` |
| `sendRateHz` | `0` | 发送频率,0=每帧 |
| `predictLocal` | `true` | 客机对自己角色做预测 |
| `interpFactor` | `0.35` | 客机追赶主机状态的插值系数 |
| `debugHud` | `true` | 左下角诊断 HUD |

URL 快捷覆盖(便于测试):`?mp_mode=`、`?mp_transport=`、`?mp_signaling=`、`?mp_server=`、`?mp_hud=0`、`?mp_verbose=1`。

---

## 本地测试(两个标签页)

联机需要 HTTP(S) 环境(`file://` 下 Service Worker / 部分 API 不可用)。

```bash
# 在仓库根目录起一个静态服务器
python3 -m http.server 8000
```

1. 开标签页 A:`http://localhost:8000/games/1-forest-temple/` → 进入第 1 关。
2. 开标签页 B:同样地址 → 进入第 1 关。
3. A 点「创建房间」,房间号 `test`;B 用 `test` 点「加入房间」。
4. 看两个标签页里角色能否互相驱动;HUD 的 RTT 有跳动即连通。

> 想用自建服务器测:`python3 -m http.server 8000` + 另开 `PORT=8080 node server/signal-server.js`,
> 然后在两个标签页 URL 后加 `?mp_signaling=ws&mp_server=ws://localhost:8080`(会覆盖配置)。

---

## 已知限制 / 后续可优化

- **关卡进度**:目前由主机驱动(主机换关,客机自动跟随)。客机在通关瞬间可能短暂看到自己的结算画面,随后被主机的换关指令覆盖。
- **动态物体同步**:按 `level.objects` 顺序索引对齐(两端加载同一关卡 JSON,顺序一致)。门/钻石/液体等靠"位置镜像"自然涌现,未逐一显式同步。
- **断线重连**:MVP 暂未实现,断开后刷新页面重连即可。
- **序列化**:当前用 JSON。后续可换二进制(定点/量化)进一步压带宽。
- **确定性锁步**:受浮点差异影响会漂移,仅作对比;如需正式用需加"状态校验 + 定期重同步"。

---

## 相关文件

```
games/lib/net/
  net-config.js    配置(用户可编辑)
  net-core.js      传输层
  net-touch.js     触屏适配
  net-bridge.js    游戏集成桥(两种同步模型)
  net-lobby.js     大厅 UI + HUD
  multiplayer.js   加载器(index.html 引入的唯一入口)
server/
  signal-server.js 信令 / 中转服务器(可选自建)
  package.json
docs/
  MULTIPLAYER.md   本文档
  SELF-HOSTING.md  自部署指南
```
