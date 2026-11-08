# Mochii Member Club 后端（Cloud Functions）

位置：admin 仓库 `_functions/`（底线开头，GitHub Pages 不会把它发布到 admin.themochiishop.com）
Firebase 项目：`member-system-27ae0` · 方案：Blaze

目前只有一个功能：🎉 **新会员奖励（New Member Special）**。设计见项目文件 `新会员奖励-第二阶段设计.md` 和 `新会员奖励-第二阶段补充.md`。

## 资料夹
| 档案 | 用途 |
|---|---|
| `functions/index.js` | 函式入口：`nmMember`（会员）、`nmAdmin`（后台）、`nmOnMemberCreated`、`nmOnOrderWritten`、`nmDaily` |
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
