// 🎉 新会员奖励（New Member Special）— 后端核心逻辑
// 所有积分、状态变更只在这里执行（Firestore Transaction）；网页只能呼叫，不能直接写。
// 每个动作都是 (db, ctx, data) → 结果；ctx = { uid, email, emailVerified, now(毫秒，可选，测试用) }
"use strict";

const { Timestamp, FieldValue } = require("firebase-admin/firestore");

const OWNER_EMAIL = "mail@themochiishop.com";
const DAY = 86400000;
const COL = { rewards: "newMemberRewards", locks: "nmrOrderLocks", tx: "nmrTx" };
const SETTINGS_PATH = ["settings", "newMember"];

// 状态
const S = {
  APPROVAL: "pending_approval",   // 待批准（积分暂扣）
  ORDER: "pending_order",         // 等待下一笔订单
  REVIEW: "order_review",         // 有候选订单，待审核
  EXPIRED: "expired_review",      // 已逾期，待管理员处理
  READY: "ready_to_pack",         // 订单确认，待打包
  PACKED: "packed",               // 已打包
  SHIPPED: "shipped",             // 已寄出
  COMPLETED: "completed",         // 已完成（会员确认收货 / 寄出 14 天后自动完成）
  CANCELLED: "cancelled",         // 已取消（不退分）
  REFUNDED: "refunded",           // 已取消并退分
};
const ALL_STATUS = Object.values(S);
// 进行中（还没结束）的状态
const ACTIVE = [S.APPROVAL, S.ORDER, S.REVIEW, S.EXPIRED, S.READY, S.PACKED];
// 允许的状态转换（异常处理除外）
const MOVES = {
  [S.APPROVAL]: [S.ORDER, S.CANCELLED],
  [S.ORDER]: [S.REVIEW, S.EXPIRED, S.CANCELLED, S.REFUNDED],
  [S.REVIEW]: [S.READY, S.ORDER, S.EXPIRED, S.CANCELLED, S.REFUNDED],
  [S.EXPIRED]: [S.ORDER, S.REVIEW, S.CANCELLED, S.REFUNDED],
  [S.READY]: [S.PACKED, S.REVIEW, S.CANCELLED, S.REFUNDED],
  [S.PACKED]: [S.SHIPPED, S.READY, S.CANCELLED, S.REFUNDED],
  [S.CANCELLED]: [S.REFUNDED],
  [S.SHIPPED]: [S.COMPLETED],
  [S.COMPLETED]: [],
  [S.REFUNDED]: [],
};

// 活动设定的预设值（后台还没设定过时使用）
const DEFAULTS = {
  active: false,
  popupOn: true,
  startAt: null,
  version: 0,
  gift: { name: "Home Diffuser", image: "", i18n: {} },
  cost: 30,
  validDays: 20,
  perMemberLimit: 1,
  stock: null,
  manualReview: true,
  remindOn: true,
  remindDays: 5,
  copy: {},
};

// ---------- 错误 ----------
// code：https 错误代码；key：给网页翻译用的代号
class NmError extends Error {
  constructor(code, key, message) {
    super(message || key);
    this.code = code;
    this.key = key;
  }
}
const fail = (key, msg, code = "failed-precondition") => { throw new NmError(code, key, msg); };

// ---------- 小工具 ----------
const nowMs = ctx => (ctx && typeof ctx.now === "number" ? ctx.now : Date.now());
const ts = msv => Timestamp.fromMillis(msv);
function toMs(v) {
  if (v == null) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v._seconds === "number") return v._seconds * 1000;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return null;
}
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const cleanReason = (r, required = true) => {
  const s = typeof r === "string" ? r.trim() : "";
  if (required && !s) fail("nm/reason-required", "请填写原因", "invalid-argument");
  if (s.length > 300) fail("nm/reason-too-long", "原因最多 300 字", "invalid-argument");
  return s;
};
const ridOk = rid => typeof rid === "string" && /^[A-Za-z0-9]{6,64}_[0-9]{1,2}$/.test(rid);
const txIdOk = id => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const orderNoOk = no => typeof no === "string" && /^[A-Za-z0-9]{6,40}$/.test(no);
const redemptionIdOf = rid => "nm_" + rid;
// 兑换记录（redemptions）状态对应（会员「兑换记录」显示用）
function redemptionStatusOf(status) {
  if (status === S.APPROVAL) return "pending";
  if (status === S.SHIPPED) return "shipped";
  if (status === S.COMPLETED) return "completed";
  if (status === S.CANCELLED || status === S.REFUNDED) return "cancelled";
  return "approved";
}

function mergeSettings(data) {
  const d = data || {};
  return {
    ...DEFAULTS,
    ...d,
    gift: { ...DEFAULTS.gift, ...(d.gift || {}) },
  };
}

// ---------- 身份检查 ----------
function requireSignedIn(ctx) {
  if (!ctx || !ctx.uid) fail("nm/signin", "请先登入", "unauthenticated");
}
function isOwnerCtx(ctx) {
  return !!(ctx && ctx.emailVerified === true && typeof ctx.email === "string"
    && ctx.email.toLowerCase() === OWNER_EMAIL);
}
// 和 Firestore 规则的 club('newMember') 一样：店主，或 staff 名单里启用中、有 Member Club 全部或「新会员奖励」子权限的人
//   pack: true → 有「🧺 打包清单」权限也可以（只用在迎新礼的「已打包 / 已寄出」）
async function requireStaff(db, ctx, { ownerOnly = false, pack = false } = {}) {
  requireSignedIn(ctx);
  if (isOwnerCtx(ctx)) return { owner: true, email: OWNER_EMAIL };
  if (ownerOnly) fail("nm/owner-only", "只有店主可以执行", "permission-denied");
  if (ctx.emailVerified !== true || typeof ctx.email !== "string") fail("nm/no-perm", "没有权限", "permission-denied");
  const email = ctx.email.toLowerCase();
  const snap = await db.collection("staff").doc(email).get();
  const d = snap.exists ? snap.data() : null;
  const m = d && d.perms ? d.perms.member : undefined;
  const ok = d && d.active !== false
    && (m === true || (m && typeof m === "object" && m.newMember === true)
      || (pack && d.perms && d.perms.pack === true));
  if (!ok) fail("nm/no-perm", "没有「新会员奖励」权限", "permission-denied");
  return { owner: false, email };
}

// ---------- 事务包装：同一个 txId 只执行一次（防重复点击、网络重送） ----------
async function inTx(db, ctx, action, txId, actor, fn) {
  if (!txIdOk(txId)) fail("nm/bad-txid", "缺少事务 ID", "invalid-argument");
  return db.runTransaction(async tx => {
    const txRef = db.collection(COL.tx).doc(txId);
    const prev = await tx.get(txRef);
    if (prev.exists) {
      const p = prev.data();
      if (p.actor !== actor || p.action !== action) fail("nm/txid-used", "事务 ID 重复", "already-exists");
      return { ...(p.result || {}), replay: true };
    }
    const result = (await fn(tx)) || {};
    tx.set(txRef, { actor, action, result, at: ts(nowMs(ctx)) });
    return result;
  });
}

function historyRef(db, rid) {
  return db.collection(COL.rewards).doc(rid).collection("history").doc();
}
function addHistory(tx, db, rid, h, ctx) {
  tx.set(historyRef(db, rid), {
    action: h.action,
    from: h.from || null,
    to: h.to || null,
    by: h.by || "system",
    reason: h.reason || "",
    detail: h.detail || {},
    txId: h.txId || null,
    at: ts(nowMs(ctx)),
  });
}

// 会员资料上的小摘要（首页卡片、铃铛用，不必多读文件）；只更新 nmr.* 栏位，不动其他会员资料
function syncMember(tx, db, uid, r) {
  tx.update(db.collection("members").doc(uid), {
    "nmr.rid": r.rid,
    "nmr.status": r.status,
    "nmr.deadline": r.deadline || null,
    "nmr.updatedAt": r.updatedAt,
  });
}

// 同步到对应的兑换记录（已被会员确认收到的不再改）
function syncRedemption(tx, redSnap, newStatus, extra = {}) {
  if (!redSnap || !redSnap.exists) return;
  const cur = redSnap.data().status;
  if (cur === "completed") return;
  const to = extra.status || redemptionStatusOf(newStatus);
  const upd = { ...extra, status: to };
  if (cur === to && Object.keys(extra).length === 0) return;
  tx.update(redSnap.ref, upd);
}

function assertMove(from, to) {
  if (!(MOVES[from] || []).includes(to)) {
    fail("nm/bad-move", `不能从「${from}」改成「${to}」`);
  }
}

// ---------- 积分余额（和会员网页 loadBalance 相同算法） ----------
async function readBalance(tx, db, uid, at, excludeRedemptionId) {
  const [lSnap, rSnap] = await Promise.all([
    tx.get(db.collection("pointsLedger").where("uid", "==", uid)),
    tx.get(db.collection("redemptions").where("uid", "==", uid)),
  ]);
  let available = 0, pending = 0;
  lSnap.docs.forEach(d => {
    const x = d.data();
    const a = toMs(x.availableAt);
    if (a && a > at) pending += Number(x.delta) || 0;
    else available += Number(x.delta) || 0;
  });
  const reserved = rSnap.docs
    .filter(d => d.id !== excludeRedemptionId && d.data().status === "pending")
    .reduce((s, d) => s + (Number(d.data().cost) || 0), 0);
  return { available, pending, reserved, spendable: available - reserved };
}

// ---------- 订单是否符合 ----------
// 回传 { ok, reason, info }；reason 只在 ok = false 时有
const EARLY_MS = 7 * 86400000; // 管理员手动关联时，最多接受兑换前 7 天内下的单
async function checkOrder(tx, db, reward, rid, orderSnap, { ignoreDeadline = false, allowEarly = false } = {}) {
  if (!orderSnap || !orderSnap.exists) return { ok: false, reason: "not-found" };
  const o = orderSnap.data();
  const info = {
    orderNo: orderSnap.id,
    platform: o.platform || "",
    username: o.username || "",
    orderTime: o.orderTime || null,
    amount: typeof o.amount === "number" ? o.amount : null,
  };
  if (o.uid !== reward.uid) return { ok: false, reason: "other-member", info };
  if (o.status === "refunded") return { ok: false, reason: "refunded", info };
  const ot = toMs(o.orderTime);
  if (!ot) return { ok: false, reason: "no-time", info };
  // 起点：会员按兑换的时间（批准前下的单也算）；终点：目前截止时间（用平台下单时间，不用同步时间）
  const req = toMs(reward.requestedAt);
  if (ot < req && !(allowEarly && ot >= req - EARLY_MS)) return { ok: false, reason: allowEarly ? "too-early" : "before-redeem", info };
  if (!ignoreDeadline && reward.deadline && ot > toMs(reward.deadline)) return { ok: false, reason: "after-deadline", info };
  // 订单的购买账号必须仍绑定在这位会员名下
  const bSnap = await tx.get(db.collection("bindings").doc(`${o.platform}_${o.username}`));
  if (!bSnap.exists || bSnap.data().uid !== reward.uid) return { ok: false, reason: "not-bound", info };
  // 不能被别的迎新礼占用
  const lock = await tx.get(db.collection(COL.locks).doc(orderSnap.id));
  if (lock.exists && lock.data().rid !== rid) return { ok: false, reason: "locked", info };
  return { ok: true, info };
}

// ---------- 会员资格 ----------
function eligibleBySettings(member, settings) {
  const created = toMs(member && member.createdAt);
  const start = toMs(settings.startAt);
  return !!(settings.active && start && created && created >= start);
}

// 新会员资料建立时（触发器）或网页刚注册时呼叫：判断并写入 nmr.eligible
async function ensureEligibility(db, uid, ctx) {
  const memberRef = db.collection("members").doc(uid);
  return db.runTransaction(async tx => {
    const [mSnap, sSnap] = await Promise.all([tx.get(memberRef), tx.get(db.doc(SETTINGS_PATH.join("/")))]);
    if (!mSnap.exists) return { eligible: false };
    const m = mSnap.data();
    if (m.nmr && typeof m.nmr === "object" && "eligible" in m.nmr) return publicNmr(m.nmr);
    const settings = mergeSettings(sSnap.exists ? sSnap.data() : null);
    if (!eligibleBySettings(m, settings)) return { eligible: false };   // 旧会员不写任何资料
    const nmr = { eligible: true, joinedAfter: settings.startAt, at: ts(nowMs(ctx)) };
    tx.update(memberRef, { nmr });
    return publicNmr(nmr);
  });
}
function publicNmr(n) {
  return {
    eligible: !!n.eligible,
    popupSeen: !!n.popupSeenAt,
    rid: n.rid || null,
    status: n.status || null,
    deadline: toMs(n.deadline),
  };
}

// ======================================================================
// 会员用
// ======================================================================

async function nmEnsure(db, ctx) {
  requireSignedIn(ctx);
  return ensureEligibility(db, ctx.uid, ctx);
}

// 关闭弹窗（只记一次）；source = "card" 表示从包裹卡片进来
async function nmDismissPopup(db, ctx, data = {}) {
  requireSignedIn(ctx);
  const ref = db.collection("members").doc(ctx.uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) fail("nm/no-member", "找不到会员资料", "not-found");
    const n = snap.data().nmr || {};
    if (!n.eligible) return { ok: true, skipped: true };
    const upd = {};
    if (!n.popupSeenAt) upd["nmr.popupSeenAt"] = ts(nowMs(ctx));
    if (data.source === "card" && !n.source) upd["nmr.source"] = "card";
    if (Object.keys(upd).length) tx.update(ref, upd);
    return { ok: true };
  });
}

// 兑换迎新礼
async function nmRedeem(db, ctx, data = {}) {
  requireSignedIn(ctx);
  const uid = ctx.uid;
  return inTx(db, ctx, "redeem", data.txId, uid, async tx => {
    const at = nowMs(ctx);
    const settingsRef = db.doc(SETTINGS_PATH.join("/"));
    const memberRef = db.collection("members").doc(uid);
    const [sSnap, mSnap, rwSnap, bSnap] = await Promise.all([
      tx.get(settingsRef),
      tx.get(memberRef),
      tx.get(db.collection(COL.rewards).where("uid", "==", uid)),
      tx.get(db.collection("bindings").where("uid", "==", uid)),
    ]);
    const settings = mergeSettings(sSnap.exists ? sSnap.data() : null);
    if (!settings.active) fail("nm/inactive", "活动暂停中");
    if (!mSnap.exists) fail("nm/no-member", "找不到会员资料", "not-found");
    const member = mSnap.data();
    const internal = !!(member.internal && member.internal.on === true);
    const nmr = member.nmr || {};
    // 🏷️ 内部会员：不用新会员资格、不用绑定，标记为测试（不扣库存、不算统计）
    const test = internal;
    if (!internal && nmr.eligible !== true) fail("nm/not-eligible", "只有新会员可以兑换");
    const binds = bSnap.docs.map(d => d.data());
    if (!internal && !binds.length) fail("nm/need-bind", "请先绑定 Shopee / TikTok 账号");

    const existing = rwSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (existing.some(r => ACTIVE.includes(r.status))) fail("nm/already", "已经有一笔迎新礼在处理中");
    // 批准前就取消 / 被拒绝的不算次数
    const used = existing.filter(r => !(r.status === S.CANCELLED && !r.approvedAt)).length;
    if (used >= settings.perMemberLimit) fail("nm/limit", "已经兑换过迎新礼");
    if (!test && typeof settings.stock === "number" && settings.stock <= 0) fail("nm/out-of-stock", "迎新礼已换完");

    const cost = settings.cost;
    const bal = await readBalance(tx, db, uid, at, null);
    if (bal.available < 0) fail("nm/negative", "积分是负数，暂时不能兑换");
    if (bal.spendable < cost) fail("nm/insufficient", `积分不足（需要 ${cost} 分）`);

    const rid = `${uid}_${existing.length + 1}`;
    const rewardRef = db.collection(COL.rewards).doc(rid);
    const redRef = db.collection("redemptions").doc(redemptionIdOf(rid));
    const auto = settings.manualReview === false;
    const status = auto ? S.ORDER : S.APPROVAL;
    const nowTs = ts(at);
    const deadline = auto ? ts(at + settings.validDays * DAY) : null;

    const reward = {
      uid,
      memberName: member.name || "",
      boundAccounts: binds.map(b => ({ platform: b.platform || "", username: b.username || "" })),
      redemptionId: redRef.id,
      status,
      test,
      gift: { name: settings.gift.name, image: settings.gift.image || "", i18n: settings.gift.i18n || {} },
      cost,
      rule: {
        version: settings.version || 0,
        cost,
        validDays: settings.validDays,
        manualReview: !auto,
        perMemberLimit: settings.perMemberLimit,
      },
      requestedAt: nowTs,
      approvedAt: auto ? nowTs : null,
      originalDeadline: deadline,
      deadline,
      candidates: [],
      linkedOrder: null,
      orderIssue: null,
      reviewedBy: null, reviewedAt: null,
      packedBy: null, packedAt: null,
      shippedBy: null, shippedAt: null,
      refund: null,
      hasNote: false,
      remindedAt: null,
      source: nmr.source || (data.source === "card" ? "card" : null),
      createdAt: nowTs,
      updatedAt: nowTs,
    };
    tx.create(rewardRef, reward);

    const red = {
      uid,
      rewardId: "newMember",
      rewardName: settings.gift.name,
      cost,
      status: auto ? "approved" : "pending",
      kind: "gift",
      delivery: "withOrder",
      newMember: true,
      nmrId: rid,
      createdAt: nowTs,
    };
    if (auto) red.decidedAt = nowTs;
    if (test) red.test = true;
    tx.create(redRef, red);

    if (auto) {
      tx.create(db.collection("pointsLedger").doc("nmr_redeem_" + rid), {
        uid, delta: -cost, reason: "兑换：" + settings.gift.name + "（新会员礼）", orderNo: null,
        redemptionId: redRef.id, availableAt: nowTs, createdAt: nowTs,
      });
    }
    if (!test && typeof settings.stock === "number") tx.update(settingsRef, { stock: FieldValue.increment(-1) });
    syncMember(tx, db, uid, { rid, status, deadline, updatedAt: nowTs });
    addHistory(tx, db, rid, { action: "redeem", to: status, by: uid, detail: { cost, auto }, txId: data.txId }, ctx);
    return { rid, status };
  });
}

// 会员取消还没批准的兑换
async function nmMemberCancel(db, ctx, data = {}) {
  requireSignedIn(ctx);
  if (!ridOk(data.rid)) fail("nm/bad-rid", "资料错误", "invalid-argument");
  return inTx(db, ctx, "memberCancel", data.txId, ctx.uid, async tx => {
    const { reward, red, ref, settingsRef, settings } = await loadReward(tx, db, data.rid, { settings: true });
    if (reward.uid !== ctx.uid) fail("nm/no-perm", "没有权限", "permission-denied");
    if (reward.status !== S.APPROVAL) fail("nm/bad-move", "已经批准，不能自己取消，请联系客服");
    return finishCancel(tx, db, ctx, { ref, reward, red, settingsRef, settings, to: S.CANCELLED,
      by: ctx.uid, reason: "会员自行取消", redExtra: { status: "cancelled" }, action: "memberCancel", txId: data.txId });
  });
}

// ======================================================================
// 管理员用
// ======================================================================

async function loadReward(tx, db, rid, { settings = false } = {}) {
  const ref = db.collection(COL.rewards).doc(rid);
  const snap = await tx.get(ref);
  if (!snap.exists) fail("nm/not-found", "找不到这笔迎新礼", "not-found");
  const reward = snap.data();
  const redSnap = await tx.get(db.collection("redemptions").doc(reward.redemptionId || redemptionIdOf(rid)));
  let settingsRef = null, s = null;
  if (settings) {
    settingsRef = db.doc(SETTINGS_PATH.join("/"));
    const sSnap = await tx.get(settingsRef);
    s = { exists: sSnap.exists, ...mergeSettings(sSnap.exists ? sSnap.data() : null) };
  }
  return { ref, reward, red: redSnap, settingsRef, settings: s };
}

// 取消 / 拒绝 / 退分共用的写入（读取必须都在前面做完）
function finishCancel(tx, db, ctx, o) {
  const at = ts(nowMs(ctx));
  const { ref, reward, red, settingsRef, settings, to } = o;
  const rid = ref.id;
  const upd = { status: to, updatedAt: at, cancelledAt: at, cancelledBy: o.by, cancelReason: o.reason || "" };
  if (o.refundLedgerId) upd.refund = { ledgerId: o.refundLedgerId, by: o.by, at };
  // 释放订单锁
  if (reward.linkedOrder && reward.linkedOrder.orderNo) {
    tx.delete(db.collection(COL.locks).doc(reward.linkedOrder.orderNo));
    upd.linkedOrder = null;
  }
  tx.update(ref, upd);
  // 库存退回（测试的不算；已寄出不会走到这里）
  if (o.restoreStock && !reward.test && settings && settings.exists && typeof settings.stock === "number") {
    tx.update(settingsRef, { stock: FieldValue.increment(1) });
  }
  syncRedemption(tx, red, to, o.redExtra || {});
  syncMember(tx, db, reward.uid, { rid, status: to, deadline: reward.deadline, updatedAt: at });
  addHistory(tx, db, rid, { action: o.action, from: reward.status, to, by: o.by, reason: o.reason, txId: o.txId,
    detail: o.refundLedgerId ? { refund: reward.cost } : {} }, ctx);
  return { rid, status: to };
}

async function adminAction(db, ctx, name, data, opts, fn) {
  const staff = await requireStaff(db, ctx, opts);
  if (!ridOk(data.rid)) fail("nm/bad-rid", "资料错误", "invalid-argument");
  return inTx(db, ctx, name, data.txId, staff.email, tx => fn(tx, staff));
}

// 批准：扣分、开始倒数
async function nmApprove(db, ctx, data = {}) {
  return adminAction(db, ctx, "approve", data, {}, async (tx, staff) => {
    const at = nowMs(ctx);
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (reward.status !== S.APPROVAL) fail("nm/bad-move", "这笔不是待批准状态");
    const ledgerRef = db.collection("pointsLedger").doc("nmr_redeem_" + data.rid);
    const lSnap = await tx.get(ledgerRef);
    if (lSnap.exists) fail("nm/already-charged", "这笔已经扣过分");
    const bal = await readBalance(tx, db, reward.uid, at, red.exists ? red.id : null);
    if (bal.available < 0 || bal.spendable < reward.cost) fail("nm/insufficient", "会员积分不足，请拒绝或请会员补足");
    const deadline = ts(at + (reward.rule.validDays || DEFAULTS.validDays) * DAY);
    // 兑换后、批准前下的单也算：马上扫一次
    const tmp = { ...reward, deadline };
    const oSnap = await tx.get(db.collection("orders").where("uid", "==", reward.uid));
    const candidates = [];
    for (const o of oSnap.docs) {
      const c = await checkOrder(tx, db, tmp, data.rid, o);
      if (c.ok) candidates.push({ ...c.info, source: "auto", ignoreDeadline: false, foundAt: ts(at) });
    }
    const status = candidates.length ? S.REVIEW : S.ORDER;
    const nowTs = ts(at);
    tx.create(ledgerRef, {
      uid: reward.uid, delta: -reward.cost, reason: "兑换：" + reward.gift.name + "（新会员礼）", orderNo: null,
      redemptionId: red.exists ? red.id : redemptionIdOf(data.rid), availableAt: nowTs, createdAt: nowTs,
    });
    tx.update(ref, {
      status, approvedAt: nowTs, originalDeadline: deadline, deadline, candidates,
      reviewedBy: staff.email, reviewedAt: nowTs, updatedAt: nowTs,
    });
    syncRedemption(tx, red, status, { decidedAt: nowTs });
    syncMember(tx, db, reward.uid, { rid: data.rid, status, deadline, updatedAt: nowTs });
    addHistory(tx, db, data.rid, { action: "approve", from: reward.status, to: status, by: staff.email,
      detail: { cost: reward.cost, candidates: candidates.map(c => c.orderNo) }, txId: data.txId }, ctx);
    return { rid: data.rid, status };
  });
}

// 拒绝（还没扣分，不用退）
async function nmReject(db, ctx, data = {}) {
  return adminAction(db, ctx, "reject", data, {}, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const o = await loadReward(tx, db, data.rid, { settings: true });
    if (o.reward.status !== S.APPROVAL) fail("nm/bad-move", "这笔不是待批准状态");
    return finishCancel(tx, db, ctx, { ...o, to: S.CANCELLED, by: staff.email, reason, restoreStock: true,
      redExtra: { status: "rejected", decidedAt: ts(nowMs(ctx)) }, action: "reject", txId: data.txId });
  });
}

// 手动关联订单（加进候选，等确认）
async function nmLinkOrder(db, ctx, data = {}) {
  return adminAction(db, ctx, "linkOrder", data, {}, async (tx, staff) => {
    if (!orderNoOk(data.orderNo)) fail("nm/bad-order", "订单编号格式不对", "invalid-argument");
    const ignoreDeadline = data.ignoreDeadline === true;
    const allowEarly = data.allowEarly === true;
    const reason = cleanReason(data.reason, ignoreDeadline || allowEarly);
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (![S.ORDER, S.REVIEW, S.EXPIRED].includes(reward.status)) fail("nm/bad-move", "这个状态不能关联订单");
    const oSnap = await tx.get(db.collection("orders").doc(data.orderNo));
    const c = await checkOrder(tx, db, reward, data.rid, oSnap, { ignoreDeadline, allowEarly });
    if (!c.ok) fail("nm/order-" + c.reason, orderReasonText(c.reason));
    const at = ts(nowMs(ctx));
    const early = toMs(c.info.orderTime) < toMs(reward.requestedAt);
    const list = (reward.candidates || []).filter(x => x.orderNo !== data.orderNo);
    list.push({ ...c.info, source: "manual", ignoreDeadline, allowEarly: early, foundAt: at, by: staff.email });
    const status = S.REVIEW;
    tx.update(ref, { candidates: list, status, updatedAt: at });
    if (reward.status !== status) {
      syncRedemption(tx, red, status);
      syncMember(tx, db, reward.uid, { rid: data.rid, status, deadline: reward.deadline, updatedAt: at });
    }
    addHistory(tx, db, data.rid, { action: "linkOrder", from: reward.status, to: status, by: staff.email, reason,
      detail: { orderNo: data.orderNo, ignoreDeadline, allowEarly: early }, txId: data.txId }, ctx);
    return { rid: data.rid, status };
  });
}

// 否决某张候选订单
async function nmRejectCandidate(db, ctx, data = {}) {
  return adminAction(db, ctx, "rejectCandidate", data, {}, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (reward.status !== S.REVIEW) fail("nm/bad-move", "这笔不是待审核订单状态");
    const list = (reward.candidates || []).filter(x => x.orderNo !== data.orderNo);
    if (list.length === (reward.candidates || []).length) fail("nm/not-candidate", "这张单不在候选名单");
    const at = nowMs(ctx);
    const status = list.length ? S.REVIEW : (toMs(reward.deadline) >= at ? S.ORDER : S.EXPIRED);
    tx.update(ref, { candidates: list, status, updatedAt: ts(at) });
    if (status !== reward.status) {
      syncRedemption(tx, red, status);
      syncMember(tx, db, reward.uid, { rid: data.rid, status, deadline: reward.deadline, updatedAt: ts(at) });
    }
    addHistory(tx, db, data.rid, { action: "rejectCandidate", from: reward.status, to: status, by: staff.email, reason,
      detail: { orderNo: data.orderNo }, txId: data.txId }, ctx);
    return { rid: data.rid, status };
  });
}

// 确认订单 → 待打包（锁住这张单）
async function nmConfirmOrder(db, ctx, data = {}) {
  return adminAction(db, ctx, "confirmOrder", data, {}, async (tx, staff) => {
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (reward.status !== S.REVIEW) fail("nm/bad-move", "这笔不是待审核订单状态");
    const cand = (reward.candidates || []).find(x => x.orderNo === data.orderNo);
    if (!cand) fail("nm/not-candidate", "请先把这张单加进候选");
    const oSnap = await tx.get(db.collection("orders").doc(data.orderNo));
    const c = await checkOrder(tx, db, reward, data.rid, oSnap,
      { ignoreDeadline: cand.ignoreDeadline === true, allowEarly: cand.allowEarly === true });
    if (!c.ok) fail("nm/order-" + c.reason, orderReasonText(c.reason));
    const at = ts(nowMs(ctx));
    tx.set(db.collection(COL.locks).doc(data.orderNo), { rid: data.rid, uid: reward.uid, at });
    const linkedOrder = { ...c.info, by: staff.email, at, ignoreDeadline: cand.ignoreDeadline === true, allowEarly: cand.allowEarly === true };
    tx.update(ref, { status: S.READY, linkedOrder, orderIssue: null, reviewedBy: staff.email, reviewedAt: at, updatedAt: at });
    syncRedemption(tx, red, S.READY);
    syncMember(tx, db, reward.uid, { rid: data.rid, status: S.READY, deadline: reward.deadline, updatedAt: at });
    addHistory(tx, db, data.rid, { action: "confirmOrder", from: reward.status, to: S.READY, by: staff.email,
      detail: { orderNo: data.orderNo }, txId: data.txId }, ctx);
    return { rid: data.rid, status: S.READY };
  });
}

// 换订单：待打包 → 回到待审核
async function nmUnlinkOrder(db, ctx, data = {}) {
  return adminAction(db, ctx, "unlinkOrder", data, {}, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (reward.status !== S.READY) fail("nm/bad-move", "只有待打包可以换订单（已打包请先拆包）");
    const at = ts(nowMs(ctx));
    if (reward.linkedOrder) tx.delete(db.collection(COL.locks).doc(reward.linkedOrder.orderNo));
    const keep = (reward.candidates || []).filter(x => !reward.linkedOrder || x.orderNo !== reward.linkedOrder.orderNo || data.keepCandidate === true);
    tx.update(ref, { status: S.REVIEW, linkedOrder: null, candidates: keep, updatedAt: at });
    syncMember(tx, db, reward.uid, { rid: data.rid, status: S.REVIEW, deadline: reward.deadline, updatedAt: at });
    syncRedemption(tx, red, S.REVIEW);
    addHistory(tx, db, data.rid, { action: "unlinkOrder", from: reward.status, to: S.REVIEW, by: staff.email, reason,
      detail: { orderNo: reward.linkedOrder ? reward.linkedOrder.orderNo : null }, txId: data.txId }, ctx);
    return { rid: data.rid, status: S.REVIEW };
  });
}

// 打包 / 拆包 / 寄出（一定由管理员按）
function simpleMove(name, from, to, { needReason = false, field, pack = false } = {}) {
  return async (db, ctx, data = {}) => adminAction(db, ctx, name, data, { pack }, async (tx, staff) => {
    const reason = cleanReason(data.reason, needReason);
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (reward.status !== from) fail("nm/bad-move", `这笔不是「${from}」状态`);
    assertMove(from, to);
    const at = ts(nowMs(ctx));
    const upd = { status: to, updatedAt: at };
    if (field) { upd[field + "By"] = staff.email; upd[field + "At"] = at; }
    tx.update(ref, upd);
    // 寄出：和一般随单寄送的兑换一样，写入「随订单寄出 + 订单编号」，会员的兑换记录才看得到
    const redExtra = to === S.SHIPPED ? {
      shippedAt: at,
      shipping: { withOrder: true, orderNo: reward.linkedOrder ? reward.linkedOrder.orderNo : "", platform: reward.linkedOrder ? reward.linkedOrder.platform : "" },
    } : {};
    syncRedemption(tx, red, to, redExtra);
    syncMember(tx, db, reward.uid, { rid: data.rid, status: to, deadline: reward.deadline, updatedAt: at });
    addHistory(tx, db, data.rid, { action: name, from, to, by: staff.email, reason, txId: data.txId }, ctx);
    return { rid: data.rid, status: to };
  });
}
const nmPacked = simpleMove("packed", S.READY, S.PACKED, { field: "packed", pack: true });
const nmUnpack = simpleMove("unpack", S.PACKED, S.READY, { needReason: true });
const nmShipped = simpleMove("shipped", S.PACKED, S.SHIPPED, { field: "shipped", pack: true });

// 延期：7 / 14 天，或自订日期；原因必填
async function nmExtend(db, ctx, data = {}) {
  return adminAction(db, ctx, "extend", data, {}, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (![S.ORDER, S.REVIEW, S.EXPIRED].includes(reward.status)) fail("nm/bad-move", "这个状态不能延期");
    const at = nowMs(ctx);
    const cur = toMs(reward.deadline) || at;
    let until;
    if (data.days === 7 || data.days === 14) until = Math.max(cur, at) + data.days * DAY;
    else if (typeof data.until === "number") until = data.until;
    else fail("nm/bad-extend", "请选择延期天数或日期", "invalid-argument");
    if (until <= at) fail("nm/bad-extend", "新的截止时间必须在现在之后", "invalid-argument");
    if (until > at + 365 * DAY) fail("nm/bad-extend", "最多延到一年内", "invalid-argument");
    let status = reward.status;
    if (status === S.EXPIRED) status = (reward.candidates || []).length ? S.REVIEW : S.ORDER;
    const deadline = ts(until);
    tx.update(ref, { deadline, status, remindedAt: null, updatedAt: ts(at) });
    if (status !== reward.status) syncRedemption(tx, red, status);
    syncMember(tx, db, reward.uid, { rid: data.rid, status, deadline, updatedAt: ts(at) });
    addHistory(tx, db, data.rid, { action: "extend", from: reward.status, to: status, by: staff.email, reason,
      detail: { oldDeadline: reward.deadline || null, newDeadline: deadline, days: data.days || null }, txId: data.txId }, ctx);
    return { rid: data.rid, status, deadline: until };
  });
}

// 取消（可选择同时退分）
async function nmCancelReward(db, ctx, data = {}) {
  return adminAction(db, ctx, "cancel", data, {}, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const o = await loadReward(tx, db, data.rid, { settings: true });
    const r = o.reward;
    if (!ACTIVE.includes(r.status)) fail("nm/bad-move", "已经结束的纪录不能取消");
    const charged = !!r.approvedAt;
    const wantRefund = data.refund === true && charged;
    let refundLedgerId = null;
    if (wantRefund) {
      const lRef = db.collection("pointsLedger").doc("nmr_refund_" + data.rid);
      const lSnap = await tx.get(lRef);
      if (lSnap.exists) fail("nm/already-refunded", "已经退过分");
      refundLedgerId = lRef.id;
    }
    const to = wantRefund ? S.REFUNDED : S.CANCELLED;
    if (r.status !== S.APPROVAL) assertMove(r.status, to);
    if (wantRefund) writeRefund(tx, db, ctx, r, data.rid, refundLedgerId);
    const at = ts(nowMs(ctx));
    return finishCancel(tx, db, ctx, { ...o, to, by: staff.email, reason, refundLedgerId, restoreStock: true,
      redExtra: r.status === S.APPROVAL
        ? { status: "rejected", decidedAt: at }
        : { adminCancelled: true, cancelledAt: at, cancelNote: reason, cancelledBy: staff.email },
      action: wantRefund ? "cancelRefund" : "cancel", txId: data.txId });
  });
}

function writeRefund(tx, db, ctx, reward, rid, ledgerId) {
  const at = ts(nowMs(ctx));
  tx.create(db.collection("pointsLedger").doc(ledgerId), {
    uid: reward.uid, delta: reward.cost, reason: "兑换取消退回：" + reward.gift.name + "（新会员礼）", orderNo: null,
    redemptionId: reward.redemptionId || redemptionIdOf(rid), availableAt: at, createdAt: at,
  });
}

// 已取消的补退分
async function nmRefund(db, ctx, data = {}) {
  return adminAction(db, ctx, "refund", data, {}, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const o = await loadReward(tx, db, data.rid);
    const r = o.reward;
    if (r.status !== S.CANCELLED) fail("nm/bad-move", "只有「已取消」可以补退分");
    if (!r.approvedAt) fail("nm/not-charged", "这笔没有扣过分，不用退");
    const lRef = db.collection("pointsLedger").doc("nmr_refund_" + data.rid);
    const lSnap = await tx.get(lRef);
    if (lSnap.exists || r.refund) fail("nm/already-refunded", "已经退过分");
    writeRefund(tx, db, ctx, r, data.rid, lRef.id);
    const at = ts(nowMs(ctx));
    tx.update(o.ref, { status: S.REFUNDED, refund: { ledgerId: lRef.id, by: staff.email, at }, updatedAt: at });
    syncMember(tx, db, r.uid, { rid: data.rid, status: S.REFUNDED, deadline: r.deadline, updatedAt: at });
    addHistory(tx, db, data.rid, { action: "refund", from: r.status, to: S.REFUNDED, by: staff.email, reason,
      detail: { refund: r.cost }, txId: data.txId }, ctx);
    return { rid: data.rid, status: S.REFUNDED };
  });
}

// 管理员备注（只写进历史，会员看不到内容）
async function nmNote(db, ctx, data = {}) {
  return adminAction(db, ctx, "note", data, {}, async (tx, staff) => {
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text || text.length > 500) fail("nm/bad-note", "备注 1–500 字", "invalid-argument");
    const { ref, reward } = await loadReward(tx, db, data.rid);
    const at = ts(nowMs(ctx));
    tx.update(ref, { hasNote: true, noteCount: FieldValue.increment(1), lastNoteAt: at, updatedAt: at });
    addHistory(tx, db, data.rid, { action: "note", from: reward.status, to: reward.status, by: staff.email,
      reason: text, txId: data.txId }, ctx);
    return { rid: data.rid, status: reward.status };
  });
}

// 异常处理：只有店主；只改状态（不动积分、库存），原因必填
async function nmException(db, ctx, data = {}) {
  return adminAction(db, ctx, "exception", data, { ownerOnly: true }, async (tx, staff) => {
    const reason = cleanReason(data.reason);
    const to = data.to;
    if (!ALL_STATUS.includes(to)) fail("nm/bad-status", "状态不对", "invalid-argument");
    const { ref, reward, red } = await loadReward(tx, db, data.rid);
    if (reward.status === to) fail("nm/same-status", "状态没有改变");
    if (reward.status === S.SHIPPED && to === S.ORDER) fail("nm/bad-move", "已寄出不能改回等待订单");
    if ([S.READY, S.PACKED, S.SHIPPED].includes(to) && !reward.linkedOrder) fail("nm/need-order", "要先有关联订单");
    if (to === S.REFUNDED && !reward.refund) fail("nm/use-refund", "退分请用「取消并退分」或「补退分」");
    const at = ts(nowMs(ctx));
    tx.update(ref, { status: to, updatedAt: at, exceptionAt: at });
    syncRedemption(tx, red, to);
    syncMember(tx, db, reward.uid, { rid: data.rid, status: to, deadline: reward.deadline, updatedAt: at });
    addHistory(tx, db, data.rid, { action: "exception", from: reward.status, to, by: staff.email, reason, txId: data.txId }, ctx);
    return { rid: data.rid, status: to };
  });
}

// ---------- 活动设定（只有店主）----------
const COPY_LANGS = ["en", "ms", "zh"];
function validateSettings(input) {
  const out = {};
  const bool = k => { if (k in input) { if (typeof input[k] !== "boolean") bad(k); out[k] = input[k]; } };
  const int = (k, lo, hi) => {
    if (k in input) {
      const v = input[k];
      if (!Number.isInteger(v) || v < lo || v > hi) bad(k);
      out[k] = v;
    }
  };
  function bad(k) { fail("nm/bad-setting", "设定值不正确：" + k, "invalid-argument"); }
  bool("active"); bool("popupOn"); bool("manualReview"); bool("remindOn");
  int("cost", 1, 100000); int("validDays", 1, 365); int("perMemberLimit", 1, 10); int("remindDays", 1, 30);
  if ("stock" in input) {
    if (input.stock !== null && (!Number.isInteger(input.stock) || input.stock < 0 || input.stock > 1000000)) bad("stock");
    out.stock = input.stock;
  }
  if ("gift" in input) {
    const g = input.gift || {};
    if (!isStr(g.name, 60) || !g.name.trim()) bad("gift.name");
    const img = g.image || "";
    if (!(img === "" || (isStr(img, 500) && /^https:\/\//i.test(img))
      || (isStr(img, 400000) && /^data:image\/(webp|jpeg|png);base64,/.test(img)))) bad("gift.image");
    const i18n = {};
    for (const l of COPY_LANGS) {
      const v = (g.i18n || {})[l];
      if (v == null) continue;
      if (typeof v !== "object" || !isStr(v.name || "", 60) || !isStr(v.desc || "", 300)) bad("gift.i18n." + l);
      i18n[l] = { name: v.name || "", desc: v.desc || "" };
    }
    out.gift = { name: g.name.trim(), image: img, i18n };
  }
  if ("copy" in input) {
    const c = input.copy || {};
    const copy = {};
    for (const l of COPY_LANGS) {
      const v = c[l];
      if (v == null) continue;
      if (typeof v !== "object") bad("copy." + l);
      const keys = Object.keys(v);
      if (keys.length > 20) bad("copy." + l);
      copy[l] = {};
      for (const k of keys) {
        if (!/^[a-zA-Z0-9_]{1,30}$/.test(k) || !isStr(v[k], 500)) bad("copy." + l + "." + k);
        copy[l][k] = v[k];
      }
    }
    out.copy = copy;
  }
  return out;
}

async function nmSaveSettings(db, ctx, data = {}) {
  const staff = await requireStaff(db, ctx, { ownerOnly: true });
  const clean = validateSettings(data.settings || {});
  const ref = db.doc(SETTINGS_PATH.join("/"));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    const at = ts(nowMs(ctx));
    const upd = { ...clean, version: (cur.version || 0) + 1, updatedAt: at, updatedBy: staff.email };
    // 第一次启用时写入活动开始时间（之后不再改，旧会员不会因为重新启用变成新会员）
    if (clean.active === true && !cur.startAt) upd.startAt = at;
    tx.set(ref, upd, { merge: true });
    return { version: upd.version, startAt: toMs(upd.startAt || cur.startAt) };
  });
}

// ======================================================================
// 自动执行
// ======================================================================

// 订单写入 / 更新（Apps Script 同步）时：找候选订单、订单被取消时移除
async function onOrderWritten(db, orderNo, before, after, ctx = {}) {
  const uid = (after && after.uid) || (before && before.uid);
  if (!uid) return { skipped: "no-uid" };
  const mSnap = await db.collection("members").doc(uid).get();
  const n = mSnap.exists ? (mSnap.data().nmr || {}) : {};
  if (!n.rid || ![S.ORDER, S.REVIEW, S.EXPIRED, S.READY, S.PACKED].includes(n.status)) return { skipped: "no-active" };
  const rid = n.rid;
  return db.runTransaction(async tx => {
    const ref = db.collection(COL.rewards).doc(rid);
    const snap = await tx.get(ref);
    if (!snap.exists) return { skipped: "no-reward" };
    const reward = snap.data();
    const at = nowMs(ctx);
    const redSnap = await tx.get(db.collection("redemptions").doc(reward.redemptionId || redemptionIdOf(rid)));
    const oSnap = await tx.get(db.collection("orders").doc(orderNo));
    const list = reward.candidates || [];
    const inList = list.some(c => c.orderNo === orderNo);

    // 已关联、待打包 / 已打包的订单被取消或删除：只标记，等管理员处理
    if ([S.READY, S.PACKED].includes(reward.status)) {
      const linked = reward.linkedOrder && reward.linkedOrder.orderNo === orderNo;
      const bad = !oSnap.exists || oSnap.data().status === "refunded";
      if (linked && bad && !reward.orderIssue) {
        tx.update(ref, { orderIssue: { type: "order-refunded", orderNo, at: ts(at) }, updatedAt: ts(at) });
        addHistory(tx, db, rid, { action: "orderIssue", from: reward.status, to: reward.status, detail: { orderNo } }, ctx);
        return { flagged: true };
      }
      return { skipped: "packing" };
    }
    if (![S.ORDER, S.REVIEW, S.EXPIRED].includes(reward.status)) return { skipped: "status" };

    const c = await checkOrder(tx, db, reward, rid, oSnap);
    if (c.ok && !inList) {
      const candidates = [...list, { ...c.info, source: "auto", ignoreDeadline: false, foundAt: ts(at) }];
      const status = S.REVIEW;
      tx.update(ref, { candidates, status, updatedAt: ts(at) });
      if (status !== reward.status) {
        syncRedemption(tx, redSnap, status);
        syncMember(tx, db, reward.uid, { rid, status, deadline: reward.deadline, updatedAt: ts(at) });
      }
      addHistory(tx, db, rid, { action: "candidateFound", from: reward.status, to: status, detail: { orderNo } }, ctx);
      return { added: true, status };
    }
    // 自动加入的候选后来变成不符合（例如取消 / 退货）：移除；手动加的保留，交给管理员
    const cand = list.find(x => x.orderNo === orderNo);
    if (!c.ok && cand && cand.source === "auto" && ["refunded", "not-found", "other-member", "not-bound"].includes(c.reason)) {
      const rest = list.filter(x => x.orderNo !== orderNo);
      let status = reward.status;
      if (status === S.REVIEW && !rest.length) status = toMs(reward.deadline) >= at ? S.ORDER : S.EXPIRED;
      tx.update(ref, { candidates: rest, status, updatedAt: ts(at) });
      if (status !== reward.status) {
        syncRedemption(tx, redSnap, status);
        syncMember(tx, db, reward.uid, { rid, status, deadline: reward.deadline, updatedAt: ts(at) });
      }
      addHistory(tx, db, rid, { action: "candidateRemoved", from: reward.status, to: status,
        detail: { orderNo, reason: c.reason } }, ctx);
      return { removed: true, status };
    }
    return { skipped: "no-change" };
  });
}

// 铃铛讯息（用现有的「只发给我」公告）
function memberMessage(uid, kind, vars, at, copy) {
  const T = {
    remind: {
      zh: { title: "⏰ 迎新礼快到期了", body: "请在 {d} 前用已绑定的 Shopee / TikTok 账号下单，Home Diffuser 会随订单寄出。" },
      en: { title: "⏰ Your welcome gift is expiring soon", body: "Place an order with a linked Shopee / TikTok account before {d}. Your Home Diffuser will ship with that order." },
      ms: { title: "⏰ Hadiah alu-aluan hampir tamat", body: "Buat pesanan dengan akaun Shopee / TikTok yang dipautkan sebelum {d}. Home Diffuser akan dihantar bersama pesanan itu." },
    },
    expired: {
      zh: { title: "迎新礼已超过下单期限", body: "您的迎新礼已超过下单期限，正在等待管理员审核。" },
      en: { title: "Welcome gift order period has passed", body: "Your welcome gift has passed its order deadline and is waiting for admin review." },
      ms: { title: "Tempoh pesanan hadiah alu-aluan telah tamat", body: "Hadiah alu-aluan anda telah melepasi tarikh akhir pesanan dan sedang menunggu semakan admin." },
    },
  }[kind];
  const fill = s => String(s).replace("{d}", vars.d || "");
  const pick = l => {
    const c = copy && copy[l] ? copy[l] : {};
    return { title: fill(c[kind + "Title"] || T[l].title), body: fill(c[kind + "Body"] || T[l].body) };
  };
  const zh = pick("zh");
  return {
    uids: [uid],
    title: zh.title,
    body: zh.body,
    link: "home.html",
    i18n: { en: pick("en"), ms: pick("ms"), zh },
    by: "system",
    createdAt: ts(at),
  };
}
function fmtMy(msv) {
  // 马来西亚时间 dd/mm/yyyy
  const d = new Date(msv + 8 * 3600000);
  const p = x => String(x).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

// 每日：逾期 → 待管理员审核；到期前提醒。不删除、不扣分、不没收
// 兑换记录变成「已完成」（会员按确认收货，或 Apps Script 寄出 14 天后自动完成）→ 迎新礼也改成已完成
async function markReceived(db, red, redId, ctx = {}) {
  if (!red || red.newMember !== true || red.status !== "completed" || !red.nmrId) return { skipped: true };
  const ref = db.collection(COL.rewards).doc(red.nmrId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== S.SHIPPED) return { skipped: true };
    const r = snap.data();
    const at = ts(nowMs(ctx));
    const doneAt = red.completedAt || red.receivedAt || at;
    const by = red.autoCompleted ? "auto" : "member";
    tx.update(ref, { status: S.COMPLETED, completedAt: doneAt, receivedBy: by, updatedAt: at });
    syncMember(tx, db, r.uid, { rid: ref.id, status: S.COMPLETED, deadline: r.deadline, updatedAt: at });
    addHistory(tx, db, ref.id, { action: "received", from: S.SHIPPED, to: S.COMPLETED,
      by: by === "member" ? r.uid : "system", detail: { redemptionId: redId, auto: by === "auto" } }, ctx);
    return { completed: true };
  });
}
async function onRedemptionWritten(db, redId, before, after, ctx = {}) {
  if (!after || after.newMember !== true) return { skipped: true };
  if (after.status !== "completed" || (before && before.status === "completed")) return { skipped: true };
  return markReceived(db, after, redId, ctx);
}

async function daily(db, ctx = {}) {
  const at = nowMs(ctx);
  const sSnap = await db.doc(SETTINGS_PATH.join("/")).get();
  const settings = mergeSettings(sSnap.exists ? sSnap.data() : null);
  const snap = await db.collection(COL.rewards).where("status", "==", S.ORDER).get();
  let expired = 0, reminded = 0;
  for (const d of snap.docs) {
    const r = d.data();
    const dl = toMs(r.deadline);
    if (!dl) continue;
    if (dl < at) {
      const done = await db.runTransaction(async tx => {
        const cur = await tx.get(d.ref);
        if (!cur.exists || cur.data().status !== S.ORDER || toMs(cur.data().deadline) >= at) return false;
        const redSnap = await tx.get(db.collection("redemptions").doc(r.redemptionId || redemptionIdOf(d.id)));
        tx.update(d.ref, { status: S.EXPIRED, expiredAt: ts(at), updatedAt: ts(at) });
        syncRedemption(tx, redSnap, S.EXPIRED);
        syncMember(tx, db, r.uid, { rid: d.id, status: S.EXPIRED, deadline: r.deadline, updatedAt: ts(at) });
        addHistory(tx, db, d.id, { action: "expire", from: S.ORDER, to: S.EXPIRED }, ctx);
        if (!r.test) tx.set(db.collection("memberMessages").doc(), memberMessage(r.uid, "expired", {}, at, settings.copy));
        return true;
      });
      if (done) expired++;
    } else if (settings.remindOn && !r.remindedAt && dl - at <= settings.remindDays * DAY) {
      const done = await db.runTransaction(async tx => {
        const cur = await tx.get(d.ref);
        if (!cur.exists || cur.data().status !== S.ORDER || cur.data().remindedAt) return false;
        tx.update(d.ref, { remindedAt: ts(at) });
        tx.set(db.collection("memberMessages").doc(), memberMessage(r.uid, "remind", { d: fmtMy(dl) }, at, settings.copy));
        return true;
      });
      if (done) reminded++;
    }
  }
  // 补漏：已寄出、但兑换记录已经是「已完成」的（例如触发器漏掉）
  let completed = 0;
  const shipped = await db.collection(COL.rewards).where("status", "==", S.SHIPPED).get();
  for (const d of shipped.docs) {
    const r = d.data();
    const red = await db.collection("redemptions").doc(r.redemptionId || redemptionIdOf(d.id)).get();
    if (red.exists && red.data().status === "completed") {
      const res = await markReceived(db, red.data(), red.id, ctx);
      if (res.completed) completed++;
    }
  }
  return { expired, reminded, completed };
}

function orderReasonText(reason) {
  return {
    "not-found": "找不到这张订单",
    "other-member": "这张订单不属于这位会员",
    "refunded": "这张订单已取消 / 退货",
    "no-time": "这张订单没有下单时间",
    "before-redeem": "下单时间早于兑换时间（可确认后手动关联）",
    "too-early": "只能关联兑换前 7 天内下的订单",
    "after-deadline": "下单时间晚于截止时间（可勾选忽略期限）",
    "not-bound": "这个购买账号目前没有绑定在这位会员名下",
    "locked": "这张订单已被另一笔迎新礼使用",
  }[reason] || "订单不符合";
}

module.exports = {
  NmError, S, MOVES, DEFAULTS, OWNER_EMAIL, COL, DAY,
  mergeSettings, validateSettings, eligibleBySettings, toMs,
  ensureEligibility,
  nmEnsure, nmDismissPopup, nmRedeem, nmMemberCancel,
  nmApprove, nmReject, nmLinkOrder, nmRejectCandidate, nmConfirmOrder, nmUnlinkOrder,
  nmPacked, nmUnpack, nmShipped, nmExtend, nmCancelReward, nmRefund, nmNote, nmException,
  nmSaveSettings,
  onOrderWritten, onRedemptionWritten, daily,
};
