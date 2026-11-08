// 新会员奖励后端测试：要先开 Firestore 模拟器
//   firebase emulators:exec --only firestore --project demo-nm "npm test"
// 对照需求书第 15 节（前台显示、三语、手机版要在网页上测）
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("请先启动 Firestore 模拟器（FIRESTORE_EMULATOR_HOST 未设定），测试不会连正式资料库");
  process.exit(1);
}
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-nm";

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const core = require("../src/core");

const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = getFirestore(app);
const DAY = core.DAY;

const T0 = Date.parse("2026-12-01T02:00:00Z");   // 活动开始
const OWNER = { uid: "ownerUid01", email: core.OWNER_EMAIL, emailVerified: true };
const at = (ctx, ms) => ({ ...ctx, now: ms });
const tid = () => crypto.randomBytes(9).toString("hex");
const rnd = () => crypto.randomBytes(5).toString("hex");
const ts = ms => Timestamp.fromMillis(ms);

async function setup() {
  await core.nmSaveSettings(db, at(OWNER, T0), {
    settings: { active: true, cost: 30, validDays: 20, stock: 100, manualReview: true, perMemberLimit: 1 },
  });
}
async function newMember({ createdAt = T0 + DAY, points = 30, binds = [["shopee"]], internal = false } = {}) {
  const uid = "m" + rnd() + rnd();
  const data = { name: "会员" + uid.slice(0, 4), email: uid + "@x.test", createdAt: ts(createdAt) };
  if (internal) data.internal = { on: true };
  await db.collection("members").doc(uid).set(data);
  const accounts = [];
  for (const [platform] of binds) {
    const username = "buyer" + rnd();
    await db.collection("bindings").doc(`${platform}_${username}`).set({ uid, platform, username, verifyOrder: "x", createdAt: ts(createdAt) });
    accounts.push({ platform, username });
  }
  if (points) {
    await db.collection("pointsLedger").doc("welcome_" + uid).set({
      uid, delta: points, reason: "新会员欢迎礼", orderNo: null, bindingIds: [], availableAt: ts(createdAt), createdAt: ts(createdAt),
    });
  }
  await core.ensureEligibility(db, uid, { now: createdAt });
  return { uid, accounts, ctx: { uid, email: data.email, emailVerified: true } };
}
async function addOrder(m, acct, orderTime, extra = {}) {
  const no = "26" + rnd().toUpperCase() + rnd().toUpperCase();
  const data = { uid: m.uid, platform: acct.platform, username: acct.username, orderTime: ts(orderTime), amount: 50, points: 50, ...extra };
  await db.collection("orders").doc(no).set(data);
  return { no, data };
}
async function ledgerOf(uid) {
  const s = await db.collection("pointsLedger").where("uid", "==", uid).get();
  return s.docs.map(d => ({ id: d.id, ...d.data() }));
}
const sum = l => l.reduce((s, x) => s + x.delta, 0);
async function reward(rid) { return (await db.collection("newMemberRewards").doc(rid).get()).data(); }
async function rejects(p, key) {
  await assert.rejects(p, e => { assert.equal(e.key, key, `期待 ${key}，实际 ${e.key}：${e.message}`); return true; });
}
const admin = (op, ctx, data) => core[op](db, ctx, { txId: tid(), ...data });

test.before(setup);

// ---------------------------------------------------------------- 资格
test("1/2 新会员有资格；活动开始前注册的旧会员没有，也不写任何资料", async () => {
  const fresh = await newMember();
  const m = (await db.collection("members").doc(fresh.uid).get()).data();
  assert.equal(m.nmr.eligible, true);

  const old = await newMember({ createdAt: T0 - 30 * DAY });
  const o = (await db.collection("members").doc(old.uid).get()).data();
  assert.equal(o.nmr, undefined, "旧会员不应该被写入 nmr");
  await rejects(core.nmRedeem(db, at(old.ctx, T0 + 2 * DAY), { txId: tid() }), "nm/not-eligible");
});

test("3 关闭弹窗只记录一次", async () => {
  const m = await newMember();
  await core.nmDismissPopup(db, at(m.ctx, T0 + 2 * DAY), { source: "card" });
  await core.nmDismissPopup(db, at(m.ctx, T0 + 3 * DAY), {});
  const n = (await db.collection("members").doc(m.uid).get()).data().nmr;
  assert.equal(n.popupSeenAt.toMillis(), T0 + 2 * DAY);
  assert.equal(n.source, "card");
});

// ---------------------------------------------------------------- 兑换
test("7 30 分可兑换；批准后扣 30 分，开始 20 天倒数", async () => {
  const m = await newMember();
  const t = T0 + 2 * DAY;
  const r = await core.nmRedeem(db, at(m.ctx, t), { txId: tid() });
  assert.equal(r.status, "pending_approval");
  const red = (await db.collection("redemptions").doc("nm_" + r.rid).get()).data();
  assert.equal(red.status, "pending");
  assert.equal(red.newMember, true);
  assert.equal(sum(await ledgerOf(m.uid)), 30, "批准前不扣分");

  const ta = t + 3600000;
  const a = await admin("nmApprove", at(OWNER, ta), { rid: r.rid });
  assert.equal(a.status, "pending_order");
  assert.equal(sum(await ledgerOf(m.uid)), 0);
  const rw = await reward(r.rid);
  assert.equal(rw.deadline.toMillis(), ta + 20 * DAY);
  assert.equal(rw.rule.cost, 30);
  const mem = (await db.collection("members").doc(m.uid).get()).data();
  assert.equal(mem.nmr.status, "pending_order");
});

test("积分不足、没绑定都不能兑换", async () => {
  const poor = await newMember({ points: 20 });
  await rejects(core.nmRedeem(db, at(poor.ctx, T0 + 2 * DAY), { txId: tid() }), "nm/insufficient");
  const noBind = await newMember({ binds: [] });
  await rejects(core.nmRedeem(db, at(noBind.ctx, T0 + 2 * DAY), { txId: tid() }), "nm/need-bind");
});

test("8 重复点击：同一个 txId 只执行一次；同时按两次只会成功一笔", async () => {
  const m = await newMember();
  const t = T0 + 2 * DAY;
  const id = tid();
  const a = await core.nmRedeem(db, at(m.ctx, t), { txId: id });
  const b = await core.nmRedeem(db, at(m.ctx, t), { txId: id });
  assert.equal(b.replay, true);
  assert.equal(a.rid, b.rid);

  const m2 = await newMember();
  const results = await Promise.allSettled([
    core.nmRedeem(db, at(m2.ctx, t), { txId: tid() }),
    core.nmRedeem(db, at(m2.ctx, t), { txId: tid() }),
  ]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const s = await db.collection("newMemberRewards").where("uid", "==", m2.uid).get();
  assert.equal(s.size, 1);
  const reds = await db.collection("redemptions").where("uid", "==", m2.uid).get();
  assert.equal(reds.size, 1);
});

test("每人只能兑换一次（含批准后取消退分）；批准前自己取消的可以再换", async () => {
  const m = await newMember();
  const t = T0 + 2 * DAY;
  const r1 = await core.nmRedeem(db, at(m.ctx, t), { txId: tid() });
  await core.nmMemberCancel(db, at(m.ctx, t + 1000), { txId: tid(), rid: r1.rid });
  const r2 = await core.nmRedeem(db, at(m.ctx, t + 2000), { txId: tid() });
  assert.notEqual(r1.rid, r2.rid);
  await admin("nmApprove", at(OWNER, t + 3000), { rid: r2.rid });
  await admin("nmCancelReward", at(OWNER, t + 4000), { rid: r2.rid, refund: true, reason: "测试" });
  await rejects(core.nmRedeem(db, at(m.ctx, t + 5000), { txId: tid() }), "nm/limit");
});

// ---------------------------------------------------------------- 订单
async function approved(opts) {
  const m = await newMember(opts);
  const t = T0 + 2 * DAY;
  const r = await core.nmRedeem(db, at(m.ctx, t), { txId: tid() });
  await admin("nmApprove", at(OWNER, t + 1000), { rid: r.rid });
  return { m, rid: r.rid, t: t + 1000 };
}

test("9 / 16 期限内、任何一个已绑定账号的新订单都会成为候选，确认后待打包", async () => {
  const { m, rid, t } = await approved({ binds: [["shopee"], ["tiktok"]] });
  const tik = m.accounts.find(a => a.platform === "tiktok");
  const o = await addOrder(m, tik, t + 5 * DAY);
  const res = await core.onOrderWritten(db, o.no, null, o.data, { now: t + 5 * DAY + 600000 });
  assert.equal(res.added, true);
  let rw = await reward(rid);
  assert.equal(rw.status, "order_review");
  assert.equal(rw.candidates[0].orderNo, o.no);

  await admin("nmConfirmOrder", at(OWNER, t + 6 * DAY), { rid, orderNo: o.no });
  rw = await reward(rid);
  assert.equal(rw.status, "ready_to_pack");
  assert.equal(rw.linkedOrder.orderNo, o.no);
  const lock = await db.collection("nmrOrderLocks").doc(o.no).get();
  assert.equal(lock.data().rid, rid);
});

test("兑换前的订单、没绑定的账号、取消的订单都不算", async () => {
  const { m, rid, t } = await approved();
  const old = await addOrder(m, m.accounts[0], T0 + DAY);   // 兑换前
  assert.equal((await core.onOrderWritten(db, old.no, null, old.data, { now: t + DAY })).skipped, "no-change");
  const stranger = await addOrder(m, { platform: "shopee", username: "notmine" + rnd() }, t + DAY);
  assert.equal((await core.onOrderWritten(db, stranger.no, null, stranger.data, { now: t + DAY })).skipped, "no-change");
  const cancelled = await addOrder(m, m.accounts[0], t + DAY, { status: "refunded" });
  assert.equal((await core.onOrderWritten(db, cancelled.no, null, cancelled.data, { now: t + DAY })).skipped, "no-change");
  assert.equal((await reward(rid)).status, "pending_order");
});

test("候选订单后来被取消 / 退货：自动移除，回到等待订单", async () => {
  const { m, rid, t } = await approved();
  const o = await addOrder(m, m.accounts[0], t + 2 * DAY);
  await core.onOrderWritten(db, o.no, null, o.data, { now: t + 2 * DAY });
  assert.equal((await reward(rid)).status, "order_review");
  const after = { ...o.data, status: "refunded" };
  await db.collection("orders").doc(o.no).set(after);
  const res = await core.onOrderWritten(db, o.no, o.data, after, { now: t + 3 * DAY });
  assert.equal(res.removed, true);
  assert.equal((await reward(rid)).status, "pending_order");
});

test("10 / 11 第 20 天下单、第 22 天才同步：先自动逾期，同步后仍可审核", async () => {
  const { m, rid, t } = await approved();
  const r = await core.daily(db, { now: t + 21 * DAY });
  assert.ok(r.expired >= 1);
  let rw = await reward(rid);
  assert.equal(rw.status, "expired_review");
  assert.equal(sum(await ledgerOf(m.uid)), 0, "逾期不能没收或退回积分");
  const red = (await db.collection("redemptions").doc("nm_" + rid).get()).data();
  assert.equal(red.status, "approved", "会员兑换记录不显示已取消");

  const o = await addOrder(m, m.accounts[0], t + 20 * DAY - 3600000);   // 截止前 1 小时下单
  await core.onOrderWritten(db, o.no, null, o.data, { now: t + 22 * DAY });
  rw = await reward(rid);
  assert.equal(rw.status, "order_review");
  assert.equal(rw.candidates[0].orderNo, o.no);
});

test("12 延期：逾期后延 7 天回到等待订单，原因必填", async () => {
  const { rid, t } = await approved();
  await core.daily(db, { now: t + 21 * DAY });
  await rejects(admin("nmExtend", at(OWNER, t + 22 * DAY), { rid, days: 7, reason: "" }), "nm/reason-required");
  const r = await admin("nmExtend", at(OWNER, t + 22 * DAY), { rid, days: 7, reason: "会员要求" });
  assert.equal(r.status, "pending_order");
  const rw = await reward(rid);
  assert.equal(rw.deadline.toMillis(), t + 29 * DAY);
  assert.equal(rw.originalDeadline.toMillis(), t + 20 * DAY);
  const h = await db.collection("newMemberRewards").doc(rid).collection("history").where("action", "==", "extend").get();
  assert.equal(h.size, 1);
  assert.equal(h.docs[0].data().by, core.OWNER_EMAIL);
});

test("到期前提醒只发一次", async () => {
  const { m, t } = await approved();
  await core.daily(db, { now: t + 16 * DAY });
  await core.daily(db, { now: t + 17 * DAY });
  const msgs = await db.collection("memberMessages").where("uids", "array-contains", m.uid).get();
  assert.equal(msgs.size, 1);
  assert.ok(msgs.docs[0].data().i18n.en.title);
});

// ---------------------------------------------------------------- 取消、退分
test("13 / 14 取消并退分只会退一次", async () => {
  const { m, rid, t } = await approved();
  const id = tid();
  await core.nmCancelReward(db, at(OWNER, t + DAY), { txId: id, rid, refund: true, reason: "会员要求取消" });
  await core.nmCancelReward(db, at(OWNER, t + DAY), { txId: id, rid, refund: true, reason: "会员要求取消" });   // 重送
  await rejects(admin("nmCancelReward", at(OWNER, t + DAY), { rid, refund: true, reason: "再按一次" }), "nm/bad-move");
  await rejects(admin("nmRefund", at(OWNER, t + DAY), { rid, reason: "再退一次" }), "nm/bad-move");
  const l = await ledgerOf(m.uid);
  assert.equal(sum(l), 30);
  assert.equal(l.filter(x => x.id.startsWith("nmr_refund_")).length, 1);
  assert.equal((await reward(rid)).status, "refunded");
});

test("先取消不退分，之后补退分一次", async () => {
  const { m, rid, t } = await approved();
  await admin("nmCancelReward", at(OWNER, t + DAY), { rid, refund: false, reason: "违规" });
  assert.equal(sum(await ledgerOf(m.uid)), 0);
  await admin("nmRefund", at(OWNER, t + 2 * DAY), { rid, reason: "改为退分" });
  await rejects(admin("nmRefund", at(OWNER, t + 2 * DAY), { rid, reason: "再退" }), "nm/bad-move");
  assert.equal(sum(await ledgerOf(m.uid)), 30);
});

test("拒绝待批准的兑换：不扣分、库存退回", async () => {
  const before = (await db.doc("settings/newMember").get()).data().stock;
  const m = await newMember();
  const r = await core.nmRedeem(db, at(m.ctx, T0 + 2 * DAY), { txId: tid() });
  assert.equal((await db.doc("settings/newMember").get()).data().stock, before - 1);
  await admin("nmReject", at(OWNER, T0 + 3 * DAY), { rid: r.rid, reason: "测试拒绝" });
  assert.equal((await db.doc("settings/newMember").get()).data().stock, before);
  assert.equal(sum(await ledgerOf(m.uid)), 30);
  const red = (await db.collection("redemptions").doc("nm_" + r.rid).get()).data();
  assert.equal(red.status, "rejected");
});

// ---------------------------------------------------------------- 寄送
test("15 已寄出不能再寄、不能取消、不能改回等待订单", async () => {
  const { m, rid, t } = await approved();
  const o = await addOrder(m, m.accounts[0], t + DAY);
  await core.onOrderWritten(db, o.no, null, o.data, { now: t + DAY });
  await admin("nmConfirmOrder", at(OWNER, t + 2 * DAY), { rid, orderNo: o.no });
  await rejects(admin("nmShipped", at(OWNER, t + 2 * DAY), { rid }), "nm/bad-move");   // 要先打包
  await admin("nmPacked", at(OWNER, t + 2 * DAY), { rid });
  await admin("nmShipped", at(OWNER, t + 3 * DAY), { rid });
  await rejects(admin("nmShipped", at(OWNER, t + 3 * DAY), { rid }), "nm/bad-move");
  await rejects(admin("nmCancelReward", at(OWNER, t + 3 * DAY), { rid, refund: true, reason: "x" }), "nm/bad-move");
  await rejects(admin("nmException", at(OWNER, t + 3 * DAY), { rid, to: "pending_order", reason: "x" }), "nm/bad-move");
  const red = (await db.collection("redemptions").doc("nm_" + rid).get()).data();
  assert.equal(red.status, "shipped");
  assert.equal(red.shipping.withOrder, true);
  assert.equal(red.shipping.orderNo, o.no);
});

test("关联订单被平台取消：只标记，不自动改状态", async () => {
  const { m, rid, t } = await approved();
  const o = await addOrder(m, m.accounts[0], t + DAY);
  await core.onOrderWritten(db, o.no, null, o.data, { now: t + DAY });
  await admin("nmConfirmOrder", at(OWNER, t + 2 * DAY), { rid, orderNo: o.no });
  const after = { ...o.data, status: "refunded" };
  await db.collection("orders").doc(o.no).set(after);
  await core.onOrderWritten(db, o.no, o.data, after, { now: t + 3 * DAY });
  const rw = await reward(rid);
  assert.equal(rw.status, "ready_to_pack");
  assert.equal(rw.orderIssue.type, "order-refunded");
});

test("手动关联：超过期限要勾选「忽略期限」并填原因", async () => {
  const { m, rid, t } = await approved();
  const late = await addOrder(m, m.accounts[0], t + 25 * DAY);
  await rejects(admin("nmLinkOrder", at(OWNER, t + 26 * DAY), { rid, orderNo: late.no }), "nm/order-after-deadline");
  await rejects(admin("nmLinkOrder", at(OWNER, t + 26 * DAY), { rid, orderNo: late.no, ignoreDeadline: true }), "nm/reason-required");
  await admin("nmLinkOrder", at(OWNER, t + 26 * DAY), { rid, orderNo: late.no, ignoreDeadline: true, reason: "客服同意" });
  await admin("nmConfirmOrder", at(OWNER, t + 26 * DAY), { rid, orderNo: late.no });
  assert.equal((await reward(rid)).status, "ready_to_pack");
});

// ---------------------------------------------------------------- 权限、设定
test("权限：会员、没有权限的管理员都不能操作；有「新会员奖励」子权限可以；异常处理只有店主", async () => {
  const { m, rid, t } = await approved();
  await rejects(admin("nmExtend", at(m.ctx, t), { rid, days: 7, reason: "x" }), "nm/no-perm");
  const noPerm = { uid: "staffA01", email: "a" + rnd() + "@staff.test", emailVerified: true };
  await db.collection("staff").doc(noPerm.email).set({ active: true, perms: { member: { redeem: true } } });
  await rejects(admin("nmExtend", at(noPerm, t), { rid, days: 7, reason: "x" }), "nm/no-perm");
  const ok = { uid: "staffB01", email: "b" + rnd() + "@staff.test", emailVerified: true };
  await db.collection("staff").doc(ok.email).set({ active: true, perms: { member: { newMember: true } } });
  await admin("nmExtend", at(ok, t), { rid, days: 7, reason: "员工延期" });
  await rejects(admin("nmException", at(ok, t), { rid, to: "cancelled", reason: "x" }), "nm/owner-only");
  await rejects(core.nmSaveSettings(db, at(ok, t), { settings: { cost: 1 } }), "nm/owner-only");
  const off = { uid: "staffC01", email: "c" + rnd() + "@staff.test", emailVerified: true };
  await db.collection("staff").doc(off.email).set({ active: false, perms: { member: true } });
  await rejects(admin("nmExtend", at(off, t), { rid, days: 7, reason: "x" }), "nm/no-perm");
});

test("修改设定不影响已兑换的纪录（规则快照）；startAt 只写一次", async () => {
  const { rid } = await approved();
  const s0 = (await db.doc("settings/newMember").get()).data();
  await core.nmSaveSettings(db, at(OWNER, T0 + 50 * DAY), { settings: { cost: 50, validDays: 10, active: true } });
  const s1 = (await db.doc("settings/newMember").get()).data();
  assert.equal(s1.startAt.toMillis(), s0.startAt.toMillis());
  assert.equal(s1.version, s0.version + 1);
  const rw = await reward(rid);
  assert.equal(rw.cost, 30);
  assert.equal(rw.rule.validDays, 20);
  await core.nmSaveSettings(db, at(OWNER, T0 + 50 * DAY), { settings: { cost: 30, validDays: 20 } });
  await rejects(core.nmSaveSettings(db, at(OWNER, T0), { settings: { cost: -5 } }), "nm/bad-setting");
});

test("活动暂停：不能新兑换，但已兑换的仍可由管理员处理", async () => {
  const { rid, t } = await approved();
  await core.nmSaveSettings(db, at(OWNER, t), { settings: { active: false } });
  try {
    const m = await newMember();
    await rejects(core.nmRedeem(db, at(m.ctx, t), { txId: tid() }), "nm/inactive");
    await admin("nmExtend", at(OWNER, t), { rid, days: 14, reason: "暂停期间处理" });
  } finally {
    await core.nmSaveSettings(db, at(OWNER, t), { settings: { active: true } });
  }
});

test("内部会员可以测试兑换：不用绑定、标记 test、不扣库存", async () => {
  const before = (await db.doc("settings/newMember").get()).data().stock;
  const m = await newMember({ binds: [], internal: true, createdAt: T0 - 90 * DAY });
  const r = await core.nmRedeem(db, at(m.ctx, T0 + 2 * DAY), { txId: tid() });
  assert.equal((await reward(r.rid)).test, true);
  assert.equal((await db.doc("settings/newMember").get()).data().stock, before);
});
