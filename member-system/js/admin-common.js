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
