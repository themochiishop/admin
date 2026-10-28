// member-system 后台共用功能
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
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
   mochii: "Mochii 会员", silver: "🥈 银卡", gold: "🥇 金卡", diamond: "💎 钻石"
};

// 列表用：Mochii 会员显示会员俱乐部 logo
export function tierHTML(tier) {
  const label = TIER_LABELS[tier] || TIER_LABELS.mochii;
  return (tier || "mochii") === "mochii"
    ? `<img src="https://www.themochiishop.com/memberclub/img/member.jpg" alt="" style="width:18px;height:18px;border-radius:4px;vertical-align:-4px"> ${label}`
    : label;
}
export const TIER_ORDER = { mochii: 0, silver: 1, gold: 2, diamond: 3 };

// 商城分类（会员前台 common.js 的 SHOP_CATS 也要一致；名称三语在前台 i18n.js 的 shop.cat.*）
export const SHOP_CATS = [
  { id: "coupon",   label: "🎫 优惠券" },
  { id: "bracelet", label: "📿 手链" },
  { id: "blindbox", label: "🎁 盲盒" },
  { id: "figure",   label: "🧸 公仔玩具" },
  { id: "other",    label: "✨ 其他" },
];
export function catOf(r) {
  if (r.category && SHOP_CATS.some(c => c.id === r.category)) return r.category;
  return r.type === "coupon" ? "coupon" : "other";
}

// 首页区块（会员前台 home.html 的 DEFAULT_SECTIONS 也要一致）
export const HOME_SECTIONS = [
  { key: "hero",    label: "👋 你好 + 积分 + 等级", on: true },
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

// ---------- 顶部导航 ----------
export function renderAdminNav(active) {
  const links = [
    ["redeem", "index.html", "兑换审核"],
    ["members", "members.html", "会员管理"],
    ["rewards", "rewards.html", "奖品管理"],
    ["perks", "perks.html", "🎁 额外福利"],
    ["home", "home.html", "🏠 首页设定"],
    ["announce", "announcements.html", "📢 会员公告"],
    ["back", "../", "← 返回控制台"],
  ];
  document.getElementById("adminHeader").innerHTML = `
    <div class="brand">Mochiishop/admin · 会员系统</div>
    <nav>
      ${links.map(([k, href, t]) => `<a href="${href}" class="${k === active ? "active" : ""}">${t}</a>`).join("")}
            <a href="#" id="clubSwitch" class="club-switch">俱乐部…</a>
      <a href="#" id="adminLogout">登出</a>
    </nav>`;
  document.getElementById("adminLogout").addEventListener("click", e => {
    e.preventDefault();
    signOut(auth);
  });
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

    gate.classList.add("hidden");
    app.classList.remove("hidden");
    onReady(user);
        initClubSwitch(user);
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
    } catch (err) {
      alert("切换失败：" + err.message);
    }
  });
}
