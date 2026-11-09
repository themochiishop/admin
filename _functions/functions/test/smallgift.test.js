// 🎁 小礼物后端测试（不用模拟器：用记忆体里的假资料库）
//   node --test test/smallgift.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sg = require("../src/smallgift");

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

const OWNER = { uid: "o1", email: "mail@themochiishop.com", emailVerified: true };
const STAFF_CLAIMS = { uid: "s1", email: "Claims@x.com", emailVerified: true };
const STAFF_PACK = { uid: "s2", email: "pack@x.com", emailVerified: true };
const STAFF_NONE = { uid: "s3", email: "none@x.com", emailVerified: true };
const STAFF = {
  "staff/claims@x.com": { perms: { draw: { claims: true } } },
  "staff/pack@x.com": { perms: { pack: true } },
  "staff/none@x.com": { perms: { draw: { console: true }, member: { prizes: true } } },
};
const myt = (date, h = 12) => Date.parse(`${date}T${String(h).padStart(2, "0")}:00:00+08:00`);
const T0 = myt("2026-11-10");
const DAY = 86400000;
const gifts = db => [...db.data.entries()].filter(([k]) => k.startsWith("smallGifts/")).map(([k, d]) => ({ id: k.split("/")[1], ...d }));
const msgs = db => [...db.data.entries()].filter(([k]) => k.startsWith("memberMessages/")).map(([, d]) => d);
async function rejects(p, key) { await assert.rejects(p, e => { assert.equal(e.key, key); return true; }); }

// 会员 u1：Shopee aqmar（有订单记录）+ TikTok aqmar77（绑定）；buyer2：非会员
const SEED = {
  ...STAFF,
  "orders/2610082JN7CQR9": { username: "aqmar", platform: "shopee", uid: "u1", orderTime: T0 - 20 * DAY },
  "orders/587070631390577755": { username: "aqmar77", platform: "tiktok", orderTime: T0 - 18 * DAY },
  "bindings/tiktok_aqmar77": { uid: "u1", platform: "tiktok", username: "aqmar77" },
  "orders/261014HN714REB": { username: "buyer2", platform: "shopee", orderTime: T0 - 15 * DAY },
};
const LIST = [
  { orderNo: "2610082JN7CQR9", name: "aqmar" },
  { orderNo: "587070631390577755", name: "aqmar77" },
  { orderNo: "261014HN714REB", name: "buyer2" },
  { orderNo: "261014hn714reb ", name: "buyer2" },          // 重复（大小写、空格）
];
const create = (db, ctx, extra = {}) => sg.sgCreate(db, { ...ctx, now: T0 },
  { batchId: "20261101200000", label: "2026年11月", month: "2026-11", giftName: "小礼物 A", mode: "order", list: LIST, ...extra });

// ---------------------------------------------------------------- 建立
test("平台：5 开头 TikTok、2 开头 Shopee", () => {
  assert.equal(sg.platformOf("587070631390577755"), "tiktok");
  assert.equal(sg.platformOf("2610082JN7CQR9"), "shopee");
  assert.equal(sg.platformOf("X1"), "");
});

test("每单一份：去掉重复单号，认出会员（订单 uid / 绑定）", async () => {
  const db = fakeDb(SEED);
  const r = await create(db, OWNER);
  assert.deepEqual(r, { ok: true, count: 3, orders: 3, members: 2 });
  const g = Object.fromEntries(gifts(db).map(x => [x.orderNos[0], x]));
  assert.equal(g["2610082JN7CQR9"].uid, "u1");
  assert.equal(g["587070631390577755"].uid, "u1");                 // 靠 TikTok 绑定认出
  assert.equal(g["261014HN714REB"].uid, null);
  assert.equal(g["261014HN714REB"].status, "pending");
  assert.equal(g["261014HN714REB"].deadline.toMillis(), T0 + 30 * DAY);   // 预设 1 个月
  const b = db.data.get("smallGiftBatches/20261101200000");
  assert.equal(b.count, 3); assert.equal(b.members, 2); assert.equal(b.giftName, "小礼物 A");
});

test("每人一份：同一位会员的两个平台账号合成一份", async () => {
  const db = fakeDb(SEED);
  const r = await create(db, OWNER, { mode: "person", days: 14 });
  assert.equal(r.count, 2);
  const mine = gifts(db).find(x => x.uid === "u1");
  assert.deepEqual(mine.orderNos.sort(), ["2610082JN7CQR9", "587070631390577755"]);
  assert.equal(mine.deadline.toMillis(), T0 + 14 * DAY);
});

test("同一期不能生成两次；资料不对会挡", async () => {
  const db = fakeDb(SEED);
  await create(db, OWNER);
  await rejects(create(db, OWNER), "sg/exists");
  await rejects(create(fakeDb(SEED), OWNER, { giftName: " " }), "sg/bad-name");
  await rejects(create(fakeDb(SEED), OWNER, { mode: "x" }), "sg/bad-mode");
  await rejects(create(fakeDb(SEED), OWNER, { days: 0 }), "sg/bad-days");
  await rejects(create(fakeDb(SEED), OWNER, { list: [] }), "sg/empty");
  await rejects(create(fakeDb(SEED), OWNER, { list: [{ orderNo: "abc" }] }), "sg/empty");
  await rejects(create(fakeDb(SEED), OWNER, { batchId: "a/b" }), "sg/bad-batch");
});

test("权限：建立要「领奖追踪」；打包清单的人只能寄出 / 作废", async () => {
  const db = fakeDb(SEED);
  await rejects(create(db, STAFF_PACK), "sg/no-perm");
  await rejects(create(db, STAFF_NONE), "sg/no-perm");
  await rejects(create(db, { uid: "x" }), "sg/no-perm");
  await rejects(sg.sgCreate(db, null, {}), "sg/signin");
  await create(db, STAFF_CLAIMS);                                  // email 大小写不影响
  const id = gifts(db)[0].id;
  await sg.sgShip(db, { ...STAFF_PACK, now: T0 }, { id, orderNo: "261099AAAAAA" });
  assert.equal(db.data.get("smallGifts/" + id).sentBy, "pack@x.com");
  await rejects(sg.sgShip(db, STAFF_NONE, { id }), "sg/no-perm");
  db.data.set("staff/pack@x.com", { active: false, perms: { pack: true } });   // 停用
  await rejects(sg.sgUnship(db, STAFF_PACK, { id }), "sg/no-perm");
});

// ---------------------------------------------------------------- 寄出 / 作废 / 恢复
test("寄出 → 取消寄出；作废 → 恢复（恢复后不再自动作废）", async () => {
  const db = fakeDb(SEED);
  await create(db, OWNER);
  const id = gifts(db).find(x => x.uid === null).id;
  const ctx = { ...OWNER, now: T0 + DAY };
  await sg.sgShip(db, ctx, { id, orderNo: "261120bbbbbb" });
  let g = db.data.get("smallGifts/" + id);
  assert.equal(g.status, "sent"); assert.equal(g.sentOrder, "261120BBBBBB");
  assert.deepEqual(await sg.sgShip(db, ctx, { id }), { ok: true, already: true });
  await rejects(sg.sgVoid(db, ctx, { id }), "sg/state");
  await sg.sgUnship(db, ctx, { id });
  await sg.sgVoid(db, ctx, { id, note: "买家说不要" });
  g = db.data.get("smallGifts/" + id);
  assert.equal(g.status, "voided"); assert.equal(g.voidReason, "manual");
  await rejects(sg.sgShip(db, ctx, { id }), "sg/state");
  await sg.sgRestore(db, ctx, { id });
  g = db.data.get("smallGifts/" + id);
  assert.equal(g.status, "pending"); assert.equal(g.noExpire, true);
  const d = await sg.sgDaily(db, { now: T0 + 60 * DAY });
  assert.equal(db.data.get("smallGifts/" + id).status, "pending");
  assert.ok(d.checked >= 1);
  await rejects(sg.sgShip(db, ctx, { id: "../x" }), "sg/bad-id");
  await rejects(sg.sgShip(db, ctx, { id: "nope" }), "sg/not-found");
});

// ---------------------------------------------------------------- 每日检查
test("每日：到期前 7 天提醒会员一次；非会员不提醒", async () => {
  const db = fakeDb(SEED);
  await create(db, OWNER);
  let r = await sg.sgDaily(db, { now: T0 + 20 * DAY });
  assert.equal(r.reminded, 0);
  r = await sg.sgDaily(db, { now: T0 + 24 * DAY });
  assert.equal(r.reminded, 2);                                     // u1 的两张单
  r = await sg.sgDaily(db, { now: T0 + 25 * DAY });
  assert.equal(r.reminded, 0);                                     // 只提醒一次
  const m = msgs(db);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0].uids, ["u1"]);
  assert.match(m[0].body, /小礼物 A/);
  assert.match(m[0].body, /10\/12\/2026/);                         // 期限 = 11/10 + 30 天
  assert.ok(m[0].i18n.en.title && m[0].i18n.ms.title);
});

test("每日：期限内有新订单 → 保留；没有 → 作废并通知会员", async () => {
  const db = fakeDb(SEED);
  await create(db, OWNER);
  db.data.set("orders/261201NEWONE", { username: "aqmar", platform: "shopee", uid: "u1", orderTime: T0 + 10 * DAY });
  db.data.set("orders/261201LATE00", { username: "buyer2", platform: "shopee", orderTime: T0 + 40 * DAY });   // 过期后才下单
  const r = await sg.sgDaily(db, { now: T0 + 31 * DAY });
  assert.equal(r.hasOrder, 2);                                     // 会员 u1 两份都保留
  assert.equal(r.expired, 1);                                      // buyer2 期限内没下单
  const g = Object.fromEntries(gifts(db).map(x => [x.orderNos[0], x]));
  assert.equal(g["2610082JN7CQR9"].foundOrder, "261201NEWONE");
  assert.equal(g["261014HN714REB"].status, "voided");
  assert.equal(g["261014HN714REB"].voidReason, "expired");
  assert.equal(msgs(db).length, 0);                                // 非会员没有通知
});

test("每日：非会员靠用户名找到新订单；取消的订单和抽奖那张单不算", async () => {
  const db = fakeDb(SEED);
  await create(db, OWNER);
  db.data.set("orders/261205REFUND", { username: "buyer2", platform: "shopee", orderTime: T0 + 5 * DAY, status: "refunded" });
  db.data.set("orders/587099OTHERP", { username: "buyer2", platform: "tiktok", orderTime: T0 + 5 * DAY });   // 别的平台同名
  let r = await sg.sgDaily(db, { now: T0 + 2 * DAY });
  assert.equal(r.hasOrder, 0);
  db.data.set("orders/261206GOOD01", { username: "buyer2", platform: "shopee", orderTime: T0 + 6 * DAY });
  r = await sg.sgDaily(db, { now: T0 + 7 * DAY });
  assert.equal(r.hasOrder, 1);
});

test("每日：买家后来加入 Club → 补认会员，过期时有通知", async () => {
  const db = fakeDb(SEED);
  await create(db, OWNER);
  db.data.set("bindings/shopee_buyer2", { uid: "u9", platform: "shopee", username: "buyer2" });
  const r = await sg.sgDaily(db, { now: T0 + 31 * DAY });
  assert.equal(r.linked, 1);
  const g = gifts(db).find(x => x.orderNos[0] === "261014HN714REB");
  assert.equal(g.uid, "u9"); assert.equal(g.status, "voided");
  assert.ok(msgs(db).some(m => m.uids[0] === "u9" && /作废/.test(m.title)));
});
