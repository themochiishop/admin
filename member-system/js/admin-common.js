// member-system 后台共用功能
import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

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
    ["back", "../", "← 返回控制台"],
  ];
  document.getElementById("adminHeader").innerHTML = `
    <div class="brand">Mochiishop/admin · 会员系统</div>
    <nav>
      ${links.map(([k, href, t]) => `<a href="${href}" class="${k === active ? "active" : ""}">${t}</a>`).join("")}
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
  });
}
