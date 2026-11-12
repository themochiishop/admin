// 🔗 分享网址预览（2026-11-13）：club.themochiishop.com（Firebase Hosting → 这个 Function）
//   /u/{代码}     会员 Feed 主页（/u/shop = 店铺主页）
//   /p/{帖子编号}  Feed 单篇帖子
//   /i/u/{代码}.jpg、/i/p/{帖子编号}.jpg  预览图（把存在 Firestore 的 base64 头像 / 图片转成 JPEG）
// WhatsApp / Facebook 来抓 → 看到 og:title / og:image；一般人 → 马上跳到会员俱乐部
// 隐私：会员主页只用 Feed 上本来就公开的资料（memberFeed：名字、等级、头像、简介）；
//       帖子只有「已公开、所有会员可看」的才有预览；会员发的帖子只显示作者（不显示内容和照片），店铺的帖子才显示内容
const CLUB = "https://www.themochiishop.com/memberclub/feed.html";
const LOGO = "https://www.themochiishop.com/assets/images/logo.png";
const BASE = "https://club.themochiishop.com";
const TIER = { mochii: "Mochii 会员", silver: "银卡会员", gold: "金卡会员", diamond: "钻石会员", black: "Black Elite" };
const CODE_RE = /^[A-Za-z0-9_-]{4,40}$/, PID_RE = /^[A-Za-z0-9]{6,40}$/;

const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const dataImg = s => typeof s === "string" && /^data:image\/(webp|jpeg|png);base64,/.test(s) ? s : null;

async function memberByCode(db, code) {
  const s = await db.collection("memberFeed").where("code", "==", code).limit(1).get();
  return s.empty ? null : { id: s.docs[0].id, ...s.docs[0].data() };
}
// 帖子：已公开 + 所有会员可看（minRank 0）才给预览
async function publicPost(db, pid) {
  const s = await db.collection("feedPosts").doc(pid).get();
  if (!s.exists) return null;
  const p = s.data() || {};
  if (p.status !== "published" || (p.minRank || 0) > 0) return { hidden: true };
  return { id: pid, ...p };
}
const isShopPost = p => !p.authorUid || p.authorTier === "" || p.authorTier == null;

function page({ title, desc, image, url, target, type = "website", big = false }) {
  const t = escH(title), d = escH(desc), tg = escH(target);
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:site_name" content="Mochii Club">
<meta property="og:type" content="${type}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${escH(image)}">
<meta property="og:url" content="${escH(url)}">
<meta name="twitter:card" content="${big ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${escH(image)}">
<meta http-equiv="refresh" content="0;url=${tg}">
<link rel="icon" href="${LOGO}">
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#f472b6}</style>
</head><body><p>正在打开 Mochii Club… <a href="${tg}">没有自动打开请按这里</a></p>
<script>location.replace(${JSON.stringify(target)})</script></body></html>`;
}

// 页面资料（测试也用这个）
async function sharePage(db, path) {
  const m = path.match(/^\/(u|p)\/([^/?#]+)\/?$/);
  const home = { title: "Mochii Club · The Mochii Shop", desc: "Mochii 会员俱乐部：积分、奖品、Mochii Feed", image: LOGO, url: BASE + path, target: CLUB };
  if (!m) return { status: 404, ...home };
  const [, kind, id] = m;
  if (kind === "u") {
    if (id === "shop") return { status: 200, title: "The Mochii Shop · Mochii Club", desc: "官方店铺 · Mochii Feed", image: LOGO, url: BASE + path, target: CLUB + "#shop", type: "profile" };
    if (!CODE_RE.test(id)) return { status: 404, ...home };
    const w = await memberByCode(db, id);
    if (!w) return { status: 404, ...home, target: CLUB + "#c-" + id };
    const tier = TIER[w.tier] || TIER.mochii;
    return { status: 200, title: `${cut(w.name, 40) || "会员"} · Mochii Club`, desc: [tier, w.title ? cut(w.title, 20) : "", cut(w.bio, 80)].filter(Boolean).join(" · "),
      image: dataImg(w.avatar) ? `${BASE}/i/u/${id}.jpg${w.updatedAt && w.updatedAt.toMillis ? "?v=" + w.updatedAt.toMillis() : ""}` : LOGO,
      url: BASE + path, target: CLUB + "#c-" + id, type: "profile" };
  }
  if (!PID_RE.test(id)) return { status: 404, ...home };
  const p = await publicPost(db, id);
  const target = CLUB + "#p-" + id;
  if (!p || p.hidden) return { status: p ? 200 : 404, ...home, title: "Mochii Feed · Mochii Club", desc: "会员专属的帖子，登录 Mochii Club 就能看", target };
  if (isShopPost(p)) {
    const c = await db.collection("feedPosts").doc(id).collection("content").doc("main").get();
    const ct = c.exists ? (c.data() || {}) : {};
    const img = Array.isArray(ct.images) && dataImg(ct.images[0]);
    return { status: 200, title: `${cut(p.authorName, 30) || "The Mochii Shop"} · Mochii Feed`, desc: cut(ct.text, 150) || "Mochii Feed",
      image: img ? `${BASE}/i/p/${id}.jpg` : LOGO, url: BASE + path, target, type: "article", big: !!img };
  }
  const w = p.authorUid ? (await db.collection("memberFeed").doc(p.authorUid).get()) : null;
  const wd = w && w.exists ? (w.data() || {}) : {};
  const code = wd.code || "";
  return { status: 200, title: `${cut(p.authorName, 30) || "会员"} 在 Mochii Feed 发了一篇帖子`, desc: `${TIER[p.authorTier] || TIER.mochii} · 登录 Mochii Club 看全文`,
    image: dataImg(wd.avatar) && CODE_RE.test(code) ? `${BASE}/i/u/${code}.jpg` : LOGO, url: BASE + path, target, type: "article" };
}

// 预览图：回传 { buf, type } 或 null（→ 转到 logo）
async function shareImage(db, path, toJpeg) {
  const m = path.match(/^\/i\/(u|p)\/([^/?#.]+)\.jpg$/);
  if (!m) return null;
  const [, kind, id] = m;
  let src = null, square = true;
  if (kind === "u" && CODE_RE.test(id)) { const w = await memberByCode(db, id); src = w && dataImg(w.avatar); }
  if (kind === "p" && PID_RE.test(id)) {
    const p = await publicPost(db, id);
    if (p && !p.hidden && isShopPost(p)) {
      const c = await db.collection("feedPosts").doc(id).collection("content").doc("main").get();
      const ct = c.exists ? (c.data() || {}) : {};
      src = Array.isArray(ct.images) && dataImg(ct.images[0]); square = false;
    }
  }
  if (!src) return null;
  const buf = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  return { buf: await toJpeg(buf, square), type: "image/jpeg" };
}

// HTTP 入口（index.js 包成 onRequest）
async function handle(db, req, res, toJpeg) {
  const path = String(req.path || req.url || "/").split("?")[0];
  res.set("X-Robots-Tag", "noindex");
  try {
    if (path.startsWith("/i/")) {
      const img = await shareImage(db, path, toJpeg);
      if (!img) { res.set("Cache-Control", "public, max-age=300"); return res.redirect(302, LOGO); }
      res.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
      res.type(img.type).send(img.buf);
      return;
    }
    const pg = await sharePage(db, path);
    res.set("Cache-Control", pg.status === 200 ? "public, max-age=300, s-maxage=600" : "public, max-age=60");
    res.status(pg.status).type("html").send(page(pg));
  } catch (e) {
    console.error("share", path, e);
    res.status(302).set("Cache-Control", "no-store").redirect(CLUB);
  }
}

module.exports = { handle, sharePage, shareImage, page, escH };
