# Mochii Member Club 后端（Cloud Functions）

位置：admin 仓库 `_functions/`（底线开头，GitHub Pages 不会把它发布到 admin.themochiishop.com）
Firebase 项目：`member-system-27ae0` · 方案：Blaze

两个功能：🎉 **新会员奖励（New Member Special）**、📅 **每日签到**（2026-11-09）。设计见项目文件 `新会员奖励-第二阶段设计.md` 和 `新会员奖励-第二阶段补充.md`。

## 资料夹
| 档案 | 用途 |
|---|---|
| `functions/index.js` | 函式入口：`nmMember`（会员）、`nmAdmin`（后台）、`ciMember`（📅 签到）、`nmOnMemberCreated`、`nmOnOrderWritten`、`nmDaily` |
| `functions/src/checkin.js` | 📅 每日签到逻辑（7 天一轮、每天一笔）+ 🏅 签到达人（30 天奖励、礼物、分享奖励、每日检查） |
| `functions/test/checkin.test.js` | 签到 + 签到达人测试（17 项，不用模拟器：`npm run test:checkin`） |
| `functions/src/smallgift.js` | 🎁 小礼物：建立一期、作废 / 恢复 / 寄出、每日检查 |
| `functions/test/smallgift.test.js` | 小礼物测试（10 项，不用模拟器：`npm run test:smallgift`） |
| `functions/src/pack.js` | 🧺 打包清单：这一批、找单号、勾选寄出、打包完成 |
| `functions/test/pack.test.js` | 打包清单测试（7 项，不用模拟器：`npm run test:pack`） |
| `functions/src/core.js` | 全部逻辑：状态机、积分、订单检查、权限 |
| `functions/test/core.test.js` | 后端测试（22 项） |
| `firestore.rules` | 完整规则（= 11/08 版 + 新会员奖励 4 处新增） |
| `rules-test/` | 规则测试（官方模拟器） |
| `firebase.json`、`.firebaserc` | 部署设定 |

里面**没有任何密钥**。不要把 `node_modules` 上传到 GitHub（`.gitignore` 已排除）。

---

## 部署步骤（Google Cloud Shell，不用在电脑安装东西）

### 0. 先确认 Firestore 位置
Firebase 控制台 › Firestore Database › 看资料库的「位置」。
- 如果是 `asia-southeast1`：不用改
- 如果是别的（例如 `nam5`、`asia-east1`）：打开 `functions/index.js`，把 `const DB_REGION = "asia-southeast1";` 改成那个位置（`nam5` 填 `us-central1`），存档后再上传

### 1. 把 `_functions` 放进 admin 仓库
和平常一样，把压缩档里的 `_functions` 资料夹上传到 GitHub `themochiishop/admin` 的最上层。

### 2. 打开 Cloud Shell
用店主账号打开 https://shell.cloud.google.com ，等它开好（下面有黑色的终端机）。

### 3. 下载程式码
```bash
git clone https://github.com/themochiishop/admin.git
cd admin/_functions
```

### 4. 登入 Firebase
```bash
firebase --version || npm install -g firebase-tools
firebase login --no-localhost
```
照画面指示：打开连结 → 选店主账号 → 允许 → 把验证码贴回终端机。

### 5. 跑测试（只在模拟器里，不会碰正式资料）
```bash
(cd functions && npm install) && (cd rules-test && npm install)
firebase emulators:exec --only firestore --project demo-nm "cd functions && npm test && cd ../rules-test && npm test"
```
最后看到 `fail 0` 才继续。有任何 `not ok`，把整段画面截图给 Claude。

### 6. 部署 Functions
```bash
firebase deploy --only functions --project member-system-27ae0
```
- 第一次会问要不要启用几个 Google API，回答 `y`
- 如果问「清除旧映像档的天数（cleanup policy）」，输入 `1`
- 看到 `Deploy complete!` 就完成

### 6.5 部署后一定要做（每次部署 Functions 后都要再做一次）
这个项目在 Google Workspace 组织下，组织政策不允许「所有人」呼叫，部署后网站会 403 呼叫不到。执行：
```bash
gcloud run services update nmmember --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0
gcloud run services update nmadmin --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0
gcloud run services update cimember --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0
gcloud run services update sgadmin --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0
gcloud run services update pkadmin --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0
```
检查（要看到「请先登入」）：
```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"data":{"op":"ensure"}}' https://asia-southeast1-member-system-27ae0.cloudfunctions.net/nmMember
```

**第一次部署才需要（2026-11-09 已经做过）**：组织不会自动给预设服务账号权限，已手动加上
`roles/cloudbuild.builds.builder`、`roles/datastore.user`、`roles/eventarc.eventReceiver`、`roles/run.invoker`
（账号 `692900536052-compute@developer.gserviceaccount.com`）。

### 7. 更新 Firestore 规则
Firebase 控制台 › Firestore Database › 规则 → 把 `firestore.rules` 全部内容贴上 → 发布。
（和平常更新规则的方式一样。这份 = 你 11/08 的版本 + 4 处新增，对照见 `rules.diff`）

### 部署后会怎样
- **会员网站完全没有变化**：活动还没启用（后台「活动设定」还没做好），前台也还没加弹窗
- 每次订单同步写入一张单，后端会多读 1 次会员资料（检查有没有进行中的迎新礼）
- 每天 9:05 会跑一次逾期检查（目前没有资料，什么都不做）

---

## 📅 每日签到（2026-11-09）
- 会员：`ciMember({ op: "checkIn" })` → `{ already, today, day, pts, streak, nextPts }`
- 设定：`settings/perks.checkin = { active, points: [7 个数字] }`（后台「额外福利 › 每日签到」）；没设定过 = 关闭，预设分数 1·1·2·2·3·3·8
- 状态：`checkins/{uid}`（会员只读自己的，只有后端写）；积分：`pointsLedger/checkin_{uid}_{yyyymmdd}`，原因「每日签到：第N天」
- 只有绑定订单的会员或内部会员能签；错误 key：`ci/off`、`ci/need-bind`、`ci/not-member`、`ci/signin`
- 只部署签到：`firebase deploy --only functions:ciMember --project member-system-27ae0`，然后做 6.5 的 `cimember` 那一行

## 🏅 签到达人（2026-11-09，设计见项目文件「签到达人-设计.md」）
- 连续签满 30 天（每满 30 天一次）：`ciMember checkIn` 回传多一个 `milestone: { streak, points, sharePts, badges, gift: { name, backorder, days } | null }`
  - +30 分 `pointsLedger/checkin_m30_{uid}_{yyyymmdd}`（原因「签到达人：连续 30 天」）
  - 礼物兑换 `redemptions/ci_{uid}_{yyyymmdd}`：0 积分、pending、随单寄送、`gift: true`、`ciGift: true`、`deadline`；库存 0 → `backorder: true`
  - 徽章 `memberFeed/{uid}.ciBadge`（只有后端能写）；分享资格 `checkins/{uid}.share = { ms, claimed, postId }`
- 分享奖励 `ciOnFeedPostWritten`：`feedPosts` 有 `tag: "checkin"`、`ciMs` = 达标日期，变成已发布 → +10 `pointsLedger/checkin_share_{uid}_{yyyymmdd}`
- 每日 9:15 `ciDaily`：礼物到期前 7 天铃铛提醒；过期且礼物建立后没有订单 → 取消、退库存（补货中的不退）、通知；有订单 → 标 `orderFound`，等管理员随单寄出
- 设定 `settings/perks.checkin.m30 = { points, sharePts, giftRewardId, giftDays }`（预设 30 / 10 / 无礼物 / 30 天）
- 部署：`firebase deploy --only functions:ciMember,functions:ciOnFeedPostWritten,functions:ciDaily --project member-system-27ae0`，然后再跑一次 6.5 的 `cimember`（触发器和排程不用）

## 🎁 小礼物（2026-11-10）
抽奖没得奖的买家，每期送一份小礼物，随下一单寄出。
- 资料：`smallGiftBatches/{场次}`（每期：礼物名称、每单 / 每人、期限）、`smallGifts/{场次}__{单号或买家}`（每一份：单号、平台、用户名、会员 uid、状态 pending / sent / voided、期限）
- `sgAdmin`（后台 callable）：`create`（领奖追踪按「生成小礼物」，要「领奖追踪」权限）、`void` / `restore` / `ship` / `unship`（「领奖追踪」或「📦 打包清单」权限）
- 认人：先看 `orders/{单号}.uid`，再看 `bindings/{platform}_{username}`；认不到 = 非会员，每日检查会再试
- 每日 9:25 `sgDaily`：补认会员；期限内有新订单（看下单时间）→ 标 `orderFound` 不作废；过期没下单 → 作废（`voidReason: expired`）并通知会员；到期前 7 天铃铛提醒会员一次
- 规则：两个集合都只有后端写；会员只能读自己的（`uid`）
- 部署：`firebase deploy --only functions:sgAdmin,functions:sgDaily --project member-system-27ae0`，然后跑 `gcloud run services update sgadmin --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0`，再把 `firestore.rules` 贴到 Firebase 控制台

## 🧺 打包清单（2026-11-10）
页面：admin `pack/`（要「🧺 打包清单」权限）。扫一张单 → 这位顾客要随单寄出的全部东西。
- `pkAdmin`（后台 callable）：`batch`（最近 14 天、没取消、没标记打包完成的订单 + 每张单要放的东西）、`lookup`（单号或买家名）、`ship`（勾选；`done: true` 同时标记这一包完成）、`done`（标记 / 取消打包完成）
- 合并五种：🎁 小礼物（smallGifts pending）、🏆 中奖奖品（prizeWins 随单；claimed / approved 可勾，unclaimed 只提醒）、🛍️ 兑换（redemptions 实体随单；approved 可勾，pending 只提醒）、🏅 签到达人礼物（ciGift，pending 也可勾 = 批准 + 寄出，补货中会扣 1 库存）、🎉 迎新礼（newMemberRewards ready_to_pack / packed，走 core 的 已打包 → 已寄出）
- 寄出写法和后台「随订单寄出」一样：`status: shipped`、`shippedAt`、`shipping: { withOrder: true, orderNo, by, via: "pack" }` → 会员看到已发货，14 天后自动完成照旧
- 权限只在后端检查；回传只有单号、平台、用户名、会员名字、要放什么（没有地址、电话）。打包员不需要能直接读会员资料
- `core.js`：迎新礼的「已打包」「已寄出」两个动作，有「打包清单」权限也可以做（其他迎新礼操作不变）
- 新集合 `packDone/{单号}`（只有后端写）
- 🏆 非会员抽奖得主：页面直接读领奖追踪（要同一个浏览器登录过领奖追踪），勾选会在领奖追踪标记已寄出
- 部署：`firebase deploy --only functions:pkAdmin,functions:nmAdmin --project member-system-27ae0`，然后跑 `pkadmin` 和 `nmadmin` 的 `gcloud` 那两行，再贴规则

## 🛍️ 商城兑换（2026-11-09）
- 会员：`rdMember({ op: "redeem", rewardId, variantId? })` → `{ id }`；`rdMember({ op: "cancel", id })`
- 同一个 Transaction 检查：上架、非签到达人专属、已开放、没过下架时间、款式、库存、本期限兑次数、积分（已到账 − 审核中），通过才建立 pending 兑换并**马上扣库存**（奖品和款式），兑换带 `reserved: true`
- 后台：`reserved` 的兑换批准时不再扣库存（标测试的会加回）；拒绝 / 会员取消时加回；旧的兑换（没有 reserved）照旧批准时扣
- 规则：会员不能再直接建立兑换；`reserved` 的兑换会员只能经后端取消
- 错误 key：`rd/sold-out`、`rd/points`、`rd/limit`、`rd/variant`、`rd/gone`、`rd/not-open`、`rd/ci-only`、`rd/closed`、`rd/not-member`、`rd/not-pending`、`rd/no-cancel`
- 测试：`node --test test/redeem.test.js`（10 项，用 `test/fake-db.js`）
- 部署：`firebase deploy --only functions:rdMember --project member-system-27ae0`，再跑 `gcloud run services update rdmember --no-invoker-iam-check --region=asia-southeast1 --project=member-system-27ae0`

## 网页怎么呼叫
```js
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-functions.js";
const fns = getFunctions(app, "asia-southeast1");
const nmMember = httpsCallable(fns, "nmMember");
await nmMember({ op: "redeem", txId: crypto.randomUUID().replace(/-/g, "") });
```
每次按钮动作产生一个新的 `txId`；同一个动作重送（网络不稳）用同一个 `txId`，后端只执行一次。

**会员 `nmMember`**：`ensure`、`dismissPopup {source}`、`redeem`、`cancel {rid}`
**后台 `nmAdmin`**（都要 `rid`、`txId`）：`approve`、`reject {reason}`、`linkOrder {orderNo, ignoreDeadline, reason}`、`rejectCandidate {orderNo, reason}`、`confirmOrder {orderNo}`、`unlinkOrder {reason}`、`packed`、`unpack {reason}`、`shipped`、`extend {days: 7|14 或 until: 毫秒, reason}`、`cancel {refund, reason}`、`refund {reason}`、`note {text}`、`exception {to, reason}`（只有店主）、`saveSettings {settings}`（只有店主，不用 rid/txId）

错误会带 `details.key`（例如 `nm/insufficient`），网页用它显示三语讯息。

## 状态
`pending_approval` 待批准 → `pending_order` 等待订单 → `order_review` 候选订单待审核 → `ready_to_pack` 待打包 → `packed` 已打包 → `shipped` 已寄出
另有 `expired_review` 逾期待处理、`cancelled` 已取消、`refunded` 已取消并退分。
