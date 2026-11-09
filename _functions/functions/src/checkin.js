// 📅 每日签到 — 后端逻辑
// 7 天一轮（预设 1·1·2·2·3·3·8 分），中间断一天就从第 1 天重新开始；每天 00:00（马来西亚时间）换日。
// 积分只能由这里写（会员网页不能直接写积分流水）。每人每天一笔，文件 ID 固定，重复按也不会多拿分。
// 资料：
//   settings/perks.checkin = { active: true/false, points: [7 个数字] }   ← 后台「额外福利 › 每日签到」
//   checkins/{uid}         = { lastDate: "2026-11-09", day: 1–7, streak, total, totalPts, updatedAt }   ← 会员可读自己的
//   pointsLedger/checkin_{uid}_{yyyymmdd} = { uid, delta, reason: "每日签到：第N天", ... }
"use strict";

const { Timestamp } = require("firebase-admin/firestore");
const { NmError } = require("./core");

const DAY = 86400000;
const MYT = 8 * 3600000;   // 马来西亚 UTC+8，没有夏令时间
const CI_DEFAULT_POINTS = [1, 1, 2, 2, 3, 3, 8];
const CI_MAX_POINTS = 100;   // 每天最多给几分（防止后台打错字）

const fail = (key, msg, code = "failed-precondition") => { throw new NmError(code, key, msg); };
const nowMs = ctx => (ctx && typeof ctx.now === "number" ? ctx.now : Date.now());

// 马来西亚日期 "YYYY-MM-DD"
function mytDate(ms) { return new Date(ms + MYT).toISOString().slice(0, 10); }
function prevDate(date) { return new Date(Date.parse(date + "T00:00:00Z") - DAY).toISOString().slice(0, 10); }

// 后台设定 → { active, points[7] }；没设定过是关闭的（店主部署好函式后再到后台打开）
function ciSettings(perks) {
  const c = (perks && perks.checkin) || {};
  const ok = Array.isArray(c.points) && c.points.length === 7
    && c.points.every(n => Number.isInteger(n) && n >= 0 && n <= CI_MAX_POINTS);
  return { active: c.active === true, points: ok ? c.points.slice() : CI_DEFAULT_POINTS.slice() };
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

async function ciCheckIn(db, ctx) {
  if (!ctx || !ctx.uid) fail("ci/signin", "请先登入", "unauthenticated");
  const uid = ctx.uid;
  const now = nowMs(ctx);
  const today = mytDate(now);
  const nowTs = Timestamp.fromMillis(now);
  const stateRef = db.collection("checkins").doc(uid);
  const ledgerRef = db.collection("pointsLedger").doc(`checkin_${uid}_${today.replace(/-/g, "")}`);

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
    const pts = s.points[step.day - 1];
    if (pts > 0) {
      tx.create(ledgerRef, {
        uid, delta: pts, reason: `每日签到：第${step.day}天`, orderNo: null, bindingIds: [],
        availableAt: nowTs, createdAt: nowTs,
      });
    }
    tx.set(stateRef, {
      lastDate: today, day: step.day, streak: step.streak,
      total: ((state && Number(state.total)) || 0) + 1,
      totalPts: ((state && Number(state.totalPts)) || 0) + pts,
      updatedAt: nowTs,
    });
    return { already: false, today, day: step.day, pts, streak: step.streak, nextPts: s.points[step.day % 7] };
  });
}

module.exports = { CI_DEFAULT_POINTS, mytDate, prevDate, ciSettings, nextStep, ciCheckIn };
