// 🔗 分享网址预览：node --test test/share.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const sh = require("../src/share");

function fakeDb(seed) {
  const data = new Map(Object.entries(seed));
  const docRef = path => ({
    async get() { const d = data.get(path); return { exists: d !== undefined, id: path.split("/").pop(), data: () => d }; },
    collection: c => col(path + "/" + c),
  });
  const col = name => ({
    doc: id => docRef(name + "/" + id),
    where(f, op, v) {
      return { limit: () => ({ async get() {
        const docs = [...data.entries()].filter(([k, d]) => k.startsWith(name + "/") && k.split("/").length === name.split("/").length + 1 && d[f] === v)
          .map(([k, d]) => ({ id: k.split("/").pop(), data: () => d }));
        return { empty: !docs.length, docs: docs.slice(0, 1) };
      } }) };
    },
  });
  return { collection: col };
}
const AV = "data:image/webp;base64," + Buffer.from("avatar").toString("base64");
const IMG = "data:image/jpeg;base64," + Buffer.from("photo").toString("base64");
const db = fakeDb({
  "memberFeed/uidNina0001": { code: "uidNina0", name: "Nina <b>", tier: "gold", title: "", bio: "喜欢 Mochii", avatar: AV, updatedAt: { toMillis: () => 123 } },
  "memberFeed/uidPat00001": { code: "uidPat00", name: "Pat", tier: "mochii", bio: "", avatar: "p:3" },
  "feedPosts/postShop0001": { status: "published", minRank: 0, authorUid: "", authorTier: "", authorName: "The Mochii Shop" },
  "feedPosts/postShop0001/content/main": { text: "新货到了！快来看看", images: [IMG] },
  "feedPosts/postNina0001": { status: "published", minRank: 0, authorUid: "uidNina0001", authorTier: "gold", authorName: "Nina" },
  "feedPosts/postNina0001/content/main": { text: "我的开箱 012-3456789", images: [IMG] },
  "feedPosts/postPend0001": { status: "pending", minRank: 0, authorUid: "uidPat00001", authorTier: "mochii", authorName: "Pat" },
  "feedPosts/postGold0001": { status: "published", minRank: 2, authorUid: "", authorTier: "", authorName: "Shop" },
});

test("会员主页：名字、等级、简介、头像图；系统头像用 logo；名字有 HTML 会被转义", async () => {
  const a = await sh.sharePage(db, "/u/uidNina0");
  assert.equal(a.status, 200); assert.equal(a.title, "Nina <b> · Mochii Club");
  assert.equal(a.desc, "金卡会员 · 喜欢 Mochii");
  assert.equal(a.image, "https://club.themochiishop.com/i/u/uidNina0.jpg?v=123");
  assert.equal(a.target, "https://www.themochiishop.com/memberclub/feed.html#c-uidNina0");
  const html = sh.page(a);
  assert.ok(html.includes("Nina &lt;b&gt;")); assert.ok(!html.includes("Nina <b>"));
  assert.ok(html.includes('property="og:image"'));
  assert.ok((await sh.sharePage(db, "/u/uidPat00")).image.endsWith("logo.png"));
  assert.equal((await sh.sharePage(db, "/u/shop")).target.endsWith("#shop"), true);
  assert.equal((await sh.sharePage(db, "/u/nobody00")).status, 404);
  assert.equal((await sh.sharePage(db, "/u/<script>")).status, 404);
  assert.equal((await sh.sharePage(db, "/x")).status, 404);
});

test("帖子：店铺帖子显示内容和图片；会员帖子只显示作者；没公开 / 限等级的不给内容", async () => {
  const s = await sh.sharePage(db, "/p/postShop0001");
  assert.equal(s.desc, "新货到了！快来看看"); assert.equal(s.image, "https://club.themochiishop.com/i/p/postShop0001.jpg"); assert.equal(s.big, true);
  assert.equal(s.target, "https://www.themochiishop.com/memberclub/feed.html#p-postShop0001");
  const n = await sh.sharePage(db, "/p/postNina0001");
  assert.equal(n.title, "Nina 在 Mochii Feed 发了一篇帖子");
  assert.ok(!JSON.stringify(n).includes("开箱")); assert.equal(n.image, "https://club.themochiishop.com/i/u/uidNina0.jpg");
  for (const id of ["postPend0001", "postGold0001"]) {
    const h = await sh.sharePage(db, "/p/" + id);
    assert.equal(h.title, "Mochii Feed · Mochii Club"); assert.ok(h.image.endsWith("logo.png"));
  }
  assert.equal((await sh.sharePage(db, "/p/nope000001")).status, 404);
});

test("预览图：头像 / 店铺帖子第一张图转 JPEG；会员帖子、没公开的不给", async () => {
  const conv = async (buf, square) => Buffer.from(`${buf.toString()}|${square}`);
  assert.equal((await sh.shareImage(db, "/i/u/uidNina0.jpg", conv)).buf.toString(), "avatar|true");
  assert.equal((await sh.shareImage(db, "/i/p/postShop0001.jpg", conv)).buf.toString(), "photo|false");
  assert.equal(await sh.shareImage(db, "/i/p/postNina0001.jpg", conv), null);
  assert.equal(await sh.shareImage(db, "/i/p/postPend0001.jpg", conv), null);
  assert.equal(await sh.shareImage(db, "/i/u/uidPat00.jpg", conv), null);
  assert.equal(await sh.shareImage(db, "/i/u/../x.jpg", conv), null);
});

test("HTTP：页面 / 图片 / 找不到图片转 logo", async () => {
  const mk = () => { const r = { h: {}, st: 200 }; r.set = (k, v) => { r.h[k] = v; return r; }; r.status = s => { r.st = s; return r; };
    r.type = t => { r.t = t; return r; }; r.send = b => { r.body = b; return r; }; r.redirect = (s, u) => { r.st = s; r.loc = u; return r; }; return r; };
  let r = mk(); await sh.handle(db, { path: "/u/uidNina0" }, r, async b => b);
  assert.equal(r.st, 200); assert.equal(r.t, "html"); assert.ok(r.body.includes("og:title"));
  r = mk(); await sh.handle(db, { path: "/i/u/uidNina0.jpg" }, r, async b => b);
  assert.equal(r.t, "image/jpeg"); assert.equal(r.body.toString(), "avatar");
  r = mk(); await sh.handle(db, { path: "/i/u/uidPat00.jpg" }, r, async b => b);
  assert.equal(r.st, 302); assert.ok(r.loc.endsWith("logo.png"));
});
