// 📅 每日签到 + 🏅 签到达人 — 后端逻辑
// 7 天一轮（预设 1·1·2·2·3·3·8 分），中间断一天就从第 1 天重新开始；每天 00:00（马来西亚时间）换日。
// 积分只能由这里写（会员网页不能直接写积分流水）。每人每天一笔，文件 ID 固定，重复按也不会多拿分。
//
// 🏅 签到达人（2026-11-09，设计见项目文件「签到达人-设计.md」）：连续签满 30 天（之后每满 30 天一次）
//   1. +30 分（m30.points）
//   2. 🎁 签到达人礼物：自动建立一笔 0 积分兑换（随下一单寄出，m30.giftDays 天内要下单，库存 0 照建、标补货中）
//   3. 签到达人次数 +1（写到公开的 memberFeed/{uid}.ciBadge，只有后端能写）
//   4. 开放一次「分享到 Feed」：会员发签到分享帖（tag = "checkin"、ciMs = 达标日期），发布后 +10 分（m30.sharePts）
//
// 资料：
//   settings/perks.checkin = { active, points: [7], m30: { points, sharePts, giftRewardId, giftDays } }
//   checkins/{uid} = { lastDate, day, streak, total, totalPts, badges, share: { ms, claimed, postId }, updatedAt }
//   pointsLedger/checkin_{uid}_{yyyymmdd}         每日签到
//   pointsLedger/checkin_m30_{uid}_{yyyymmdd}     签到达人 30 天奖励
//   pointsLedger/checkin_share_{uid}_{yyyymmdd}   分享到 Feed 奖励（日期 = 达标日期）
//   redemptions/ci_{uid}_{yyyymmdd}               签到达人礼物（ciGift: true）
"use strict";

const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const { NmError } = require("./core");

const DAY = 86400000;
const MYT = 8 * 3600000;   // 马来西亚 UTC+8，没有夏令时间
const CI_DEFAULT_POINTS = [1, 1, 2, 2, 3, 3, 8];
const CI_MAX_POINTS = 100;   // 每天最多给几分（防止后台打错字）
const MILESTONE = 30;        // 连续几天算一次签到达人
const M30_DEFAULT = { points: 30, sharePts: 10, giftRewardId: "", giftDays: 30 };
const REMIND_DAYS = 7;       // 礼物到期前几天提醒会员
const ACTIVE_GIFT = ["pending", "approved", "problem"];   // 礼物还没寄出

const fail = (key, msg, code = "failed-precondition") => { throw new NmError(code, key, msg); };
const nowMs = ctx => (ctx && typeof ctx.now === "number" ? ctx.now : Date.now());
const tsOf = ms => Timestamp.fromMillis(ms);
function toMs(v) {
  if (v == null) return null;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return null;
}

// 马来西亚日期 "YYYY-MM-DD"
function mytDate(ms) { return new Date(ms + MYT).toISOString().slice(0, 10); }
function prevDate(date) { return new Date(Date.parse(date + "T00:00:00Z") - DAY).toISOString().slice(0, 10); }
const compact = d => d.replace(/-/g, "");
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// 后台设定 → { active, points[7], m30 }；没设定过是关闭的（店主部署好函式后再到后台打开）
function ciSettings(perks) {
  const c = (perks && perks.checkin) || {};
  const ok = Array.isArray(c.points) && c.points.length === 7 && c.points.every(n => intIn(n, 0, CI_MAX_POINTS));
  const m = c.m30 || {};
  return {
    active: c.active === true,
    points: ok ? c.points.slice() : CI_DEFAULT_POINTS.slice(),
    m30: {
      points: intIn(m.points, 0, 1000) ? m.points : M30_DEFAULT.points,
      sharePts: intIn(m.sharePts, 0, 1000) ? m.sharePts : M30_DEFAULT.sharePts,
      giftRewardId: typeof m.giftRewardId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(m.giftRewardId) ? m.giftRewardId : "",
      giftDays: intIn(m.giftDays, 1, 365) ? m.giftDays : M30_DEFAULT.giftDays,
    },
  };
}

// 今天签到会是第几天：昨天有签 → 接下去（第 7 天之后回到第 1 天）；断了 → 第 1 天
function nextStep(state, today) {
  if (state && state.lastDate === today) return { already: true, day: state.day, streak: state.streak || 1 };
  const cont = !!(state && state.lastDate === prevDate(today) && state.day >= 1 && state.day <= 7);
  return {
    already: false,
    day: cont ? (state.day % 7) + 1 : 1,
    streak: cont ? (Number(state.streak) || 0) + 1 : 1,
  };
}
const isMilestone = streak => streak > 0 && streak % MILESTONE === 0;

// ---------- 🔔 铃铛通知（三语，和后台公告同一个集合 memberMessages）----------
const MSG = {
  m30: {
    zh: ["🏅 你成为签到达人了！", "连续签到 {n} 天：+{p} 积分{gift}。分享到 Feed 再拿 +{s} 积分！"],
    en: ["🏅 You're a Check-in Star!", "{n}-day streak: +{p} points{gift}. Share it on the Feed for +{s} more!"],
    ms: ["🏅 Anda Bintang Daftar Masuk!", "{n} hari berturut-turut: +{p} mata{gift}. Kongsi di Feed untuk +{s} lagi!"],
  },
  share: {
    zh: ["✨ 分享奖励已到账", "谢谢你分享签到达人！+{p} 积分已加到你的账户。"],
    en: ["✨ Share reward added", "Thanks for sharing! +{p} points have been added to your account."],
    ms: ["✨ Ganjaran perkongsian ditambah", "Terima kasih kerana berkongsi! +{p} mata telah ditambah ke akaun anda."],
  },
  remind: {
    zh: ["⏰ 签到达人礼物快到期了", "请在 {d} 前下单，「{g}」会随订单一起寄出。"],
    en: ["⏰ Your Check-in Star gift expires soon", "Place an order before {d} and \"{g}\" will ship with it."],
    ms: ["⏰ Hadiah Bintang Daftar Masuk hampir tamat", "Buat pesanan sebelum {d} dan \"{g}\" akan dihantar bersamanya."],
  },
  expired: {
    zh: ["签到达人礼物已过期", "「{g}」超过下单期限，已经取消。签到达人积分不受影响，继续签到下次再拿！"],
    en: ["Check-in Star gift expired", "\"{g}\" passed its order deadline and was cancelled. Your points stay — keep checking in!"],
    ms: ["Hadiah Bintang Daftar Masuk tamat", "\"{g}\" melepasi tarikh akhir pesanan dan dibatalkan. Mata anda kekal — teruskan daftar masuk!"],
  },
};
const GIFT_TXT = { zh: " + 🎁「{g}」（随下一单寄出）", en: " + 🎁 \"{g}\" (ships with your next order)", ms: " + 🎁 \"{g}\" (dihantar bersama pesanan seterusnya)" };
function message(uid, kind, vars, at, link) {
  const fill = (s, l) => String(s).replace(/\{(\w+)\}/g, (_, k) => k === "gift"
    ? (vars.g ? GIFT_TXT[l].replace("{g}", vars.g) : "") : (vars[k] ?? ""));
  const one = l => ({ title: fill(MSG[kind][l][0], l), body: fill(MSG[kind][l][1], l) });
  const zh = one("zh");
  return { uids: [uid], title: zh.title, body: zh.body, link: link || "home.html",
    i18n: { zh, en: one("en"), ms: one("ms") }, by: "system", createdAt: tsOf(at) };
}
// 马来西亚日期显示 "9/12/2026"
function fmtMy(ms) { const d = new Date(ms + MYT); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`; }

// ---------- 📅 签到 ----------
async function ciCheckIn(db, ctx) {
  if (!ctx || !ctx.uid) fail("ci/signin", "请先登入", "unauthenticated");
  const uid = ctx.uid;
  const now = nowMs(ctx);
  const today = mytDate(now);
  const nowTs = tsOf(now);
  const stateRef = db.collection("checkins").doc(uid);
  const ledgerRef = db.collection("pointsLedger").doc(`checkin_${uid}_${compact(today)}`);

  return db.runTransaction(async tx => {
    const [perksSnap, memSnap, stSnap, bindSnap, ledSnap] = await Promise.all([
      tx.get(db.collection("settings").doc("perks")),
      tx.get(db.collection("members").doc(uid)),
      tx.get(stateRef),
      tx.get(db.collection("bindings").where("uid", "==", uid).limit(1)),
      tx.get(ledgerRef),
    ]);
    const s = ciSettings(perksSnap.exists ? perksSnap.data() : null);
    if (!s.active) fail("ci/off", "签到功能目前没有开放");
    if (!memSnap.exists) fail("ci/not-member", "请先注册会员");
    const member = memSnap.data();
    const internal = !!(member.internal && member.internal.on === true);
    if (!internal && bindSnap.empty) fail("ci/need-bind", "绑定订单后才能签到");

    const state = stSnap.exists ? stSnap.data() : null;
    const step = nextStep(state, today);
    if (step.already || ledSnap.exists) {
      return { already: true, today, day: state ? state.day : step.day, streak: step.streak,
        nextPts: s.points[(state ? state.day : step.day) % 7] };
    }

    // 🏅 签到达人：读礼物奖品（所有读取要在写入之前）
    const mile = isMilestone(step.streak);
    let giftSnap = null;
    if (mile && s.m30.giftRewardId) giftSnap = await tx.get(db.collection("rewards").doc(s.m30.giftRewardId));

    // ---- 写入 ----
    const pts = s.points[step.day - 1];
    if (pts > 0) {
      tx.create(ledgerRef, {
        uid, delta: pts, reason: `每日签到：第${step.day}天`, orderNo: null, bindingIds: [],
        availableAt: nowTs, createdAt: nowTs,
      });
    }
    const next = {
      lastDate: today, day: step.day, streak: step.streak,
      total: ((state && Number(state.total)) || 0) + 1,
      totalPts: ((state && Number(state.totalPts)) || 0) + pts,
      badges: (state && Number(state.badges)) || 0,
      updatedAt: nowTs,
    };
    if (state && state.share) next.share = state.share;
    const out = { already: false, today, day: step.day, pts, streak: step.streak, nextPts: s.points[step.day % 7] };

    if (mile) {
      next.badges += 1;
      next.share = { ms: today, claimed: false, postId: null };   // 开放这一次的分享（上一次没分享的就作废）
      if (s.m30.points > 0) {
        tx.create(db.collection("pointsLedger").doc(`checkin_m30_${uid}_${compact(today)}`), {
          uid, delta: s.m30.points, reason: `签到达人：连续 ${step.streak} 天`, orderNo: null, bindingIds: [],
          availableAt: nowTs, createdAt: nowTs,
        });
      }
      let gift = null;
      if (giftSnap && giftSnap.exists) {
        const r = giftSnap.data();
        const hasStock = typeof r.stock !== "number" || r.stock > 0;
        gift = { id: giftSnap.id, name: r.name || "", backorder: !hasStock };
        const red = {
          uid, rewardId: giftSnap.id, rewardName: r.name || "", cost: 0, status: "pending",
          kind: "gift", delivery: "withOrder", gift: true, giftReason: `签到达人：连续 ${step.streak} 天`,
          ciGift: true, ciMs: today, deadline: tsOf(now + s.m30.giftDays * DAY), createdAt: nowTs,
        };
        if (!hasStock) red.backorder = true;   // 📦 库存 0：照样建立，标「补货中」
        tx.create(db.collection("redemptions").doc(`ci_${uid}_${compact(today)}`), red);
        if (hasStock && typeof r.stock === "number") tx.update(giftSnap.ref, { stock: FieldValue.increment(-1) });
      }
      // 🏅 徽章次数：公开的 Feed 资料（只有后端能写这个栏位）
      tx.set(db.collection("memberFeed").doc(uid), { ciBadge: next.badges }, { merge: true });
      tx.set(db.collection("memberMessages").doc(), message(uid, "m30",
        { n: step.streak, p: s.m30.points, s: s.m30.sharePts, g: gift ? gift.name : "" }, now));
      out.milestone = { streak: step.streak, points: s.m30.points, sharePts: s.m30.sharePts, badges: next.badges,
        gift: gift ? { name: gift.name, backorder: gift.backorder, days: s.m30.giftDays } : null };
    }
    tx.set(stateRef, next);
    return out;
  });
}

// ---------- ✨ 分享到 Feed：签到分享帖发布后 +10（触发器呼叫）----------
// 只有「这一篇刚变成已发布」才处理；同一次达标只给一次（文件 ID 固定 + share.claimed）
async function onFeedPostWritten(db, pid, before, after, ctx = {}) {
  if (!after || after.tag !== "checkin" || after.status !== "published") return { skip: "not-share" };
  if (before && before.status === "published") return { skip: "already-published" };
  const uid = after.authorUid, ms = after.ciMs;
  if (typeof uid !== "string" || typeof ms !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ms)) return { skip: "bad" };
  const now = nowMs(ctx);
  const stateRef = db.collection("checkins").doc(uid);
  const ledgerRef = db.collection("pointsLedger").doc(`checkin_share_${uid}_${compact(ms)}`);
  return db.runTransaction(async tx => {
    const [stSnap, ledSnap, perksSnap] = await Promise.all([
      tx.get(stateRef), tx.get(ledgerRef), tx.get(db.collection("settings").doc("perks")),
    ]);
    const st = stSnap.exists ? stSnap.data() : null;
    const share = st && st.share;
    if (!share || share.ms !== ms || share.claimed === true || ledSnap.exists) return { skip: "not-open" };
    const pts = ciSettings(perksSnap.exists ? perksSnap.data() : null).m30.sharePts;
    if (pts > 0) {
      tx.create(ledgerRef, {
        uid, delta: pts, reason: "签到达人：分享到 Feed", orderNo: null, bindingIds: [],
        availableAt: tsOf(now), createdAt: tsOf(now),
      });
      tx.set(db.collection("memberMessages").doc(), message(uid, "share", { p: pts }, now, "points.html"));
    }
    tx.update(stateRef, { share: { ms, claimed: true, postId: pid } });
    return { ok: true, pts };
  });
}

// ---------- ⏰ 每日检查：礼物到期前提醒、过期取消 ----------
// 「有下一单」= 礼物建立之后，会员有新的订单（orders.orderTime ≥ 礼物建立时间）→ 不取消，等管理员随单寄出
async function ciDaily(db, ctx = {}) {
  const now = nowMs(ctx);
  const snap = await db.collection("redemptions").where("ciGift", "==", true).get();
  const r = { checked: 0, reminded: 0, expired: 0, hasOrder: 0 };
  for (const d of snap.docs) {
    const g = d.data();
    if (!ACTIVE_GIFT.includes(g.status) || g.orderFound === true) continue;
    r.checked++;
    const created = toMs(g.createdAt), deadline = toMs(g.deadline);
    if (!created || !deadline) continue;
    const oSnap = await db.collection("orders").where("uid", "==", g.uid).get();
    const ordered = oSnap.docs.some(o => {
      const x = o.data();
      return x.status !== "refunded" && (toMs(x.orderTime) || 0) >= created;
    });
    if (ordered) { await d.ref.update({ orderFound: true }); r.hasOrder++; continue; }
    if (now > deadline) {
      const done = await db.runTransaction(async tx => {
        const cur = await tx.get(d.ref);
        const c = cur.data();
        if (!cur.exists || !ACTIVE_GIFT.includes(c.status)) return false;
        const rw = c.backorder ? null : await tx.get(db.collection("rewards").doc(c.rewardId));
        tx.update(d.ref, { status: "cancelled", cancelReason: "签到达人礼物逾期（期限内没有下单）", cancelledAt: tsOf(now), decidedBy: "system" });
        if (rw && rw.exists && typeof rw.data().stock === "number") tx.update(rw.ref, { stock: FieldValue.increment(1) });
        tx.set(db.collection("memberMessages").doc(), message(c.uid, "expired", { g: c.rewardName }, now, "rewards.html"));
        return true;
      });
      if (done) r.expired++;
    } else if (deadline - now <= REMIND_DAYS * DAY && !g.remindedAt) {
      await db.collection("memberMessages").add(message(g.uid, "remind", { g: g.rewardName, d: fmtMy(deadline) }, now, "rewards.html"));
      await d.ref.update({ remindedAt: tsOf(now) });
      r.reminded++;
    }
  }
  return r;
}

module.exports = {
  CI_DEFAULT_POINTS, MILESTONE, M30_DEFAULT, mytDate, prevDate, ciSettings, nextStep, isMilestone,
  ciCheckIn, onFeedPostWritten, ciDaily,
};
