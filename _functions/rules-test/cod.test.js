// Firestore 规则测试：📦 COD 商品分类（codConfig/catalog）
// 在 _functions 资料夹执行：firebase emulators:exec --only firestore --project demo-cod "cd rules-test && node --test cod.test.js"
"use strict";
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { initializeTestEnvironment, assertFails, assertSucceeds } = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } = require("firebase/firestore");

const OWNER = "mail@themochiishop.com";
let env;
test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-cod",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8") },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await setDoc(doc(db, "staff/cod@staff.test"), { active: true, perms: { cod: true } });
    await setDoc(doc(db, "staff/other@staff.test"), { active: true, perms: { invoice: true } });
    await setDoc(doc(db, "staff/off@staff.test"), { active: false, perms: { cod: true } });
  });
});
test.after(async () => { if (env) await env.cleanup(); });

const user = (email, uid) => env.authenticatedContext(uid || ("u_" + email.split("@")[0]), { email, email_verified: true }).firestore();
const owner = () => user(OWNER, "ownerUid");
const data = (email, cats) => ({
  cats, catIds: cats.map(c => c.id), channels: ["COD"], quantities: ["x1", "x2"],
  updatedAt: serverTimestamp(), updatedBy: email, updatedByName: "T",
});
const A = { id: "a", name: "Cat A", vars: ["v1"] };
const B = { id: "b", name: "Cat B", vars: [] };

test("COD 权限：可建立、可读；没权限 / 停用 / 没登录 不行", async () => {
  await assertSucceeds(setDoc(doc(user("cod@staff.test"), "codConfig/catalog"), data("cod@staff.test", [A, B])));
  await assertSucceeds(getDoc(doc(user("cod@staff.test"), "codConfig/catalog")));
  await assertFails(getDoc(doc(user("other@staff.test"), "codConfig/catalog")));
  await assertFails(getDoc(doc(user("off@staff.test"), "codConfig/catalog")));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "codConfig/catalog")));
  await assertFails(setDoc(doc(user("other@staff.test"), "codConfig/catalog"), data("other@staff.test", [A])));
});

test("非店主：可改名、加分类、加规格；不能删除分类", async () => {
  const db = user("cod@staff.test");
  await assertSucceeds(setDoc(doc(db, "codConfig/catalog"), data("cod@staff.test", [{ ...B, name: "B2" }, { ...A, vars: [] }, { id: "c", name: "C", vars: ["x"] }])));
  await assertFails(setDoc(doc(db, "codConfig/catalog"), data("cod@staff.test", [A])));
  await assertSucceeds(updateDoc(doc(db, "codConfig/catalog"), { channels: ["COD", "SPX"], updatedAt: serverTimestamp(), updatedBy: "cod@staff.test", updatedByName: "T" }));
});

test("格式检查：冒名、多余栏位、别的文件编号、删除整笔都不行", async () => {
  const db = user("cod@staff.test");
  await assertFails(setDoc(doc(db, "codConfig/catalog"), data(OWNER, [A, B, { id: "c", name: "C", vars: [] }])));
  await assertFails(setDoc(doc(db, "codConfig/catalog"), { ...data("cod@staff.test", [A, B, { id: "c", name: "C", vars: [] }]), hack: 1 }));
  await assertFails(setDoc(doc(db, "codConfig/other"), data("cod@staff.test", [A])));
  await assertFails(deleteDoc(doc(owner(), "codConfig/catalog")));
});

test("店主：可以删除分类", async () => {
  await assertSucceeds(setDoc(doc(owner(), "codConfig/catalog"), data(OWNER, [A])));
});
