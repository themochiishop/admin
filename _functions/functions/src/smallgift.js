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
//
// ✋ 手动指定的小礼物（2026-11-12）：smallGifts/manual__{时间}_{随机}
//   { batchId: "manual", manual: true, uid, name, giftName, note, noteI18n, delivery: "withOrder"|"separate",
//     linkedOrder|null（指定随哪一张单寄）, deadline|null, noExpire, status, createdAt, … }
//   寄出：随单 → sentOrder + shipping { withOrder, orderNo, via }；单独寄 → shipping { carrier…, trackingNo, trackingUrl, address, via: "admin" }
//   每日检查：单独寄的不会过期；过期通知用「店主送的」文字（不是抽奖）
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
  // 会员系统「🏆 中奖奖品」权限（手动指定小礼物用）
  const prizes = !!p && (p.member === true || (p.member && typeof p.member === "object" && p.member.prizes === true));
  const ok = need.some(n => (n === "claims" && claims) || (n === "pack" && pack) || (n === "prizes" && prizes));
  if (!ok) fail("sg/no-perm", "没有「领奖追踪」「中奖奖品」或「打包清单」权限", "permission-denied");
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
  manual: {
    zh: ["🎁 你有一份小礼物", "「{g}」{w}{n}"],
    en: ["🎁 A little gift for you", "\"{g}\" {w}{n}"],
    ms: ["🎁 Hadiah kecil untuk anda", "\"{g}\" {w}{n}"],
  },
  mExpired: {
    zh: ["小礼物已作废", "「{g}」超过下单期限（{d}），已经作废。"],
    en: ["Little gift expired", "\"{g}\" passed its order deadline ({d}) and has expired."],
    ms: ["Hadiah kecil tamat", "\"{g}\" melepasi tarikh akhir pesanan ({d}) dan telah tamat."],
  },
  expired: {
    zh: ["小礼物已作废", "「{g}」超过下单期限（{d}），已经作废。下次抽奖再接再厉！"],
    en: ["Little gift expired", "\"{g}\" passed its order deadline ({d}) and has expired. Better luck next draw!"],
    ms: ["Hadiah kecil tamat", "\"{g}\" melepasi tarikh akhir pesanan ({d}) dan telah tamat. Semoga berjaya cabutan seterusnya!"],
  },
};
function message(uid, kind, vars, at) {
  // vars 的值可以是 { zh, en, ms }（每种语言不同的文字）
  const fill = (s, l) => String(s).replace(/\{(\w+)\}/g, (_, k) => { const v = vars[k]; return v && typeof v === "object" ? (v[l] ?? v.zh ?? "") : (v ?? ""); });
  const one = l => ({ title: fill(MSG[kind][l][0], l), body: fill(MSG[kind][l][1], l) });
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
  const who = await requirePerm(db, ctx, ["claims", "pack", "prizes"]);
  const { ref, g } = await loadGift(db, data.id);
  if (g.status !== "pending") fail("sg/state", "只有待寄的小礼物可以作废");
  const note = String(data.note || "").trim().slice(0, 100);
  await ref.update({ status: "voided", voidReason: "manual", voidNote: note, voidedAt: tsOf(nowMs(ctx)), voidedBy: "staff" });
  return { ok: true };
}
// 恢复：作废 → 待寄；之后每日检查不再自动作废（noExpire）
async function sgRestore(db, ctx, data) {
  const who = await requirePerm(db, ctx, ["claims", "pack", "prizes"]);
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
  await requirePerm(db, ctx, ["pack", "claims", "prizes"]);
  const { ref, g } = await loadGift(db, data.id);
  if (g.status !== "sent") fail("sg/state", "这份小礼物还没寄出");
  await ref.update({ status: "pending", sentAt: null, sentOrder: null, sentBy: null, shipping: null });
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
    if (g.orderFound === true || g.noExpire === true || g.delivery === "separate") continue;
    const created = toMs(g.createdAt), deadline = toMs(g.deadline);
    if (!created || !deadline) continue;
    const found = await hasNewOrder(db, g, created, deadline);
    if (found) { await d.ref.update({ orderFound: true, foundOrder: found }); r.hasOrder++; continue; }
    if (now > deadline) {
      await d.ref.update({ status: "voided", voidReason: "expired", voidedAt: tsOf(now), voidedBy: "system" });
      if (g.uid) await db.collection("memberMessages").add(message(g.uid, g.manual ? "mExpired" : "expired", { g: g.giftName, d: fmtMy(deadline) }, now));
      r.expired++;
    } else if (g.uid && deadline - now <= REMIND_DAYS * DAY && !g.remindedAt) {
      await db.collection("memberMessages").add(message(g.uid, "remind", { g: g.giftName, d: fmtMy(deadline) }, now));
      await d.ref.update({ remindedAt: tsOf(now) });
      r.reminded++;
    }
  }
  return r;
}

// ---------- ✋ 手动指定的小礼物（会员系统后台「🎁 指定小礼物」）----------
//   权限：店主，或有「领奖追踪」「中奖奖品」权限的人
const MAX_MANUAL = 200;   // 一次最多送几位会员
const DLV = ["withOrder", "separate"];
function cleanNote(data) {
  const note = String(data.note || "").trim().slice(0, 200);
  const i = data.noteI18n && typeof data.noteI18n === "object" ? data.noteI18n : {};
  const noteI18n = {};
  ["zh", "en", "ms"].forEach(l => { const v = String(i[l] || "").trim().slice(0, 200); if (v) noteI18n[l] = v; });
  return { note, noteI18n: Object.keys(noteI18n).length ? noteI18n : null };
}
// 这张单是不是这位会员的（订单上的 uid，或买家账号绑定了这位会员），而且没取消
async function orderOfMember(db, uid, orderNo) {
  const no = normNo(orderNo);
  if (!/^[A-Z0-9]{6,40}$/.test(no)) fail("sg/bad-order", "订单号不正确", "invalid-argument");
  const s = await db.collection("orders").doc(no).get();
  if (!s.exists) fail("sg/no-order", `找不到订单 ${no}（订单要先录入、同步）`, "not-found");
  const o = s.data() || {};
  if (o.status === "refunded") fail("sg/order-refunded", `订单 ${no} 已取消 / 退货`);
  let owner = o.uid || null;
  if (!owner && o.platform && o.username) {
    const b = await db.collection("bindings").doc(`${o.platform}_${o.username}`).get();
    owner = b.exists ? b.data().uid || null : null;
  }
  if (owner !== uid) fail("sg/not-member-order", `订单 ${no} 不是这位会员的`);
  return no;
}
// 新增：data { uids: [...], giftName, note?, noteI18n?, days?（没给 = 30 天；null / 0 = 不过期）, delivery?, linkedOrder?（只限一位会员）, notify? }
async function sgManualCreate(db, ctx, data = {}) {
  await requirePerm(db, ctx, ["claims", "prizes"]);
  const now = nowMs(ctx);
  const uids = [...new Set((Array.isArray(data.uids) ? data.uids : []).map(String))].filter(u => /^[A-Za-z0-9_-]{1,128}$/.test(u));
  if (!uids.length) fail("sg/no-member", "请选择会员", "invalid-argument");
  if (uids.length > MAX_MANUAL) fail("sg/too-many", `一次最多 ${MAX_MANUAL} 位会员`, "invalid-argument");
  const giftName = String(data.giftName || "").trim();
  if (!giftName || giftName.length > 60) fail("sg/bad-name", "请填写礼物名称（60 字以内）", "invalid-argument");
  const delivery = data.delivery == null ? "withOrder" : DLV.includes(data.delivery) ? data.delivery : fail("sg/bad-dlv", "配送方式不正确", "invalid-argument");
  // 期限：没给 = 预设 30 天；0 或 null = 不过期；单独寄出不会过期
  const noExp = data.days === 0 || data.days === null || delivery === "separate";
  const days = noExp ? null : data.days === undefined ? DEFAULT_DAYS : Number(data.days);
  if (!noExp && (!Number.isInteger(days) || days < 1 || days > 365)) fail("sg/bad-days", "期限要 1–365 天", "invalid-argument");
  const { note, noteI18n } = cleanNote(data);
  let linkedOrder = null;
  if (data.linkedOrder) {
    if (uids.length !== 1) fail("sg/link-one", "指定订单只限一位会员", "invalid-argument");
    if (delivery !== "withOrder") fail("sg/link-dlv", "单独寄出不用指定订单", "invalid-argument");
    linkedOrder = await orderOfMember(db, uids[0], data.linkedOrder);
  }
  const names = new Map();
  for (const uid of uids) {
    const m = await db.collection("members").doc(uid).get();
    if (!m.exists) fail("sg/no-member", "找不到会员 " + uid, "not-found");
    names.set(uid, String((m.data() || {}).name || "").slice(0, 60));
  }
  const deadline = noExp ? null : now + days * DAY;
  const ids = [];
  for (const uid of uids) {
    const id = `manual__${now}_${Math.random().toString(36).slice(2, 8)}`;
    // 会员读得到自己的小礼物：不写员工 email（后台操作记录有）
    await db.collection(COL.gifts).doc(id).set({
      batchId: "manual", manual: true, label: "", giftName, mode: "person", status: "pending",
      uid, name: names.get(uid), platform: "", username: "", orderNos: [],
      note, noteI18n, delivery, linkedOrder, deadline: deadline ? tsOf(deadline) : null, noExpire: noExp,
      ...(linkedOrder ? { orderFound: true, foundOrder: linkedOrder } : {}),
      createdAt: tsOf(now),
    });
    ids.push(id);
    if (data.notify !== false) {
      const w = delivery === "separate"
        ? { zh: "会单独寄给你，寄出后这里会显示运单号。", en: "will be shipped to you separately — the tracking no. will show here once it's sent.", ms: "akan dihantar berasingan — nombor penjejakan akan dipaparkan di sini selepas dihantar." }
        : linkedOrder ? { zh: `会随订单 …${linkedOrder.slice(-6)} 一起寄出。`, en: `will ship with order …${linkedOrder.slice(-6)}.`, ms: `akan dihantar bersama pesanan …${linkedOrder.slice(-6)}.` }
        : deadline ? { zh: `会随你的下一张订单一起寄出，${fmtMy(deadline)} 前下单就能拿到。`, en: `will ship with your next order — order by ${fmtMy(deadline)} to get it.`, ms: `akan dihantar bersama pesanan seterusnya — buat pesanan sebelum ${fmtMy(deadline)}.` }
        : { zh: "会随你的下一张订单一起寄出。", en: "will ship with your next order.", ms: "akan dihantar bersama pesanan seterusnya." };
      const n = noteI18n || note ? { zh: (noteI18n && noteI18n.zh) || note ? "\n" + ((noteI18n && noteI18n.zh) || note) : "",
        en: (noteI18n && noteI18n.en) || note ? "\n" + ((noteI18n && noteI18n.en) || note) : "",
        ms: (noteI18n && noteI18n.ms) || note ? "\n" + ((noteI18n && noteI18n.ms) || note) : "" } : "";
      await db.collection("memberMessages").add(message(uid, "manual", { g: giftName, w, n }, now));
    }
  }
  return { ok: true, ids };
}
// 只能改手动指定、还没寄出的
async function loadManual(db, id) {
  const r = await loadGift(db, id);
  if (r.g.manual !== true) fail("sg/not-manual", "这份小礼物不是手动指定的（抽奖的小礼物到领奖追踪处理）");
  return r;
}
// 修改：data { id, delivery?, linkedOrder?（"" = 取消指定）, note?, noteI18n?, days?（重新算期限；0 = 不过期）}
async function sgManualUpdate(db, ctx, data = {}) {
  await requirePerm(db, ctx, ["claims", "prizes"]);
  const { ref, g } = await loadManual(db, data.id);
  if (g.status !== "pending") fail("sg/state", "只有待寄的小礼物可以修改");
  const upd = {};
  const dlv = data.delivery === undefined ? g.delivery || "withOrder" : DLV.includes(data.delivery) ? data.delivery : fail("sg/bad-dlv", "配送方式不正确", "invalid-argument");
  if (dlv !== (g.delivery || "withOrder")) upd.delivery = dlv;
  if (data.linkedOrder !== undefined || dlv === "separate") {
    const want = dlv === "separate" ? "" : String(data.linkedOrder === undefined ? g.linkedOrder || "" : data.linkedOrder || "");
    const lo = want ? await orderOfMember(db, g.uid, want) : null;
    if (lo !== (g.linkedOrder || null)) {
      upd.linkedOrder = lo;
      if (lo) { upd.orderFound = true; upd.foundOrder = lo; } else if (g.foundOrder === g.linkedOrder) { upd.orderFound = false; upd.foundOrder = null; }
    }
  }
  if (data.note !== undefined || data.noteI18n !== undefined) Object.assign(upd, cleanNote(data));
  if (data.days !== undefined) {
    if (data.days === 0 || data.days === null) Object.assign(upd, { deadline: null, noExpire: true });
    else {
      const days = Number(data.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) fail("sg/bad-days", "期限要 1–365 天", "invalid-argument");
      Object.assign(upd, { deadline: tsOf(nowMs(ctx) + days * DAY), noExpire: false, remindedAt: null });
    }
  }
  if (!Object.keys(upd).length) return { ok: true, changed: false };
  await ref.update(upd);
  return { ok: true, changed: true };
}
// 后台手动标记寄出：data { id, orderNo }（随单）或 { id, ship: { carrier, carrierName, trackingNo, trackingUrl, address } }（单独寄）
const str = (v, n) => String(v || "").trim().slice(0, n);
async function sgManualShip(db, ctx, data = {}) {
  const who = await requirePerm(db, ctx, ["claims", "prizes"]);
  const { ref, g } = await loadManual(db, data.id);
  if (g.status === "sent") return { ok: true, already: true };
  if (g.status !== "pending") fail("sg/state", "这份小礼物已作废，要先恢复");
  const at = tsOf(nowMs(ctx));
  if ((g.delivery || "withOrder") === "withOrder") {
    const no = await orderOfMember(db, g.uid, data.orderNo);
    if (g.linkedOrder && g.linkedOrder !== no) fail("sg/linked", `这份小礼物指定随 ${g.linkedOrder} 寄出`);
    await ref.update({ status: "sent", sentAt: at, sentOrder: no, sentBy: "staff", shipping: { withOrder: true, orderNo: no, via: "admin" } });
    return { ok: true };
  }
  const s = data.ship && typeof data.ship === "object" ? data.ship : {};
  const trackingNo = str(s.trackingNo, 60).toUpperCase(), trackingUrl = str(s.trackingUrl, 300);
  if (!trackingNo) fail("sg/bad-ship", "请填写运单号", "invalid-argument");
  if (trackingUrl && !/^https:\/\//i.test(trackingUrl)) fail("sg/bad-ship", "查询链接要 https://", "invalid-argument");
  const a = s.address && typeof s.address === "object" ? s.address : null;
  const address = a ? { name: str(a.name, 60), phone: str(a.phone, 30), line1: str(a.line1, 120), line2: str(a.line2, 120),
    postcode: str(a.postcode, 10), city: str(a.city, 60), state: str(a.state, 60), country: str(a.country, 40) || "Malaysia" } : null;
  if (!address || !address.name || !address.line1) fail("sg/bad-addr", "请选择或填写收货地址", "invalid-argument");
  await ref.update({ status: "sent", sentAt: at, sentOrder: null, sentBy: "staff",
    shipping: { carrier: str(s.carrier, 30), carrierName: str(s.carrierName, 60), trackingNo, trackingUrl, address, via: "admin" } });
  return { ok: true };
}

module.exports = {
  COL, DEFAULT_DAYS, REMIND_DAYS, platformOf, resolveBuyer,
  sgCreate, sgVoid, sgRestore, sgShip, sgUnship, sgDaily,
  sgManualCreate, sgManualUpdate, sgManualShip,
};
