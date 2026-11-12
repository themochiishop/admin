// 🎁 小礼物（每月抽奖没得奖的买家 → 随下一单寄出的小礼物）
//
// 资料：
//   smallGiftBatches/{batchId}   每一期：{ label, month, giftName, mode, days, deadline, count, members, createdAt, by }
//                                batchId = 领奖追踪的场次编号（draw_private/claimBatches 的 key）
//   smallGifts/{batchId}__{key}  每一份：{ batchId, label, giftName, mode, orderNos[], name, platform, username,
//                                uid|null, status, deadline, createdAt, by, orderFound?, foundOrder?, remindedAt?,
//                                sentAt?, sentOrder?, sentBy?, voidReason?, voidNote?, voidedAt?, voidedBy?, noExpire? }
//   status：pending 待寄 → sent 已寄出；pending → voided 作废（expired 过期 / manual 手动）
//
// 认人：先看 orders/{单号}.uid，再看 bindings/{platform}_{username}.uid；认不到 = 非会员（每日检查会再试）
// 期限：看「下单时间」——期限内有新订单就不作废，等打包时寄出
// 只有后端写这两个集合（规则 write: false）；会员只能读自己的
"use strict";

const { Timestamp } = require("firebase-admin/firestore");
const { NmError, OWNER_EMAIL } = require("./core");

const DAY = 86400000;
const MYT = 8 * 3600000;
const REMIND_DAYS = 7;           // 到期前几天提醒会员
const DEFAULT_DAYS = 30;         // 预设期限：1 个月
const MAX_LIST = 3000;           // 一期最多几张订单
const COL = { batches: "smallGiftBatches", gifts: "smallGifts" };

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
// 单号开头：5 = TikTok、2 = Shopee（和领奖追踪一样）
function platformOf(orderNo) {
  const c = normNo(orderNo).charAt(0);
  return c === "5" ? "tiktok" : c === "2" ? "shopee" : "";
}
const safeKey = s => String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
function fmtMy(ms) { const d = new Date(ms + MYT); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; }

// ---------- 权限：店主；或 staff 名单里启用中、有「领奖追踪」或「📦 打包清单」权限的人 ----------
//   和 Firestore 规则的 drawClaims() / perm('pack') 一样
async function requirePerm(db, ctx, need) {
  if (!ctx || !ctx.uid) fail("sg/signin", "请先登入", "unauthenticated");
  if (ctx.emailVerified === true && typeof ctx.email === "string" && ctx.email.toLowerCase() === OWNER_EMAIL)
    return { owner: true, email: OWNER_EMAIL };
  if (ctx.emailVerified !== true || typeof ctx.email !== "string") fail("sg/no-perm", "没有权限", "permission-denied");
  const email = ctx.email.toLowerCase();
  const snap = await db.collection("staff").doc(email).get();
  const d = snap.exists ? snap.data() : null;
  const p = d && d.active !== false && d.perms ? d.perms : null;
  const claims = !!p && (p.draw === true || (p.draw && typeof p.draw === "object" && p.draw.claims === true));
  const pack = !!p && p.pack === true;
  const ok = need.some(n => (n === "claims" && claims) || (n === "pack" && pack));
  if (!ok) fail("sg/no-perm", "没有「领奖追踪」或「打包清单」权限", "permission-denied");
  return { owner: false, email };
}

// ---------- 认人 ----------
async function resolveBuyer(db, orderNo, name) {
  let platform = platformOf(orderNo), username = String(name || "").trim();
  const o = await db.collection("orders").doc(normNo(orderNo)).get();
  if (o.exists) {
    const x = o.data();
    if (x.platform) platform = x.platform;
    if (x.username) username = x.username;
    if (x.uid) return { uid: x.uid, platform, username };
  }
  if (platform && username) {
    const b = await db.collection("bindings").doc(`${platform}_${username}`).get();
    if (b.exists && b.data().uid) return { uid: b.data().uid, platform, username };
  }
  return { uid: null, platform, username };
}

// ---------- 🔔 铃铛通知（三语，和签到达人同一个集合 memberMessages）----------
const MSG = {
  remind: {
    zh: ["⏰ 你的小礼物快到期了", "请在 {d} 前下单，「{g}」会随订单一起寄出。"],
    en: ["⏰ Your little gift expires soon", "Place an order before {d} and \"{g}\" will ship with it."],
    ms: ["⏰ Hadiah kecil anda hampir tamat", "Buat pesanan sebelum {d} dan \"{g}\" akan dihantar bersamanya."],
  },
  expired: {
    zh: ["小礼物已作废", "「{g}」超过下单期限（{d}），已经作废。下次抽奖再接再厉！"],
    en: ["Little gift expired", "\"{g}\" passed its order deadline ({d}) and has expired. Better luck next draw!"],
    ms: ["Hadiah kecil tamat", "\"{g}\" melepasi tarikh akhir pesanan ({d}) dan telah tamat. Semoga berjaya cabutan seterusnya!"],
  },
};
function message(uid, kind, vars, at) {
  const fill = s => String(s).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  const one = l => ({ title: fill(MSG[kind][l][0]), body: fill(MSG[kind][l][1]) });
  const zh = one("zh");
  return { uids: [uid], title: zh.title, body: zh.body, link: "rewards.html",
    i18n: { zh, en: one("en"), ms: one("ms") }, by: "system", createdAt: tsOf(at) };
}

// ---------- 建立一期（领奖追踪按「生成小礼物」）----------
// data: { batchId, label, month, giftName, mode: "order"|"person", days, list: [{ orderNo, name }], winners: [{ orderNo, name }] }
//   list = 这一场没得奖的订单（领奖追踪算好再送来）
//   winners = 这一场的得主：中过奖的人这期不送小礼物（同一位会员的其他平台账号也算；非会员按平台 + 用户名）
async function sgCreate(db, ctx, data) {
  const who = await requirePerm(db, ctx, ["claims"]);
  const now = nowMs(ctx);
  const batchId = String(data.batchId || "");
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(batchId)) fail("sg/bad-batch", "场次编号不正确", "invalid-argument");
  const label = String(data.label || "").trim().slice(0, 40);
  const month = /^\d{4}-\d{2}$/.test(data.month || "") ? data.month : "";
  const giftName = String(data.giftName || "").trim();
  if (!giftName || giftName.length > 60) fail("sg/bad-name", "请填写礼物名称（60 字以内）", "invalid-argument");
  const mode = data.mode === "person" ? "person" : data.mode === "order" ? "order" : null;
  if (!mode) fail("sg/bad-mode", "请选择每单一份或每人一份", "invalid-argument");
  const days = data.days == null ? DEFAULT_DAYS : Number(data.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) fail("sg/bad-days", "期限要 1–365 天", "invalid-argument");
  if (!Array.isArray(data.list) || !data.list.length) fail("sg/empty", "没有没得奖的订单", "invalid-argument");
  if (data.list.length > MAX_LIST) fail("sg/too-many", `一期最多 ${MAX_LIST} 张订单`, "invalid-argument");

  const batchRef = db.collection(COL.batches).doc(batchId);
  if ((await batchRef.get()).exists) fail("sg/exists", "这一期已经生成过小礼物", "already-exists");

  // 去掉重复单号
  const seen = new Set(), list = [];
  for (const x of data.list) {
    const no = normNo(x && x.orderNo);
    if (!/^[A-Z0-9]{6,40}$/.test(no) || seen.has(no)) continue;
    seen.add(no);
    list.push({ orderNo: no, name: String((x && x.name) || "").trim().slice(0, 60) });
  }
  if (!list.length) fail("sg/empty", "没有有效的订单号", "invalid-argument");

  // 得主：认出是谁（会员 uid / 平台 + 用户名）
  const wonU = new Set(), wonP = new Set();
  const pkey = (platform, username) => (platform || "x") + "_" + String(username || "").toLowerCase();
  for (const w of (Array.isArray(data.winners) ? data.winners : []).slice(0, 500)) {
    const no = normNo(w && w.orderNo);
    if (!/^[A-Z0-9]{6,40}$/.test(no)) continue;
    const b = await resolveBuyer(db, no, String((w && w.name) || "").trim().slice(0, 60));
    if (b.uid) wonU.add(b.uid);
    if (b.username) wonP.add(pkey(b.platform, b.username));
  }

  // 认人 + 分组：每单一份 = 一张单一份；每人一份 = 同一位会员（或同一个平台账号）合成一份
  const groups = new Map();
  let skipped = 0;
  for (const x of list) {
    const b = await resolveBuyer(db, x.orderNo, x.name);
    if ((b.uid && wonU.has(b.uid)) || (b.username && wonP.has(pkey(b.platform, b.username)))) { skipped++; continue; }
    const key = mode === "order" ? x.orderNo
      : b.uid ? "u_" + b.uid : "p_" + (b.platform || "x") + "_" + (b.username || x.orderNo).toLowerCase();
    const g = groups.get(key);
    if (g) { g.orderNos.push(x.orderNo); if (!g.uid && b.uid) g.uid = b.uid; continue; }
    groups.set(key, { key, orderNos: [x.orderNo], name: x.name || b.username, platform: b.platform, username: b.username, uid: b.uid });
  }

  if (!groups.size) fail("sg/all-won", "没得奖的订单都是这一期中过奖的人，不用送小礼物");
  const deadline = now + days * DAY;
  // 会员读得到自己的小礼物：不写员工 email（批次那一笔有记录）
  const base = { batchId, label, giftName, mode, status: "pending", deadline: tsOf(deadline), createdAt: tsOf(now) };
  let members = 0;
  await batchRef.set({ label, month, giftName, mode, days, deadline: tsOf(deadline), count: groups.size, orders: list.length - skipped, skippedWinners: skipped,
    members: 0, createdAt: tsOf(now), by: who.email });
  for (const g of groups.values()) {
    if (g.uid) members++;
    await db.collection(COL.gifts).doc(`${batchId}__${safeKey(g.key)}`).set({
      ...base, orderNos: g.orderNos, name: g.name, platform: g.platform || "", username: g.username || "", uid: g.uid || null,
    });
  }
  await batchRef.update({ members });
  return { ok: true, count: groups.size, orders: list.length - skipped, members, skippedWinners: skipped };
}

// ---------- 单份操作：作废 / 恢复 / 寄出 / 取消寄出 ----------
async function loadGift(db, id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,260}$/.test(id)) fail("sg/bad-id", "编号不正确", "invalid-argument");
  const ref = db.collection(COL.gifts).doc(id);
  const snap = await ref.get();
  if (!snap.exists) fail("sg/not-found", "找不到这份小礼物", "not-found");
  return { ref, g: snap.data() };
}
async function sgVoid(db, ctx, data) {
  const who = await requirePerm(db, ctx, ["claims", "pack"]);
  const { ref, g } = await loadGift(db, data.id);
  if (g.status !== "pending") fail("sg/state", "只有待寄的小礼物可以作废");
  const note = String(data.note || "").trim().slice(0, 100);
  await ref.update({ status: "voided", voidReason: "manual", voidNote: note, voidedAt: tsOf(nowMs(ctx)), voidedBy: "staff" });
  return { ok: true };
}
// 恢复：作废 → 待寄；之后每日检查不再自动作废（noExpire）
async function sgRestore(db, ctx, data) {
  const who = await requirePerm(db, ctx, ["claims", "pack"]);
  const { ref, g } = await loadGift(db, data.id);
  if (g.status !== "voided") fail("sg/state", "只有已作废的小礼物可以恢复");
  await ref.update({ status: "pending", voidReason: null, voidNote: null, voidedAt: null, voidedBy: null,
    noExpire: true, restoredBy: "staff", restoredAt: tsOf(nowMs(ctx)) });
  return { ok: true };
}
// 寄出：打包清单勾选 ✅（orderNo = 随哪一张单寄出）
async function sgShip(db, ctx, data) {
  const who = await requirePerm(db, ctx, ["pack", "claims"]);
  const orderNo = normNo(data.orderNo);
  if (orderNo && !/^[A-Z0-9]{6,40}$/.test(orderNo)) fail("sg/bad-order", "订单号不正确", "invalid-argument");
  const { ref, g } = await loadGift(db, data.id);
  if (g.status === "sent") return { ok: true, already: true };
  if (g.status !== "pending") fail("sg/state", "这份小礼物已作废，要先恢复");
  await ref.update({ status: "sent", sentAt: tsOf(nowMs(ctx)), sentOrder: orderNo || null, sentBy: "staff" });
  return { ok: true };
}
async function sgUnship(db, ctx, data) {
  await requirePerm(db, ctx, ["pack", "claims"]);
  const { ref, g } = await loadGift(db, data.id);
  if (g.status !== "sent") fail("sg/state", "这份小礼物还没寄出");
  await ref.update({ status: "pending", sentAt: null, sentOrder: null, sentBy: null });
  return { ok: true };
}

// ---------- ⏰ 每日检查 ----------
//   1. 还没认出会员的：再找一次（买家后来才加入 Club）
//   2. 礼物建立之后有新订单（期限内下单）→ orderFound，不作废，等打包寄出
//   3. 过了期限、没有新订单 → 作废（expired），通知会员
//   4. 到期前 7 天 → 铃铛提醒会员（只提醒一次）
async function hasNewOrder(db, g, created, deadline) {
  let docs;
  if (g.uid) docs = (await db.collection("orders").where("uid", "==", g.uid).get()).docs;
  else if (g.username) docs = (await db.collection("orders").where("username", "==", g.username).get()).docs
    .filter(o => !g.platform || !o.data().platform || o.data().platform === g.platform);
  else return null;
  const hit = docs.find(o => {
    const x = o.data(), t = toMs(x.orderTime) || 0;
    return x.status !== "refunded" && t >= created && t <= deadline && !(g.orderNos || []).includes(o.id);
  });
  return hit ? hit.id : null;
}
async function sgDaily(db, ctx = {}) {
  const now = nowMs(ctx);
  const snap = await db.collection(COL.gifts).where("status", "==", "pending").get();
  const r = { checked: 0, linked: 0, hasOrder: 0, expired: 0, reminded: 0 };
  for (const d of snap.docs) {
    const g = { ...d.data() };
    r.checked++;
    if (!g.uid) {
      for (const no of g.orderNos || []) {
        const b = await resolveBuyer(db, no, g.username || g.name);
        if (b.uid) { g.uid = b.uid; await d.ref.update({ uid: b.uid }); r.linked++; break; }
      }
    }
    if (g.orderFound === true || g.noExpire === true) continue;
    const created = toMs(g.createdAt), deadline = toMs(g.deadline);
    if (!created || !deadline) continue;
    const found = await hasNewOrder(db, g, created, deadline);
    if (found) { await d.ref.update({ orderFound: true, foundOrder: found }); r.hasOrder++; continue; }
    if (now > deadline) {
      await d.ref.update({ status: "voided", voidReason: "expired", voidedAt: tsOf(now), voidedBy: "system" });
      if (g.uid) await db.collection("memberMessages").add(message(g.uid, "expired", { g: g.giftName, d: fmtMy(deadline) }, now));
      r.expired++;
    } else if (g.uid && deadline - now <= REMIND_DAYS * DAY && !g.remindedAt) {
      await db.collection("memberMessages").add(message(g.uid, "remind", { g: g.giftName, d: fmtMy(deadline) }, now));
      await d.ref.update({ remindedAt: tsOf(now) });
      r.reminded++;
    }
  }
  return r;
}

module.exports = {
  COL, DEFAULT_DAYS, REMIND_DAYS, platformOf, resolveBuyer,
  sgCreate, sgVoid, sgRestore, sgShip, sgUnship, sgDaily,
};
