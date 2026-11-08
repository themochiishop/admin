// 📤 发送给会员前的共用工具
//   previewSend(opts)  — 发送前预览：会员会看到什么（中文 / EN / BM），按「确认发送」才回传 true
//   confirmSimple(msg) — 简单确认（不含留言的操作）
//   memberPicker(el)   — 👥 选择会员（可多选、可贴上一串平台用户名自动对应）
import { auth, db } from "./firebase-config.js";
import { esc, platformTag, normalizeUsername } from "./admin-common.js";
import { normNote } from "./note-i18n.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

// ---------- 样式（只放一次） ----------
function injectStyle() {
  if (document.getElementById("sendToolsCss")) return;
  const css = document.createElement("style");
  css.id = "sendToolsCss";
  css.textContent = `
  .ps-scrim { position: fixed; inset: 0; z-index: 95; background: rgba(15,23,42,.55); display: flex; align-items: center; justify-content: center; padding: 16px; }
  .ps-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; width: 100%; max-width: 520px; max-height: 88vh; overflow-y: auto; padding: 18px; }
  .ps-card h3 { font-size: 1.02rem; color: var(--ink); margin-bottom: 2px; }
  .ps-to { font-size: .84rem; color: var(--text2); margin-bottom: 10px; }
  .ps-rows { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 12px; }
  .ps-rows div { display: flex; gap: 10px; padding: 8px 12px; font-size: .86rem; border-bottom: 1px solid var(--soft); }
  .ps-rows div:last-child { border-bottom: none; }
  .ps-rows b { flex: 0 0 92px; color: var(--muted); font-weight: 600; }
  .ps-rows span { flex: 1; min-width: 0; color: var(--ink); word-break: break-word; }
  .ps-langs { display: flex; gap: 6px; margin-bottom: 6px; }
  .ps-langs button { padding: 4px 12px; border-radius: 999px; border: 1px solid var(--line2); background: var(--card); color: var(--text2); font-size: .8rem; font-weight: 700; cursor: pointer; }
  .ps-langs button.on { background: #db2777; border-color: #db2777; color: #fff; }
  .ps-bubble { background: var(--pink-bg); border: 1px solid var(--pink-bg2); border-radius: 10px; padding: 10px 12px; font-size: .9rem; color: var(--ink); white-space: pre-wrap; min-height: 2.4em; }
  .ps-fb { font-size: .74rem; color: var(--amber-tx); margin-top: 4px; }
  .ps-empty { color: var(--faint); font-style: italic; }
  .ps-warn { background: var(--amber-bg); border: 1px solid var(--amber-bg2); color: var(--amber-tx); border-radius: 8px; padding: 8px 10px; font-size: .82rem; margin-bottom: 10px; }
  .mp { position: relative; }
  .mp-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
  .mp-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--pink-bg2); color: var(--pink-tx); border-radius: 999px; padding: 3px 4px 3px 10px; font-size: .8rem; font-weight: 700; }
  .mp-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: .8rem; padding: 0 4px; }
  .mp-res { position: absolute; left: 0; right: 0; top: 100%; z-index: 30; background: var(--card); border: 1px solid var(--line2); border-radius: 10px; box-shadow: 0 8px 20px var(--shadow); max-height: 280px; overflow-y: auto; }
  .mp-res button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 8px 12px; font-size: .85rem; color: var(--ink); cursor: pointer; border-bottom: 1px solid var(--soft); }
  .mp-res button:hover { background: var(--soft); }
  .mp-res small { color: var(--muted); }
  .mp-tools { display: flex; flex-wrap: wrap; gap: 6px; }
  .mp-tools .btn { padding: 5px 10px; font-size: .8rem; }
  .mp-paste textarea { margin-top: 6px; font-size: .85rem; }
  .mp-miss { font-size: .8rem; color: var(--red-tx); margin-top: 4px; word-break: break-word; }
  `;
  document.head.appendChild(css);
}

// ---------- 📤 发送前预览 ----------
// opts: { title, to, rows: [[标签, 文字]], note: {zh,en,ms} | 字符串 | null, noteLabel, warn, okText, danger }
//   rows 的文字会自动转义；note 显示成会员看到的留言泡泡，可切换语言看看（没翻译 = 会员看到中文）
export function previewSend(opts = {}) {
  injectStyle();
  const note = opts.note === undefined || opts.note === null ? null : normNote(opts.note);
  return new Promise(resolve => {
    const wrap = document.createElement("div");
    wrap.className = "ps-scrim";
    const rows = (opts.rows || []).filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== "");
    wrap.innerHTML = `
      <div class="ps-card" role="dialog" aria-modal="true">
        <h3>📤 ${esc(opts.title || "确认发送给会员")}</h3>
        ${opts.to ? `<div class="ps-to">发送给：<b>${esc(opts.to)}</b></div>` : ""}
        ${opts.warn ? `<div class="ps-warn">⚠️ ${esc(opts.warn)}</div>` : ""}
        ${rows.length ? `<div class="ps-rows">${rows.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("")}</div>` : ""}
        ${note ? `
          <div style="font-size:.8rem;color:var(--muted);margin-bottom:4px">${esc(opts.noteLabel || "会员看到的留言")}</div>
          <div class="ps-langs">${["zh", "en", "ms"].map((l, i) => `<button type="button" data-l="${l}" class="${i ? "" : "on"}">${{ zh: "中文", en: "EN", ms: "BM" }[l]}</button>`).join("")}</div>
          <div class="ps-bubble" id="psBubble"></div><div class="ps-fb" id="psFb"></div>` : ""}
        <div class="actions" style="margin-top:14px">
          <button type="button" class="btn ${opts.danger ? "btn-bad" : "btn-primary"}" data-ps="ok">${esc(opts.okText || "✅ 确认发送")}</button>
          <button type="button" class="btn btn-ghost" data-ps="back">✏️ 返回修改</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const show = l => {
      if (!note) return;
      wrap.querySelectorAll(".ps-langs button").forEach(b => b.classList.toggle("on", b.dataset.l === l));
      const txt = note[l] || note.zh;
      const bub = wrap.querySelector("#psBubble");
      bub.innerHTML = txt ? esc(txt) : `<span class="ps-empty">（没有留言）</span>`;
      wrap.querySelector("#psFb").textContent = l !== "zh" && !note[l] && note.zh ? `没有填${l === "en" ? "英文" : "马来文"}，选这个语言的会员会看到中文` : "";
    };
    show("zh");
    const done = v => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = e => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", e => {
      if (e.target === wrap) return done(false);
      const l = e.target.closest("[data-l]");
      if (l) return show(l.dataset.l);
      const b = e.target.closest("[data-ps]");
      if (b) done(b.dataset.ps === "ok");
    });
    wrap.querySelector('[data-ps="ok"]').focus();
  });
}

// 🟡 简单确认（标记完成、配送异常…）：跟 confirm() 一样，只是统一样式
export function confirmSimple(text, okText = "确认") {
  return previewSend({ title: text, okText });
}

// ---------- 👥 选择会员 ----------
let cache = null;   // { members: {uid: 资料}, bindings: [{uid, platform, username}] }
export async function loadMemberIndex(force = false) {
  if (cache && !force) return cache;
  const [mS, bS] = await Promise.all([getDocs(collection(db, "members")), getDocs(collection(db, "bindings"))]);
  const members = {};
  mS.docs.forEach(d => { members[d.id] = d.data(); });
  const bindings = bS.docs.map(d => d.data()).filter(b => b.uid && members[b.uid]);
  cache = { members, bindings };
  return cache;
}

// opts: { onChange(uids), placeholder }
// 回传 { get(): uid[], set(uids), clear(), names(): "A、B…" }
export function memberPicker(el, opts = {}) {
  injectStyle();
  let picked = [];
  el.classList.add("mp");
  el.innerHTML = `
    <input type="search" class="mp-q" placeholder="${esc(opts.placeholder || "🔍 搜索会员：名字、Email、平台用户名")}" autocomplete="off">
    <div class="mp-res hidden"></div>
    <div class="mp-chips"></div>
    <div class="mp-tools">
      <button type="button" class="btn btn-ghost" data-mp="paste">📋 贴上用户名（批量）</button>
      <button type="button" class="btn btn-ghost" data-mp="me">🧪 只选我自己（测试）</button>
      <button type="button" class="btn btn-ghost" data-mp="clear">清空</button>
    </div>
    <div class="mp-paste hidden">
      <textarea rows="4" placeholder="一行一个（或用逗号、空格分开）：平台用户名、会员名字或 Email&#10;例如直播游戏参与者的 Shopee / TikTok 用户名"></textarea>
      <div class="actions" style="margin-top:6px"><button type="button" class="btn btn-primary" data-mp="match">➕ 对应并加入</button></div>
      <div class="mp-miss"></div>
    </div>`;
  const $q = el.querySelector(".mp-q"), $res = el.querySelector(".mp-res"), $chips = el.querySelector(".mp-chips");
  const label = (c, uid) => (c.members[uid] || {}).name || "(没有名字)";
  const accountsOf = (c, uid) => c.bindings.filter(b => b.uid === uid);
  function changed(notify = true) {
    const c = cache;
    $chips.innerHTML = picked.map(uid => `<span class="mp-chip">${esc(c ? label(c, uid) : uid)}<button type="button" data-rm="${esc(uid)}" title="移除">✕</button></span>`).join("")
      + (picked.length ? `<span class="meta" style="align-self:center">共 ${picked.length} 位</span>` : "");
    if (notify && opts.onChange) opts.onChange(picked.slice());
  }
  const add = uids => { uids.forEach(u => { if (u && !picked.includes(u)) picked.push(u); }); changed(); };
  async function search() {
    const q = $q.value.trim().toLowerCase();
    if (!q) { $res.classList.add("hidden"); return; }
    const c = await loadMemberIndex();
    const hit = Object.entries(c.members).filter(([uid, m]) =>
      (m.name || "").toLowerCase().includes(q) || (m.email || "").toLowerCase().includes(q)
      || accountsOf(c, uid).some(b => (b.username || "").toLowerCase().includes(q))).slice(0, 10);
    $res.innerHTML = hit.length ? hit.map(([uid, m]) => `<button type="button" data-add="${esc(uid)}">
        <b>${esc(m.name || "(没有名字)")}</b> ${picked.includes(uid) ? "✓" : ""}<br>
        <small>${esc(m.email || "")} ${accountsOf(c, uid).map(b => platformTag(b.platform) + " " + esc(b.username)).join(" ")}</small></button>`).join("")
      : `<div class="meta" style="padding:8px 12px">找不到会员</div>`;
    $res.classList.remove("hidden");
  }
  let tm = 0;
  $q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => search().catch(e => console.warn(e)), 150); });
  $q.addEventListener("focus", () => loadMemberIndex().catch(e => console.warn("members", e)));
  document.addEventListener("click", e => { if (!el.contains(e.target)) $res.classList.add("hidden"); });
  el.addEventListener("click", async e => {
    const a = e.target.closest("[data-add]");
    if (a) { add([a.dataset.add]); $q.value = ""; $res.classList.add("hidden"); $q.focus(); return; }
    const rm = e.target.closest("[data-rm]");
    if (rm) { picked = picked.filter(u => u !== rm.dataset.rm); changed(); return; }
    const b = e.target.closest("[data-mp]");
    if (!b) return;
    const act = b.dataset.mp;
    if (act === "paste") el.querySelector(".mp-paste").classList.toggle("hidden");
    if (act === "clear") { picked = []; changed(); }
    if (act === "me") {
      const c = await loadMemberIndex();
      const me = auth.currentUser && auth.currentUser.uid;
      if (!me || !c.members[me]) { alert("你这个管理员账号还没有在前台注册会员，没办法只发给自己。\n请先用同一个 Google 账号登录会员俱乐部一次。"); return; }
      picked = [me]; changed();
    }
    if (act === "match") {
      const c = await loadMemberIndex();
      const words = el.querySelector(".mp-paste textarea").value.split(/[\n,，、\t]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
      const found = [], miss = [];
      words.forEach(w => {
        const u = normalizeUsername(w), lw = w.toLowerCase();
        const b = c.bindings.find(x => normalizeUsername(x.username) === u);
        const m = b ? b.uid : (Object.entries(c.members).find(([, m]) => (m.email || "").toLowerCase() === lw || (m.name || "").toLowerCase() === lw) || [])[0];
        if (m) found.push(m); else miss.push(w);
      });
      add(found);
      el.querySelector(".mp-miss").textContent = (found.length ? `✅ 已加入 ${new Set(found).size} 位。` : "")
        + (miss.length ? ` 找不到（可能还没注册 / 还没关联平台）：${miss.join("、")}` : "");
    }
  });
  changed(false);   // 第一次画出来时不回报（呼叫的页面这时可能还没准备好，例如会员公告页）
  return {
    get: () => picked.slice(),
    set: uids => { picked = [...new Set(uids)]; loadMemberIndex().then(changed).catch(changed); },
    clear: () => { picked = []; changed(); el.querySelector(".mp-paste textarea").value = ""; el.querySelector(".mp-miss").textContent = ""; },
    names: () => cache ? picked.map(u => label(cache, u)).join("、") : `${picked.length} 位会员`,
  };
}
