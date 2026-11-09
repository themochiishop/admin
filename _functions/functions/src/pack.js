// 🧺 打包清单：扫一张单 → 这位顾客所有要随这一单寄出的东西
//
// 一个入口看全部（资料各自留在原本的地方，只在这里合并显示）：
//   🎁 小礼物        smallGifts      status pending
//   🏆 中奖奖品      prizeWins       随单寄送；unclaimed（会员还没领）只提醒；claimed / approved 可以勾
//   🛍️ 兑换商品      redemptions     实体（kind gift）、随单寄送；approved 可以勾；pending 要先审核
//   🏅 签到达人礼物  redemptions     ciGift；pending 也可以直接勾（批准 + 已寄出一次完成）
//   🎉 迎新礼        newMemberRewards ready_to_pack / packed 可以勾（走 core 的 已打包 → 已寄出）；
//                                    pending_order / order_review 只提醒（要先到新会员奖励确认订单）
//
// 「这一批」= 最近 14 天、还没标记打包完成（packDone/{单号}）、没有取消的订单
// 权限：店主，或有「🧺 打包清单」权限的人（只在后端检查；这些人不需要能直接读会员资料）
// 回传给页面的只有打包需要的资料：单号、平台、用户名、会员名字、要放什么；没有地址、电话
"use strict";

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { NmError, OWNER_EMAIL } = require("./core");
const core = require("./core");

const DAY = 86400000;
const BATCH_DAYS = 14;
const fail = (key, msg, code = "failed-precondition") => { throw new NmError(code, key, msg); };
const nowMs = ctx => (ctx && typeof ctx.now === "number" ? ctx.now : Date.now());
const tsOf = ms => Timestamp.fromMillis(ms);
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "string") { const n = Date.parse(v); return Number.isNaN(n) ? null : n; }
  return null;
}
const normNo = o => String(o || "").replace(/\s/g, "").toUpperCase();
const noOk = no => /^[A-Z0-9]{6,40}$/.test(no);
const platformOf = no => { const c = normNo(no).charAt(0); return c === "5" ? "tiktok" : c === "2" ? "shopee" : ""; };
const userKey = (platform, username) => `p:${platform || "x"}:${String(username || "").toLowerCase()}`;

async function requirePack(db, ctx) {
  if (!ctx || !ctx.uid) fail("pk/signin", "请先登入", "unauthenticated");
  if (ctx.emailVerified === true && typeof ctx.email === "string" && ctx.email.toLowerCase() === OWNER_EMAIL)
    return { owner: true, email: OWNER_EMAIL };
  if (ctx.emailVerified !== true || typeof ctx.email !== "string") fail("pk/no-perm", "没有权限", "permission-denied");
  const email = ctx.email.toLowerCase();
  const snap = await db.collection("staff").doc(email).get();
  const d = snap.exists ? snap.data() : null;
  if (!(d && d.active !== false && d.perms && d.perms.pack === true)) fail("pk/no-perm", "没有「🧺 打包清单」权限", "permission-denied");
  return { owner: false, email };
}

async function byStatus(db, col, statuses) {
  const out = [];
  for (const s of statuses) (await db.collection(col).where("status", "==", s).get()).docs.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

// ---------- 全部还没寄出、可以随单寄的东西 → 按顾客分组 ----------
//   key：会员 = "u:{uid}"；非会员小礼物 = "p:{platform}:{username}"
async function loadPending(db) {
  const by = new Map();
  const add = (key, it) => { if (!by.has(key)) by.set(key, []); by.get(key).push(it); };
  const names = new Map();      // uid → 会员名字（迎新礼、兑换才有）

  for (const g of await byStatus(db, "smallGifts", ["pending"])) {
    const key = g.uid ? "u:" + g.uid : userKey(g.platform, g.username);
    add(key, { kind: "sg", id: g.id, icon: "🎁", title: `小礼物「${g.giftName || ""}」`,
      sub: `${g.label || ""}抽奖没得奖${g.deadline ? " · 期限到 " + fmt(toMs(g.deadline)) : ""}`, prep: g.giftName || "小礼物", can: true });
  }
  for (const w of await byStatus(db, "prizeWins", ["unclaimed", "claimed", "approved"])) {
    if (!w.uid || w.delivery === "separate") continue;
    const base = { kind: "prize", id: w.id, icon: "🏆", title: `中奖奖品「${w.prizeName || ""}」`, prep: w.prizeName || "中奖奖品" };
    if (w.status === "unclaimed") add("u:" + w.uid, { ...base, sub: `${w.drawMonth || ""} · 会员还没按领取`, can: false, warn: "会员还没领取" });
    else add("u:" + w.uid, { ...base, sub: `${w.drawMonth || ""} · ${w.status === "claimed" ? "待审核（勾选 = 批准 + 已寄出）" : "待发货"}`, can: true });
  }
  for (const r of await byStatus(db, "redemptions", ["pending", "approved"])) {
    if (!r.uid || r.kind !== "gift" || r.newMember === true) continue;
    const dlv = r.delivery || (r.address ? "separate" : "withOrder");
    if (dlv !== "withOrder") continue;
    if (r.ciGift === true) {
      add("u:" + r.uid, { kind: "red", id: r.id, icon: "🏅", title: `签到达人礼物「${r.rewardName || ""}」`, prep: r.rewardName || "签到达人礼物",
        sub: r.status === "pending" ? (r.backorder ? "补货中 · 勾选会扣 1 个库存" : "勾选 = 批准 + 已寄出") : "待发货", can: true });
      continue;
    }
    const title = `兑换「${r.rewardName || ""}」${r.variantName ? "（" + r.variantName + "）" : ""}`;
    if (r.status === "pending") add("u:" + r.uid, { kind: "red", id: r.id, icon: "🛍️", title, prep: r.rewardName, sub: "待审核", can: false, warn: "要先到「兑换审核」批准" });
    else add("u:" + r.uid, { kind: "red", id: r.id, icon: "🛍️", title, prep: r.rewardName, sub: `${r.cost ? r.cost + " 分 · " : ""}待发货${r.test ? " · 🧪 测试" : ""}`, can: true });
  }
  for (const n of await byStatus(db, "newMemberRewards", ["ready_to_pack", "packed", "pending_order", "order_review"])) {
    if (!n.uid) continue;
    if (n.memberName) names.set(n.uid, n.memberName);
    const g = (n.gift && n.gift.name) || "迎新礼";
    const base = { kind: "nm", id: n.id, icon: "🎉", title: `迎新礼「${g}」`, prep: "迎新礼 " + g };
    if (n.status === "ready_to_pack" || n.status === "packed")
      add("u:" + n.uid, { ...base, sub: `订单 ${(n.linkedOrder && n.linkedOrder.orderNo) || "-"}${n.test ? " · 🧪 测试" : ""}`, can: true, linkedOrder: (n.linkedOrder && n.linkedOrder.orderNo) || "" });
    else if (n.status === "order_review") add("u:" + n.uid, { ...base, sub: "有候选订单待确认", can: false, warn: "要先到「新会员奖励」确认订单" });
  }
  return { by, names };
}
function fmt(ms) { if (!ms) return ""; const d = new Date(ms + 8 * 3600000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; }

// 订单 → 顾客 key（会员优先：订单上的 uid，或平台账号的绑定）
async function buyerOf(db, o, cache) {
  const platform = o.platform || platformOf(o.no), username = o.username || "";
  if (o.uid) return { uid: o.uid, platform, username };
  const bk = `${platform}_${username}`;
  if (platform && username) {
    if (!cache.has(bk)) { const b = await db.collection("bindings").doc(bk).get(); cache.set(bk, b.exists ? b.data().uid || null : null); }
    const uid = cache.get(bk);
    if (uid) return { uid, platform, username };
  }
  return { uid: null, platform, username };
}
async function memberNames(db, uids, names) {
  for (const uid of uids) {
    if (names.has(uid)) continue;
    const m = await db.collection("members").doc(uid).get();
    names.set(uid, m.exists ? (m.data().name || "") : "");
  }
}
function parcel(o, buyer, pend, names, done) {
  const keys = [buyer.uid ? "u:" + buyer.uid : null, userKey(buyer.platform, buyer.username)].filter(Boolean);
  const items = [], seen = new Set();
  keys.forEach(k => (pend.by.get(k) || []).forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } }));
  return {
    orderNo: o.no, platform: buyer.platform, username: buyer.username, uid: buyer.uid || null,
    member: buyer.uid ? (names.get(buyer.uid) || "会员") : null, orderTime: toMs(o.orderTime), done: !!done, items,
  };
}

// ---------- 这一批 ----------
async function pkBatch(db, ctx) {
  await requirePack(db, ctx);
  const now = nowMs(ctx);
  const since = now - BATCH_DAYS * DAY;
  const pend = await loadPending(db);
  const snap = await db.collection("orders").where("orderTime", ">=", tsOf(since)).get();
  const orders = snap.docs.map(d => ({ no: d.id, ...d.data() })).filter(o => o.status !== "refunded");
  const doneSnap = await db.collection("packDone").where("at", ">=", tsOf(since - 7 * DAY)).get();
  const done = new Set(doneSnap.docs.map(d => d.id));
  const cache = new Map(), out = [];
  const buyers = [];
  for (const o of orders) { const b = await buyerOf(db, o, cache); buyers.push([o, b]); }
  await memberNames(db, [...new Set(buyers.map(([, b]) => b.uid).filter(Boolean))], pend.names);
  for (const [o, b] of buyers) out.push(parcel(o, b, pend, pend.names, done.has(o.no)));
  out.sort((a, b) => (b.orderTime || 0) - (a.orderTime || 0));
  return { ok: true, now, days: BATCH_DAYS, parcels: out };
}

// ---------- 找一张单（不在这一批里，例如比较早的单）或一个买家 ----------
//   data: { orderNo } 或 { username, platform? }
async function pkLookup(db, ctx, data = {}) {
  await requirePack(db, ctx);
  let o = null;
  const no = normNo(data.orderNo);
  if (no) {
    if (!noOk(no)) fail("pk/bad-order", "订单号不正确", "invalid-argument");
    const s = await db.collection("orders").doc(no).get();
    if (!s.exists) return { ok: true, found: false };
    o = { no, ...s.data() };
  } else {
    const u = String(data.username || "").trim();
    if (!u || u.length > 60) fail("pk/bad-user", "请输入单号或买家名", "invalid-argument");
    const docs = (await db.collection("orders").where("username", "==", u).get()).docs
      .map(d => ({ no: d.id, ...d.data() }))
      .filter(x => !data.platform || x.platform === data.platform)
      .sort((a, b) => (toMs(b.orderTime) || 0) - (toMs(a.orderTime) || 0));
    if (!docs.length) return { ok: true, found: false };
    o = docs[0];
  }
  const pend = await loadPending(db);
  const b = await buyerOf(db, o, new Map());
  if (b.uid) await memberNames(db, [b.uid], pend.names);
  const done = (await db.collection("packDone").doc(o.no).get()).exists;
  return { ok: true, found: true, parcel: parcel(o, b, pend, pend.names, done) };
}

// ---------- ✅ 勾选：放进这一包 ----------
//   data: { orderNo, items: [{ kind, id }], txId }   每样各自处理，一样失败不影响其他
async function shipOne(db, ctx, who, orderNo, it, txBase) {
  const at = tsOf(nowMs(ctx));
  const shipping = { withOrder: true, orderNo, by: who.email, via: "pack" };
  if (it.kind === "sg") {
    const ref = db.collection("smallGifts").doc(it.id);
    return db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) fail("pk/not-found", "找不到这份小礼物", "not-found");
      const g = s.data();
      if (g.status === "sent") return "already";
      if (g.status !== "pending") fail("pk/state", "小礼物已作废");
      tx.update(ref, { status: "sent", sentAt: at, sentOrder: orderNo, sentBy: who.email });
      return "ok";
    });
  }
  if (it.kind === "prize") {
    const ref = db.collection("prizeWins").doc(it.id);
    return db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) fail("pk/not-found", "找不到这个奖品", "not-found");
      const w = s.data();
      if (w.status === "shipped" || w.status === "completed") return "already";
      if (!["claimed", "approved"].includes(w.status)) fail("pk/state", "会员还没领取这个奖品");
      if (w.delivery === "separate") fail("pk/state", "这个奖品是单独寄出");
      const upd = { status: "shipped", shippedAt: at, shipping };
      if (w.status === "claimed") upd.approvedAt = at;
      tx.update(ref, upd);
      return "ok";
    });
  }
  if (it.kind === "red") {
    const ref = db.collection("redemptions").doc(it.id);
    return db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) fail("pk/not-found", "找不到这笔兑换", "not-found");
      const r = s.data();
      if (r.status === "shipped" || r.status === "completed") return "already";
      if (r.kind !== "gift" || r.newMember === true) fail("pk/state", "这笔兑换不能在这里处理");
      if ((r.delivery || (r.address ? "separate" : "withOrder")) !== "withOrder") fail("pk/state", "这笔兑换是单独寄出");
      const upd = { status: "shipped", shippedAt: at, shipping, problemNote: null };
      if (r.status === "pending") {
        if (r.ciGift !== true) fail("pk/state", "要先到「兑换审核」批准");
        upd.decidedAt = at;                                   // 🏅 签到达人礼物：批准 + 已寄出一次完成
        if (r.backorder === true) {                           // 补货中：批准时才扣库存（和兑换审核一样）
          const rw = await tx.get(db.collection("rewards").doc(r.rewardId));
          upd.backorder = false;
          if (rw.exists && typeof rw.data().stock === "number" && !r.test) tx.update(rw.ref, { stock: FieldValue.increment(-1) });
        }
      } else if (r.status !== "approved") fail("pk/state", "这笔兑换不是待发货");
      tx.update(ref, upd);
      return "ok";
    });
  }
  if (it.kind === "nm") {
    // 迎新礼：走新会员奖励原本的流程（已打包 → 已寄出），历史记录、会员资料都会同步
    const snap = await db.collection("newMemberRewards").doc(it.id).get();
    if (!snap.exists) fail("pk/not-found", "找不到这份迎新礼", "not-found");
    const n = snap.data();
    if (n.status === "shipped" || n.status === "completed") return "already";
    const tid = s => `${txBase.slice(0, 24)}_${s}_${it.id}`.slice(0, 64);   // 每一步一个事务 ID（防重复）
    if (n.status === core.S.READY) await core.nmPacked(db, ctx, { rid: it.id, txId: tid("p") });
    else if (n.status !== core.S.PACKED) fail("pk/state", "迎新礼还没确认订单");
    await core.nmShipped(db, ctx, { rid: it.id, txId: tid("s") });
    return "ok";
  }
  fail("pk/bad-kind", "不认识的种类", "invalid-argument");
}
async function pkShip(db, ctx, data = {}) {
  const who = await requirePack(db, ctx);
  const orderNo = normNo(data.orderNo);
  if (!noOk(orderNo)) fail("pk/bad-order", "订单号不正确", "invalid-argument");
  const items = Array.isArray(data.items) ? data.items.slice(0, 30) : [];
  const txBase = /^[A-Za-z0-9_-]{8,64}$/.test(data.txId || "") ? data.txId : fail("pk/bad-txid", "缺少事务 ID", "invalid-argument");
  const results = [];
  for (const it of items) {
    if (!it || !["sg", "prize", "red", "nm"].includes(it.kind) || typeof it.id !== "string" || !/^[A-Za-z0-9_-]{1,260}$/.test(it.id)) {
      results.push({ id: it && it.id, ok: false, error: "资料不正确" }); continue;
    }
    try { results.push({ kind: it.kind, id: it.id, ok: true, result: await shipOne(db, ctx, who, orderNo, it, txBase) }); }
    catch (e) { results.push({ kind: it.kind, id: it.id, ok: false, error: e instanceof NmError ? e.message : "系统错误" }); }
  }
  if (data.done === true) await db.collection("packDone").doc(orderNo).set({ at: tsOf(nowMs(ctx)), by: who.email });
  return { ok: results.every(r => r.ok), results };
}

// ---------- 标记打包完成（这一包 / 这一批）：之后不再出现在「这一批」----------
//   data: { orderNos: [...], undo? }
async function pkDone(db, ctx, data = {}) {
  const who = await requirePack(db, ctx);
  const list = [...new Set((Array.isArray(data.orderNos) ? data.orderNos : []).map(normNo))].filter(noOk).slice(0, 500);
  if (!list.length) fail("pk/empty", "没有订单", "invalid-argument");
  for (const no of list) {
    const ref = db.collection("packDone").doc(no);
    if (data.undo === true) await ref.delete();
    else await ref.set({ at: tsOf(nowMs(ctx)), by: who.email });
  }
  return { ok: true, count: list.length };
}

// ---------- ↩️ 撤销这一包（例如订单打包后被取消）----------
//   打包清单寄出的东西（随这张单）全部退回：小礼物 → 待寄；中奖奖品 / 兑换 → 待发货；这一包的「打包完成」也取消
//   只退还没完成的（会员按了确认收到 / 已自动完成的不动）；迎新礼要到「新会员奖励」处理
async function pkUndo(db, ctx, data = {}) {
  await requirePack(db, ctx);
  const orderNo = normNo(data.orderNo);
  if (!noOk(orderNo)) fail("pk/bad-order", "订单号不正确", "invalid-argument");
  const r = { smallGifts: 0, prizes: 0, redemptions: 0, welcome: 0, kept: 0 };
  for (const d of (await db.collection("smallGifts").where("sentOrder", "==", orderNo).get()).docs) {
    if (d.data().status !== "sent") continue;
    await d.ref.update({ status: "pending", sentAt: null, sentOrder: null, sentBy: null });
    r.smallGifts++;
  }
  for (const [col, key] of [["prizeWins", "prizes"], ["redemptions", "redemptions"]]) {
    for (const d of (await db.collection(col).where("shipping.orderNo", "==", orderNo).get()).docs) {
      const x = d.data();
      if (x.newMember === true) { if (x.status === "shipped") r.welcome++; continue; }   // 迎新礼：只提醒
      if (!x.shipping || x.shipping.via !== "pack") continue;          // 不是打包清单寄出的不动
      if (x.status !== "shipped") { r.kept++; continue; }
      await d.ref.update({ status: "approved", shippedAt: null, shipping: null });
      r[key]++;
    }
  }
  await db.collection("packDone").doc(orderNo).delete();
  return { ok: true, ...r };
}

module.exports = { BATCH_DAYS, platformOf, loadPending, pkBatch, pkLookup, pkShip, pkDone, pkUndo };
