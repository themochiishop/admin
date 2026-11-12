// 💰 积分与会员等级（2026-11-12 从 Apps Script member-system-sync.gs 搬过来）
//
// 以前：Apps Script 每 30 分钟把全部订单、会员、绑定读一遍再算（msSyncPointsCore_）。
// 现在：只算有变动的 —
//   订单写入（Apps Script 同步订单时写）→ 只算这一张单：属于谁、积分、等级
//   绑定建立 / 删除 → 只把这个平台账号的订单重新归属
//   会员 Black Elite 开关改变 → 只重算这位会员的等级
//   积分记录 / 兑换变动 → 只重算这位会员的余额（写在 members.bal）
//   每天一次（ptDaily）：等级到期（保级 / 降级）、消费滑出 365 天、生日积分、积分过期、兑换和中奖的自动完成、中奖过期
//
// 规则和 Apps Script 完全一样（下面的数字、文字也照抄），等级设定读后台「💎 会员等级」（settings/perks）。
//
// ⚠️ 开关：pointsMeta/engine.on = true 才会动（预设关；pointsMeta 只有后端读写，网页改不到）。
//   上线顺序：部署 → 后台「比对」确认和 Apps Script 算的一样 → Apps Script 停掉积分那一步 → 打开开关（同时补算余额）
//   两边不能同时算，不然同一张单会发两次积分。
//
// 资料：
//   orders/{单号}：uid、points、multiplier、availableAt、ptSeq（积分记录编号，防止重复）
//   pointsLedger/po_{单号}_{n}：这张单的第 n 笔积分变动（固定编号：触发器重跑也不会重复）
//   pointsLedger/birthday_{uid}_{年}、expire_{uid}_{日期}：和 Apps Script 同一个编号（不会重复发）
//   members/{uid}.bal：{ sum, reserved, pend: [{ at, d }], at } — 余额 = sum − 未到期的 pend − reserved
//   pointsMeta/state：每日检查做到哪里（积分过期、消费滑出）
"use strict";

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { NmError, OWNER_EMAIL } = require("./core");

const DAY = 86400000;
const fail = (key, msg, code = "failed-precondition") => { throw new NmError(code, key, msg); };
const nowMs = ctx => (ctx && typeof ctx.now === "number" ? ctx.now : Date.now());
const ts = ms => Timestamp.fromMillis(ms);
function toMs(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v === "string") { const n = Date.parse(v); return Number.isNaN(n) ? null : n; }
  return null;
}

// ---------- 规则（照 member-system-sync.gs）----------
const POINTS_PER_RM = 1;     // MS_POINTS_PER_RM
const PENDING_DAYS = 14;     // MS_PENDING_DAYS
const TIER_WINDOW_DAYS = 365;
const EXPIRY_MONTHS = 12;    // MS_EXPIRY_MONTHS（前台 common.js EXPIRY_MONTHS 也是 12）
const AUTO_COMPLETE_DAYS = 14;        // 兑换发货后自动完成
const PRIZE_AUTO_COMPLETE_DAYS = 14;  // 中奖发货后自动完成
const PRIZE_CLAIM_DAYS = 30;          // 中奖领取期限（没有 expiresAt 时）
const DEFAULT_TIERS = [
  { id: "mochii",  label: "Mochii 会员", minSpend: 0,    multiplier: 1,   birthday: 88  },
  { id: "silver",  label: "银卡",        minSpend: 300,  multiplier: 1.2, birthday: 128 },
  { id: "gold",    label: "金卡",        minSpend: 800,  multiplier: 1.5, birthday: 188 },
  { id: "diamond", label: "钻石",        minSpend: 2000, multiplier: 2,   birthday: 288 },
  { id: "black",   label: "Black Elite", minSpend: Infinity, multiplier: 2, birthday: 888, invite: true },
];
const DEFAULT_RULES = { validMonths: 12, keepRatio: 0.5 };

// 后台「💎 会员等级」的设定（settings/perks.tiers / tierRules），同一个执行环境 5 分钟内共用
let cfgCache = null;
async function loadCfg(db, ctx) {
  const now = nowMs(ctx);
  if (cfgCache && now - cfgCache.at < 5 * 60000 && !(ctx && ctx.noCache)) return cfgCache.cfg;
  const tiers = DEFAULT_TIERS.map(t => ({ ...t }));
  const rules = { ...DEFAULT_RULES };
  try {
    const s = await db.collection("settings").doc("perks").get();
    const p = s.exists ? (s.data() || {}) : {};
    const tc = p.tiers || {};
    tiers.forEach(t => {
      const c = tc[t.id];
      if (!c) return;
      if (!t.invite && typeof c.minSpend === "number" && c.minSpend >= 0) t.minSpend = c.minSpend;
      if (typeof c.multiplier === "number" && c.multiplier > 0) t.multiplier = c.multiplier;
      if (typeof c.birthday === "number" && c.birthday >= 0) t.birthday = c.birthday;
    });
    const r = p.tierRules || {};
    if (typeof r.validMonths === "number" && r.validMonths > 0) rules.validMonths = r.validMonths;
    if (typeof r.keepRatio === "number" && r.keepRatio > 0 && r.keepRatio <= 1) rules.keepRatio = r.keepRatio;
  } catch (e) { /* 读不到就用预设值（和 Apps Script 一样）*/ }
  const cfg = { tiers, rules };
  cfgCache = { at: now, cfg };
  return cfg;
}
const tierById = (cfg, id) => cfg.tiers.find(t => t.id === id) || cfg.tiers[0];
const tierRank = (cfg, id) => Math.max(0, cfg.tiers.findIndex(t => t.id === id));
function tierBySpend(cfg, spend) {
  let t = cfg.tiers[0];
  cfg.tiers.forEach(x => { if (!x.invite && spend >= x.minSpend) t = x; });
  return t;
}
function addMonths(ms, n) { const d = new Date(ms); d.setMonth(d.getMonth() + n); return d.getTime(); }

// ---------- 这位会员现在应该是什么等级（msNextTier_，逐行照抄）----------
// m：会员资料；s：近一年消费；回传 { tier, since, expires, best, event }
function nextTier(cfg, m, s, now) {
  const addM = d => addMonths(d, cfg.rules.validMonths);
  const cur = tierById(cfg, m.tier || "mochii");
  const bySpend = tierBySpend(cfg, s);
  let tier = cur, since = toMs(m.tierSince), expires = toMs(m.tierExpires);
  let event = null;
  if (m.blackElite && m.blackElite.on === true) {
    if (cur.id !== "black") { event = { type: "up", from: cur.id, to: "black", at: now }; since = now; }
    tier = tierById(cfg, "black"); expires = null;
  } else if (cur.id === "black") {
    tier = bySpend; since = now; expires = addM(now);
    event = { type: "down", from: "black", to: tier.id, at: now };
  } else if (tierRank(cfg, bySpend.id) > tierRank(cfg, cur.id)) {
    tier = bySpend; since = now; expires = addM(now);
    event = { type: "up", from: cur.id, to: tier.id, at: now };
  } else if (!expires) {
    since = since || now; expires = addM(now);
  } else if (now >= expires && cur.id !== "mochii") {
    if (s >= cur.minSpend * cfg.rules.keepRatio) {
      expires = addM(now);
      event = { type: "keep", from: cur.id, to: cur.id, at: now };
    } else {
      const down = cfg.tiers[Math.max(tierRank(cfg, bySpend.id), tierRank(cfg, cur.id) - 1)];
      tier = down; since = now; expires = addM(now);
      event = { type: "down", from: cur.id, to: tier.id, at: now };
    }
  } else if (now >= expires) {
    expires = addM(now);
  }
  const best = [m.bestTier || "mochii", cur.id, tier.id].reduce((a, b) => tierRank(cfg, b) > tierRank(cfg, a) ? b : a);
  return { tier, since, expires, best, event };
}

// ---------- 订单的可用时间（msAvailableAt_）----------
function availableAtOf(o) {
  const t = toMs(o.orderTime);
  const base = t + PENDING_DAYS * DAY;
  const c = toMs(o.completedAt);
  if (o.completed && c != null && c < base) return c;
  return base;
}

// ---------- 订单属于谁：只有 active / refunded 的单才有主人（和 Apps Script 一样看绑定）----------
async function ownerOf(db, o) {
  if (!o || (o.status !== "active" && o.status !== "refunded") || !o.platform || !o.username) return null;
  const b = await db.collection("bindings").doc(`${o.platform}_${o.username}`).get();
  return b.exists ? (b.data().uid || null) : null;
}

// ---------- 会员近一年消费（只读这位会员的订单）----------
//   override：{ no, data, uid } 这一张单用新的资料算（触发器里订单的 uid 可能还没写上）
async function spendOf(db, uid, now, override) {
  const from = now - TIER_WINDOW_DAYS * DAY;
  let total = 0;
  const docs = (await db.collection("orders").where("uid", "==", uid).get()).docs;
  docs.forEach(d => {
    if (override && d.id === override.no) return;
    const o = d.data();
    if (o.status === "active" && (toMs(o.orderTime) || 0) >= from) total += Number(o.amount) || 0;
  });
  if (override && override.uid === uid && override.data.status === "active" && (toMs(override.data.orderTime) || 0) >= from)
    total += Number(override.data.amount) || 0;
  return Math.round(total * 100) / 100;
}

// ---------- 更新一位会员的等级（有变才写）；回传现在的等级 ----------
async function refreshTier(db, ctx, cfg, uid, override) {
  const now = nowMs(ctx);
  const ref = db.collection("members").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const m = snap.data() || {};
  const s = await spendOf(db, uid, now, override);
  const nt = nextTier(cfg, m, s, now);
  const same = (a, b) => (a == null ? null : a) === (b == null ? null : b);
  if (m.tier !== nt.tier.id || m.spend12m !== s || m.bestTier !== nt.best
      || !same(toMs(m.tierSince), nt.since) || !same(toMs(m.tierExpires), nt.expires) || nt.event) {
    const data = { tier: nt.tier.id, spend12m: s, tierSince: nt.since == null ? null : ts(nt.since),
      tierExpires: nt.expires == null ? null : ts(nt.expires), bestTier: nt.best, tierUpdatedAt: ts(now) };
    if (nt.event) data.tierEvent = { ...nt.event, at: ts(nt.event.at) };   // 会员铃铛：升级 / 保级成功 / 降级
    await ref.update(data);
  }
  return nt.tier;
}

// ---------- 开关 ----------
let onCache = null;
async function engineOn(db, ctx) {
  const now = nowMs(ctx);
  if (onCache && now - onCache.at < 60000 && !(ctx && ctx.noCache)) return onCache.on;
  const s = await db.collection("pointsMeta").doc("engine").get();
  const on = s.exists && s.data().on === true;
  onCache = { at: now, on };
  return on;
}

// ======================================================================
// 一张订单（订单触发器、绑定变动、全量核对都用这个）
// ======================================================================
//   回传 { changed, uid, oldUid }；同一张单重复跑不会重复给分（交易 + 固定编号）
async function processOrder(db, ctx, cfg, orderNo, opts = {}) {
  const now = nowMs(ctx);
  const ref = db.collection("orders").doc(orderNo);
  const pre = await ref.get();
  if (!pre.exists) return { changed: false, gone: true };
  const o0 = pre.data();
  if (!toMs(o0.orderTime)) return { changed: false };
  const newUid = await ownerOf(db, o0);
  // 先算等级：新订单的加成用「算进这张单之后」的等级（和 Apps Script 同一轮里先更新等级一样）
  let tierNow = null;
  if (newUid && !opts.skipTier) tierNow = await refreshTier(db, ctx, cfg, newUid, { no: orderNo, data: o0, uid: newUid });
  else if (newUid) { const m = await db.collection("members").doc(newUid).get(); tierNow = tierById(cfg, m.exists ? m.data().tier : "mochii"); }

  const res = await db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (!s.exists) return { changed: false };
    const d = s.data();
    const oldUid = d.uid || null, oldPts = d.points || 0;
    let mult = null;
    if (newUid) mult = oldUid === newUid ? (d.multiplier != null ? d.multiplier : 1) : (tierNow || cfg.tiers[0]).multiplier;
    const newPts = d.status === "active" && newUid ? Math.floor(Number(d.amount) * POINTS_PER_RM * mult + 1e-9) : 0;
    const avail = availableAtOf(d);
    const availChanged = toMs(d.availableAt) != null && toMs(d.availableAt) !== avail;
    const ptsChanged = !(newUid === oldUid && newPts === oldPts);
    const needFields = toMs(d.availableAt) == null && !!newUid;   // 新订单第一次写上可用时间
    if (!ptsChanged && !availChanged && !needFields) return { changed: false, uid: newUid, oldUid };

    let seq = Number(d.ptSeq) || 0;
    const led = (uid, delta, reason) => {
      seq++;
      tx.set(db.collection("pointsLedger").doc(`po_${orderNo}_${seq}`),
        { uid, delta, reason, orderNo, availableAt: ts(avail), createdAt: ts(now) });
    };
    if (ptsChanged) {
      if (oldUid && oldUid === newUid) {
        led(newUid, newPts - oldPts, newPts === 0 ? "订单取消/退货" : "订单金额更正");
      } else {
        if (oldUid && oldPts) led(oldUid, -oldPts, "订单转出");
        if (newUid && newPts) {
          const t = tierNow || cfg.tiers[0];
          led(newUid, newPts, mult > 1 ? `购物积分（${t.label} ×${mult}）` : "购物积分");
        }
      }
    }
    tx.update(ref, { uid: newUid, points: newPts, availableAt: ts(avail), multiplier: newUid ? mult : null, ptSeq: seq });
    return { changed: true, availChanged, avail, uid: newUid, oldUid };
  });

  // 可用时间改了（例如改成「已完成」）：这张单以前的积分记录也一起改
  if (res.changed && res.availChanged) {
    const snap = await db.collection("pointsLedger").where("orderNo", "==", orderNo).get();
    for (const x of snap.docs) if (toMs(x.data().availableAt) !== res.avail) await x.ref.update({ availableAt: ts(res.avail) });
  }
  // 单子从别人那里转走：原本的主人也要重算等级（消费少了这张）
  if (res.changed && res.oldUid && res.oldUid !== res.uid && !opts.skipTier) await refreshTier(db, ctx, cfg, res.oldUid);
  // 🎂 这位会员这个月生日、第一次有有效订单：马上补发（以前 Apps Script 每天检查）
  if (res.changed && res.uid && o0.status === "active" && !opts.skipBirthday) await birthdayFor(db, ctx, cfg, res.uid);
  return res;
}

// ======================================================================
// 触发器（index.js 接上）
// ======================================================================
async function onOrder(db, orderNo, before, after, ctx = {}) {
  if (!(await engineOn(db, ctx))) return { off: true };
  if (!after) return { deleted: true };   // 订单被删：和 Apps Script 一样不处理（取消要用订单状态）
  // 只有会影响积分的栏位改了才算（触发器自己写回 uid / points 时不会再算一次）
  const KEYS = ["platform", "username", "amount", "status", "orderTime", "completed", "completedAt"];
  const same = before && KEYS.every(k => JSON.stringify(norm(before[k])) === JSON.stringify(norm(after[k])));
  if (same && toMs(after.availableAt) != null) return { same: true };
  const cfg = await loadCfg(db, ctx);
  return processOrder(db, ctx, cfg, orderNo);
}
const norm = v => (v && typeof v.toMillis === "function" ? v.toMillis() : v === undefined ? null : v);

// 绑定建立 / 删除：只把这个平台账号的订单重新归属
async function onBinding(db, id, before, after, ctx = {}) {
  if (!(await engineOn(db, ctx))) return { off: true };
  const b = after || before;
  if (!b) return {};
  if (before && after && before.uid === after.uid) return { same: true };
  const platform = b.platform || String(id).split("_")[0];
  const username = b.username || String(id).slice(platform.length + 1);
  const cfg = await loadCfg(db, ctx);
  const docs = (await db.collection("orders").where("username", "==", username).get()).docs.filter(d => (d.data().platform || "") === platform);
  let n = 0;
  for (const d of docs) { const r = await processOrder(db, ctx, cfg, d.id); if (r.changed) n++; }
  // 解绑：原本的主人重算等级（processOrder 已经处理转出）；新绑定：等级在 processOrder 里算
  if (before && before.uid && (!after || after.uid !== before.uid)) await refreshTier(db, ctx, cfg, before.uid);
  return { orders: docs.length, changed: n };
}

// 会员资料：Black Elite 开关改了 → 重算等级（以前 Apps Script 看人数变动，最多等 30 分钟）
//           生日 / 内部会员改了（或新会员）→ 这个月生日的话马上补发生日积分
async function onMember(db, uid, before, after, ctx = {}) {
  if (!after) return {};
  const on = x => !!(x && x.blackElite && x.blackElite.on === true);
  const inl = x => !!(x && x.internal && x.internal.on === true);
  const tierChg = !before ? false : on(before) !== on(after);
  const bdayChg = !before || before.birthday !== after.birthday || inl(before) !== inl(after);
  if (!tierChg && !(bdayChg && after.birthday)) return {};
  if (!(await engineOn(db, ctx))) return { off: true };
  const cfg = await loadCfg(db, ctx);
  const r = {};
  if (tierChg) { await refreshTier(db, ctx, cfg, uid); r.tier = true; }
  if (bdayChg && after.birthday) r.birthday = await birthdayFor(db, ctx, cfg, uid, after);
  return r;
}

// ---------- 余额（members.bal）：积分记录或兑换变动就重算这位会员 ----------
//   bal = { sum：全部积分记录加总, reserved：审核中的兑换, pend：[{ at, d }] 还没到可用时间的, at }
//   网页：可用 = sum − Σ(pend 里 at > 现在的 d)；可兑换 = 可用 − reserved（和前台 loadBalance 算法一样）
async function refreshBal(db, ctx, uid) {
  const now = nowMs(ctx);
  const [l, r] = await Promise.all([
    db.collection("pointsLedger").where("uid", "==", uid).get(),
    db.collection("redemptions").where("uid", "==", uid).get(),
  ]);
  let sum = 0;
  const pend = [];
  l.docs.forEach(d => {
    const x = d.data(), delta = Number(x.delta) || 0, at = toMs(x.availableAt);
    sum += delta;
    if (at != null && at > now) pend.push({ at: ts(at), d: delta });
  });
  pend.sort((a, b) => a.at.toMillis() - b.at.toMillis());
  const reserved = r.docs.map(d => d.data()).filter(x => x.status === "pending").reduce((s, x) => s + (Number(x.cost) || 0), 0);
  const ref = db.collection("members").doc(uid);
  const m = await ref.get();
  if (!m.exists) return null;
  const bal = { sum, reserved, pend: pend.slice(0, 200), at: ts(now) };
  const old = m.data().bal;
  const key = x => x ? JSON.stringify([x.sum, x.reserved, (x.pend || []).map(p => [toMs(p.at), p.d])]) : "";
  if (key(old) !== key(bal)) await ref.update({ bal });
  return bal;
}
async function onLedger(db, before, after, ctx = {}) {
  if (!(await engineOn(db, ctx))) return { off: true };
  const uids = [...new Set([before && before.uid, after && after.uid].filter(Boolean))];
  for (const u of uids) await refreshBal(db, ctx, u);
  return { uids };
}
async function onRedemption(db, before, after, ctx = {}) {
  if (!(await engineOn(db, ctx))) return { off: true };
  const st = x => x ? `${x.status}|${x.cost}|${x.uid}` : "";
  if (st(before) === st(after)) return { same: true };
  const uids = [...new Set([before && before.uid, after && after.uid].filter(Boolean))];
  for (const u of uids) await refreshBal(db, ctx, u);
  return { uids };
}

// ======================================================================
// 🎂 生日积分（msBirthdayRewards）：当月寿星、已绑定且有过有效订单（内部会员不用订单），每人每年一次
// ======================================================================
const birthdayMonth = b => { const p = String(b || "").split("-"); return p.length >= 2 ? Number(p[1]) : null; };
function myt(ms) { const d = new Date(ms + 8 * 3600000); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.toISOString().slice(0, 10) }; }
async function birthdayFor(db, ctx, cfg, uid, member) {
  const now = nowMs(ctx), t = myt(now);
  const m = member || (await db.collection("members").doc(uid).get()).data();
  if (!m || birthdayMonth(m.birthday) !== t.m) return false;
  const internal = !!(m.internal && m.internal.on === true);
  if (!internal) {
    const q = await db.collection("orders").where("uid", "==", uid).where("status", "==", "active").limit(1).get();
    if (q.empty) return false;
  }
  const ref = db.collection("pointsLedger").doc(`birthday_${uid}_${t.y}`);
  const tier = tierById(cfg, m.tier);
  try {
    await ref.create({ uid, delta: tier.birthday, reason: `🎂 生日礼物（${tier.label}）`, orderNo: null, availableAt: ts(now), createdAt: ts(now) });
    return true;
  } catch (e) { return false; }   // 已经发过（固定编号）
}

// ======================================================================
// ⏳ 积分过期（msPointLots_ / msExpirePoints_）
// ======================================================================
function lotStart(x) {
  const a = toMs(x.availableAt), c = toMs(x.createdAt);
  if (a == null) return c;
  if (c == null) return a;
  return a > c ? a : c;
}
function pointLots(ledger, reserved) {
  const credits = [], byOrder = {};
  let used = reserved || 0;
  ledger.forEach(x => {
    if (x.orderNo) { (byOrder[x.orderNo] = byOrder[x.orderNo] || []).push(x); return; }
    if (x.delta > 0) credits.push({ amount: x.delta, start: lotStart(x) });
    else used -= x.delta;
  });
  Object.keys(byOrder).forEach(k => {
    const list = byOrder[k];
    const net = list.reduce((s, x) => s + x.delta, 0);
    if (net > 0) {
      const starts = list.filter(x => x.delta > 0).map(lotStart).filter(v => v != null);
      credits.push({ amount: net, start: starts.length ? Math.min(...starts) : null });
    } else if (net < 0) used -= net;
  });
  credits.sort((a, b) => (a.start || 0) - (b.start || 0));
  const lots = [];
  credits.forEach(c => {
    const take = Math.min(used, c.amount);
    used -= take;
    if (c.amount - take > 0 && c.start != null) lots.push({ amount: c.amount - take, start: c.start, expires: addMonths(c.start, EXPIRY_MONTHS) });
  });
  return lots;
}
async function expireFor(db, ctx, uid) {
  const now = nowMs(ctx);
  const [l, r] = await Promise.all([
    db.collection("pointsLedger").where("uid", "==", uid).get(),
    db.collection("redemptions").where("uid", "==", uid).get(),
  ]);
  const ledger = l.docs.map(d => d.data());
  const reserved = r.docs.map(d => d.data()).filter(x => x.status === "pending").reduce((s, x) => s + (Number(x.cost) || 0), 0);
  const expired = pointLots(ledger, reserved).filter(x => x.start <= now && x.expires <= now).reduce((s, x) => s + x.amount, 0);
  if (expired <= 0) return 0;
  const ref = db.collection("pointsLedger").doc(`expire_${uid}_${myt(now).day}`);
  try { await ref.create({ uid, delta: -expired, reason: "积分过期", orderNo: null, availableAt: ts(now), createdAt: ts(now) }); return expired; }
  catch (e) { return 0; }
}

// ======================================================================
// ⏰ 每天一次（凌晨 3:10 马来西亚）
// ======================================================================
async function daily(db, ctx = {}) {
  if (!(await engineOn(db, { ...ctx, noCache: true }))) return { off: true };
  const now = nowMs(ctx);
  const cfg = await loadCfg(db, { ...ctx, noCache: true });
  const metaRef = db.collection("pointsMeta").doc("state");
  const meta = (await metaRef.get()).data() || {};
  const r = { tierExpired: 0, windowOut: 0, birthday: 0, expired: 0, redeemDone: 0, prizeDone: 0, prizeExpired: 0 };
  const touched = new Set();

  // ① 等级到期：保级 / 降一级 / 续期
  for (const d of (await db.collection("members").where("tierExpires", "<=", ts(now)).get()).docs) {
    await refreshTier(db, ctx, cfg, d.id); touched.add(d.id); r.tierExpired++;
  }
  // ② 消费滑出 365 天：订单时间刚好在「上次检查」到「现在 − 365 天」之间的会员，更新近一年消费
  const cut = now - TIER_WINDOW_DAYS * DAY;
  const lastCut = toMs(meta.windowCut) || cut - 2 * DAY;
  if (cut > lastCut) {
    const out = (await db.collection("orders").where("orderTime", ">", ts(lastCut)).where("orderTime", "<=", ts(cut)).get()).docs;
    for (const uid of new Set(out.map(d => d.data().uid).filter(Boolean))) {
      if (touched.has(uid)) continue;
      await refreshTier(db, ctx, cfg, uid); touched.add(uid); r.windowOut++;
    }
  }
  // ③ 🎂 生日：每个月只在第一次跑的那天检查全部会员（通常是 1 号）
  //    月中才填生日 / 第一次下单 / 开通内部会员的，由会员资料和订单的触发器马上补发
  const t = myt(now);
  if (meta.bdayMonth !== `${t.y}-${t.m}`) {
    for (const d of (await db.collection("members").get()).docs) {
      if (birthdayMonth(d.data().birthday) !== t.m) continue;
      if (await birthdayFor(db, ctx, cfg, d.id, d.data())) r.birthday++;
    }
  }
  // ④ ⏳ 积分过期：只看「上次检查以后」刚满 12 个月的积分记录的会员（2027 年 9 月以前不会有）
  const expCut = addMonths(now, -EXPIRY_MONTHS);
  const lastExp = toMs(meta.expiryCut) || addMonths(now - 2 * DAY, -EXPIRY_MONTHS);
  if (expCut > lastExp) {
    const uids = new Set();
    for (const f of ["availableAt", "createdAt"]) {
      (await db.collection("pointsLedger").where(f, ">", ts(lastExp)).where(f, "<=", ts(expCut)).get()).docs
        .forEach(d => { const x = d.data(); if (x.uid && x.delta > 0) uids.add(x.uid); });
    }
    for (const uid of uids) if (await expireFor(db, ctx, uid)) r.expired++;
  }
  // ⑤ 兑换发货满 14 天 → 自动完成
  for (const d of (await db.collection("redemptions").where("status", "==", "shipped").get()).docs) {
    const at = toMs(d.data().shippedAt);
    if (at != null && now - at >= AUTO_COMPLETE_DAYS * DAY) {
      await d.ref.update({ status: "completed", completedAt: ts(now), autoCompleted: true }); r.redeemDone++;
    }
  }
  // ⑥ 中奖：发货满 14 天自动完成；超过领取期限作废
  for (const d of (await db.collection("prizeWins").where("status", "in", ["unclaimed", "shipped"]).get()).docs) {
    const x = d.data();
    if (x.status === "shipped") {
      const at = toMs(x.shippedAt);
      if (at != null && now - at >= PRIZE_AUTO_COMPLETE_DAYS * DAY) {
        await d.ref.update({ status: "completed", completedAt: ts(now), autoCompleted: true }); r.prizeDone++;
      }
    } else {
      const end = toMs(x.expiresAt) != null ? toMs(x.expiresAt) : toMs(x.createdAt) != null ? toMs(x.createdAt) + PRIZE_CLAIM_DAYS * DAY : null;
      if (end != null && end <= now) {
        await d.ref.update({ status: "cancelled", cancelledAt: ts(now), autoExpired: true, cancelNote: "超过领取期限", cancelledBy: "system" });
        r.prizeExpired++;
      }
    }
  }
  await metaRef.set({ windowCut: cut, expiryCut: expCut, bdayMonth: `${t.y}-${t.m}`, lastDaily: ts(now) }, { merge: true });
  return r;
}

// ======================================================================
// 🔧 后台（只有店主）：ptAdmin { op: "status" | "compare" | "enable" | "disable" | "fullCheck" }
// ======================================================================
function requireOwner(ctx) {
  if (!ctx || !ctx.uid) fail("pt/signin", "请先登入", "unauthenticated");
  if (!(ctx.emailVerified === true && typeof ctx.email === "string" && ctx.email.toLowerCase() === OWNER_EMAIL))
    fail("pt/no-perm", "只有店主可以使用", "permission-denied");
}
async function ptStatus(db, ctx) {
  requireOwner(ctx);
  const s = await db.collection("pointsMeta").doc("engine").get();
  const m = (await db.collection("pointsMeta").doc("state").get()).data() || {};
  return { ok: true, on: s.exists && s.data().on === true, since: s.exists ? toMs(s.data().onAt) : null, lastDaily: toMs(m.lastDaily) };
}

// 比对：用新的算法把全部订单、会员算一次（只算不写），列出和现在资料不一样的地方
//   这是唯一会读全部订单的地方，只在上线前 / 怀疑对不上时手动按
async function ptCompare(db, ctx) {
  requireOwner(ctx);
  const now = nowMs(ctx);
  const cfg = await loadCfg(db, { ...ctx, noCache: true });
  const [oS, bS, mS, lS, rS] = await Promise.all(["orders", "bindings", "members", "pointsLedger", "redemptions"].map(c => db.collection(c).get()));
  const bind = {}; bS.docs.forEach(d => { bind[d.id] = d.data().uid; });
  const members = {}; mS.docs.forEach(d => { members[d.id] = d.data(); });
  const from = now - TIER_WINDOW_DAYS * DAY;
  const owner = o => (o.status === "active" || o.status === "refunded") && o.platform && o.username ? bind[`${o.platform}_${o.username}`] || null : null;
  const spend = {};
  const orders = oS.docs.map(d => ({ no: d.id, ...d.data() }));
  orders.forEach(o => { const u = owner(o); o._uid = u; if (u && o.status === "active" && (toMs(o.orderTime) || 0) >= from) spend[u] = (spend[u] || 0) + (Number(o.amount) || 0); });
  const diffs = { orders: [], tiers: [], bal: [] };
  const tierOf = {};
  Object.keys(members).forEach(uid => {
    const s = Math.round((spend[uid] || 0) * 100) / 100, m = members[uid];
    const nt = nextTier(cfg, m, s, now);
    tierOf[uid] = nt.tier;
    if ((m.tier || "mochii") !== nt.tier.id || Number(m.spend12m || 0) !== s)
      diffs.tiers.push({ uid, name: m.name || "", tier: m.tier || "mochii", newTier: nt.tier.id, spend: Number(m.spend12m || 0), newSpend: s });
  });
  orders.forEach(o => {
    if (!toMs(o.orderTime)) return;
    const newUid = o._uid, oldUid = o.uid || null;
    let mult = null;
    if (newUid) mult = oldUid === newUid ? (o.multiplier != null ? o.multiplier : 1) : (tierOf[newUid] || cfg.tiers[0]).multiplier;
    const pts = o.status === "active" && newUid ? Math.floor(Number(o.amount) * POINTS_PER_RM * mult + 1e-9) : 0;
    const avail = availableAtOf(o);
    if (newUid !== oldUid || pts !== (o.points || 0) || (toMs(o.availableAt) != null && toMs(o.availableAt) !== avail))
      diffs.orders.push({ no: o.no, username: o.username, uid: oldUid, newUid, points: o.points || 0, newPoints: pts });
  });
  // 余额：新算法（members.bal）和现在网页算的（读全部积分记录）是否一样
  const led = {}; lS.docs.forEach(d => { const x = d.data(); if (x.uid) (led[x.uid] = led[x.uid] || []).push(x); });
  const res = {}; rS.docs.forEach(d => { const x = d.data(); if (x.uid && x.status === "pending") res[x.uid] = (res[x.uid] || 0) + (Number(x.cost) || 0); });
  Object.keys(members).forEach(uid => {
    const b = members[uid].bal;
    let avail = 0, pending = 0;
    (led[uid] || []).forEach(x => { const at = toMs(x.availableAt); if (at != null && at > now) pending += x.delta; else avail += x.delta; });
    const web = avail - (res[uid] || 0);
    if (b) {
      const fromBal = b.sum - (b.pend || []).filter(p => toMs(p.at) > now).reduce((s, p) => s + p.d, 0) - (b.reserved || 0);
      if (fromBal !== web) diffs.bal.push({ uid, name: members[uid].name || "", web, bal: fromBal });
    }
  });
  return { ok: true, counts: { orders: orders.length, members: mS.size, bindings: bS.size, ledger: lS.size },
    diffs: { orders: diffs.orders.slice(0, 200), tiers: diffs.tiers.slice(0, 200), bal: diffs.bal.slice(0, 200) },
    total: { orders: diffs.orders.length, tiers: diffs.tiers.length, bal: diffs.bal.length } };
}

// 打开：先补算每位会员的余额（members.bal），再打开开关；Apps Script 的积分计算要先停掉
async function ptEnable(db, ctx, data = {}) {
  requireOwner(ctx);
  if (data.confirm !== "APPS_SCRIPT_OFF") fail("pt/confirm", "请先在 Apps Script 停掉积分计算，再确认打开", "invalid-argument");
  const now = nowMs(ctx);
  const mS = await db.collection("members").get();
  let n = 0;
  for (const d of mS.docs) { if (await refreshBal(db, ctx, d.id)) n++; }
  const cutW = now - TIER_WINDOW_DAYS * DAY, cutE = addMonths(now, -EXPIRY_MONTHS);
  await db.collection("pointsMeta").doc("state").set({ windowCut: cutW, expiryCut: cutE }, { merge: true });
  await db.collection("pointsMeta").doc("engine").set({ on: true, onAt: ts(now), by: ctx.email });
  onCache = null;
  // 换 Apps Script 的那几分钟里同步进来的订单（触发器那时还关着）：最近 2 天改过的订单再算一次
  const cfg = await loadCfg(db, { ...ctx, noCache: true });
  const recent = (await db.collection("orders").where("updatedAt", ">=", ts(now - 2 * DAY)).get()).docs;
  let changed = 0;
  for (const d of recent) { const r = await processOrder(db, { ...ctx, noCache: true }, cfg, d.id); if (r.changed) changed++; }
  if (changed) for (const d of mS.docs) await refreshBal(db, ctx, d.id);
  return { ok: true, members: n, recent: recent.length, changed };
}
async function ptDisable(db, ctx) {
  requireOwner(ctx);
  await db.collection("pointsMeta").doc("engine").set({ on: false, offAt: ts(nowMs(ctx)), by: ctx.email }, { merge: true });
  onCache = null;
  // 关掉后 members.bal 不会再更新 → 删掉，后台、会员网页自动改回读积分记录（不会显示旧的余额）
  let cleared = 0;
  for (const d of (await db.collection("members").get()).docs) {
    if (d.data().bal) { await d.ref.update({ bal: FieldValue.delete() }); cleared++; }
  }
  return { ok: true, cleared };
}
// 全量核对（取代 Apps Script 的「🔧 全量核对」的积分部分）：每张单、每位会员都重算并写入（开关要开着）
async function ptFullCheck(db, ctx) {
  requireOwner(ctx);
  if (!(await engineOn(db, { ...ctx, noCache: true }))) fail("pt/off", "积分计算还没打开（目前由 Apps Script 计算）");
  const cfg = await loadCfg(db, { ...ctx, noCache: true });
  const mS = await db.collection("members").get();
  for (const d of mS.docs) await refreshTier(db, ctx, cfg, d.id);
  let changed = 0;
  for (const d of (await db.collection("orders").get()).docs) {
    const r = await processOrder(db, ctx, cfg, d.id, { skipTier: false, skipBirthday: true });
    if (r.changed) changed++;
  }
  for (const d of mS.docs) await refreshBal(db, ctx, d.id);
  return { ok: true, orders: changed, members: mS.size };
}

module.exports = {
  DEFAULT_TIERS, nextTier, availableAtOf, pointLots, loadCfg, tierBySpend,
  processOrder, refreshTier, refreshBal, birthdayFor, expireFor,
  onOrder, onBinding, onMember, onLedger, onRedemption, daily,
  ptStatus, ptCompare, ptEnable, ptDisable, ptFullCheck,
  _reset() { cfgCache = null; onCache = null; },
};
