// 📅 每日签到后端测试（不用模拟器：用记忆体里的假资料库）
//   node --test test/checkin.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ci = require("../src/checkin");

// ---------- 假资料库：只做签到用到的部分（doc get/create/set、where == + limit、transaction）----------
function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));   // "col/id" → 资料
  const ref = (col, id) => ({ kind: "doc", col, id, path: col + "/" + id });
  const db = {
    data,
    collection(col) {
      return {
        doc: id => ref(col, id),
        where(f, op, v) {
          const q = { kind: "query", col, f, v, n: Infinity, limit(n) { q.n = n; return q; } };
          return q;
        },
      };
    },
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(r) {
          if (r.kind === "doc") {
            const d = data.get(r.path);
            return { exists: d !== undefined, data: () => d, id: r.id };
          }
          const docs = [...data.entries()]
            .filter(([k, d]) => k.startsWith(r.col + "/") && d[r.f] === r.v)
            .slice(0, r.n).map(([k, d]) => ({ id: k.split("/")[1], data: () => d }));
          return { empty: docs.length === 0, docs };
        },
        create(r, d) { writes.push(["create", r, d]); },
        set(r, d) { writes.push(["set", r, d]); },
      };
      const out = await fn(tx);
      for (const [op, r, d] of writes) {
        if (op === "create" && data.has(r.path)) throw new Error("ALREADY_EXISTS " + r.path);
      }
      for (const [, r, d] of writes) data.set(r.path, d);
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
  assert.deepEqual(ci.ciSettings(null), { active: false, points: [1, 1, 2, 2, 3, 3, 8] });
  assert.deepEqual(ci.ciSettings({ checkin: { active: true, points: [5, 5, 5] } }).points, [1, 1, 2, 2, 3, 3, 8]);
  assert.deepEqual(ci.ciSettings({ checkin: { active: true, points: [2, 2, 2, 2, 2, 2, 20] } }), { active: true, points: [2, 2, 2, 2, 2, 2, 20] });
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
