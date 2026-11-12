// ===== Mochii 后台：管理员与权限（控制台、管理员页面、各子页面共用） =====
// 名单存在 member-system 的 Firestore「staff」集合，文件编号 = email（小写）
// 店主 mail@themochiishop.com 永远拥有全部权限，不需要在名单里
import { auth, db } from "/member-system/js/firebase-config.js";
import {
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

export const OWNER_EMAIL = "mail@themochiishop.com";

// ---------- 权限清单（控制台卡片 + 下层功能） ----------
// 以后要加新卡片或下层功能，在这里加一行就好；管理员页面会自动出现
export const PERM_TREE = [
  { group: "🎥 直播", items: [
    { id: "hub", icon: "📱", label: "Mochii Hub" },
    { id: "wheel", icon: "🎡", label: "幸运大转盘" },
    { id: "draw", icon: "🎁", label: "每月抽奖", subs: [
      { id: "console", label: "抽奖控制台" },
      { id: "test", label: "测试大屏" },
      { id: "claims", label: "领奖追踪" },
    ] },
  ] },
  { group: "🧾 订单", items: [
    { id: "entry", icon: "📝", label: "订单录入" },
    { id: "invoice", icon: "📄", label: "PO / Invoice" },
    { id: "search", icon: "🔍", label: "订单查询" },
    { id: "cod", icon: "📦", label: "COD 手动 AWB 打印" },
    // 打包清单：勾选随单寄出的小礼物、中奖奖品、兑换商品（2026-11-10）
    { id: "pack", icon: "🧺", label: "打包清单" },
  ] },
  { group: "🎫 会员与内容", items: [
    // 会员系统按页面细分；以前整个勾了（member: true）的人，等于下面全部都有
    { id: "member", icon: "🎫", label: "Member Club", subs: [
      { id: "overview", label: "📊 总览" },
      { id: "redeem", label: "🔔 兑换审核" },
      { id: "prizes", label: "🏆 中奖奖品" },
      { id: "members", label: "👥 会员" },
      { id: "newMember", label: "🎉 新会员奖励" },
      { id: "shop", label: "🛍️ 商城" },
      { id: "content", label: "📝 内容" },
      { id: "settings", label: "⚙️ 设定" },
    ] },
    { id: "feed", icon: "📰", label: "Mochii Feed" },
    { id: "gallery", icon: "🖼️", label: "图库管理", subs: [
      { id: "view", label: "查看前台（直播看图）" },
      { id: "upload", label: "管理（上传、更换、删除）" },
    ] },
  ] },
];

// 权限模板：新增人员时一键套用，之后可以再微调
export const PRESETS = [
  { id: "streamer", label: "🎥 主播", perms: { hub: true, wheel: true, draw: { console: true, test: true, claims: true } } },
  { id: "cs", label: "💬 客服", perms: { entry: true, search: true, cod: true, pack: true, member: { redeem: true, prizes: true, members: true } } },
  { id: "all", label: "✅ 全部", perms: "all" },
  { id: "none", label: "⬜ 清空", perms: {} },
];

export const PERM_ITEMS = PERM_TREE.flatMap(g => g.items);

// 会员系统：每一页要哪个权限（Feed 页面看「Mochii Feed」）
export const MEMBER_PAGE_PERM = {
  "index.html": "member.overview", "": "member.overview",
  "redeem.html": "member.redeem",
  "prizes.html": "member.prizes",
  "gifts.html": ["member.prizes", "draw.claims"],   // 🎁 指定小礼物（后端 sgAdmin 同样检查）
  "members.html": "member.members", "member.html": "member.members", "checkin.html": "member.members",
  "newmember.html": "member.newMember",
  "rewards.html": "member.shop", "perks.html": "member.shop",
  "home.html": "member.content", "announcements.html": "member.content", "storehelp.html": "member.content",
  "notify.html": "member.settings", "tiers.html": "member.settings",
  "coupon-check.html": "member.shop",
  "shipping.html": ["member.redeem", "member.prizes"],   // 其中一项就可以
  "pack.html": "pack",            // 🧺 打包管理：要「打包清单」权限（也要能进会员系统）
  "feed.html": "feed",
  "faq.html": "member",           // 📖 客服 FAQ：有任何一项 Member Club 权限就能看
  "changelog.html": "_owner",     // 🕒 更新记录：只有店主（_owner 不会出现在权限勾选里）
};
// 这个人进会员系统时，第一个能打开的页面（都没有就回传 null）
const MEMBER_FIRST = ["index.html", "redeem.html", "prizes.html", "members.html", "newmember.html", "rewards.html", "home.html", "notify.html", "feed.html"];
export function firstMemberPage(access) {
  return MEMBER_FIRST.find(p => can(access, MEMBER_PAGE_PERM[p])) || null;
}

// 名称：「每月抽奖 › 抽奖控制台」
export function permLabel(key) {
  if (key === "staff") return "👥 管理员管理";   // 只有店主
  const [a, b] = String(key || "").split(".");
  const it = PERM_ITEMS.find(x => x.id === a);
  if (!it) return key;
  const s = b && (it.subs || []).find(x => x.id === b);
  return it.label + (s ? " › " + s.label : "");
}

// 全部权限（「全部」模板用）
export function allPerms() {
  const p = {};
  PERM_ITEMS.forEach(it => {
    p[it.id] = it.subs ? Object.fromEntries(it.subs.map(s => [s.id, true])) : true;
  });
  return p;
}

// 有没有这项权限。key：「draw」= 下层任何一项；「draw.console」= 这一项
// perms[x] === true 代表这一项（含全部下层）都有
export function can(access, key) {
  if (!access || !access.ok) return false;
  if (access.owner) return true;
  const [a, b] = String(key).split(".");
  const v = (access.perms || {})[a];
  if (v === true) return true;
  if (!v || typeof v !== "object") return false;
  return b ? v[b] === true : Object.values(v).some(x => x === true);
}

// 勾了几项（管理员列表显示用）
export function countPerms(perms) {
  let n = 0;
  PERM_ITEMS.forEach(it => {
    const v = (perms || {})[it.id];
    if (!it.subs) { if (v) n++; return; }
    if (v === true) n += it.subs.length;
    else if (v && typeof v === "object") n += it.subs.filter(s => v[s.id] === true).length;
  });
  return n;
}
export const TOTAL_PERMS = PERM_ITEMS.reduce((n, it) => n + (it.subs ? it.subs.length : 1), 0);

export const normEmail = s => String(s || "").trim().toLowerCase();
export const isOwnerUser = u => !!u && normEmail(u.email) === OWNER_EMAIL && u.emailVerified === true;

// ---------- 读取这个账号的权限 ----------
// 回传 { ok, owner, email, name, title, perms } 或 { ok:false, reason: none / disabled / error }
export async function getAccess(user) {
  if (!user) return { ok: false, reason: "login" };
  const email = normEmail(user.email);
  if (isOwnerUser(user)) return { ok: true, owner: true, email, name: user.displayName || "店主", title: "店主" };
  try {
    const s = await getDoc(doc(db, "staff", email));
    if (!s.exists()) return { ok: false, reason: "none", email };
    const d = s.data();
    if (d.active === false) return { ok: false, reason: "disabled", email, name: d.name };
    return { ok: true, owner: false, email, name: d.name || user.displayName || email, title: d.title || "", perms: d.perms || {}, uid: d.uid || "" };
  } catch (e) {
    return { ok: false, reason: "error", email, error: e.message };
  }
}

// 登录控制台时记下 UID 和登录时间（店主同步会员系统管理员名单要用 UID）
// 有 Member Club / Feed 权限、还不是会员系统管理员的，自动加进去（Firestore 规则会再检查一次）
export async function recordLogin(user, access) {
  if (!access || !access.ok || access.owner) return;
  try {
    await setDoc(doc(db, "staff", access.email), {
      uid: user.uid, lastLoginAt: serverTimestamp(),
      authName: (user.displayName || "").slice(0, 60), photoURL: user.photoURL || "",
    }, { merge: true });
  } catch (e) { console.warn("recordLogin", e.message); }
  if (can(access, "member") || can(access, "feed")) {
    try {
      const ref = doc(db, "admins", user.uid);
      let has = false;
      try { has = (await getDoc(ref)).exists(); } catch (e) {}
      if (!has) await setDoc(ref, { email: access.email, name: access.name || "", fromStaff: true, createdAt: serverTimestamp() });
    } catch (e) { console.warn("admins 自动加入失败（店主打开管理员页面时会再同步）", e.message); }
  }
}

// ---------- Google 登录 ----------
export async function googleLogin() {
  const p = new GoogleAuthProvider();
  p.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, p);
  } catch (e) {
    // 手机主画面（App 模式）开不了弹出视窗时，改用整页跳转登录
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/web-storage-unsupported"].includes(e.code)) {
      await signInWithRedirect(auth, p);
      return;
    }
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    throw e;
  }
}
export async function logout() { await signOut(auth); }

// ---------- 子页面检查：放在每个子页面的 <head> ----------
//   <script type="module">import { guard } from "/js/admin-guard.js"; guard("wheel");</script>
// 没登录 → 回控制台登录，登录后自动回来；没有权限 → 回控制台并显示提示
// 只有店主能用的按钮：加 class="owner-only" 就会对其他人隐藏；
// 按钮的程式开头加 if (!window.ownerOnly || !window.ownerOnly()) return; 再挡一次
// 会员系统的页面不走 guard()，在确认权限后呼叫 setupOwnerOnly(是不是店主)
export function setupOwnerOnly(isOwner) {
  ownerOnlySetup();
  window.__isOwner = !!isOwner;
  document.documentElement.classList.toggle("is-owner", !!isOwner);
}
function ownerOnlySetup() {
  if (document.getElementById("ownerOnlyCss")) return;
  const st = document.createElement("style");
  st.id = "ownerOnlyCss";
  st.textContent = "html:not(.is-owner) .owner-only { display: none !important; }";
  document.head.appendChild(st);
  window.__isOwner = false;
  window.ownerOnly = () => {
    if (window.__isOwner === true) return true;
    alert("🔒 只有店主可以删除。");
    return false;
  };
}

export function guard(key) {
  const root = document.documentElement;
  root.style.visibility = "hidden";
  ownerOnlySetup();
  let first = true;
  return new Promise(resolve => {
    onAuthStateChanged(auth, async user => {
      const back = why => {
        const here = location.pathname + location.search + location.hash;
        location.replace("/?" + why + "=" + encodeURIComponent(key) + "&next=" + encodeURIComponent(here));
      };
      if (!user) { back("login"); return; }
      if (!first) return;   // 已经通过的页面，不重复检查
      const a = await getAccess(user);
      if (!can(a, key)) { back("denied"); return; }
      first = false;
      window.__isOwner = !!a.owner;
      root.classList.toggle("is-owner", !!a.owner);
      root.style.visibility = "";
      resolve(a);
    });
  });
}
