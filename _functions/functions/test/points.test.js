// 💰 积分与会员等级测试（不用模拟器：记忆体里的假资料库）
//   node --test test/points.test.js
//   规则逐条对照 Apps Script member-system-sync.gs（msSyncPointsCore_ / msNextTier_ / msBirthdayRewards / msExpirePoints_）
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const pt = require("../src/points");

// ---------- 假资料库：doc get/set(merge)/update/create/delete、where（== > >= < <= in）+ limit、transaction ----------
const val = v => (v && typeof v.toMillis === "function" ? v.toMillis() : v);
const pathGet = (o, f) => f.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));
  const snapOf = r => { const d = data.get(r.path); return { exists: d !== undefined, data: () => d, id: r.id, ref: r }; };
  const test = (d, [f, op, v]) => {
    const x = val(pathGet(d, f)), y = val(v);
    if (op === "==") return x === y;
    if (op === "in") return y.includes(x);
    if (x == null) return false;
    return op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : op === "<=" ? x <= y : false;
  };
  const run = q => {
    let docs = [...data.entries()].filter(([k]) => k.split("/").length === 2 && k.startsWith(q.col + "/"))
      .filter(([, d]) => q.conds.every(c => test(d, c))).map(([k]) => snapOf(ref(k)));
    if (q.n != null) docs = docs.slice(0, q.n);
    return { empty: !docs.length, docs, size: docs.length };
  };
  const query = (col, conds = [], n = null) => ({
    kind: "query", col, conds, n,
    where: (f, op, v) => query(col, [...conds, [f, op, v]], n),
    limit: k => query(col, conds, k),
    get: async () => run({ col, conds, n }),
  });
  function ref(path) {
    const r = { kind: "doc", path, id: path.split("/").pop(),
      get: async () => snapOf(r),
      set: async (d, o) => { data.set(path, o && o.merge ? { ...(data.get(path) || {}), ...d } : d); },
      update: async d => { if (!data.has(path)) throw new Error("NOT_FOUND " + path);
        const n = { ...data.get(path), ...d }; Object.keys(d).forEach(k => { if (FieldValue.delete().isEqual(d[k])) delete n[k]; }); data.set(path, n); },
      create: async d => { if (data.has(path)) throw new Error("ALREADY_EXISTS " + path); data.set(path, d); },
      delete: async () => { data.delete(path); } };
    return r;
  }
  return {
    data,
    collection: col => ({ doc: id => ref(col + "/" + id), ...query(col) }),
    async runTransaction(fn) {
      const w = [];
      const tx = { get: async r => snapOf(r), set: (r, d) => w.push(() => data.set(r.path, d)),
        update: (r, d) => w.push(() => data.set(r.path, { ...data.get(r.path), ...d })) };
      const out = await fn(tx);
      w.forEach(f => f());
      return out;
    },
  };
}

const DAY = 86400000;
const T0 = Date.parse("2026-11-20T12:00:00+08:00");
const ts = ms => Timestamp.fromMillis(ms);
const ctx = (extra = {}) => ({ now: T0, noCache: true, ...extra });
const OWNER = { uid: "o", email: "mail@themochiishop.com", emailVerified: true, now: T0, noCache: true };
const ledger = db => [...db.data.entries()].filter(([k]) => k.startsWith("pointsLedger/")).map(([k, d]) => ({ id: k.split("/")[1], ...d }));
const cfgP = db => pt.loadCfg(db, ctx());
const on = { "pointsMeta/engine": { on: true } };
const order = (no, x) => ({ ["orders/" + no]: { platform: "shopee", username: "aqmar", amount: 100, status: "active", completed: false, orderTime: ts(T0 - DAY), ...x } });

test.beforeEach(() => pt._reset());

// ---------------------------------------------------------------- 等级规则（msNextTier_）
test("等级：升级马上生效 12 个月；到期达一半保级；不到一半只降一级；Mochii 只续期", async () => {
  const cfg = await cfgP(fakeDb());
  const now = T0;
  let r = pt.nextTier(cfg, {}, 50, now);
  assert.equal(r.tier.id, "mochii"); assert.equal(r.expires, new Date(now).setMonth(new Date(now).getMonth() + 12)); assert.equal(r.event, null);
  r = pt.nextTier(cfg, { tier: "mochii", tierExpires: ts(now + DAY) }, 850, now);
  assert.equal(r.tier.id, "gold"); assert.equal(r.event.type, "up"); assert.equal(r.since, now);
  r = pt.nextTier(cfg, { tier: "gold", tierExpires: ts(now - 1), tierSince: ts(now - 400 * DAY) }, 400, now);   // 400 ≥ 800×0.5
  assert.equal(r.tier.id, "gold"); assert.equal(r.event.type, "keep");
  r = pt.nextTier(cfg, { tier: "diamond", tierExpires: ts(now - 1) }, 10, now);                                  // 只降一级
  assert.equal(r.tier.id, "gold"); assert.equal(r.event.type, "down"); assert.equal(r.best, "diamond");
  r = pt.nextTier(cfg, { tier: "silver", tierExpires: ts(now + DAY) }, 0, now);                                  // 还没到期：不变
  assert.equal(r.tier.id, "silver"); assert.equal(r.event, null);
  r = pt.nextTier(cfg, { tier: "silver", blackElite: { on: true } }, 0, now);
  assert.equal(r.tier.id, "black"); assert.equal(r.expires, null); assert.equal(r.event.type, "up");
  r = pt.nextTier(cfg, { tier: "black" }, 900, now);                                                              // 取消邀请：按消费
  assert.equal(r.tier.id, "gold"); assert.equal(r.event.type, "down");
  r = pt.nextTier(cfg, { tier: "mochii", tierExpires: ts(now - 1) }, 0, now);
  assert.equal(r.tier.id, "mochii"); assert.equal(r.event, null); assert.ok(r.expires > now);
});

test("等级设定读后台 settings/perks（门槛、倍数、生日）", async () => {
  const db = fakeDb({ "settings/perks": { tiers: { silver: { minSpend: 200, multiplier: 1.3, birthday: 150 }, black: { minSpend: 1 } }, tierRules: { keepRatio: 0.6 } } });
  const cfg = await cfgP(db);
  const s = cfg.tiers.find(t => t.id === "silver");
  assert.deepEqual([s.minSpend, s.multiplier, s.birthday], [200, 1.3, 150]);
  assert.equal(cfg.tiers.find(t => t.id === "black").minSpend, Infinity);   // 邀请制不改门槛
  assert.equal(cfg.rules.keepRatio, 0.6);
});

// ---------------------------------------------------------------- 一张订单
test("新订单：绑定会员 → 积分 + 记录（固定编号，重跑不重复）；没绑定 → 不写", async () => {
  const db = fakeDb({ ...on, "members/u1": { name: "A" }, "bindings/shopee_aqmar": { uid: "u1" },
    ...order("2611010000001", {}), ...order("2611010000002", { username: "stranger" }) });
  const cfg = await cfgP(db);
  await pt.processOrder(db, ctx(), cfg, "2611010000001");
  const o = db.data.get("orders/2611010000001");
  assert.equal(o.uid, "u1"); assert.equal(o.points, 100); assert.equal(o.multiplier, 1); assert.equal(o.ptSeq, 1);
  assert.equal(o.availableAt.toMillis(), T0 - DAY + 14 * DAY);
  let L = ledger(db);
  assert.equal(L.length, 1); assert.equal(L[0].id, "po_2611010000001_1"); assert.equal(L[0].delta, 100); assert.equal(L[0].reason, "购物积分");
  await pt.processOrder(db, ctx(), cfg, "2611010000001");   // 再跑一次：不变
  assert.equal(ledger(db).length, 1);
  await pt.processOrder(db, ctx(), cfg, "2611010000002");
  assert.equal(db.data.get("orders/2611010000002").uid, undefined);   // 非会员的单不写
  const m = db.data.get("members/u1");
  assert.equal(m.tier, "mochii"); assert.equal(m.spend12m, 100); assert.ok(m.tierExpires);
});

test("这张单让会员升级：用升级后的倍数（和 Apps Script 同一轮先算等级一样）；铃铛有升级事件", async () => {
  const db = fakeDb({ ...on, "members/u1": {}, "bindings/shopee_aqmar": { uid: "u1" },
    "orders/2610010000001": { platform: "shopee", username: "aqmar", amount: 250, status: "active", orderTime: ts(T0 - 30 * DAY), uid: "u1", points: 250, multiplier: 1, availableAt: ts(T0 - 16 * DAY) },
    ...order("2611010000009", { amount: 60 }) });
  await pt.processOrder(db, ctx(), await cfgP(db), "2611010000009");
  const m = db.data.get("members/u1");
  assert.equal(m.tier, "silver"); assert.equal(m.spend12m, 310); assert.equal(m.tierEvent.type, "up");
  const o = db.data.get("orders/2611010000009");
  assert.equal(o.multiplier, 1.2); assert.equal(o.points, 72);
  assert.equal(ledger(db)[0].reason, "购物积分（银卡 ×1.2）");
  assert.equal(db.data.get("orders/2610010000001").points, 250);   // 已给过分的单不受影响
});

test("改金额 → 订单金额更正；取消 / 退货 → 扣回；改成已完成 → 可用时间提早，以前的记录一起改", async () => {
  const db = fakeDb({ ...on, "members/u1": {}, "bindings/shopee_aqmar": { uid: "u1" }, ...order("2611010000001", {}) });
  const cfg = await cfgP(db);
  await pt.processOrder(db, ctx(), cfg, "2611010000001");
  db.data.set("orders/2611010000001", { ...db.data.get("orders/2611010000001"), amount: 80 });
  await pt.processOrder(db, ctx(), cfg, "2611010000001");
  let L = ledger(db).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(L[1].id, "po_2611010000001_2"); assert.equal(L[1].delta, -20); assert.equal(L[1].reason, "订单金额更正");
  const done = T0 - 12 * 3600000;
  db.data.set("orders/2611010000001", { ...db.data.get("orders/2611010000001"), completed: true, completedAt: ts(done) });
  await pt.processOrder(db, ctx(), cfg, "2611010000001");
  assert.equal(db.data.get("orders/2611010000001").availableAt.toMillis(), done);
  assert.ok(ledger(db).every(x => x.availableAt.toMillis() === done));
  db.data.set("orders/2611010000001", { ...db.data.get("orders/2611010000001"), status: "refunded" });
  await pt.processOrder(db, ctx(), cfg, "2611010000001");
  L = ledger(db).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(L.at(-1).delta, -80); assert.equal(L.at(-1).reason, "订单取消/退货");
  assert.equal(L.reduce((s, x) => s + x.delta, 0), 0);
  assert.equal(db.data.get("orders/2611010000001").points, 0);
  assert.equal(db.data.get("members/u1").spend12m, 0);   // 取消的单不算消费
});

test("绑定：新绑定 → 那个账号的旧单归给会员；解绑 → 订单转出", async () => {
  const db = fakeDb({ ...on, "members/u1": {}, ...order("2611010000001", {}), ...order("2611010000002", { amount: 50 }),
    ...order("587000000000000003", { platform: "tiktok" }) });
  await pt.onBinding(db, "shopee_aqmar", null, { uid: "u1", platform: "shopee", username: "aqmar" }, ctx());
  db.data.set("bindings/shopee_aqmar", { uid: "u1", platform: "shopee", username: "aqmar" });   // （真的触发器在写入之后）
  pt._reset();
  await pt.onBinding(db, "shopee_aqmar", null, { uid: "u1", platform: "shopee", username: "aqmar" }, ctx());
  assert.equal(ledger(db).reduce((s, x) => s + x.delta, 0), 150);
  assert.equal(db.data.get("orders/587000000000000003").uid, undefined);   // 别的平台不算
  db.data.delete("bindings/shopee_aqmar");
  await pt.onBinding(db, "shopee_aqmar", { uid: "u1", platform: "shopee", username: "aqmar" }, null, ctx());
  const out = ledger(db).filter(x => x.reason === "订单转出");
  assert.equal(out.length, 2); assert.equal(ledger(db).reduce((s, x) => s + x.delta, 0), 0);
  assert.equal(db.data.get("members/u1").spend12m, 0);
});

test("订单触发器：开关关着不动；只有影响积分的栏位改了才算", async () => {
  const db = fakeDb({ "members/u1": {}, "bindings/shopee_aqmar": { uid: "u1" }, ...order("2611010000001", {}) });
  const o = db.data.get("orders/2611010000001");
  assert.deepEqual(await pt.onOrder(db, "2611010000001", null, o, ctx()), { off: true });
  assert.equal(ledger(db).length, 0);
  db.data.set("pointsMeta/engine", { on: true }); pt._reset();
  await pt.onOrder(db, "2611010000001", null, o, ctx());
  assert.equal(ledger(db).length, 1);
  const after = db.data.get("orders/2611010000001");
  assert.deepEqual(await pt.onOrder(db, "2611010000001", o, after, ctx()), { same: true });   // 触发器自己写回的那一次
});

// ---------------------------------------------------------------- 余额
test("余额 members.bal：和网页算法一样（可用 − 审核中；未到期的另外列）", async () => {
  const db = fakeDb({ ...on, "members/u1": {},
    "pointsLedger/a": { uid: "u1", delta: 100, availableAt: ts(T0 - DAY) },
    "pointsLedger/b": { uid: "u1", delta: 40, availableAt: ts(T0 + 5 * DAY) },
    "pointsLedger/c": { uid: "u1", delta: -30, availableAt: ts(T0 - DAY) },
    "redemptions/r1": { uid: "u1", status: "pending", cost: 20 }, "redemptions/r2": { uid: "u1", status: "approved", cost: 999 } });
  await pt.onLedger(db, null, { uid: "u1" }, ctx());
  const b = db.data.get("members/u1").bal;
  assert.equal(b.sum, 110); assert.equal(b.reserved, 20); assert.deepEqual(b.pend.map(p => p.d), [40]);
  const spendable = b.sum - b.pend.filter(p => p.at.toMillis() > T0).reduce((s, p) => s + p.d, 0) - b.reserved;
  assert.equal(spendable, 50);   // 100 − 30 − 20
  db.data.set("redemptions/r1", { uid: "u1", status: "rejected", cost: 20 });
  await pt.onRedemption(db, { uid: "u1", status: "pending", cost: 20 }, { uid: "u1", status: "rejected", cost: 20 }, ctx());
  assert.equal(db.data.get("members/u1").bal.reserved, 0);
  assert.deepEqual(await pt.onRedemption(db, { uid: "u1", status: "x", cost: 1 }, { uid: "u1", status: "x", cost: 1 }, ctx()), { same: true });
});

// ---------------------------------------------------------------- 生日 / 过期
test("生日：当月、有有效订单（内部会员不用）→ 每人每年一次；会员改生日时马上补发", async () => {
  const db = fakeDb({ ...on, "members/u1": { birthday: "1990-11-05", tier: "silver" }, "members/u2": { birthday: "1990-11-09" },
    "members/u3": { birthday: "1990-11-09", internal: { on: true } }, "members/u4": { birthday: "1990-12-01" },
    "orders/x1": { uid: "u1", status: "active" } });
  const cfg = await cfgP(db);
  assert.equal(await pt.birthdayFor(db, ctx(), cfg, "u1"), true);
  assert.equal(await pt.birthdayFor(db, ctx(), cfg, "u1"), false);   // 已发过
  const b = db.data.get("pointsLedger/birthday_u1_2026");
  assert.equal(b.delta, 128); assert.equal(b.reason, "🎂 生日礼物（银卡）");
  assert.equal(await pt.birthdayFor(db, ctx(), cfg, "u2"), false);   // 没有订单
  assert.equal(await pt.birthdayFor(db, ctx(), cfg, "u3"), true);    // 内部会员
  assert.equal(await pt.birthdayFor(db, ctx(), cfg, "u4"), false);   // 不是这个月
  db.data.set("orders/x2", { uid: "u2", status: "active" });
  await pt.onMember(db, "u2", { birthday: "" }, { birthday: "1990-11-09" }, ctx());
  assert.ok(db.data.get("pointsLedger/birthday_u2_2026"));
});

test("积分过期：先进先出、审核中的兑换算已用；同一天不重复扣", async () => {
  const old = new Date(T0); old.setMonth(old.getMonth() - 13);
  const db = fakeDb({ ...on,
    "pointsLedger/a": { uid: "u1", delta: 100, availableAt: ts(old.getTime()), createdAt: ts(old.getTime()) },
    "pointsLedger/b": { uid: "u1", delta: -30, availableAt: ts(T0 - 100 * DAY) },
    "pointsLedger/c": { uid: "u1", delta: 50, availableAt: ts(T0 - DAY), createdAt: ts(T0 - DAY) },
    "redemptions/r": { uid: "u1", status: "pending", cost: 20 } });
  assert.equal(await pt.expireFor(db, ctx(), "u1"), 50);   // 100 − 30 − 20 = 50 过期；新的 50 不动
  assert.equal(db.data.get("pointsLedger/expire_u1_2026-11-20").delta, -50);
  assert.equal(await pt.expireFor(db, ctx(), "u1"), 0);
  assert.deepEqual(pt.pointLots([{ delta: 10, orderNo: "o", availableAt: ts(T0) }, { delta: -10, orderNo: "o" }], 0), []);   // 同一张单先合并
});

// ---------------------------------------------------------------- 每日
test("每日：等级到期保级 / 降级、消费滑出 365 天、过期、兑换 / 中奖自动完成、中奖过期", async () => {
  const old = new Date(T0); old.setMonth(old.getMonth() - 12); old.setDate(old.getDate() - 1);
  const db = fakeDb({ ...on,
    "pointsMeta/state": { windowCut: T0 - 365 * DAY - 3 * DAY, expiryCut: old.getTime() - 3 * DAY },
    "members/g": { tier: "gold", tierExpires: ts(T0 - 1), tierSince: ts(T0 - 400 * DAY) },
    "members/w": { tier: "silver", spend12m: 300, tierExpires: ts(T0 + 100 * DAY) },
    "orders/w1": { uid: "w", status: "active", amount: 300, orderTime: ts(T0 - 366 * DAY) },
    "pointsLedger/e": { uid: "x", delta: 70, availableAt: ts(old.getTime()), createdAt: ts(old.getTime()) },
    "redemptions/s1": { status: "shipped", shippedAt: ts(T0 - 15 * DAY) },
    "redemptions/s2": { status: "shipped", shippedAt: ts(T0 - 2 * DAY) },
    "prizeWins/p1": { status: "shipped", shippedAt: ts(T0 - 20 * DAY) },
    "prizeWins/p2": { status: "unclaimed", expiresAt: ts(T0 - DAY) },
    "prizeWins/p3": { status: "unclaimed", createdAt: ts(T0 - 10 * DAY) } });
  const r = await pt.daily(db, ctx());
  assert.equal(db.data.get("members/g").tier, "silver");          // 没消费：金卡降一级
  assert.equal(db.data.get("members/g").tierEvent.type, "down");
  assert.equal(db.data.get("members/w").spend12m, 0);             // 滑出 365 天
  assert.equal(db.data.get("members/w").tier, "silver");          // 还没到期：等级不变
  assert.equal(db.data.get("pointsLedger/expire_x_2026-11-20").delta, -70);
  assert.equal(db.data.get("redemptions/s1").status, "completed"); assert.equal(db.data.get("redemptions/s2").status, "shipped");
  assert.equal(db.data.get("prizeWins/p1").status, "completed");
  assert.equal(db.data.get("prizeWins/p2").status, "cancelled"); assert.equal(db.data.get("prizeWins/p3").status, "unclaimed");
  assert.deepEqual([r.tierExpired, r.windowOut, r.expired, r.redeemDone, r.prizeDone, r.prizeExpired], [1, 1, 1, 1, 1, 1]);
  const r2 = await pt.daily(db, ctx());                            // 同一天再跑：不重复
  assert.deepEqual([r2.windowOut, r2.expired, r2.redeemDone], [0, 0, 0]);
  db.data.set("pointsMeta/engine", { on: false }); pt._reset();
  assert.deepEqual(await pt.daily(db, ctx()), { off: true });
});

// ---------------------------------------------------------------- 后台
test("后台：只有店主；比对列出不一样的；打开要先确认 Apps Script 已停，并补算余额", async () => {
  const db = fakeDb({ "members/u1": { tier: "mochii", spend12m: 0 }, "bindings/shopee_aqmar": { uid: "u1" },
    ...order("2611010000001", {}), ...order("2611010000002", { amount: 20, updatedAt: ts(T0 - 3600000) }),
    "pointsLedger/a": { uid: "u1", delta: 5, availableAt: ts(T0 - DAY) } });
  await assert.rejects(pt.ptCompare(db, { uid: "x", email: "a@b.c", emailVerified: true }), e => e.key === "pt/no-perm");
  const c = await pt.ptCompare(db, OWNER);
  assert.equal(c.total.orders, 2); assert.equal(c.diffs.orders.find(x => x.no === "2611010000001").newPoints, 100);
  assert.equal(c.total.tiers, 1);   // spend 0 → 100
  await assert.rejects(pt.ptEnable(db, OWNER, {}), e => e.key === "pt/confirm");
  await assert.rejects(pt.ptFullCheck(db, OWNER), e => e.key === "pt/off");
  const en = await pt.ptEnable(db, OWNER, { confirm: "APPS_SCRIPT_OFF" });
  assert.equal(en.members, 1); assert.equal(en.recent, 1); assert.equal(en.changed, 1);   // 最近同步的单马上补算
  assert.equal(db.data.get("members/u1").bal.sum, 25);
  assert.equal((await pt.ptStatus(db, OWNER)).on, true);
  const f = await pt.ptFullCheck(db, OWNER);
  assert.equal(f.orders, 1); assert.equal(db.data.get("members/u1").bal.sum, 125);
  const c2 = await pt.ptCompare(db, OWNER);
  assert.deepEqual(c2.total, { orders: 0, tiers: 0, bal: 0 });
  const off = await pt.ptDisable(db, OWNER);
  assert.equal((await pt.ptStatus(db, OWNER)).on, false);
  assert.equal(off.cleared, 1); assert.equal("bal" in db.data.get("members/u1"), false);   // 关掉 → 余额删掉，网页改回读积分记录
});
