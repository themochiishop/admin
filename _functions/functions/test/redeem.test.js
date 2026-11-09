// 🛍️ 商城兑换后端测试（不用模拟器）：node --test test/redeem.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp } = require("firebase-admin/firestore");
const rd = require("../src/redeem");
const { fakeDb } = require("./fake-db");

const NOW = Date.parse("2026-11-09T12:00:00+08:00");
const ts = ms => Timestamp.fromMillis(ms);
const base = (extra = {}) => ({
  "settings/club": { open: true },
  "members/m1": { name: "A" }, "members/m2": { name: "B" },
  "pointsLedger/l1": { uid: "m1", delta: 500, availableAt: ts(NOW - 1000) },
  "pointsLedger/l2": { uid: "m2", delta: 500, availableAt: ts(NOW - 1000) },
  "rewards/g1": { name: "杯子", type: "gift", cost: 100, active: true, stock: 1 },
  ...extra,
});
const ctx = uid => ({ uid, now: NOW });
async function rejects(p, key) { await assert.rejects(p, e => { assert.equal(e.key, key, e.message); return true; }); }
const reds = db => [...db.data.entries()].filter(([k]) => k.startsWith("redemptions/")).map(([k, d]) => ({ id: k.split("/")[1], ...d }));

test("兑换成功：建立待审核兑换（reserved）、马上扣库存", async () => {
  const db = fakeDb(base());
  const r = await rd.rdRedeem(db, ctx("m1"), { rewardId: "g1" });
  const red = db.data.get("redemptions/" + r.id);
  assert.equal(red.status, "pending"); assert.equal(red.reserved, true); assert.equal(red.cost, 100);
  assert.equal(red.kind, "gift"); assert.equal(red.delivery, "withOrder");
  assert.equal(db.data.get("rewards/g1").stock, 0);
});

test("最后 1 个：第二位会员拿到「已兑完」，不会超卖", async () => {
  const db = fakeDb(base());
  await rd.rdRedeem(db, ctx("m1"), { rewardId: "g1" });
  await rejects(rd.rdRedeem(db, ctx("m2"), { rewardId: "g1" }), "rd/sold-out");
  assert.equal(reds(db).length, 1);
  assert.equal(db.data.get("rewards/g1").stock, 0);
});

test("款式：一定要选、款式库存会扣、这一款卖完就不能换", async () => {
  const db = fakeDb(base({ "rewards/g2": { name: "香氛", type: "gift", cost: 50, active: true, stock: 10,
    variants: { a1: { name: "A1", stock: 1 }, a2: { name: "A2", stock: 5 } } } }));
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "g2" }), "rd/variant");
  const r = await rd.rdRedeem(db, ctx("m1"), { rewardId: "g2", variantId: "a1" });
  const g = db.data.get("rewards/g2");
  assert.equal(g.stock, 9); assert.equal(g.variants.a1.stock, 0); assert.equal(g.variants.a2.stock, 5);
  assert.equal(db.data.get("redemptions/" + r.id).variantName, "A1");
  await rejects(rd.rdRedeem(db, ctx("m2"), { rewardId: "g2", variantId: "a1" }), "rd/sold-out");
  await rd.rdRedeem(db, ctx("m2"), { rewardId: "g2", variantId: "a2" });
});

test("积分不足（算进审核中的兑换）", async () => {
  const db = fakeDb(base({ "rewards/g3": { name: "大奖", type: "gift", cost: 450, active: true } }));
  await rd.rdRedeem(db, ctx("m1"), { rewardId: "g1" });   // 先换 100（审核中）
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "g3" }), "rd/points");   // 500 − 100 < 450
});

test("还没到账的积分不能用", async () => {
  const db = fakeDb(base({ "pointsLedger/l3": { uid: "m3", delta: 999, availableAt: ts(NOW + 86400000) }, "members/m3": { name: "C" } }));
  await rejects(rd.rdRedeem(db, ctx("m3"), { rewardId: "g1" }), "rd/points");
});

test("限兑次数：本期满了就不能换；换新码（roundSince）后重新算；取消的不算", async () => {
  const db = fakeDb(base({ "rewards/c1": { name: "RM5 券", type: "coupon", cost: 10, active: true, perMember: 1 } }));
  const r = await rd.rdRedeem(db, ctx("m1"), { rewardId: "c1" });
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "c1" }), "rd/limit");
  await rd.rdCancel(db, ctx("m1"), { id: r.id });
  await rd.rdRedeem(db, ctx("m1"), { rewardId: "c1" });   // 取消的不算
  db.data.get("rewards/c1").roundSince = ts(NOW + 1);
  await rd.rdRedeem(db, { uid: "m1", now: NOW + 10 }, { rewardId: "c1" });   // 新的一期
});

test("下架、未开放、签到达人专属、俱乐部维修中、不是会员 → 拒绝", async () => {
  const db = fakeDb(base({
    "rewards/off": { name: "x", cost: 10, active: false },
    "rewards/soon": { name: "x", cost: 10, active: true, comingSoon: true, openAt: ts(NOW + 3600000) },
    "rewards/ended": { name: "x", cost: 10, active: true, endAt: ts(NOW - 1) },
    "rewards/ci": { name: "x", cost: 0, active: true, ciOnly: true },
    "rewards/opened": { name: "x", cost: 10, active: true, comingSoon: true, openAt: ts(NOW - 1) },
  }));
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "off" }), "rd/gone");
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "soon" }), "rd/not-open");
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "ended" }), "rd/gone");
  await rejects(rd.rdRedeem(db, ctx("m1"), { rewardId: "ci" }), "rd/ci-only");
  await rd.rdRedeem(db, ctx("m1"), { rewardId: "opened" });   // 开放时间到了就可以
  await rejects(rd.rdRedeem(db, ctx("nobody"), { rewardId: "g1" }), "rd/not-member");
  db.data.set("settings/club", { open: false });
  await rejects(rd.rdRedeem(db, ctx("m2"), { rewardId: "g1" }), "rd/closed");
  db.data.set("admins/m2", {});
  await rd.rdRedeem(db, ctx("m2"), { rewardId: "g1" });   // 管理员维修中也能测试
});

test("会员取消：库存（含款式）加回；别人的、已审核的、迎新礼不能取消", async () => {
  const db = fakeDb(base({ "rewards/g2": { name: "香氛", type: "gift", cost: 50, active: true, stock: 3,
    variants: { a1: { name: "A1", stock: 1 } } } }));
  const r = await rd.rdRedeem(db, ctx("m1"), { rewardId: "g2", variantId: "a1" });
  await rejects(rd.rdCancel(db, ctx("m2"), { id: r.id }), "rd/not-found");
  await rd.rdCancel(db, ctx("m1"), { id: r.id });
  const g = db.data.get("rewards/g2");
  assert.equal(g.stock, 3); assert.equal(g.variants.a1.stock, 1);
  assert.equal(db.data.get("redemptions/" + r.id).status, "cancelled");
  await rejects(rd.rdCancel(db, ctx("m1"), { id: r.id }), "rd/not-pending");
  db.data.set("redemptions/nm", { uid: "m1", status: "pending", newMember: true, rewardId: "newMember" });
  await rejects(rd.rdCancel(db, ctx("m1"), { id: "nm" }), "rd/no-cancel");
});

test("旧的兑换（没有 reserved）取消时不加库存", async () => {
  const db = fakeDb(base({ "redemptions/old": { uid: "m1", status: "pending", rewardId: "g1", cost: 100 } }));
  await rd.rdCancel(db, ctx("m1"), { id: "old" });
  assert.equal(db.data.get("rewards/g1").stock, 1);
});

test("没设库存（不限）的奖品照常兑换，不写库存", async () => {
  const db = fakeDb(base({ "rewards/u": { name: "无限", type: "gift", cost: 10, active: true } }));
  await rd.rdRedeem(db, ctx("m1"), { rewardId: "u" });
  await rd.rdRedeem(db, ctx("m1"), { rewardId: "u" });
  assert.equal(db.data.get("rewards/u").stock, undefined);
});
