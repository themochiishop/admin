// Mochii Member Club — Cloud Functions 入口
// 🎉 新会员奖励：会员用 nmMember、后台用 nmAdmin，两个 callable；另有触发器和每日排程
// 📅 每日签到：会员用 ciMember；🏅 签到达人：ciOnFeedPostWritten（分享奖励）、ciDaily（礼物到期）
"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const core = require("./src/core");
const checkin = require("./src/checkin");   // 📅 每日签到

initializeApp();
const db = getFirestore();

// ⚙️ 区域
// CALL_REGION：网页呼叫的函式放新加坡（离马来西亚最近）
// DB_REGION：触发器要和 Firestore 资料库同一区域 —— 部署前到 Firebase 控制台 › Firestore 确认位置后填这里
const CALL_REGION = "asia-southeast1";
const DB_REGION = "asia-southeast1";

// 只接受自己网站的呼叫（真正的权限检查在 core.js，这只是多一层）
const ORIGINS = [
  "https://www.themochiishop.com",
  "https://themochiishop.com",
  "https://admin.themochiishop.com",
];

function ctxOf(req) {
  const a = req.auth;
  if (!a) return null;
  return { uid: a.uid, email: a.token.email || null, emailVerified: a.token.email_verified === true };
}
async function run(fn, req) {
  try {
    return await fn(db, ctxOf(req), req.data || {});
  } catch (e) {
    if (e instanceof core.NmError) throw new HttpsError(e.code, e.message, { key: e.key });
    logger.error("nm error", e);
    throw new HttpsError("internal", "系统错误，请稍后再试", { key: "nm/internal" });
  }
}

const MEMBER_OPS = {
  ensure: core.nmEnsure,
  dismissPopup: core.nmDismissPopup,
  redeem: core.nmRedeem,
  cancel: core.nmMemberCancel,
};
const ADMIN_OPS = {
  approve: core.nmApprove,
  reject: core.nmReject,
  linkOrder: core.nmLinkOrder,
  rejectCandidate: core.nmRejectCandidate,
  confirmOrder: core.nmConfirmOrder,
  unlinkOrder: core.nmUnlinkOrder,
  packed: core.nmPacked,
  unpack: core.nmUnpack,
  shipped: core.nmShipped,
  extend: core.nmExtend,
  cancel: core.nmCancelReward,
  refund: core.nmRefund,
  note: core.nmNote,
  exception: core.nmException,
  saveSettings: core.nmSaveSettings,
};
function pick(ops, req) {
  const op = req.data && req.data.op;
  const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
  if (!fn) throw new HttpsError("invalid-argument", "未知的操作", { key: "nm/bad-op" });
  return fn;
}

// 会员：{ op: "ensure" | "dismissPopup" | "redeem" | "cancel", ... }
exports.nmMember = onCall({ region: CALL_REGION, cors: ORIGINS, maxInstances: 10 },
  req => run(pick(MEMBER_OPS, req), req));

// 后台：{ op: "approve" | "extend" | ..., rid, txId, ... }
exports.nmAdmin = onCall({ region: CALL_REGION, cors: ORIGINS, maxInstances: 5 },
  req => run(pick(ADMIN_OPS, req), req));

// 📅 每日签到（会员）：{ op: "checkIn" }
const CI_OPS = { checkIn: checkin.ciCheckIn };
exports.ciMember = onCall({ region: CALL_REGION, cors: ORIGINS, maxInstances: 10 },
  req => run(pick(CI_OPS, req), req));

// 🏅 签到达人：签到分享帖（tag = "checkin"）变成已发布 → +10 分（金卡以下要等管理员批准）
exports.ciOnFeedPostWritten = onDocumentWritten({ document: "feedPosts/{pid}", region: DB_REGION },
  async event => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    try { await checkin.onFeedPostWritten(db, event.params.pid, before, after); }
    catch (e) { logger.error("ciOnFeedPostWritten", event.params.pid, e); }
  });

// 🏅 每天早上 9:15（马来西亚）：签到达人礼物到期前 7 天提醒、过期取消
exports.ciDaily = onSchedule({ schedule: "15 9 * * *", timeZone: "Asia/Kuala_Lumpur", region: CALL_REGION },
  async () => {
    const r = await checkin.ciDaily(db);
    logger.info("ciDaily", r);
  });

// 新会员资料建立：活动启用后注册的才标记为新会员
exports.nmOnMemberCreated = onDocumentCreated({ document: "members/{uid}", region: DB_REGION },
  async event => {
    try { await core.ensureEligibility(db, event.params.uid); }
    catch (e) { logger.error("nmOnMemberCreated", e); }
  });

// 订单同步写入：找候选订单 / 订单取消时移除
exports.nmOnOrderWritten = onDocumentWritten({ document: "orders/{orderNo}", region: DB_REGION },
  async event => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    try { await core.onOrderWritten(db, event.params.orderNo, before, after); }
    // 出错只记录：下一次同步再写到这张单时会再检查，管理员也可以手动关联
    catch (e) { logger.error("nmOnOrderWritten", event.params.orderNo, e); }
  });

// 会员按「确认收货」/ 寄出 14 天后自动完成：迎新礼也改成已完成
exports.nmOnRedemptionWritten = onDocumentWritten({ document: "redemptions/{id}", region: DB_REGION },
  async event => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    try { await core.onRedemptionWritten(db, event.params.id, before, after); }
    catch (e) { logger.error("nmOnRedemptionWritten", event.params.id, e); }   // 每日检查会补上
  });

// 每天早上 9:05（马来西亚）：逾期 → 待管理员审核、到期提醒
exports.nmDaily = onSchedule({ schedule: "5 9 * * *", timeZone: "Asia/Kuala_Lumpur", region: CALL_REGION },
  async () => {
    const r = await core.daily(db);
    logger.info("nmDaily", r);
  });
