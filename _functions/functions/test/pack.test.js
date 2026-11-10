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
  assert.equal(by["587000000000000002"].items.length, 7);
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
  assert.equal(w.status, "shipped"); assert.deepEqual(w.shipping, { withOrder: true, orderNo: "2611190000001", by: "pack@x.com", via: "pack" });
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

test("勾选迎新礼：走新会员奖励流程（已打包 → 已寄出），兑换和会员资料同步", async () => {
  const db = fakeDb(SEED());
  const r = await pk.pkShip(db, PACKER, { orderNo: "2611190000001", items: [{ kind: "nm", id: "uAqmar01_1" }], txId: "tx_nm123456" });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  const n = db.data.get("newMemberRewards/uAqmar01_1");
  assert.equal(n.status, "shipped"); assert.equal(n.packedBy, "pack@x.com"); assert.equal(n.shippedBy, "pack@x.com");
  const red = db.data.get("redemptions/nm_u1_1");
  assert.equal(red.status, "shipped"); assert.equal(red.shipping.orderNo, "2611190000001");
  assert.equal(db.data.get("members/u1").nmr.status, "shipped");
  assert.ok([...db.data.keys()].some(k => k.startsWith("newMemberRewards/uAqmar01_1/history/")));
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
  const want = { withOrder: true, orderNo: "2611190000001", by: "pack@x.com", via: "pack", carrier: "spx", carrierName: "SPX Express",
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
  assert.deepEqual(db.data.get("smallGifts/b__1").shipping, { withOrder: true, orderNo: "2611190000001", by: "pack@x.com", via: "pack" });
});
