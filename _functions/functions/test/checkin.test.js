// 📅 每日签到后端测试（不用模拟器：用记忆体里的假资料库）
//   node --test test/checkin.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ci = require("../src/checkin");

// ---------- 假资料库：只做签到用到的部分（doc get/create/set/update、where == + limit、transaction、increment）----------
const { FieldValue } = require("firebase-admin/firestore");
const INC = FieldValue.increment(1).constructor;
function applyPatch(old, patch, merge) {
  const out = merge || old ? { ...(old || {}) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.constructor === INC) out[k] = (Number(out[k]) || 0) + (v.operand ?? v._operand ?? 0);
    else out[k] = v;
  }
  return merge || old ? out : patch;
}
let autoId = 0;
function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));   // "col/id" → 资料
  let db;
  const snapOf = r => { const d = data.get(r.path); return { exists: d !== undefined, data: () => d, id: r.id, ref: r }; };
  const runQuery = r => {
    const docs = [...data.entries()]
      .filter(([k, d]) => k.split("/").length === 2 && k.startsWith(r.col + "/") && d[r.f] === r.v)
      .slice(0, r.n).map(([k]) => snapOf(ref(r.col, k.split("/")[1])));
    return { empty: docs.length === 0, docs };
  };
  const ref = (col, id) => {
    const r = { kind: "doc", col, id, path: col + "/" + id,
      async get() { return snapOf(r); },
      async update(p) { data.set(r.path, applyPatch(data.get(r.path), p, true)); },
      async set(p, o) { data.set(r.path, applyPatch(data.get(r.path), p, o && o.merge)); } };
    return r;
  };
  db = {
    data,
    collection(col) {
      return {
        doc: id => ref(col, id || "auto" + (++autoId)),
        async add(d) { const r = ref(col, "auto" + (++autoId)); data.set(r.path, d); return r; },
        where(f, op, v) {
          const q = { kind: "query", col, f, v, n: Infinity, limit(n) { q.n = n; return q; }, async get() { return runQuery(q); } };
          return q;
        },
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(r) { return r.kind === "doc" ? snapOf(r) : runQuery(r); },
        create(r, d) { writes.push(["create", r, d]); },
        set(r, d, o) { writes.push(["set", r, d, o]); },
        update(r, d) { writes.push(["update", r, d]); },
      };
      const out = await fn(tx);
      for (const [op, r] of writes) {
        if (op === "create" && data.has(r.path)) throw new Error("ALREADY_EXISTS " + r.path);
        if (op === "update" && !data.has(r.path)) throw new Error("NOT_FOUND " + r.path);
      }
      for (const [op, r, d, o] of writes) {
        data.set(r.path, op === "create" ? d : applyPatch(data.get(r.path), d, op === "update" || (o && o.merge)));
      }
      return out;
    },
  };
  return db;
}
const ON = { "settings/perks": { checkin: { active: true, points: [1, 1, 2, 2, 3, 3, 8] } } };
const member = (uid, extra = {}) => ({ [`members/${uid}`]: { name: "A", ...extra } });
const bound = uid => ({ [`bindings/shopee_${uid}`]: { uid, platform: "shopee" } });
// 马来西亚时间某天中午
const myt = (date, h = 12) => Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00+08:00`);
const ledger = (db, uid) => [...db.data.entries()].filter(([k, d]) => k.startsWith("pointsLedger/") && d.uid === uid).map(([k, d]) => ({ id: k, ...d }));
async function rejects(p, key) { await assert.rejects(p, e => { assert.equal(e.key, key); return true; }); }

// ---------------------------------------------------------------- 日期
test("马来西亚日期：UTC 16:00 之后就是隔天", () => {
  assert.equal(ci.mytDate(Date.parse("2026-11-09T15:59:59Z")), "2026-11-09");
  assert.equal(ci.mytDate(Date.parse("2026-11-09T16:00:00Z")), "2026-11-10");
  assert.equal(ci.prevDate("2026-03-01"), "2026-02-28");
  assert.equal(ci.prevDate("2026-01-01"), "2025-12-31");
});

test("设定：没设定过 = 关闭 + 预设分数；分数不对就用预设", () => {
  const d = ci.ciSettings(null);
  assert.equal(d.active, false); assert.deepEqual(d.points, [1, 1, 2, 2, 3, 3, 8]);
  assert.deepEqual(d.m30, { points: 30, sharePts: 10, giftRewardId: "", giftDays: 30 });
  assert.equal(ci.ciSettings({ checkin: { m30: { giftRewardId: "bad id!", giftDays: 0, points: -1 } } }).m30.giftRewardId, "");
  assert.deepEqual(ci.ciSettings({ checkin: { active: true, points: [5, 5, 5] } }).points, [1, 1, 2, 2, 3, 3, 8]);
  assert.deepEqual(ci.ciSettings({ checkin: { active: true, points: [2, 2, 2, 2, 2, 2, 20] } }).points, [2, 2, 2, 2, 2, 2, 20]);
  assert.deepEqual(ci.ciSettings({ checkin: { active: true, points: [1, 1, 1, 1, 1, 1, 999] } }).points, [1, 1, 2, 2, 3, 3, 8]);
});

// ---------------------------------------------------------------- 签到
test("连续 7 天：1·1·2·2·3·3·8，第 8 天回到第 1 天", async () => {
  const db = fakeDb({ ...ON, ...member("u1"), ...bound("u1") });
  const got = [];
  for (let i = 0; i < 8; i++) {
    const date = ci.mytDate(myt("2026-11-09") + i * 86400000);
    const r = await ci.ciCheckIn(db, { uid: "u1", now: myt(date) });
    got.push([r.day, r.pts]);
  }
  assert.deepEqual(got, [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3], [7, 8], [1, 1]]);
  assert.equal(ledger(db, "u1").reduce((s, x) => s + x.delta, 0), 21);
  const st = db.data.get("checkins/u1");
  assert.equal(st.streak, 8); assert.equal(st.total, 8); assert.equal(st.totalPts, 21);
});

test("同一天按两次只给一次分", async () => {
  const db = fakeDb({ ...ON, ...member("u2"), ...bound("u2") });
  const a = await ci.ciCheckIn(db, { uid: "u2", now: myt("2026-11-09", 1) });
  const b = await ci.ciCheckIn(db, { uid: "u2", now: myt("2026-11-09", 23) });
  assert.equal(a.already, false); assert.equal(b.already, true);
  assert.equal(ledger(db, "u2").length, 1);
});

test("中间断一天 → 从第 1 天重新开始", async () => {
  const db = fakeDb({ ...ON, ...member("u3"), ...bound("u3") });
  await ci.ciCheckIn(db, { uid: "u3", now: myt("2026-11-09") });
  await ci.ciCheckIn(db, { uid: "u3", now: myt("2026-11-10") });
  const r = await ci.ciCheckIn(db, { uid: "u3", now: myt("2026-11-12") });
  assert.equal(r.day, 1); assert.equal(r.streak, 1); assert.equal(r.nextPts, 1);
});

test("午夜换日：23:59 签完，00:00 可以再签（第 2 天）", async () => {
  const db = fakeDb({ ...ON, ...member("u4"), ...bound("u4") });
  await ci.ciCheckIn(db, { uid: "u4", now: Date.parse("2026-11-09T23:59:00+08:00") });
  const r = await ci.ciCheckIn(db, { uid: "u4", now: Date.parse("2026-11-10T00:00:30+08:00") });
  assert.equal(r.already, false); assert.equal(r.day, 2);
});

test("没绑定订单不能签；内部会员可以", async () => {
  const db = fakeDb({ ...ON, ...member("u5"), ...member("u6", { internal: { on: true } }) });
  await rejects(ci.ciCheckIn(db, { uid: "u5", now: myt("2026-11-09") }), "ci/need-bind");
  const r = await ci.ciCheckIn(db, { uid: "u6", now: myt("2026-11-09") });
  assert.equal(r.pts, 1);
});

test("后台关闭、不是会员、没登入 → 拒绝，不写任何资料", async () => {
  const off = fakeDb({ ...member("u7"), ...bound("u7") });
  await rejects(ci.ciCheckIn(off, { uid: "u7", now: myt("2026-11-09") }), "ci/off");
  const db = fakeDb({ ...ON, ...bound("u8") });
  await rejects(ci.ciCheckIn(db, { uid: "u8", now: myt("2026-11-09") }), "ci/not-member");
  await rejects(ci.ciCheckIn(db, null), "ci/signin");
  assert.equal(ledger(off, "u7").length + ledger(db, "u8").length, 0);
});

test("某一天设 0 分：照样算签到、接续天数，但不写积分", async () => {
  const db = fakeDb({ "settings/perks": { checkin: { active: true, points: [0, 1, 1, 1, 1, 1, 5] } }, ...member("u9"), ...bound("u9") });
  const a = await ci.ciCheckIn(db, { uid: "u9", now: myt("2026-11-09") });
  const b = await ci.ciCheckIn(db, { uid: "u9", now: myt("2026-11-10") });
  assert.equal(a.pts, 0); assert.equal(b.day, 2);
  assert.equal(ledger(db, "u9").length, 1);
});

// ---------------------------------------------------------------- 🏅 签到达人
const DAYMS = 86400000;
const GIFT = (stock = 50) => ({ "rewards/gift1": { name: "Mochii 贴纸", stock, active: false, hidden: true } });
const ONM = (m30 = {}) => ({ "settings/perks": { checkin: { active: true, points: [1, 1, 2, 2, 3, 3, 8], m30: { giftRewardId: "gift1", ...m30 } } } });
async function streakDays(db, uid, n, start = "2026-11-01") {
  let last;
  for (let i = 0; i < n; i++) last = await ci.ciCheckIn(db, { uid, now: myt(ci.mytDate(myt(start) + i * DAYMS)) });
  return last;
}
const byPrefix = (db, p) => [...db.data.entries()].filter(([k]) => k.startsWith(p)).map(([k, d]) => ({ id: k, ...d }));

test("第 30 天：+30 分、建立礼物兑换、扣库存、徽章 ×1、开放分享、铃铛通知", async () => {
  const db = fakeDb({ ...ONM(), ...GIFT(50), ...member("a1"), ...bound("a1") });
  const r29 = await streakDays(db, "a1", 29);
  assert.equal(r29.milestone, undefined);
  const r = await ci.ciCheckIn(db, { uid: "a1", now: myt("2026-11-30") });
  assert.equal(r.streak, 30);
  assert.deepEqual(r.milestone, { streak: 30, points: 30, sharePts: 10, badges: 1, gift: { name: "Mochii 贴纸", backorder: false, days: 30 } });
  const m30 = db.data.get("pointsLedger/checkin_m30_a1_20261130");
  assert.equal(m30.delta, 30); assert.equal(m30.reason, "签到达人：连续 30 天");
  const red = db.data.get("redemptions/ci_a1_20261130");
  assert.equal(red.cost, 0); assert.equal(red.status, "pending"); assert.equal(red.delivery, "withOrder");
  assert.equal(red.ciGift, true); assert.equal(red.backorder, undefined);
  assert.equal(red.deadline.toMillis(), myt("2026-11-30") + 30 * DAYMS);
  assert.equal(db.data.get("rewards/gift1").stock, 49);
  assert.equal(db.data.get("memberFeed/a1").ciBadge, 1);
  assert.deepEqual(db.data.get("checkins/a1").share, { ms: "2026-11-30", claimed: false, postId: null });
  assert.equal(byPrefix(db, "memberMessages/").length, 1);
});

test("第 60 天再一次（徽章 ×2）；断签后要重新累计 30 天", async () => {
  const db = fakeDb({ ...ONM(), ...GIFT(50), ...member("a2"), ...bound("a2") });
  const r60 = await streakDays(db, "a2", 60);
  assert.equal(r60.milestone.badges, 2);
  assert.equal(db.data.get("memberFeed/a2").ciBadge, 2);
  // 断一天，再签 29 天 → 还不算
  const r = await streakDays(db, "a2", 29, ci.mytDate(myt("2026-11-01") + 61 * DAYMS));
  assert.equal(r.milestone, undefined);
  assert.equal(db.data.get("checkins/a2").badges, 2);
});

test("库存 0：照样建立礼物、标补货中、不扣成负数", async () => {
  const db = fakeDb({ ...ONM(), ...GIFT(0), ...member("a3"), ...bound("a3") });
  const r = await streakDays(db, "a3", 30);
  assert.equal(r.milestone.gift.backorder, true);
  assert.equal(db.data.get("redemptions/ci_a3_20261130").backorder, true);
  assert.equal(db.data.get("rewards/gift1").stock, 0);
});

test("后台没选礼物：只给积分和徽章；30 天奖励设 0 分：不写积分", async () => {
  const db = fakeDb({ ...ONM({ giftRewardId: "", points: 0 }), ...member("a4"), ...bound("a4") });
  const r = await streakDays(db, "a4", 30);
  assert.equal(r.milestone.gift, null);
  assert.equal(byPrefix(db, "redemptions/").length, 0);
  assert.equal(db.data.has("pointsLedger/checkin_m30_a4_20261130"), false);
  assert.equal(db.data.get("memberFeed/a4").ciBadge, 1);
});

test("分享帖发布 → +10 一次；审核中不给；同一次达标第二篇不再给；不是签到帖不处理", async () => {
  const db = fakeDb({ ...ONM(), ...GIFT(5), ...member("a5"), ...bound("a5") });
  await streakDays(db, "a5", 30);
  const post = { tag: "checkin", ciMs: "2026-11-30", authorUid: "a5", status: "pending" };
  assert.equal((await ci.onFeedPostWritten(db, "p1", null, post)).skip, "not-share");
  const r = await ci.onFeedPostWritten(db, "p1", post, { ...post, status: "published" });
  assert.equal(r.pts, 10);
  assert.equal(db.data.get("pointsLedger/checkin_share_a5_20261130").delta, 10);
  assert.deepEqual(db.data.get("checkins/a5").share, { ms: "2026-11-30", claimed: true, postId: "p1" });
  const again = await ci.onFeedPostWritten(db, "p2", null, { ...post, status: "published" });
  assert.equal(again.skip, "not-open");
  assert.equal((await ci.onFeedPostWritten(db, "p3", null, { status: "published", authorUid: "a5" })).skip, "not-share");
  assert.equal(byPrefix(db, "pointsLedger/checkin_share_").length, 1);
});

test("没有达标资格（日期不对）的分享帖不给分", async () => {
  const db = fakeDb({ ...ONM(), ...member("a6"), ...bound("a6") });
  await streakDays(db, "a6", 30);
  const r = await ci.onFeedPostWritten(db, "p9", null, { tag: "checkin", ciMs: "2026-11-29", authorUid: "a6", status: "published" });
  assert.equal(r.skip, "not-open");
});

test("每日检查：到期前 7 天提醒一次；过期没下单 → 取消、退库存、通知；有下单 → 不取消", async () => {
  const seed = { ...ONM(), ...GIFT(10), ...member("b1"), ...bound("b1"), ...member("b2"), ...bound("b2") };
  const db = fakeDb(seed);
  await streakDays(db, "b1", 30); await streakDays(db, "b2", 30);
  assert.equal(db.data.get("rewards/gift1").stock, 8);
  const made = myt("2026-11-30");
  // b2 在礼物建立后下单
  db.data.set("orders/ORD1", { uid: "b2", orderTime: { toMillis: () => made + 3 * DAYMS }, status: "" });
  // 第 24 天：提醒
  let r = await ci.ciDaily(db, { now: made + 24 * DAYMS });
  assert.equal(r.reminded, 1); assert.equal(r.hasOrder, 1);
  r = await ci.ciDaily(db, { now: made + 25 * DAYMS });
  assert.equal(r.reminded, 0);
  // 第 31 天：b1 过期取消
  r = await ci.ciDaily(db, { now: made + 31 * DAYMS });
  assert.equal(r.expired, 1);
  assert.equal(db.data.get("redemptions/ci_b1_20261130").status, "cancelled");
  assert.equal(db.data.get("redemptions/ci_b2_20261130").status, "pending");
  assert.equal(db.data.get("rewards/gift1").stock, 9);
  assert.equal(db.data.get("pointsLedger/checkin_m30_b1_20261130").delta, 30);   // 积分保留
});

test("每日检查：补货中的礼物过期不加回库存；订单早于礼物不算", async () => {
  const db = fakeDb({ ...ONM(), ...GIFT(0), ...member("b3"), ...bound("b3") });
  await streakDays(db, "b3", 30);
  const made = myt("2026-11-30");
  db.data.set("orders/OLD", { uid: "b3", orderTime: { toMillis: () => made - DAYMS }, status: "" });
  const r = await ci.ciDaily(db, { now: made + 31 * DAYMS });
  assert.equal(r.expired, 1);
  assert.equal(db.data.get("rewards/gift1").stock, 0);
});

test("签到状态被删掉、今天已经有积分：不再给分，并把状态补回今天", async () => {
  const db = fakeDb({ ...ON, ...member("r1"), ...bound("r1") });
  await ci.ciCheckIn(db, { uid: "r1", now: myt("2026-11-09", 10) });
  db.data.delete("checkins/r1");   // 模拟资料被删
  const r = await ci.ciCheckIn(db, { uid: "r1", now: myt("2026-11-09", 12) });
  assert.equal(r.already, true); assert.equal(r.repaired, true); assert.equal(r.day, 1);
  assert.equal(ledger(db, "r1").length, 1);
  assert.equal(db.data.get("checkins/r1").lastDate, "2026-11-09");
  // 明天照常是第 2 天
  const t = await ci.ciCheckIn(db, { uid: "r1", now: myt("2026-11-10") });
  assert.equal(t.day, 2); assert.equal(t.already, false);
});
