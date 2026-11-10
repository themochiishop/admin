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
// 以扫描为准（PDA 第二版，2026-11-10）：扫到哪一张单 = 这一包现在要出货 → 列出这位顾客所有还没寄的东西（不管多久以前）
// 「今天要寄出的包裹」= 页面选的时间段（直播时段 / 一天 / 自定义）里下的单，只用来列清单和准备数量
// 寄出时一起存运输公司、运单号、查询链接、一张照片（五种都存）
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
    add(key, { kind: "sg", id: g.id, icon: "🎁", title: `小礼物「${g.giftName || ""}」`, uname: g.username || "",
      sub: `${g.label || ""}抽奖没得奖${g.deadline ? " · 期限到 " + fmt(toMs(g.deadline)) : ""}`, prep: g.giftName || "小礼物", can: true,
      src: g.label ? `${g.label}抽奖` : "抽奖",
      en: { title: `Small gift "${g.giftName || ""}"`, sub: `${g.label ? g.label + " " : ""}draw · not won${g.deadline ? " · until " + fmt(toMs(g.deadline)) : ""}`,
        prep: g.giftName || "Small gift", src: g.label ? `${g.label} draw` : "Draw" } });
  }
  for (const w of await byStatus(db, "prizeWins", ["unclaimed", "claimed", "approved"])) {
    if (!w.uid || w.delivery === "separate") continue;
    const base = { kind: "prize", id: w.id, icon: "🏆", title: `中奖奖品「${w.prizeName || ""}」`, prep: w.prizeName || "中奖奖品",
      src: `${w.drawMonth || ""} 抽奖`.trim() };
    const en = { title: `Prize "${w.prizeName || ""}"`, prep: w.prizeName || "Prize", src: `${w.drawMonth || ""} draw`.trim() };
    if (w.status === "unclaimed") add("u:" + w.uid, { ...base, sub: `${w.drawMonth || ""} · 会员还没按领取`, can: false, warn: "会员还没领取",
      en: { ...en, sub: `${w.drawMonth || ""} · member hasn't claimed yet`, warn: "Member hasn't claimed yet" } });
    else add("u:" + w.uid, { ...base, sub: `${w.drawMonth || ""} · ${w.status === "claimed" ? "待审核（勾选 = 批准 + 已寄出）" : "待发货"}`, can: true,
      en: { ...en, sub: `${w.drawMonth || ""} · ${w.status === "claimed" ? "to review (tick = approve + shipped)" : "to ship"}` } });
  }
  for (const r of await byStatus(db, "redemptions", ["pending", "approved"])) {
    if (!r.uid || r.kind !== "gift" || r.newMember === true) continue;
    const dlv = r.delivery || (r.address ? "separate" : "withOrder");
    if (dlv !== "withOrder") continue;
    if (r.ciGift === true) {
      add("u:" + r.uid, { kind: "red", id: r.id, icon: "🏅", title: `签到达人礼物「${r.rewardName || ""}」`, prep: r.rewardName || "签到达人礼物",
        sub: r.status === "pending" ? (r.backorder ? "补货中 · 勾选会扣 1 个库存" : "勾选 = 批准 + 已寄出") : "待发货", can: true, src: "签到达人",
        en: { title: `Check-in gift "${r.rewardName || ""}"`, prep: r.rewardName || "Check-in gift", src: "Check-in streak",
          sub: r.status === "pending" ? (r.backorder ? "backorder · ticking uses 1 stock" : "tick = approve + shipped") : "to ship" } });
      continue;
    }
    const title = `兑换「${r.rewardName || ""}」${r.variantName ? "（" + r.variantName + "）" : ""}`;
    const enT = `Redeem "${r.rewardName || ""}"${r.variantName ? " (" + r.variantName + ")" : ""}`;
    if (r.status === "pending") add("u:" + r.uid, { kind: "red", id: r.id, icon: "🛍️", title, prep: r.rewardName, sub: "待审核", can: false, warn: "要先到「兑换审核」批准",
      src: "商城兑换", en: { title: enT, prep: r.rewardName, sub: "to review", warn: "Approve it in Redemptions first", src: "Rewards shop" } });
    else add("u:" + r.uid, { kind: "red", id: r.id, icon: "🛍️", title, prep: r.rewardName, sub: `${r.cost ? r.cost + " 分 · " : ""}待发货${r.test ? " · 🧪 测试" : ""}`, can: true,
      src: "商城兑换", en: { title: enT, prep: r.rewardName, sub: `${r.cost ? r.cost + " pts · " : ""}to ship${r.test ? " · 🧪 test" : ""}`, src: "Rewards shop" } });
  }
  for (const n of await byStatus(db, "newMemberRewards", ["ready_to_pack", "packed", "pending_order", "order_review"])) {
    if (!n.uid) continue;
    if (n.memberName) names.set(n.uid, n.memberName);
    const g = (n.gift && n.gift.name) || "迎新礼";
    const gEn = (n.gift && n.gift.name) || "Welcome gift";
    const base = { kind: "nm", id: n.id, icon: "🎉", title: `迎新礼「${g}」`, prep: "迎新礼 " + g, src: "新会员奖励" };
    const en = { title: `Welcome gift "${gEn}"`, prep: "Welcome gift " + gEn, src: "New member reward" };
    const lo = (n.linkedOrder && n.linkedOrder.orderNo) || "";
    if (n.status === "ready_to_pack" || n.status === "packed")
      add("u:" + n.uid, { ...base, sub: `订单 ${lo || "-"}${n.test ? " · 🧪 测试" : ""}`, can: true, linkedOrder: lo,
        en: { ...en, sub: `order ${lo || "-"}${n.test ? " · 🧪 test" : ""}` } });
    else if (n.status === "order_review") add("u:" + n.uid, { ...base, sub: "有候选订单待确认", can: false, warn: "要先到「新会员奖励」确认订单",
      en: { ...en, sub: "candidate order to confirm", warn: "Confirm the order in New member rewards first" } });
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
// 会员绑定的平台账号（只回传平台 + 用户名，最多 4 个）
async function memberAccounts(db, uids) {
  const out = new Map();
  for (const uid of uids) {
    const s = await db.collection("bindings").where("uid", "==", uid).get();
    out.set(uid, s.docs.map(d => {
      const b = d.data() || {}, i = d.id.indexOf("_");
      return { platform: b.platform || (i > 0 ? d.id.slice(0, i) : ""), username: String(b.username || (i > 0 ? d.id.slice(i + 1) : "")) };
    }).filter(a => a.username).slice(0, 4));
  }
  return out;
}
// 打包记录（packDone）→ 回传给页面的摘要（照片不回传，只说有没有）
function packedOf(d) {
  if (!d) return null;
  const s = d.ship || {};
  return { at: toMs(d.at), by: d.by || "", carrierName: s.carrierName || "", trackingNo: s.trackingNo || "", trackingUrl: s.trackingUrl || "", photo: !!s.photo };
}
function parcel(o, buyer, pend, names, done) {
  const keys = [buyer.uid ? "u:" + buyer.uid : null, userKey(buyer.platform, buyer.username)].filter(Boolean);
  const items = [], seen = new Set();
  keys.forEach(k => (pend.by.get(k) || []).forEach(it => { if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } }));
  return {
    orderNo: o.no, platform: buyer.platform, username: buyer.username, uid: buyer.uid || null,
    member: buyer.uid ? (names.get(buyer.uid) || "会员") : null, orderTime: toMs(o.orderTime), done: !!done, packed: packedOf(done), items,
  };
}

// ---------- 今天要寄出的包裹（时间段）+ 全部待寄 ----------
//   data: { from, to }（毫秒；最长 62 天）；没给 = 最近 14 天
const MAX_RANGE = 62 * DAY;
async function pkBatch(db, ctx, data = {}) {
  await requirePack(db, ctx);
  const now = nowMs(ctx);
  let from = Number(data.from), to = Number(data.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) { from = now - BATCH_DAYS * DAY; to = now + DAY; }
  if (!(to > from) || to - from > MAX_RANGE) fail("pk/bad-range", "时间段不正确（最长 62 天）", "invalid-argument");
  const pend = await loadPending(db);
  const snap = await db.collection("orders").where("orderTime", ">=", tsOf(from)).get();
  const orders = snap.docs.map(d => ({ no: d.id, ...d.data() }))
    .filter(o => o.status !== "refunded" && (toMs(o.orderTime) || 0) <= to);
  const doneSnap = await db.collection("packDone").where("at", ">=", tsOf(from - 7 * DAY)).get();
  const done = new Map(doneSnap.docs.map(d => [d.id, d.data() || {}]));
  const cache = new Map(), out = [];
  const buyers = [];
  for (const o of orders) { const b = await buyerOf(db, o, cache); buyers.push([o, b]); }
  await memberNames(db, [...new Set(buyers.map(([, b]) => b.uid).filter(Boolean))], pend.names);
  for (const [o, b] of buyers) out.push(parcel(o, b, pend, pend.names, done.get(o.no) || null));
  out.sort((a, b) => (a.orderTime || 0) - (b.orderTime || 0));
  // 🗂️ 全部待寄：每位顾客还没寄的东西（含还没下单的会员）
  const uids = [...pend.by.keys()].filter(k => k.startsWith("u:")).map(k => k.slice(2));
  await memberNames(db, uids, pend.names);
  const accts = await memberAccounts(db, uids);
  const pending = [...pend.by.entries()].map(([key, items]) => {
    const isU = key.startsWith("u:");
    const uname = isU ? "" : (items.find(i => i.uname) || {}).uname || key.split(":").slice(2).join(":");
    return { key, uid: isU ? key.slice(2) : null, member: isU ? (pend.names.get(key.slice(2)) || "会员") : null,
      username: uname, platform: isU ? "" : key.split(":")[1], accounts: isU ? (accts.get(key.slice(2)) || []) : [], items };
  });
  return { ok: true, now, from, to, parcels: out, pending };
}

// ---------- 🏆 领奖追踪（每月抽奖得主，资料在另一个 RTDB）：哪些其实是会员 / 已经在会员系统处理 ----------
//   data: { items: [{ id, orderNo, username }] }（最多 300）
//   回传 res[id] = { club: 会员系统「中奖奖品」的状态（用订单号对，和领奖追踪页一样）或 null, uid, member }
//   会员系统有这笔奖品 → 打包清单改用会员那一笔（已寄出就不再出现）；没有但买家账号绑定了会员 → 标成会员
async function pkClaims(db, ctx, data = {}) {
  await requirePack(db, ctx);
  const items = Array.isArray(data.items) ? data.items.slice(0, 300) : [];
  const RANK = { completed: 6, shipped: 5, approved: 4, claimed: 3, unclaimed: 2, cancelled: 1 };
  const club = new Map();
  (await db.collection("prizeWins").get()).docs.forEach(d => {
    const w = d.data() || {}, no = normNo(w.orderNo);
    if (no && (!club.has(no) || (RANK[w.status] || 0) > (RANK[club.get(no)] || 0))) club.set(no, w.status || "");
  });
  const cache = new Map(), res = {}, uids = new Set();
  for (const it of items) {
    if (!it || typeof it.id !== "string" || it.id.length > 200) continue;
    const no = normNo(it.orderNo), u = String(it.username || "").trim().slice(0, 60);
    const platform = platformOf(no);
    let uid = null;
    if (platform && u) {
      for (const name of [...new Set([u, u.toLowerCase()])]) {
        const bk = `${platform}_${name}`;
        if (!cache.has(bk)) { const b = await db.collection("bindings").doc(bk).get(); cache.set(bk, b.exists ? b.data().uid || null : null); }
        if (cache.get(bk)) { uid = cache.get(bk); break; }
      }
    }
    if (!uid && no && noOk(no)) { const o = await db.collection("orders").doc(no).get(); if (o.exists && o.data().uid) uid = o.data().uid; }
    if (uid) uids.add(uid);
    res[it.id] = { club: (no && club.get(no)) || null, uid };
  }
  const names = new Map();
  await memberNames(db, [...uids], names);
  Object.values(res).forEach(r => { if (r.uid) r.member = names.get(r.uid) || "会员"; });
  return { ok: true, res };
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
  const ds = await db.collection("packDone").doc(o.no).get();
  const done = ds.exists ? (ds.data() || {}) : null;
  return { ok: true, found: true, parcel: parcel(o, b, pend, pend.names, done) };
}

// ---------- ✅ 勾选：放进这一包 ----------
//   data: { orderNo, items: [{ kind, id }], txId }   每样各自处理，一样失败不影响其他
async function shipOne(db, ctx, who, orderNo, it, txBase, ship = {}) {
  const at = tsOf(nowMs(ctx));
  const shipping = { withOrder: true, orderNo, by: who.email, via: "pack", ...ship };
  if (it.kind === "sg") {
    const ref = db.collection("smallGifts").doc(it.id);
    return db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (!s.exists) fail("pk/not-found", "找不到这份小礼物", "not-found");
      const g = s.data();
      if (g.status === "sent") return "already";
      if (g.status !== "pending") fail("pk/state", "小礼物已作废");
      tx.update(ref, { status: "sent", sentAt: at, sentOrder: orderNo, sentBy: who.email, shipping });
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
    // 运单号、照片：补进迎新礼的兑换（会员看得到）和迎新礼纪录（后台看得到）
    const after = (await db.collection("newMemberRewards").doc(it.id).get()).data() || {};
    if (after.redemptionId) {
      const rref = db.collection("redemptions").doc(after.redemptionId);
      const r = await rref.get();
      if (r.exists) await rref.update({ shipping: { ...(r.data().shipping || {}), ...shipping } });
    }
    await db.collection("newMemberRewards").doc(it.id).update({ shipping });
    return "ok";
  }
  fail("pk/bad-kind", "不认识的种类", "invalid-argument");
}
// 运单资料：{ carrier, carrierName, trackingNo, trackingUrl, photo }（全部选填；页面那边决定要不要必填）
const PHOTO_MAX = 300 * 1024;
function cleanShip(x) {
  if (!x || typeof x !== "object") return {};
  const out = {};
  const carrier = String(x.carrier || "").trim();
  if (carrier) { if (!/^[a-z0-9_-]{1,20}$/.test(carrier)) fail("pk/bad-ship", "运输公司不正确", "invalid-argument"); out.carrier = carrier; }
  const name = String(x.carrierName || "").trim();
  if (name) { if (name.length > 40) fail("pk/bad-ship", "运输公司名称太长", "invalid-argument"); out.carrierName = name; }
  const no = String(x.trackingNo || "").replace(/\s/g, "").toUpperCase();
  if (no) { if (!/^[A-Z0-9-]{4,40}$/.test(no)) fail("pk/bad-ship", "运单号不正确", "invalid-argument"); out.trackingNo = no; }
  const url = String(x.trackingUrl || "").trim();
  if (url) { if (!/^https:\/\/[^\s"'<>]{4,300}$/i.test(url)) fail("pk/bad-ship", "查询链接要以 https:// 开头", "invalid-argument"); out.trackingUrl = url; }
  const ph = x.photo;
  if (ph) {
    if (typeof ph !== "string" || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(ph)) fail("pk/bad-ship", "照片格式不正确", "invalid-argument");
    if (ph.length > PHOTO_MAX) fail("pk/bad-ship", "照片太大", "invalid-argument");
    out.photos = [ph];
  }
  return out;
}
async function pkShip(db, ctx, data = {}) {
  const who = await requirePack(db, ctx);
  const orderNo = normNo(data.orderNo);
  if (!noOk(orderNo)) fail("pk/bad-order", "订单号不正确", "invalid-argument");
  const ship = cleanShip(data.ship);
  const items = Array.isArray(data.items) ? data.items.slice(0, 30) : [];
  const txBase = /^[A-Za-z0-9_-]{8,64}$/.test(data.txId || "") ? data.txId : fail("pk/bad-txid", "缺少事务 ID", "invalid-argument");
  const results = [];
  for (const it of items) {
    if (!it || !["sg", "prize", "red", "nm"].includes(it.kind) || typeof it.id !== "string" || !/^[A-Za-z0-9_-]{1,260}$/.test(it.id)) {
      results.push({ id: it && it.id, ok: false, error: "资料不正确" }); continue;
    }
    try { results.push({ kind: it.kind, id: it.id, ok: true, result: await shipOne(db, ctx, who, orderNo, it, txBase, ship) }); }
    catch (e) { results.push({ kind: it.kind, id: it.id, ok: false, error: e instanceof NmError ? e.message : "系统错误" }); }
  }
  // 打包完成：连「不用放」的包裹也记下运单号、照片（打包的证据）
  if (data.done === true) {
    const rec = { at: tsOf(nowMs(ctx)), by: who.email };
    const s = {};
    if (ship.trackingNo) Object.assign(s, { carrier: ship.carrier || "", carrierName: ship.carrierName || "", trackingNo: ship.trackingNo, trackingUrl: ship.trackingUrl || "" });
    if (ship.photos && ship.photos[0]) s.photo = ship.photos[0];
    if (Object.keys(s).length) rec.ship = s;
    await db.collection("packDone").doc(orderNo).set(rec);
  }
  return { ok: results.every(r => r.ok), results };
}

// ---------- 标记打包完成（这一包 / 这一批）：之后不再出现在「这一批」----------
//   data: { orderNos: [...], undo?, finish? }   finish = 「这批打包完成」：记下时间，之后下的单才算下一批
async function pkDone(db, ctx, data = {}) {
  const who = await requirePack(db, ctx);
  const list = [...new Set((Array.isArray(data.orderNos) ? data.orderNos : []).map(normNo))].filter(noOk).slice(0, 500);
  if (data.finish === true && data.undo !== true) {
    await db.collection("packMeta").doc("state").set({ lastFinishAt: tsOf(nowMs(ctx)), lastFinishBy: who.email });
  } else if (!list.length) fail("pk/empty", "没有订单", "invalid-argument");
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
    await d.ref.update({ status: "pending", sentAt: null, sentOrder: null, sentBy: null, shipping: null });
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

module.exports = { BATCH_DAYS, platformOf, loadPending, pkBatch, pkLookup, pkClaims, pkShip, pkDone, pkUndo };
