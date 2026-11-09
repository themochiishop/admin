// 🛍️ 商城兑换 — 后端（2026-11-09）
// 会员按「兑换」：同一个 Transaction 里检查奖品、款式库存、本期限兑次数、积分，全部通过才建立「待审核」兑换并马上扣库存。
// 两个会员同时抢最后 1 个，只有一个成功（另一个拿到 rd/sold-out）。
// 兑换带 reserved: true = 库存已经在建立时扣过：后台批准时不再扣；拒绝 / 会员取消时加回。
// 旧的兑换（没有 reserved）照旧在批准时才扣库存。
"use strict";

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { NmError } = require("./core");

const fail = (key, msg, code = "failed-precondition") => { throw new NmError(code, key, msg); };
const nowMs = ctx => (ctx && typeof ctx.now === "number" ? ctx.now : Date.now());
function toMs(v) {
  if (v == null) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return null;
}
const idOk = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

// 积分：和会员网页 loadBalance 一样 —— 已到账的积分 − 审核中的兑换
function balanceOf(ledgerDocs, redDocs, at) {
  let available = 0;
  ledgerDocs.forEach(d => {
    const x = d.data(), a = toMs(x.availableAt);
    if (!(a && a > at)) available += Number(x.delta) || 0;
  });
  const reserved = redDocs.filter(d => d.data().status === "pending").reduce((s, d) => s + (Number(d.data().cost) || 0), 0);
  return available - reserved;
}

// ---------- 会员兑换 ----------
// data = { rewardId, variantId? }
async function rdRedeem(db, ctx, data = {}) {
  if (!ctx || !ctx.uid) fail("rd/signin", "请先登入", "unauthenticated");
  const uid = ctx.uid;
  const { rewardId, variantId } = data;
  if (!idOk(rewardId) || (variantId != null && !idOk(variantId))) fail("rd/bad", "资料不正确", "invalid-argument");
  const at = nowMs(ctx);
  const rewardRef = db.collection("rewards").doc(rewardId);
  const redRef = db.collection("redemptions").doc();

  return db.runTransaction(async tx => {
    const [rSnap, mSnap, clubSnap, admSnap, lSnap, myReds] = await Promise.all([
      tx.get(rewardRef),
      tx.get(db.collection("members").doc(uid)),
      tx.get(db.collection("settings").doc("club")),
      tx.get(db.collection("admins").doc(uid)),
      tx.get(db.collection("pointsLedger").where("uid", "==", uid)),
      tx.get(db.collection("redemptions").where("uid", "==", uid)),
    ]);
    if (!mSnap.exists) fail("rd/not-member", "请先注册会员");
    const open = clubSnap.exists && clubSnap.data().open === true;
    if (!open && !admSnap.exists) fail("rd/closed", "俱乐部维修中");
    if (!rSnap.exists) fail("rd/gone", "奖品已下架");
    const r = rSnap.data();

    // 奖品状态：上架、不是签到达人专属、已开放、没过下架时间
    if (r.active !== true) fail("rd/gone", "奖品已下架");
    if (r.ciOnly === true) fail("rd/ci-only", "签到达人专属，不能兑换");
    if (r.comingSoon === true && !(toMs(r.openAt) && toMs(r.openAt) <= at)) fail("rd/not-open", "奖品还没开放");
    if (toMs(r.endAt) && toMs(r.endAt) <= at) fail("rd/gone", "奖品已下架");
    const cost = Number(r.cost);
    if (!Number.isInteger(cost) || cost <= 0) fail("rd/gone", "奖品资料不正确");

    // 款式：有款式的实体奖品一定要选一款
    const kind = r.type === "coupon" ? "coupon" : "gift";
    const variants = kind === "gift" ? (r.variants || {}) : {};
    const hasVariants = Object.values(variants).some(v => v && v.name);
    let variant = null;
    if (hasVariants) {
      if (!variantId || !variants[variantId] || !variants[variantId].name) fail("rd/variant", "请选择款式", "invalid-argument");
      variant = { id: variantId, ...variants[variantId] };
    } else if (variantId) fail("rd/variant", "这个奖品没有款式", "invalid-argument");

    // 库存（奖品和款式都有设定才检查）
    if (typeof r.stock === "number" && r.stock <= 0) fail("rd/sold-out", "已兑完");
    if (variant && typeof variant.stock === "number" && variant.stock <= 0) fail("rd/sold-out", "这一款已兑完");

    // 本期限兑次数（换新码之后重新算；拒绝、取消的不算）
    const limit = typeof r.perMember === "number" && r.perMember > 0 ? r.perMember : null;
    if (limit) {
      const since = toMs(r.roundSince);
      const used = myReds.docs.filter(d => {
        const x = d.data();
        return x.rewardId === rewardId && !["rejected", "cancelled"].includes(x.status)
          && (!since || !toMs(x.createdAt) || toMs(x.createdAt) >= since);
      }).length;
      if (used >= limit) fail("rd/limit", "本期已兑换满");
    }

    // 积分够不够
    if (balanceOf(lSnap.docs, myReds.docs, at) < cost) fail("rd/points", "积分不足");

    // ---- 写入：建立兑换 + 扣库存 ----
    const red = {
      uid, rewardId, rewardName: r.name || "", cost, status: "pending", kind,
      reserved: true, createdAt: Timestamp.fromMillis(at),
    };
    if (kind === "gift") red.delivery = "withOrder";   // 预设随单寄送；要单独寄出由管理员在审核时改
    if (variant) { red.variantId = variant.id; red.variantName = variant.name; }
    tx.create(redRef, red);
    const upd = {};
    if (typeof r.stock === "number") upd.stock = FieldValue.increment(-1);
    if (variant && typeof variant.stock === "number") upd[`variants.${variant.id}.stock`] = FieldValue.increment(-1);
    if (Object.keys(upd).length) tx.update(rewardRef, upd);
    return { id: redRef.id };
  });
}

// ---------- 会员取消「审核中」的兑换：加回保留的库存 ----------
async function rdCancel(db, ctx, data = {}) {
  if (!ctx || !ctx.uid) fail("rd/signin", "请先登入", "unauthenticated");
  if (!idOk(data.id)) fail("rd/bad", "资料不正确", "invalid-argument");
  const ref = db.collection("redemptions").doc(data.id);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().uid !== ctx.uid) fail("rd/not-found", "找不到这笔兑换", "not-found");
    const red = snap.data();
    if (red.status !== "pending") fail("rd/not-pending", "这笔兑换已经审核过，不能取消");
    if (red.newMember === true || red.ciGift === true) fail("rd/no-cancel", "这笔兑换不能自己取消");
    const rSnap = red.reserved === true ? await tx.get(db.collection("rewards").doc(red.rewardId)) : null;
    tx.update(ref, { status: "cancelled", cancelledAt: Timestamp.fromMillis(nowMs(ctx)) });
    if (rSnap && rSnap.exists) {
      const r = rSnap.data(), upd = {};
      if (typeof r.stock === "number") upd.stock = FieldValue.increment(1);
      const v = red.variantId && r.variants ? r.variants[red.variantId] : null;
      if (v && typeof v.stock === "number") upd[`variants.${red.variantId}.stock`] = FieldValue.increment(1);
      if (Object.keys(upd).length) tx.update(rSnap.ref, upd);
    }
    return { ok: true };
  });
}

module.exports = { rdRedeem, rdCancel, balanceOf };
