// member-system 后台共用功能
import { auth, db } from "./firebase-config.js";
import { getAccess, can } from "/js/admin-guard.js";
import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, onSnapshot, serverTimestamp, collection, query, where, getDocs, addDoc
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// ---------- 📋 管理员操作记录（总览「最近动态」的「管理员」） ----------
// 每次操作成功后记一笔：谁、什么时候、做了什么。记录失败不影响操作本身
// type：redeem 兑换 / prize 中奖 / member 会员 / points 积分 / feed / content 内容 / settings 设定
export function logAdmin(type, text, link = "") {
  const u = auth.currentUser;
  if (!u) return;
  addDoc(collection(db, "adminLog"), {
    type, text: String(text || "").slice(0, 300), link: String(link || "").slice(0, 200),
    by: u.email || "", byName: (u.displayName || "").slice(0, 60), at: serverTimestamp(),
  }).catch(e => console.warn("adminLog", e.message));
}
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export const PLATFORM_LABELS = { tiktok: "TikTok", shopee: "Shopee" };

// 优惠码格式：prefix 是平台固定的前缀；minLen / maxLen 是你要填的部分最少 / 最多几个字
// 以后要加格式或改前缀，只改这里
export const COUPON_FORMATS = [
  { id: "shopee", label: "Shopee（THEM + 1–5 字）", prefix: "THEM", minLen: 1, maxLen: 5 },
  { id: "tiktok", label: "TikTok（THEM + 2–8 字）", prefix: "THEM", minLen: 2, maxLen: 8 },
  { id: "custom", label: "其他（填完整优惠码）",      prefix: "",     minLen: 1, maxLen: 30 },
];

// 会员等级（显示用；规则以 Google 表格同步脚本的 MS_TIERS 为准）
export const TIER_LABELS = {
   mochii: "Mochii 会员", silver: "🥈 银卡", gold: "🥇 金卡", diamond: "💎 钻石", black: "♛ Black Elite"
};

// 列表用：Mochii 会员显示会员俱乐部 logo
export function tierHTML(tier) {
  const label = TIER_LABELS[tier] || TIER_LABELS.mochii;
  return (tier || "mochii") === "mochii"
    ? `<img src="https://www.themochiishop.com/memberclub/img/member.jpg" alt="" style="width:18px;height:18px;border-radius:4px;vertical-align:-4px"> ${label}`
    : label;
}
export const TIER_ORDER = { mochii: 0, silver: 1, gold: 2, diamond: 3, black: 4 };

// 商城分类：可在「商城奖品 › 商城分类」自订（存在 settings/shop）；还没设定过就用这份预设
export const DEFAULT_SHOP_CATS = [
  { id: "coupon",   icon: "🎫", zh: "优惠券",   en: "Coupons",        ms: "Kupon" },
  { id: "bracelet", icon: "📿", zh: "手链",     en: "Bracelets",      ms: "Gelang" },
  { id: "blindbox", icon: "🎁", zh: "盲盒",     en: "Blind boxes",    ms: "Kotak misteri" },
  { id: "figure",   icon: "🧸", zh: "公仔玩具", en: "Figures & toys", ms: "Figura & mainan" },
  { id: "other",    icon: "✨", zh: "其他",     en: "Others",         ms: "Lain-lain" },
];
// 奖品属于哪个分类；分类被删掉或没设定时：优惠券 → coupon，其他 → other，再不然放第一个分类
export function catOf(r, cats = DEFAULT_SHOP_CATS) {
  if (r.category && cats.some(c => c.id === r.category)) return r.category;
  if (r.type === "coupon" && cats.some(c => c.id === "coupon")) return "coupon";
  if (cats.some(c => c.id === "other")) return "other";
  return cats[0] ? cats[0].id : "";
}

// 📦 实体奖品：运输公司
export const CARRIERS = [
  { id: "spx",   name: "SPX Express", label: "SPX Express" },
  { id: "jnt",   name: "J&T Express", label: "J&T Express" },
  { id: "other", name: "",            label: "其他（自己填写）" },
];
// 查询链接模板：输入单号后自动生成链接（{no} = 单号），可在「兑换审核」页面底部修改
export const DEFAULT_TRACK_TPL = {
  spx: "https://spx.com.my/track?{no}",
  jnt: "https://www.jtexpress.my/tracking/{no}",
};

// 兑换编号：#加上兑换 ID 前 6 码（和会员前台一样）
export function redeemCode(id) {
  return "#" + String(id || "").slice(0, 6).toUpperCase();
}

// 导航「兑换审核」旁边的红色数字：待审核 + 待发货（含配送异常）
export async function refreshRedeemBadge() {
  const el = document.getElementById("redeemBadge");
  if (!el) return;
  try {
    const snap = await getDocs(query(collection(db, "redemptions"), where("status", "in", ["pending", "approved", "problem"])));
    const n = snap.docs.filter(d => {
      const r = d.data();
      return r.status === "pending" || (r.kind === "gift" && (r.status === "approved" || r.status === "problem"));
    }).length;
    el.textContent = n > 99 ? "99+" : n;
    el.hidden = !n;
  } catch (e) { console.warn("redeem badge", e); }
  updateSideDot();
}

// 导航「中奖奖品」旁边的红色数字：会员已领取（待审核）+ 待发货
export async function refreshPrizeBadge() {
  const el = document.getElementById("prizeBadge");
  if (!el) return;
  try {
    const snap = await getDocs(query(collection(db, "prizeWins"), where("status", "in", ["claimed", "approved"])));
    const n = snap.size;
    el.textContent = n > 99 ? "99+" : n;
    el.hidden = !n;
  } catch (e) { console.warn("prize badge", e); }
  updateSideDot();
}

// ---------- ⏳ 已绑定、还没发奖的得奖者 ----------
// 读网站 Monthly Draw 最近几期的得奖名单（公开资料），用订单编号找会员（orders/{单号}.uid），
// 去掉已经在「🏆 中奖奖品」里的（同一个订单编号，任何状态都算）。回传 [{ drawId, month, prize, winner, order, uid }]
const DRAW_DB = "https://admin-status-c3bdb-default-rtdb.asia-southeast1.firebasedatabase.app";
export const READY_PERIODS = 3;   // 只看最近几期
export function parseWinnerRows(text) {
  const rows = [];
  String(text || "").split(/\n+/).map(l => l.trim()).filter(Boolean).forEach(l => {
    const c = l.split(/\s*\|\s*|\t+/).map(x => x.trim());
    const low = c.join(" ").toLowerCase();
    if (/winner/.test(low) && /(prize|order)/.test(low)) return;   // 标题行
    if (c.length === 1) rows.push({ prize: "", winner: c[0], order: "" });
    else rows.push({ prize: c[0], winner: c[1] || "", order: c[2] || "" });
  });
  return rows;
}
export const normOrderNo = s => String(s || "").replace(/\s/g, "").toUpperCase();
export async function readyWinners() {
  const get = async path => { const r = await fetch(`${DRAW_DB}/${path}.json`); return r.ok ? r.json() : null; };
  const idx = await get("homepage/drawIndex");
  const periods = (Array.isArray(idx) ? idx : Object.values(idx || {}))
    .filter(x => x && x.id && typeof x.month === "string" && x.month.trim()).slice(0, READY_PERIODS);
  const winSnap = await getDocs(collection(db, "prizeWins"));
  const done = new Set(winSnap.docs.map(d => normOrderNo(d.data().orderNo)).filter(Boolean));
  const out = [];
  for (const p of periods) {
    const d = (await get("homepage/drawData/" + p.id)) || {};
    let rows = [d.w1, d.w2, d.w3].flatMap(parseWinnerRows);
    if (!rows.length && d.winners) rows = parseWinnerRows(d.winners);
    for (const r of rows) {
      const no = normOrderNo(r.order);
      if (!no || no.includes("*") || done.has(no)) continue;
      let uid = "";
      try { const s = await getDoc(doc(db, "orders", no)); uid = s.exists() ? (s.data().uid || "") : ""; } catch (e) {}
      if (uid) { out.push({ drawId: p.id, month: p.month.trim(), prize: r.prize, winner: r.winner, order: no, uid }); done.add(no); }
    }
  }
  return out;
}

// 首页区块（会员前台 home.html 的 DEFAULT_SECTIONS 也要一致）
export const HOME_SECTIONS = [
  { key: "hero",    label: "👋 你好 + 积分 + 等级（含右边 Feed 框）", on: true },
  { key: "banners", label: "🖼️ 横幅",              on: true },
  { key: "order",   label: "🧾 最新一张订单",        on: true },
  { key: "news",    label: "📣 俱乐部消息",          on: true, count: 3 },
  { key: "rewards", label: "✨ 最新上架的兑换商品",   on: true, count: 4 },
];

// 把图片缩到最长边 max 像素，转成小档案（存进 Firestore 用）
export function compressImage(file, max = 480) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      let url = c.toDataURL("image/webp", 0.8);
      if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", 0.82);
      URL.revokeObjectURL(img.src);
      resolve(url);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// 额外福利：系统自动发放的四项（预设分数要和会员前台 common.js 的 BONUSES、Firestore 规则一致）
export const PERK_DEFAULTS = [
  { key: "welcome",   points: 50, label: "🎁 新会员欢迎礼",       cond: "绑定第一个购物账号" },
  { key: "birthday",  points: 10, label: "📝 完善资料：生日",      cond: "填写生日" },
  { key: "whatsapp",  points: 10, label: "📝 完善资料：WhatsApp 通知", cond: "填写手机号码并勾选接收 WhatsApp 通知" },
  { key: "platform2", points: 20, label: "📝 完善资料：第二个平台", cond: "Shopee 和 TikTok 都绑定" },
];

// 📣 关注我们（和会员前台 common.js 的 FOLLOWS 一致；Firestore 规则 followOk 也要一致）
export const FOLLOW_DEFAULTS = [
  { key: "follow_shopee",    points: 10, label: "🛍️ Shopee 店铺",     ph: "https://shopee.com.my/…" },
  { key: "follow_tiktok",    points: 10, label: "🎵 TikTok",          ph: "https://www.tiktok.com/@…" },
  { key: "follow_instagram", points: 10, label: "📸 Instagram",       ph: "https://www.instagram.com/…" },
  { key: "follow_facebook",  points: 10, label: "👍 Facebook",        ph: "https://www.facebook.com/…" },
  { key: "follow_whatsapp",  points: 10, label: "💬 WhatsApp 频道",   ph: "https://whatsapp.com/channel/…" },
];

export function platformTag(p) {
  return `<span class="tag tag-${p === "shopee" ? "warn" : "pink"}">${esc(PLATFORM_LABELS[p] || p)}</span>`;
}

export function normalizeUsername(s) {
  return String(s || "").trim().replace(/^@/, "").toLowerCase();
}

// ---------- 手机号码（与会员前台 common.js 规则一致） ----------
export function normalizePhone(s) {
  let d = String(s || "").trim();
  if (d.startsWith("+")) return "+" + d.slice(1).replace(/\D/g, "");
  d = d.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("60")) return "+" + d;
  if (d.startsWith("0")) return "+60" + d.slice(1);
  if (d.startsWith("1")) return "+60" + d;
  return "+" + d;
}

export function isValidPhone(p) {
  if (p.startsWith("+60")) return /^\+601\d{8,9}$/.test(p);
  return /^\+[1-9]\d{7,14}$/.test(p);
}

// +60123456789 → 012-345 6789（马来西亚号码），其他照原样
export function fmtPhone(p) {
  if (!p) return "";
  const m = String(p).match(/^\+60(1\d)(\d{3,4})(\d{4})$/);
  return m ? `0${m[1]}-${m[2]} ${m[3]}` : p;
}

// WhatsApp 聊天链接
export function waLink(p, text) {
  const digits = String(p || "").replace(/\D/g, "");
  return "https://wa.me/" + digits + (text ? "?text=" + encodeURIComponent(text) : "");
}

export function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return v;
  return null;
}

export function fmtDate(d, withTime = false) {
  if (!d) return "-";
  const p = n => String(n).padStart(2, "0");
  let s = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (withTime) s += ` ${p(d.getHours())}:${p(d.getMinutes())}`;
  return s;
}

// 计算会员现在能用的积分（扣掉其他审核中的兑换）
export function computeBalance(ledger, redemptions, excludeId) {
  const now = new Date();
  let available = 0, pending = 0;
  ledger.forEach(x => {
    const at = toDate(x.availableAt);
    if (at && at > now) pending += x.delta; else available += x.delta;
  });
  const reserved = redemptions
    .filter(r => r.status === "pending" && r.id !== excludeId)
    .reduce((s, r) => s + (r.cost || 0), 0);
  return { available, pending, reserved, spendable: available - reserved };
}

// ---------- 侧边栏导航（分组） ----------
// active：页面代号；Feed 页面网址带 #pending 时，亮「Feed 审核」
export const NAV_GROUPS = [
  { label: "", items: [
    ["overview", "index.html", "📊", "总览"],
  ] },
  { label: "待处理", items: [
    ["redeem", "redeem.html", "🔔", "兑换审核", "redeemBadge"],
    ["prizes", "prizes.html", "🏆", "中奖奖品", "prizeBadge"],
    ["feedReview", "feed.html#pending", "⏳", "Feed 审核", "feedBadge"],
  ] },
  { label: "会员", items: [
    ["members", "members.html", "👥", "会员列表"],
  ] },
  { label: "商城", items: [
    ["rewards", "rewards.html", "🛍️", "商城奖品"],
    ["perks", "perks.html", "🎁", "额外福利"],
  ] },
  { label: "内容", items: [
    ["home", "home.html", "🏠", "首页设定"],
    ["feed", "feed.html", "✨", "Feed 管理"],
    ["announce", "announcements.html", "📢", "会员公告"],
    ["storehelp", "storehelp.html", "❓", "商店帮助"],
  ] },
  { label: "设定", items: [
    ["notify", "notify.html", "📧", "邮件提醒"],
  ] },
];

export function renderAdminNav(active) {
  if (active === "feed" && location.hash === "#pending") active = "feedReview";
  document.body.classList.add("has-side");
  const head = document.getElementById("adminHeader");
  head.className = "side";
  head.innerHTML = `
    <div class="side-top">
      <button class="side-burger" id="sideBurger" type="button" aria-label="打开菜单">☰<span class="side-dot" id="sideDot" hidden></span></button>
      <a class="side-brand" href="index.html">Mochiishop/admin<small>会员系统</small></a>
    </div>
    <nav class="side-scroll">
      ${NAV_GROUPS.map(g => `
        <div class="side-group">
          ${g.label ? `<div class="side-label">${g.label}</div>` : ""}
          ${g.items.map(([k, href, ic, t, badge]) => `
            <a href="${href}" class="side-link ${k === active ? "active" : ""}">
              <span class="ic">${ic}</span><span class="tx">${t}</span>
              ${badge ? `<span id="${badge}" class="nav-badge" hidden></span>` : ""}
            </a>`).join("")}
        </div>`).join("")}
    </nav>
    <div class="side-foot">
      <a href="#" id="clubSwitch" class="club-switch">俱乐部…</a>
      <a href="#" id="themeBtn" class="side-link theme-btn"></a>
      <a href="../hub/" class="side-link"><span class="ic">📱</span><span class="tx">Mochii Hub</span></a>
      <a href="../" class="side-link"><span class="ic">←</span><span class="tx">返回控制台</span></a>
      <a href="#" id="adminLogout" class="side-link"><span class="ic">⎋</span><span class="tx">登出</span></a>
    </div>
    <div class="side-scrim" id="sideScrim"></div>`;
  document.getElementById("adminLogout").addEventListener("click", e => {
    e.preventDefault();
    signOut(auth);
  });
  // 白色 / 暗黑模式切换（记在这台设备）
  const themeBtn = document.getElementById("themeBtn");
  const paintTheme = () => {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    themeBtn.innerHTML = dark ? '<span class="ic">☀️</span><span class="tx">白色模式</span>' : '<span class="ic">🌙</span><span class="tx">暗黑模式</span>';
  };
  paintTheme();
  themeBtn.addEventListener("click", e => {
    e.preventDefault();
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("msAdminTheme", next); } catch (err) {}
    paintTheme();
  });
  const toggle = on => document.body.classList.toggle("side-open", on);
  document.getElementById("sideBurger").addEventListener("click", () => toggle(!document.body.classList.contains("side-open")));
  document.getElementById("sideScrim").addEventListener("click", () => toggle(false));
  head.querySelectorAll(".side-scroll a").forEach(a => a.addEventListener("click", () => toggle(false)));
}

// 手机顶部 ☰ 上的红色数字：三个待处理加起来
function updateSideDot() {
  const dot = document.getElementById("sideDot");
  if (!dot) return;
  const n = ["redeemBadge", "prizeBadge", "feedBadge"].reduce((s, id) => {
    const el = document.getElementById(id);
    return s + (el && !el.hidden ? (parseInt(el.textContent, 10) || 0) : 0);
  }, 0);
  dot.textContent = n > 99 ? "99+" : n;
  dot.hidden = !n;
}

// 导航「Feed 审核」旁边的红色数字：会员投稿待审核 + 待处理的检举（同一个内容算一件）
export async function openReportCount() {
  try {
    const s = await getDocs(query(collection(db, "feedReports"), where("status", "==", "open")));
    return new Set(s.docs.map(d => d.data().targetKey)).size;
  } catch (e) { return 0; }   // 还没加 feedReports 规则时当作 0
}
export async function refreshFeedBadge() {
  const el = document.getElementById("feedBadge");
  if (!el) return;
  try {
    const [snap, nr] = await Promise.all([
      getDocs(query(collection(db, "feedPosts"), where("status", "==", "pending"))),
      openReportCount(),
    ]);
    const n = snap.size + nr;
    el.textContent = n > 99 ? "99+" : n;
    el.hidden = !n;
  } catch (e) { console.warn("feed badge", e); }
  updateSideDot();
}

// ---------- 管理员检查 ----------
// 未登录：显示 Google 登录；已登录但不是管理员：显示 UID 和设定方法
export function requireAdmin(onReady) {
  const gate = document.getElementById("gate");
  const app = document.getElementById("app");

  onAuthStateChanged(auth, async user => {
    if (!user) {
      app.classList.add("hidden");
      gate.classList.remove("hidden");
      gate.innerHTML = `
        <div class="gate-card">
          <h2>🎫 会员系统后台</h2>
          <p>请用管理员 Google 账号登录</p>
          <button id="gateLogin" class="btn btn-primary">使用 Google 登录</button>
          <p id="gateMsg" class="msg err"></p>
        </div>`;
      document.getElementById("gateLogin").addEventListener("click", async () => {
        try { await signInWithPopup(auth, new GoogleAuthProvider()); }
        catch (e) { document.getElementById("gateMsg").textContent = e.message; }
      });
      return;
    }

    let isAdmin = false;
    try { isAdmin = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch (e) { isAdmin = false; }

    if (!isAdmin) {
      app.classList.add("hidden");
      gate.classList.remove("hidden");
      gate.innerHTML = `
        <div class="gate-card">
          <h2>🔒 没有管理员权限</h2>
          <p>已登录：${esc(user.email || "")}</p>
          <p>你的 UID：<br><code id="myUid">${esc(user.uid)}</code></p>
          <button id="copyUid" class="btn btn-ghost">复制 UID</button>
          <ol style="margin-top:16px">
            <li>打开 Firebase 控制台 → Firestore Database</li>
            <li>新增集合 <code>admins</code></li>
            <li>文件 ID 贴上面的 UID，随便加一个栏位，例如 <code>name</code> = <code>owner</code></li>
            <li>保存后重新整理这个页面</li>
          </ol>
          <button id="gateLogout" class="btn btn-ghost">换一个账号</button>
        </div>`;
      document.getElementById("copyUid").addEventListener("click", async e => {
        try { await navigator.clipboard.writeText(user.uid); e.target.textContent = "已复制 ✓"; }
        catch { prompt("请手动复制：", user.uid); }
      });
      document.getElementById("gateLogout").addEventListener("click", () => signOut(auth));
      return;
    }

    // 👥 控制台的管理员权限：Feed 页面要「Mochii Feed」，其他页面要「Member Club」
    const need = /\/feed\.html$/.test(location.pathname) ? "feed" : "member";
    const access = await getAccess(user);
    if (!can(access, need)) {
      app.classList.add("hidden");
      gate.classList.remove("hidden");
      gate.innerHTML = `
        <div class="gate-card">
          <h2>🔒 没有这项权限</h2>
          <p>已登录：${esc(user.email || "")}</p>
          <p>${access.reason === "disabled" ? "这个账号已被停用。" : `这个账号没有「${need === "feed" ? "Mochii Feed" : "Member Club"}」的权限，需要的话请联系店主。`}</p>
          <div class="actions" style="justify-content:center">
            <a class="btn btn-primary" href="/">回控制台</a>
            <button id="gateLogout" class="btn btn-ghost">换一个账号</button>
          </div>
        </div>`;
      document.getElementById("gateLogout").addEventListener("click", () => signOut(auth));
      return;
    }

    gate.classList.add("hidden");
    app.classList.remove("hidden");
    onReady(user);
    initClubSwitch(user);
    refreshRedeemBadge();
    refreshPrizeBadge();
    refreshFeedBadge();
  });
}

// ---------- 前台俱乐部开关（开放 / 维修中） ----------
function initClubSwitch(user) {
  const btn = document.getElementById("clubSwitch");
  if (!btn) return;
  const ref = doc(db, "settings", "club");
  let open = false;
  onSnapshot(ref, s => {
    open = s.exists() && s.data().open === true;
    btn.textContent = open ? "🟢 俱乐部开放中" : "🔴 俱乐部维修中";
    btn.className = "club-switch " + (open ? "club-open" : "club-closed");
    btn.title = open ? "点击关闭前台会员俱乐部" : "点击开放前台会员俱乐部";
  });
  btn.addEventListener("click", async e => {
    e.preventDefault();
    const msg = open
      ? "关闭会员俱乐部？\n关闭后会员无法登录，首页会显示「正在装修俱乐部」。"
      : "开放会员俱乐部？\n开放后所有人都可以注册和登录。";
    if (!confirm(msg)) return;
    try {
      await setDoc(ref, { open: !open, updatedAt: serverTimestamp(), updatedBy: user.email || "" }, { merge: true });
      logAdmin("settings", open ? "关闭了会员俱乐部（维修中）" : "开放了会员俱乐部", "index.html");
    } catch (err) {
      alert("切换失败：" + err.message);
    }
  });
}
