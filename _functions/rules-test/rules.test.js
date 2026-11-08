// Firestore 规则测试（新会员奖励 + 现有欢迎礼防重复）
// 在 _functions 资料夹执行：firebase emulators:exec --only firestore --project demo-nm "cd rules-test && npm test"
"use strict";

const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp } = require("firebase/firestore");

const OWNER = "mail@themochiishop.com";
let env;

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-nm",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8") },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    const now = Timestamp.now();
    await setDoc(doc(db, "members/memA1"), { name: "A", email: "a@x.test", createdAt: now });
    await setDoc(doc(db, "members/memB1"), { name: "B", email: "b@x.test", createdAt: now });
    await setDoc(doc(db, "bindings/shopee_buyera"), { uid: "memA1", platform: "shopee", username: "buyera", verifyOrder: "x", createdAt: now });
    await setDoc(doc(db, "staff/redeem@staff.test"), { active: true, perms: { member: { redeem: true } } });
    await setDoc(doc(db, "staff/newbie@staff.test"), { active: true, perms: { member: { newMember: true } } });
    await setDoc(doc(db, "newMemberRewards/memA1_1"), { uid: "memA1", status: "pending_order" });
    await setDoc(doc(db, "newMemberRewards/memA1_1/history/h1"), { action: "note", reason: "内部备注" });
    await setDoc(doc(db, "redemptions/nm_memA1_1"), { uid: "memA1", status: "pending", cost: 30, newMember: true, nmrId: "memA1_1" });
    await setDoc(doc(db, "redemptions/normal1"), { uid: "memA1", status: "pending", cost: 30 });
  });
});
test.after(async () => { if (env) await env.cleanup(); });

const member = uid => env.authenticatedContext(uid, { email: uid + "@x.test", email_verified: true }).firestore();
const staff = email => env.authenticatedContext("s_" + email.split("@")[0], { email, email_verified: true }).firestore();
const owner = () => env.authenticatedContext("ownerUid", { email: OWNER, email_verified: true }).firestore();

test("会员：看得到自己的迎新礼，看不到别人的、看不到历史，不能写", async () => {
  await assertSucceeds(getDoc(doc(member("memA1"), "newMemberRewards/memA1_1")));
  await assertFails(getDoc(doc(member("memB1"), "newMemberRewards/memA1_1")));
  await assertFails(getDoc(doc(member("memA1"), "newMemberRewards/memA1_1/history/h1")));
  await assertFails(updateDoc(doc(member("memA1"), "newMemberRewards/memA1_1"), { status: "shipped" }));
  await assertFails(setDoc(doc(member("memA1"), "newMemberRewards/memA1_2"), { uid: "memA1", status: "pending_order" }));
});

test("后台：有「新会员奖励」权限才看得到；店主也不能直接写", async () => {
  await assertSucceeds(getDoc(doc(staff("newbie@staff.test"), "newMemberRewards/memA1_1/history/h1")));
  await assertFails(getDoc(doc(staff("redeem@staff.test"), "newMemberRewards/memA1_1")));
  await assertFails(updateDoc(doc(owner(), "newMemberRewards/memA1_1"), { status: "shipped" }));
  await assertFails(getDoc(doc(owner(), "nmrOrderLocks/X")));
  await assertFails(getDoc(doc(owner(), "nmrTx/X")));
});

test("活动设定 settings/newMember 只能由后端改；其他设定照旧", async () => {
  await assertSucceeds(getDoc(doc(member("memA1"), "settings/newMember")));
  await assertFails(setDoc(doc(owner(), "settings/newMember"), { cost: 1 }));
  await assertSucceeds(setDoc(doc(owner(), "settings/shipping"), { testOnly: true }, { merge: true }));
});

test("兑换审核权限：不能改迎新礼的兑换、不能替它加减分；一般兑换照旧", async () => {
  const s = staff("redeem@staff.test");
  await assertFails(updateDoc(doc(s, "redemptions/nm_memA1_1"), { status: "approved" }));
  await assertFails(setDoc(doc(s, "pointsLedger/x1"), { uid: "memA1", delta: 30, reason: "兑换取消退回", orderNo: null, redemptionId: "nm_memA1_1" }));
  await assertSucceeds(setDoc(doc(s, "pointsLedger/x2"), { uid: "memA1", delta: -30, reason: "兑换", orderNo: null, redemptionId: "normal1" }));
  await assertSucceeds(updateDoc(doc(s, "redemptions/normal1"), { status: "approved" }));
});

test("会员：不能直接取消迎新礼兑换、不能改自己的 nmr 资料", async () => {
  await assertFails(updateDoc(doc(member("memA1"), "redemptions/nm_memA1_1"), { status: "cancelled" }));
  await assertFails(updateDoc(doc(member("memA1"), "members/memA1"), { "nmr.eligible": true }));
});

test("4 / 5 / 6 现有欢迎礼：第一次绑定可领，之后不能再领", async () => {
  const db = member("memA1");
  const welcome = () => setDoc(doc(db, "pointsLedger/welcome_memA1"), {
    uid: "memA1", delta: 50, reason: "新会员欢迎礼", orderNo: null, bindingIds: ["shopee_buyera"],
    availableAt: serverTimestamp(), createdAt: serverTimestamp(),
  });
  await assertSucceeds(welcome());
  await assertFails(welcome());   // 第二次（解绑再绑、绑第二个账号都一样是这个文件 ID）
  // 不能用别的文件 ID 再领一次
  await assertFails(setDoc(doc(db, "pointsLedger/welcome2_memA1"), {
    uid: "memA1", delta: 50, reason: "新会员欢迎礼", orderNo: null, bindingIds: ["shopee_buyera"],
    availableAt: serverTimestamp(), createdAt: serverTimestamp(),
  }));
});
