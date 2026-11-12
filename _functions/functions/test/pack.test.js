// 🧺 打包清单后端测试（不用模拟器：用记忆体里的假资料库）
//   node --test test/pack.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const pk = require("../src/pack");

// ---------- 假资料库：doc / 子集合 / where（== 和 >=）/ transaction / increment / delete ----------
const INC = FieldValue.increment(1).constructor;
const cmpVal = v => (v && typeof v.toMillis === "function" ? v.toMillis() : v);
function applyPatch(old, patch) {
  const out = { ...(old || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.constructor === INC) out[k] = (Number(out[k]) || 0) + (v.operand ?? v._operand ?? 0);
    else if (k.includes(".")) { const [a, b] = k.split("."); out[a] = { ...(out[a] || {}), [b]: v }; }
    else out[k] = v;
  }
  return out;
}
let autoId = 0;
function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed));
  const depth = p => p.split("/").length;
  const snapOf = r => { const d = data.get(r.path); return { exists: d !== undefined, data: () => d, id: r.id, ref: r }; };
  const runQuery = q => {
    const docs = [...data.entries()]
      .filter(([k]) => depth(k) === depth(q.col) + 1 && k.startsWith(q.col + "/"))
      .filter(([, d]) => q.conds.every(([f, op, v]) => { const x = f.split(".").reduce((o, k) => (o == null ? o : o[k]), d); return op === "==" ? x === v : cmpVal(x) >= cmpVal(v); }))
      .map(([k]) => snapOf(ref(k)));
    return { empty: !docs.length, docs };
  };
  const coll = col => ({
    doc: id => ref(col + "/" + (id || "auto" + (++autoId))),
    async add(d) { const r = ref(col + "/auto" + (++autoId)); data.set(r.path, d); return r; },
    where(f, op, v) { const q = { kind: "query", col, conds: [[f, op, v]], where(f2, o2, v2) { q.conds.push([f2, o2, v2]); return q; }, async get() { return runQuery(q); } }; return q; },
    async get() { return runQuery({ kind: "query", col, conds: [] }); },
  });
  function ref(path) {
    const r = { kind: "doc", path, id: path.split("/").pop(),
      collection: sub => coll(path + "/" + sub),
      async get() { return snapOf(r); },
      async set(p) { data.set(path, p); },
      async update(p) { if (!data.has(path)) throw new Error("NOT_FOUND " + path); data.set(path, applyPatch(data.get(path), p)); },
      async delete() { data.delete(path); } };
    return r;
  }
  return {
    data,
    collection: coll,
    doc: p => ref(p),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(r) { return r.kind === "doc" ? snapOf(r) : runQuery(r); },
        create(r, d) { writes.push(["create", r, d]); },
        set(r, d) { writes.push(["set", r, d]); },
        update(r, d) { writes.push(["update", r, d]); },
      };
      const out = await fn(tx);
      for (const [op, r] of writes) {
        if (op === "create" && data.has(r.path)) throw new Error("ALREADY_EXISTS " + r.path);
        if (op === "update" && !data.has(r.path)) throw new Error("NOT_FOUND " + r.path);
      }
      for (const [op, r, d] of writes) data.set(r.path, op === "update" ? applyPatch(data.get(r.path), d) : d);
      return out;
    },
  };
}

const T0 = Date.parse("2026-11-20T12:00:00+08:00");
const DAY = 86400000;
const ts = ms => Timestamp.fromMillis(ms);
const OWNER = { uid: "o1", email: "mail@themochiishop.com", emailVerified: true, now: T0 };
const PACKER = { uid: "s1", email: "pack@x.com", emailVerified: true, now: T0 };
const NOBODY = { uid: "s2", email: "cs@x.com", emailVerified: true, now: T0 };
async function rejects(p, key) { await assert.rejects(p, e => { assert.equal(e.key, key); return true; }); }

// 会员 u1（aqmar / Shopee，也绑了 TikTok aqmar77）四样东西都有；非会员 buyer2 有小礼物；u3 什么都没有
const SEED = () => ({
  "staff/pack@x.com": { perms: { pack: true } },
  "staff/cs@x.com": { perms: { member: { redeem: true } } },
  "members/u1": { name: "Aqmar" },
  "members/u3": { name: "Cara" },
  "bindings/tiktok_aqmar77": { uid: "u1" },
  // 这一批的订单
  "orders/2611190000001": { username: "aqmar", platform: "shopee", uid: "u1", orderTime: ts(T0 - DAY) },
  "orders/587000000000000002": { username: "aqmar77", platform: "tiktok", orderTime: ts(T0 - 2 * DAY) },     // 靠绑定认出 u1
  "orders/2611190000003": { username: "buyer2", platform: "shopee", orderTime: ts(T0 - DAY) },
  "orders/2611190000004": { username: "cara", platform: "shopee", uid: "u3", orderTime: ts(T0 - 3 * DAY) },
  "orders/2611190000005": { username: "buyer2", platform: "shopee", orderTime: ts(T0 - DAY), status: "refunded" },   // 取消的不算
  "orders/2610010000006": { username: "old", platform: "shopee", orderTime: ts(T0 - 40 * DAY) },                     // 太早
  // 要放的东西
  "smallGifts/b__1": { status: "pending", uid: "u1", giftName: "贴纸", label: "2026年11月", deadline: ts(T0 + 20 * DAY) },
  "smallGifts/b__2": { status: "pending", uid: null, platform: "shopee", username: "buyer2", giftName: "贴纸" },
  "smallGifts/b__3": { status: "voided", uid: "u3", giftName: "贴纸" },
  "prizeWins/w1": { uid: "u1", prizeName: "手链", status: "approved", delivery: "withOrder", drawMonth: "2026年10月" },
  "prizeWins/w2": { uid: "u1", prizeName: "大公仔", status: "approved", delivery: "separate" },                  // 单独寄 → 不列
  "prizeWins/w3": { uid: "u1", prizeName: "发夹", status: "unclaimed", delivery: "withOrder" },                  // 只提醒
  "redemptions/r1": { uid: "u1", kind: "gift", rewardName: "钥匙圈", status: "approved", delivery: "withOrder", cost: 120 },
  "redemptions/r2": { uid: "u1", kind: "gift", rewardName: "盲盒", status: "pending", delivery: "withOrder", cost: 80 },   // 待审核
  "redemptions/r3": { uid: "u1", kind: "coupon", rewardName: "RM5 券", status: "approved" },                    // 优惠券不寄
  "redemptions/ci_u1_20261119": { uid: "u1", kind: "gift", rewardName: "徽章", rewardId: "rwBadge", status: "pending", ciGift: true, backorder: true, delivery: "withOrder", cost: 0 },
  "rewards/rwBadge": { stock: 5 },
  "redemptions/nm_u1_1": { uid: "u1", kind: "gift", status: "approved", newMember: true },                      // 迎新礼的兑换（走 nm）
  "newMemberRewards/uAqmar01_1": { uid: "u1", memberName: "Aqmar", status: "ready_to_pack", gift: { name: "小香包" },
    linkedOrder: { orderNo: "2611190000001" }, redemptionId: "nm_u1_1", deadline: ts(T0 + 5 * DAY) },
});

test("权限：店主和「打包清单」可以；其他人不行", async () => {
  const db = fakeDb(SEED());
  await pk.pkBatch(db, OWNER);
  await pk.pkBatch(db, PACKER);
  await rejects(pk.pkBatch(db, NOBODY), "pk/no-perm");
  await rejects(pk.pkBatch(db, { uid: "x" }), "pk/no-perm");
  await rejects(pk.pkBatch(db, null), "pk/signin");
  db.data.set("staff/pack@x.com", { active: false, perms: { pack: true } });
  await rejects(pk.pkBatch(db, PACKER), "pk/no-perm");
});

test("这一批：最近 14 天、没取消的订单；会员的东西合在一起，两个平台账号都看得到", async () => {
  const db = fakeDb(SEED());
  const r = await pk.pkBatch(db, PACKER);
  const by = Object.fromEntries(r.parcels.map(p => [p.orderNo, p]));
  assert.deepEqual(Object.keys(by).sort(), ["2611190000001", "2611190000003", "2611190000004", "587000000000000002"]);
  const a = by["2611190000001"];
  assert.equal(a.member, "Aqmar");
  assert.deepEqual(a.items.map(i => i.id).sort(),
    ["b__1", "ci_u1_20261119", "r1", "r2", "uAqmar01_1", "w1", "w3"]);
  const it = Object.fromEntries(a.items.map(i => [i.id, i]));
  assert.equal(it.w3.can, false); assert.equal(it.r2.can, false);           // 还没领 / 待审核：只提醒
  assert.equal(it.w1.can, true); assert.equal(it.ci_u1_20261119.can, true); assert.equal(it.uAqmar01_1.can, true);
  assert.equal(by["587000000000000002"].uid, "u1");                        // TikTok 单靠绑定认出同一位会员
  assert.equal(by["587000000000000002"].items.length, 6);                 // 迎新礼只在它关联的那一包
  assert.ok(!by["587000000000000002"].items.some(i => i.kind === "nm"));
  assert.deepEqual(by["2611190000003"].items.map(i => i.id), ["b__2"]);    // 非会员：平台 + 用户名
  assert.equal(by["2611190000003"].member, null);
  assert.deepEqual(by["2611190000004"].items, []);                         // 作废的小礼物不算
  // 回传资料里没有地址、电话
  assert.ok(!JSON.stringify(r).match(/address|phone/));
});

test("找单号 / 买家名；找不到也不会出错", async () => {
  const db = fakeDb(SEED());
  let r = await pk.pkLookup(db, PACKER, { orderNo: " 2610010000006 " });
  assert.equal(r.found, true); assert.deepEqual(r.parcel.items, []);
  r = await pk.pkLookup(db, PACKER, { username: "buyer2" });
  assert.equal(r.parcel.orderNo, "2611190000003");                         // 最近的一张（取消的那张时间一样，但先找到有效的也可以）
  r = await pk.pkLookup(db, PACKER, { orderNo: "2699999999999" });
  assert.equal(r.found, false);
  await rejects(pk.pkLookup(db, PACKER, { orderNo: "abc" }), "pk/bad-order");
  await rejects(pk.pkLookup(db, PACKER, {}), "pk/bad-user");
});

test("勾选：各种东西都改成已寄出，写上随哪张单；签到达人礼物（补货中）批准时扣库存", async () => {
  const db = fakeDb(SEED());
  const items = ["sg:b__1", "prize:w1", "red:r1", "red:ci_u1_20261119"].map(s => ({ kind: s.split(":")[0], id: s.split(":")[1] }));
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items, txId: "tx_abcdefgh", done: true });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(db.data.get("smallGifts/b__1").status, "sent");
  assert.equal(db.data.get("smallGifts/b__1").sentOrder, "2611190000001");
  const w = db.data.get("prizeWins/w1");
  assert.equal(w.status, "shipped"); assert.deepEqual(w.shipping, { withOrder: true, orderNo: "2611190000001", via: "pack" });
  assert.equal(db.data.get("redemptions/r1").status, "shipped");
  const ci = db.data.get("redemptions/ci_u1_20261119");
  assert.equal(ci.status, "shipped"); assert.equal(ci.backorder, false); assert.ok(ci.decidedAt);
  assert.equal(db.data.get("rewards/rwBadge").stock, 4);
  assert.ok(db.data.get("packDone/2611190000001"));                        // 这一包标记完成
  // 再勾一次：不会重复
  const again = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items, txId: "tx_abcdefgh2" });
  assert.ok(again.results.every(x => x.result === "already"));
  assert.equal(db.data.get("rewards/rwBadge").stock, 4);
  // 打包完成的单：这一批还在，但标记 done
  const b = await pk.pkBatch(db, PACKER);
  assert.equal(b.parcels.find(p => p.orderNo === "2611190000001").done, true);
});

test("勾选：待审核 / 还没领的不能勾，其他照样成功", async () => {
  const db = fakeDb(SEED());
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", txId: "tx_abcdefgh",
    items: [{ kind: "red", id: "r2" }, { kind: "prize", id: "w3" }, { kind: "prize", id: "w2" }, { kind: "sg", id: "b__1" }, { kind: "x", id: "1" }] });
  assert.equal(r.ok, false);
  const res = Object.fromEntries(r.results.map(x => [x.id, x]));
  assert.match(res.r2.error, /兑换审核/);
  assert.match(res.w3.error, /还没领取/);
  assert.match(res.w2.error, /单独寄出/);
  assert.equal(res.b__1.ok, true);
  assert.equal(res["1"].ok, false);
  assert.equal(db.data.get("redemptions/r2").status, "pending");
  assert.equal(db.data.get("packDone/2611190000001"), undefined);          // 没有 done:true 就不标记
  await rejects(pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [] }), "pk/bad-txid");
  await rejects(pk.pkShip(db, NOBODY, { orderNo: "2611190000001", items: [], txId: "tx_abcdefgh" }), "pk/no-perm");
});

test("迎新礼放错包裹：拒绝，状态不变", async () => {
  const db = fakeDb(SEED());
  const r = await pk.pkShip(db, PACKER, { orderNo: "587000000000000002", items: [{ kind: "nm", id: "uAqmar01_1" }], txId: "tx_nmwrong1" });
  assert.equal(r.ok, false);
  assert.match(r.results[0].error, /2611190000001/);
  assert.equal(db.data.get("newMemberRewards/uAqmar01_1").status, "ready_to_pack");
});

test("勾选迎新礼：走新会员奖励流程（已打包 → 已寄出），兑换和会员资料同步", async () => {
  const db = fakeDb(SEED());
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [{ kind: "nm", id: "uAqmar01_1" }], txId: "tx_nm123456" });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const n = db.data.get("newMemberRewards/uAqmar01_1");
  assert.equal(n.status, "shipped"); assert.equal(n.packedBy, undefined); assert.ok(n.packedAt && n.shippedAt);
  // 员工 email 只在后台读得到的地方（操作历史）；会员读得到的迎新礼、兑换都没有
  const hist = [...db.data.entries()].filter(([k]) => k.startsWith("newMemberRewards/uAqmar01_1/history/")).map(([, v]) => v);
  assert.ok(hist.some(h => h.action === "packed" && h.by === "pack@x.com")); assert.ok(hist.some(h => h.action === "shipped" && h.by === "pack@x.com"));
  assert.ok(!JSON.stringify(n).includes("@")); assert.ok(!JSON.stringify(db.data.get("redemptions/nm_u1_1")).includes("@"));
  const red = db.data.get("redemptions/nm_u1_1");
  assert.equal(red.status, "shipped"); assert.equal(red.shipping.orderNo, "2611190000001");
  assert.equal(db.data.get("members/u1").nmr.status, "shipped");
  assert.ok([...db.data.keys()].some(k => k.startsWith("newMemberRewards/uAqmar01_1/history/")));
});

test("迎新礼放不了：要原因；标记给管理员，其他包裹只提醒；打包记录写下没放的东西", async () => {
  const db = fakeDb(SEED());
  const ship = { carrier: "spx", carrierName: "SPX Express", trackingNo: "SPXMY0001" };
  // 没给原因：整包拒绝
  await rejects(pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [], skipped: [{ kind: "nm", id: "uAqmar01_1", title: "迎新礼" }], txId: "tx_skip0001", done: true, ship }), "pk/reason");
  assert.equal(db.data.get("packDone/2611190000001"), undefined);
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [{ kind: "sg", id: "b__1", title: "小礼物「贴纸」" }],
    skipped: [{ kind: "prize", id: "w1", title: "中奖奖品「手链」" }], nmSkip: { id: "uAqmar01_1", reason: "缺货", title: "迎新礼「小香包」" },
    txId: "tx_skip0002", done: true, ship });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const n = db.data.get("newMemberRewards/uAqmar01_1");
  assert.equal(n.status, "ready_to_pack");
  assert.equal(n.orderIssue.type, "not-packed"); assert.equal(n.orderIssue.reason, "缺货"); assert.ok(!JSON.stringify(n).includes("@"));
  const pd = db.data.get("packDone/2611190000001");
  assert.deepEqual(pd.sent.map(x => x.id), ["b__1"]);
  assert.deepEqual(pd.skipped.map(x => [x.id, x.reason || ""]), [["w1", ""], ["uAqmar01_1", "缺货"]]);
  // 打包记录
  const lg = await pk.pkLog(db, PACKER, { from: T0 - DAY, to: T0 + DAY });
  assert.equal(lg.list.length, 1); assert.equal(lg.list[0].action, "pack"); assert.equal(lg.list[0].trackingNo, "SPXMY0001");
  assert.equal(lg.list[0].skipped.length, 2);
  assert.ok(db.data.get(`packLog/${lg.list[0].id}`).expireAt.toMillis() > T0 + 89 * DAY);
  assert.equal((await pk.pkLog(db, PACKER, { orderNo: "2611190000001" })).list.length, 1);
  // 她的另一包：迎新礼只提醒，不能勾
  const b = await pk.pkBatch(db, PACKER);
  const other = b.parcels.find(p => p.orderNo === "587000000000000002");
  const it = other.items.find(i => i.kind === "nm");
  assert.equal(it.can, false); assert.equal(it.issueOrder, "2611190000001");
  assert.equal(b.parcels.find(p => p.orderNo === "2611190000001").packed.skipped.length, 2);
});

test("收工：没打包的每一包都要原因；记下这一场", async () => {
  const db = fakeDb(SEED());
  const from = T0 - 14 * DAY, to = T0 + DAY;
  await pk.pkShip(db, PACKER, { orderNo: "2611190000003", items: [], txId: "tx_fin00001", done: true });
  await rejects(pk.pkFinish(db, PACKER, { from, to, reasons: { "2611190000001": "等管理员" } }), "pk/finish-reason");
  const r = await pk.pkFinish(db, PACKER, { from, to, label: "测试场", reasons: { "2611190000001": "等管理员", "587000000000000002": "缺货", "2611190000004": "订单还没到" } });
  assert.equal(r.shift.total, 4); assert.equal(r.shift.packed, 1); assert.equal(r.shift.remaining.length, 3);
  const b = await pk.pkBatch(db, PACKER, { from, to });
  assert.equal(b.shift.byName, ""); assert.equal(b.shift.packed, 1);
  const lg = await pk.pkLog(db, PACKER, { from: T0 - DAY, to: T0 + DAY });
  assert.ok(lg.list.some(x => x.action === "finish")); assert.equal(lg.shifts.length, 1);
});

test("打包完成 / 取消打包完成", async () => {
  const db = fakeDb(SEED());
  await pk.pkDone(db, PACKER, { orderNos: ["2611190000003", "2611190000004", "bad"] });
  assert.ok(db.data.get("packDone/2611190000003"));
  assert.ok(db.data.get("packDone/2611190000004"));
  await pk.pkDone(db, PACKER, { orderNos: ["2611190000003"], undo: true });
  assert.equal(db.data.get("packDone/2611190000003"), undefined);
  await rejects(pk.pkDone(db, PACKER, { orderNos: [] }), "pk/empty");
});

test("撤销这一包：打包清单寄出的全部退回，打包完成取消；会员已确认收到的不动", async () => {
  const db = fakeDb(SEED());
  const items = ["sg:b__1", "prize:w1", "red:r1", "red:ci_u1_20261119", "nm:uAqmar01_1"].map(s => ({ kind: s.split(":")[0], id: s.split(":")[1] }));
  await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items, txId: "tx_undo1234", done: true });
  db.data.set("redemptions/r9", { uid: "u1", kind: "gift", status: "completed", shipping: { withOrder: true, orderNo: "2611190000001", via: "pack" } });
  db.data.set("redemptions/r8", { uid: "u1", kind: "gift", status: "shipped", shipping: { withOrder: true, orderNo: "2611190000001" } });   // 后台自己寄的
  const r = await pk.pkUndo(db, PACKER, { orderNo: "2611190000001" });
  assert.deepEqual(r, { ok: true, smallGifts: 1, prizes: 1, redemptions: 2, welcome: 1, kept: 1 });
  assert.equal(db.data.get("smallGifts/b__1").status, "pending");
  assert.equal(db.data.get("prizeWins/w1").status, "approved"); assert.equal(db.data.get("prizeWins/w1").shipping, null);
  assert.equal(db.data.get("redemptions/r1").status, "approved");
  assert.equal(db.data.get("redemptions/ci_u1_20261119").status, "approved");   // 签到达人礼物回到待发货（库存已扣，不再动）
  assert.equal(db.data.get("redemptions/r9").status, "completed");
  assert.equal(db.data.get("redemptions/r8").status, "shipped");
  assert.equal(db.data.get("packDone/2611190000001"), undefined);
  // 退回后这一批又看得到
  const b = await pk.pkBatch(db, PACKER);
  assert.ok(b.parcels.find(p => p.orderNo === "2611190000001").items.some(i => i.id === "w1"));
  // 撤销戳记：这一包 + 管理员操作记录
  const pb = b.parcels.find(p => p.orderNo === "2611190000001");
  assert.equal(pb.done, false); assert.equal(pb.undone.by, "pack@x.com"); assert.equal(pb.undone.returned, 4);
  const logs = [...db.data.entries()].filter(([k]) => k.startsWith("adminLog/")).map(([, v]) => v);
  assert.equal(logs.length, 1); assert.equal(logs[0].type, "pack"); assert.equal(logs[0].by, "pack@x.com");
  assert.match(logs[0].text, /撤销了打包 2611190000001.*退回 4 样.*迎新礼 1 份/);
  const lk = await pk.pkLookup(db, PACKER, { orderNo: "2611190000001" });
  assert.equal(lk.parcel.undone.by, "pack@x.com");
  await rejects(pk.pkUndo(db, NOBODY, { orderNo: "2611190000001" }), "pk/no-perm");
});

test("时间段：只列这段时间下的单；全部待寄列出每位顾客（含还没下单的会员）", async () => {
  const db = fakeDb(SEED());
  db.data.set("prizeWins/w7", { uid: "u7", prizeName: "鞋", status: "approved", delivery: "withOrder" });   // u7 还没下单
  db.data.set("members/u7", { name: "Ali" });
  const r = await pk.pkBatch(db, PACKER, { from: T0 - 1.5 * DAY, to: T0 });
  assert.deepEqual(r.parcels.map(p => p.orderNo), ["2611190000001", "2611190000003"]);   // 一天前的单；旧的到这段以外
  const ali = r.pending.find(x => x.uid === "u7");
  assert.equal(ali.member, "Ali"); assert.deepEqual(ali.items.map(i => i.id), ["w7"]);
  const b2 = r.pending.find(x => x.key.startsWith("p:"));
  assert.equal(b2.username, "buyer2"); assert.equal(b2.platform, "shopee");
  const u1 = r.pending.find(x => x.uid === "u1");
  assert.ok(u1.items.length >= 5);
  assert.deepEqual(u1.accounts, [{ platform: "tiktok", username: "aqmar77" }]);   // 绑定的平台账号（没有 platform 栏位 → 从 doc id 拿）
  assert.deepEqual(ali.accounts, []);
  const sg = u1.items.find(i => i.kind === "sg");
  assert.equal(sg.en.title, 'Small gift "贴纸"'); assert.match(sg.en.sub, /2026年11月 draw · not won · until/);
  assert.equal(sg.src, "2026年11月抽奖");
  assert.equal(u1.items.find(i => i.id === "r2").en.warn, "Approve it in Redemptions first");
  await rejects(pk.pkBatch(db, PACKER, { from: T0, to: T0 - 1 }), "pk/bad-range");
  await rejects(pk.pkBatch(db, PACKER, { from: T0 - 70 * DAY, to: T0 }), "pk/bad-range");
});

const PHOTO = "data:image/webp;base64," + "A".repeat(2000);
const SHIP = { carrier: "spx", carrierName: "SPX Express", trackingNo: " spxmy0634571606 1a", trackingUrl: "https://spx.com.my/track?SPXMY06345716061A", photo: PHOTO };
test("寄出时存运输公司、运单号、链接、照片（五种都存）", async () => {
  const db = fakeDb(SEED());
  const items = ["sg:b__1", "prize:w1", "red:r1", "red:ci_u1_20261119", "nm:uAqmar01_1"].map(s => ({ kind: s.split(":")[0], id: s.split(":")[1] }));
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items, txId: "tx_ship1234", done: true, ship: SHIP });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const want = { withOrder: true, orderNo: "2611190000001", via: "pack", carrier: "spx", carrierName: "SPX Express",
    trackingNo: "SPXMY06345716061A", trackingUrl: "https://spx.com.my/track?SPXMY06345716061A", photos: [PHOTO] };
  assert.deepEqual(db.data.get("smallGifts/b__1").shipping, want);
  assert.deepEqual(db.data.get("prizeWins/w1").shipping, want);
  assert.deepEqual(db.data.get("redemptions/r1").shipping, want);
  assert.deepEqual(db.data.get("redemptions/ci_u1_20261119").shipping, want);
  const nmRed = db.data.get("redemptions/nm_u1_1").shipping;                // 迎新礼的兑换：原本的资料 + 运单号、照片
  assert.equal(nmRed.trackingNo, "SPXMY06345716061A"); assert.deepEqual(nmRed.photos, [PHOTO]); assert.equal(nmRed.withOrder, true);
  assert.equal(db.data.get("newMemberRewards/uAqmar01_1").shipping.trackingNo, "SPXMY06345716061A");
  // 撤销：小礼物的运单资料也清掉
  await pk.pkUndo(db, PACKER, { orderNo: "2611190000001" });
  assert.equal(db.data.get("smallGifts/b__1").shipping, null);
});

test("运单资料不对会挡（整包都不寄）", async () => {
  const db = fakeDb(SEED());
  const go = ship => pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [{ kind: "sg", id: "b__1" }], txId: "tx_bad12345", ship });
  await rejects(go({ trackingUrl: "http://x.com/1" }), "pk/bad-ship");
  await rejects(go({ trackingNo: "a b<c" }), "pk/bad-ship");
  await rejects(go({ carrier: "SPX!" }), "pk/bad-ship");
  await rejects(go({ photo: "data:text/html;base64,AAAA" }), "pk/bad-ship");
  await rejects(go({ photo: "data:image/jpeg;base64," + "A".repeat(320 * 1024) }), "pk/bad-ship");
  assert.equal(db.data.get("smallGifts/b__1").status, "pending");
  // 没有运单资料也可以（页面取消「需要运单号 / 照片」时）
  const r = await go(undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(db.data.get("smallGifts/b__1").shipping, { withOrder: true, orderNo: "2611190000001", via: "pack" });
});

test("领奖追踪：用订单号对会员系统的中奖奖品；绑定的账号认成会员", async () => {
  const db = fakeDb(SEED());
  db.data.set("prizeWins/wx", { uid: "u1", orderNo: "2610218GX7FUH5", status: "shipped" });
  db.data.set("bindings/shopee_nurfatinnr", { uid: "u9" });
  db.data.set("members/u9", { name: "Fatin" });
  const r = await pk.pkClaims(db, PACKER, { items: [
    { id: "a", orderNo: "2610218gx7fuh5", username: "walinungsari" },   // 会员系统已寄出
    { id: "b", orderNo: "2611050000009", username: "NurFatinnr" },      // 没有中奖记录，但账号绑定了会员（大小写不同）
    { id: "c", orderNo: "2611050000010", username: "stranger" },        // 真的非会员
  ] });
  assert.equal(r.res.a.club, "shipped");
  assert.equal(r.res.b.club, null); assert.equal(r.res.b.uid, "u9"); assert.equal(r.res.b.member, "Fatin");
  assert.deepEqual(r.res.c, { club: null, uid: null });
  await rejects(pk.pkClaims(db, { uid: "x", email: "a@b.c", emailVerified: true }, { items: [] }), "pk/no-perm");
});

test("不用放的包裹：没有东西也能「已打包好」，记下运单号和照片", async () => {
  const db = fakeDb(SEED());
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000003", items: [], txId: "tx_empty1234", done: true, ship: SHIP });
  assert.equal(r.ok, true);
  const d = db.data.get("packDone/2611190000003");
  assert.equal(d.by, "pack@x.com"); assert.equal(d.ship.trackingNo, "SPXMY06345716061A"); assert.ok(d.ship.photo.startsWith("data:image/"));
  const b = await pk.pkBatch(db, PACKER, {});
  const p = b.parcels.find(x => x.orderNo === "2611190000003");
  assert.equal(p.done, true); assert.equal(p.packed.trackingNo, "SPXMY06345716061A"); assert.equal(p.packed.photo, true);
  assert.equal(JSON.stringify(b).includes("base64"), false);   // 照片不回传
  assert.ok((await pk.pkPhoto(db, PACKER, { orderNo: "2611190000003" })).photo.startsWith("data:image/"));   // 查看时读照片
  assert.equal((await pk.pkPhoto(db, PACKER, { orderNo: "2611190000004" })).photo, null);
  await rejects(pk.pkPhoto(db, NOBODY, { orderNo: "2611190000003" }), "pk/no-perm");
  // 没勾运单号 / 照片也可以
  await pk.pkShip(db, PACKER, { orderNo: "2611190000002", items: [], txId: "tx_empty5678", done: true });
  assert.equal(db.data.get("packDone/2611190000002").ship, undefined);
  // 撤销
  await pk.pkUndo(db, PACKER, { orderNo: "2611190000003" });
  assert.equal(db.data.get("packDone/2611190000003"), undefined);
});

test("🆕 新人卡：第一次买 = 放；买过非会员 = 建议；会员不用；30 天内放过 = 显示放在哪一包", async () => {
  const db = fakeDb({
    ...SEED(),
    // newbie：第一次买，同一场直播两单（相差 3 小时）
    "orders/2611190000101": { username: "newbie", platform: "shopee", orderTime: ts(T0 - DAY) },
    "orders/2611190000102": { username: "newbie", platform: "shopee", orderTime: ts(T0 - DAY + 3 * 3600000) },
    // regular：9 天前买过，这次又买，还不是会员
    "orders/2611100000201": { username: "regular", platform: "shopee", orderTime: ts(T0 - 9 * DAY) },
    "orders/2611190000202": { username: "regular", platform: "shopee", orderTime: ts(T0 - DAY) },
    // 同名不同平台不算同一人
    "orders/587000000000000301": { username: "newbie", platform: "tiktok", orderTime: ts(T0 - 20 * DAY) },
  });
  const nc = async no => (await pk.pkLookup(db, PACKER, { orderNo: no })).parcel.newCard;
  assert.deepEqual(await nc("2611190000101"), { level: "must" });
  assert.deepEqual(await nc("2611190000102"), { level: "must" });          // 同一场直播的第二单也算第一次
  assert.deepEqual(await nc("2611190000202"), { level: "suggest" });
  assert.equal(await nc("2611190000001"), null);                            // 会员（订单有 uid）
  assert.equal(await nc("587000000000000002"), null);                       // 会员（账号绑定）
  // buyer2 的取消单不算：只剩一单 → 第一次
  assert.deepEqual(await nc("2611190000003"), { level: "must" });

  // 放进第一包 → 第二包显示「已放在 #101」；第一包 here
  await pk.pkShip(db, PACKER, { orderNo: "2611190000101", items: [], txId: "tx_card0001", done: true, newCard: true });
  assert.equal(db.data.get("packDone/2611190000101").newCard, true);
  assert.deepEqual(await nc("2611190000101"), { level: "must", here: true });
  const other = await nc("2611190000102");
  assert.equal(other.level, "placed"); assert.equal(other.inOrder, "2611190000101");
  // 重新保存（修改运单号）没勾也保留
  await pk.pkShip(db, PACKER, { orderNo: "2611190000101", items: [], txId: "tx_card0002", done: true });
  assert.equal(db.data.get("packDone/2611190000101").newCard, true);
  // 清单（batch）结果一样，打包记录也有
  const b = await pk.pkBatch(db, PACKER, {});
  const by = no => b.parcels.find(x => x.orderNo === no);
  assert.equal(by("2611190000102").newCard.level, "placed");
  assert.equal(by("2611190000101").packed.newCard, true);
  assert.equal(by("2611190000202").newCard.level, "suggest");
  assert.equal(by("2611190000001").newCard, null);
  const log = await pk.pkLog(db, PACKER, { orderNo: "2611190000101" });
  assert.equal(log.list[0].newCard, true);

  // 超过 30 天：再提醒（regular 30 多天前放过）
  db.data.set("packDone/2611100000201", { at: ts(T0 - 31 * DAY), by: "pack@x.com", newCard: true });
  assert.deepEqual(await nc("2611190000202"), { level: "suggest" });
  db.data.set("packDone/2611100000201", { at: ts(T0 - 9 * DAY), by: "pack@x.com", newCard: true });
  assert.equal((await nc("2611190000202")).level, "placed");

  // 撤销这一包 → 新人卡记录跟着取消
  await pk.pkUndo(db, PACKER, { orderNo: "2611190000101" });
  assert.deepEqual(await nc("2611190000102"), { level: "must" });

  // 绑定后变会员 → 不再提醒
  db.data.set("bindings/shopee_newbie", { uid: "u3" });
  assert.equal(await nc("2611190000102"), null);
});

test("✋ 店主指定的小礼物：随单的出现在打包清单；指定订单只在那一包；单独寄的不出现", async () => {
  const db = fakeDb({
    ...SEED(),
    "orders/2611190000007": { username: "aqmar", platform: "shopee", uid: "u1", orderTime: ts(T0 - DAY) },
    "smallGifts/manual__1_a": { status: "pending", manual: true, batchId: "manual", uid: "u1", giftName: "钥匙圈", note: "谢谢推荐", delivery: "withOrder", linkedOrder: "2611190000007" },
    "smallGifts/manual__1_b": { status: "pending", manual: true, batchId: "manual", uid: "u1", giftName: "大抱枕", delivery: "separate", linkedOrder: null },
    "smallGifts/manual__1_c": { status: "pending", manual: true, batchId: "manual", uid: "u3", giftName: "贴纸", delivery: "withOrder", linkedOrder: null },
  });
  const look = async no => (await pk.pkLookup(db, PACKER, { orderNo: no })).parcel.items;
  const a1 = await look("2611190000001"), a7 = await look("2611190000007"), c4 = await look("2611190000004");
  assert.equal(a1.some(i => i.id === "manual__1_a"), false);                 // 指定 #007：别包不出现
  const it = a7.find(i => i.id === "manual__1_a");
  assert.ok(it); assert.equal(it.linkedOrder, "2611190000007"); assert.equal(it.src, "店主指定"); assert.ok(it.sub.includes("谢谢推荐"));
  assert.equal([...a1, ...a7].some(i => i.id === "manual__1_b"), false);   // 单独寄出不随单
  assert.ok(c4.some(i => i.id === "manual__1_c"));                          // 没指定：任何一包都可以
  // 寄错包裹会挡；对的包裹可以
  const r1 = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [{ kind: "sg", id: "manual__1_a" }], txId: "tx_man00001" });
  assert.equal(r1.results[0].ok, false);
  const r2 = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [{ kind: "sg", id: "manual__1_b" }], txId: "tx_man00002" });
  assert.equal(r2.results[0].ok, false);
  const r3 = await pk.pkShip(db, PACKER, { orderNo: "2611190000007", items: [{ kind: "sg", id: "manual__1_a" }], txId: "tx_man00003" });
  assert.equal(r3.results[0].ok, true);
  assert.equal(db.data.get("smallGifts/manual__1_a").sentOrder, "2611190000007");
  // 全部待寄：单独寄的不列
  const b = await pk.pkBatch(db, PACKER, {});
  assert.equal(JSON.stringify(b.pending).includes("manual__1_b"), false);
});

test("📊 新人卡统计：加入 / 标记（自动 + 手动）/ 再下单 / 第一次买 vs 买过", async () => {
  const core = require("../src/core");
  const db = fakeDb({
    ...SEED(),
    "members/uN": { name: "Nina" }, "members/uO": { name: "Olive" }, "members/uP": { name: "Pat" },
    // 4 位买家放了新人卡
    "orders/2611010000901": { username: "nina", platform: "shopee", orderTime: ts(T0 - 10 * DAY) },
    "orders/2611010000902": { username: "olive", platform: "shopee", orderTime: ts(T0 - 10 * DAY) },
    "orders/2611010000903": { username: "pat", platform: "shopee", orderTime: ts(T0 - 9 * DAY) },
    "orders/2611010000904": { username: "quinn", platform: "shopee", orderTime: ts(T0 - 9 * DAY) },
    "orders/2611010000905": { username: "nina", platform: "shopee", orderTime: ts(T0 - 9 * DAY) },   // nina 同一场第二包
    "packDone/2611010000901": { at: ts(T0 - 9 * DAY), by: "pack@x.com", newCard: true, newCardLevel: "must" },
    "packDone/2611010000905": { at: ts(T0 - 9 * DAY + 3600000), by: "pack@x.com", newCard: true },
    "packDone/2611010000902": { at: ts(T0 - 9 * DAY), by: "pack@x.com", newCard: true, newCardLevel: "suggest" },
    "packDone/2611010000903": { at: ts(T0 - 8 * DAY), by: "pack@x.com", newCard: true, newCardLevel: "must" },
    "packDone/2611010000904": { at: ts(T0 - 8 * DAY), by: "pack@x.com", newCard: true, newCardLevel: "must" },
    "packDone/2611190000003": { at: ts(T0 - DAY), by: "pack@x.com" },                                 // 没放卡
    // 加入：nina 扫码后绑定（自动 🆕）；olive 绑定（没来源 → ❓）；pat 绑定（店主标 👥）；quinn 没加入
    "bindings/shopee_nina": { uid: "uN", platform: "shopee", username: "nina", createdAt: ts(T0 - 5 * DAY) },
    "bindings/shopee_olive": { uid: "uO", platform: "shopee", username: "olive", createdAt: ts(T0 - 4 * DAY) },
    "bindings/shopee_pat": { uid: "uP", platform: "shopee", username: "pat", createdAt: ts(T0 - 3 * DAY) },
    // 再下单
    "orders/2611150000906": { username: "olive", platform: "shopee", orderTime: ts(T0 - 2 * DAY) },
    "orders/2611150000907": { username: "quinn", platform: "shopee", orderTime: ts(T0 - 2 * DAY), status: "refunded" },
  });
  // 会员端记下来源（Welcome Hub ?from=card）：只记一次，seenAt 太旧就用现在
  await core.nmSource(db, { uid: "uN", now: T0 - 6 * DAY }, { source: "card", seenAt: T0 - 6 * DAY - 3600000 });
  assert.equal(db.data.get("members/uN").joinSource.type, "card");
  assert.deepEqual(await core.nmSource(db, { uid: "uN", now: T0 }, { source: "card" }), { ok: true, already: true });
  await assert.rejects(core.nmSource(db, { uid: "uN", now: T0 }, { source: "x" }));
  await assert.rejects(core.nmSource(db, null, { source: "card" }));
  // 店主标 pat = 旧顾客
  await pk.pkCardMark(db, OWNER, { key: "shopee_pat", mark: "other" });
  assert.equal(db.data.get("cardMarks/shopee_pat").mark, "other");
  await rejects(pk.pkCardMark(db, OWNER, { key: "../x", mark: "card" }), "pk/bad-key");
  await rejects(pk.pkCardMark(db, OWNER, { key: "shopee_pat", mark: "x" }), "pk/bad-mark");
  await rejects(pk.pkCardMark(db, NOBODY, { key: "shopee_pat", mark: "card" }), "pk/no-perm");
  await rejects(pk.pkCardStats(db, NOBODY, { from: T0 - 30 * DAY, to: T0 }), "pk/no-perm");
  await rejects(pk.pkCardStats(db, PACKER, { from: T0, to: T0 - DAY }), "pk/bad-range");

  const r = await pk.pkCardStats(db, PACKER, { from: T0 - 30 * DAY, to: T0 });
  const s = r.summary;
  assert.equal(s.cards, 4);                    // nina 两包只算一次
  assert.equal(s.joined, 3); assert.equal(s.card, 1); assert.equal(s.unsure, 1); assert.equal(s.other, 1);
  assert.equal(s.rate, 25); assert.equal(s.joinRate, 75);
  assert.equal(s.reordered, 1);                // olive 再下单；quinn 的取消单不算；nina 第二包是放卡前下的（同一场）不算
  const by = k => r.rows.find(x => x.key === k);
  assert.equal(by("shopee_nina").cards, 2); assert.equal(by("shopee_nina").mark, "card"); assert.equal(by("shopee_nina").auto, "card");
  assert.equal(by("shopee_olive").mark, "unsure"); assert.equal(by("shopee_olive").reorders, 1);
  assert.equal(by("shopee_pat").mark, "other"); assert.equal(by("shopee_quinn").joined, false); assert.equal(by("shopee_quinn").mark, null);
  assert.deepEqual(s.byLevel.must, { cards: 3, card: 1, joined: 2 });
  assert.deepEqual(s.byLevel.suggest, { cards: 1, card: 0, joined: 1 });
  // 手动改成 🆕 → 转化率跟着变；清掉标记 → 回到系统判断
  await pk.pkCardMark(db, PACKER, { key: "shopee_olive", mark: "card" });
  assert.equal((await pk.pkCardStats(db, PACKER, { from: T0 - 30 * DAY, to: T0 })).summary.card, 2);
  await pk.pkCardMark(db, PACKER, { key: "shopee_olive", mark: "" });
  const r2 = await pk.pkCardStats(db, PACKER, { from: T0 - 30 * DAY, to: T0, summary: true });
  assert.equal(r2.summary.card, 1); assert.deepEqual(r2.rows, []);
  // 时间段外不算
  assert.equal((await pk.pkCardStats(db, PACKER, { from: T0 - 3 * DAY, to: T0 })).summary.cards, 0);
});

test("📊 打包时记下新人卡等级（第一次买 / 买过），重新保存保留", async () => {
  const db = fakeDb(SEED());
  await pk.pkShip(db, PACKER, { orderNo: "2611190000003", items: [], txId: "tx_lvl00001", done: true, newCard: true, newCardLevel: "must" });
  assert.equal(db.data.get("packDone/2611190000003").newCardLevel, "must");
  await pk.pkShip(db, PACKER, { orderNo: "2611190000003", items: [], txId: "tx_lvl00002", done: true });
  assert.equal(db.data.get("packDone/2611190000003").newCardLevel, "must");
  await pk.pkShip(db, PACKER, { orderNo: "2611190000004", items: [], txId: "tx_lvl00003", done: true, newCard: true, newCardLevel: "hack" });
  assert.equal(db.data.get("packDone/2611190000004").newCardLevel, undefined);
});
