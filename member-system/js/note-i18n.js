// 🌐 三语留言：中文（必填的原文）+ EN / BM（选填，留空会员就看到中文）
// 存进资料库：note（中文）+ noteI18n: { en, ms }
// 常用句子（一键选，三种语言一起带入）存在 adminSettings/noteSets，只有管理员看得到
import { db } from "./firebase-config.js";
import { esc, logAdmin } from "./admin-common.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

export const NOTE_MAX = 200;
const clip = s => String(s ?? "").trim().slice(0, NOTE_MAX);

// 字符串（旧资料）或 {zh,en,ms} → {zh,en,ms}
export function normNote(x) {
  if (!x) return { zh: "", en: "", ms: "" };
  if (typeof x === "string") return { zh: clip(x), en: "", ms: "" };
  return { zh: clip(x.zh), en: clip(x.en), ms: clip(x.ms) };
}
// 资料库里的 note + noteI18n → {zh,en,ms}
export function noteFromDoc(note, i18n) {
  const o = i18n && typeof i18n === "object" ? i18n : {};
  return { zh: clip(note), en: clip(o.en), ms: clip(o.ms) };
}
// {zh,en,ms} → 要写进资料库的栏位（没有翻译就是 null，方便用来删掉旧翻译）
export function noteFields(n) {
  const v = normNote(n);
  const i18n = {};
  if (v.en) i18n.en = v.en;
  if (v.ms) i18n.ms = v.ms;
  return { note: v.zh || v.en || v.ms, noteI18n: Object.keys(i18n).length ? i18n : null };
}
// 后台列表显示：中文 + 小小的 EN / BM 标记
export function noteBadge(note, i18n) {
  const v = noteFromDoc(note, i18n);
  const tags = [v.en && "EN", v.ms && "BM"].filter(Boolean);
  return esc(v.zh || v.en || v.ms) + (tags.length ? ` <span class="nt-lang" title="${esc([v.en && "EN: " + v.en, v.ms && "BM: " + v.ms].filter(Boolean).join("\n"))}">🌐 ${tags.join(" · ")}</span>` : "");
}

// ---------- 常用句子 ----------
// 每一组（group）各有一份清单：prize 中奖留言 / review 审核备注 / ship 发货留言
const SETS = {};
export const DEFAULT_SETS = {
  review: [
    { zh: "已批准，谢谢你的支持 💕", en: "Approved — thank you for your support 💕", ms: "Diluluskan — terima kasih atas sokongan anda 💕" },
    { zh: "积分不足，请累积更多积分后再兑换", en: "Not enough points. Please redeem again once you have collected more points.", ms: "Mata tidak mencukupi. Sila tebus semula selepas mengumpul lebih banyak mata." },
    { zh: "此奖品已兑完，积分已退回", en: "This reward is out of stock. Your points have been returned.", ms: "Ganjaran ini telah habis. Mata anda telah dikembalikan." },
  ],
  ship: [
    { zh: "已放在你的包裹里 🎁", en: "It's packed in your parcel 🎁", ms: "Sudah dimasukkan dalam bungkusan anda 🎁" },
    { zh: "已加送一个小礼物 🎁", en: "We added a little extra gift 🎁", ms: "Kami tambah hadiah kecil untuk anda 🎁" },
  ],
};
export function getSet(group) { return SETS[group] || []; }
export async function loadNoteSets() {
  let d = {};
  try {
    const s = await getDoc(doc(db, "adminSettings", "noteSets"));
    if (s.exists()) d = s.data() || {};
  } catch (e) { console.warn("noteSets", e.message); }
  Object.keys(DEFAULT_SETS).forEach(g => {
    SETS[g] = Array.isArray(d[g]) ? d[g].map(normNote).filter(x => x.zh) : DEFAULT_SETS[g].map(normNote);
  });
  refreshPickers();
}
// 中奖奖品的清单在 prizes.html 自己管（settings/prizeNotes），这里只是让选单能用
export function setSet(group, list) { SETS[group] = list.map(normNote).filter(x => x.zh); refreshPickers(group); }

function pickOpts(group) {
  const list = getSet(group);
  return `<option value="">📋 常用</option>` + list.map((x, i) =>
    `<option value="${i}">${esc(x.zh.length > 28 ? x.zh.slice(0, 28) + "…" : x.zh)}${x.en || x.ms ? " 🌐" : ""}</option>`).join("");
}
function refreshPickers(group) {
  document.querySelectorAll(".nt-pick").forEach(s => {
    if (!group || s.dataset.group === group) s.innerHTML = pickOpts(s.dataset.group);
  });
}

// ---------- 留言框 ----------
// opts: { group, value: {zh,en,ms}, placeholder, cls }
export function noteBoxHTML(opts = {}) {
  const v = normNote(opts.value);
  const open = v.en || v.ms;
  return `<div class="nt ${esc(opts.cls || "")}" data-group="${esc(opts.group || "")}">
    <div class="nt-row">
      <input data-nt="zh" maxlength="${NOTE_MAX}" value="${esc(v.zh)}" placeholder="${esc(opts.placeholder || "留言（选填，会员看得到）")}">
      ${opts.group ? `<select class="nt-pick" data-group="${esc(opts.group)}" title="一键带入常用句子（三种语言）">${pickOpts(opts.group)}</select>` : ""}
      <button type="button" class="nt-tg${open ? " on" : ""}" title="填英文 / 马来文（选填）">🌐<span>${open ? [v.en && "EN", v.ms && "BM"].filter(Boolean).join("·") : "EN·BM"}</span></button>
      ${opts.group ? `<button type="button" class="nt-mgr" data-group="${esc(opts.group)}" title="管理常用句子">⚙️</button>` : ""}
    </div>
    <div class="nt-more${open ? "" : " hidden"}">
      <label><span>EN</span><input data-nt="en" maxlength="${NOTE_MAX}" value="${esc(v.en)}" placeholder="English（留空 = 英文会员看到中文）"></label>
      <label><span>BM</span><input data-nt="ms" maxlength="${NOTE_MAX}" value="${esc(v.ms)}" placeholder="Bahasa Melayu（留空 = 看到中文）"></label>
    </div>
  </div>`;
}
const box = root => root && (root.classList && root.classList.contains("nt") ? root : root.querySelector(".nt"));
export function readNoteBox(root) {
  const b = box(root);
  if (!b) return normNote("");
  const g = k => (b.querySelector(`[data-nt="${k}"]`) || {}).value || "";
  return normNote({ zh: g("zh"), en: g("en"), ms: g("ms") });
}
export function setNoteBox(root, val) {
  const b = box(root);
  if (!b) return;
  const v = normNote(val);
  ["zh", "en", "ms"].forEach(k => { const el = b.querySelector(`[data-nt="${k}"]`); if (el) el.value = v[k]; });
  syncTg(b);
  if (v.en || v.ms) b.querySelector(".nt-more").classList.remove("hidden");
}
function syncTg(b) {
  const v = readNoteBox(b);
  const tg = b.querySelector(".nt-tg");
  const tags = [v.en && "EN", v.ms && "BM"].filter(Boolean);
  tg.classList.toggle("on", tags.length > 0);
  tg.querySelector("span").textContent = tags.length ? tags.join("·") : "EN·BM";
  // 填了中文、但还没翻译 → 小提示
  tg.classList.toggle("need", !!v.zh && !tags.length);
}

// 全页共用的事件（只绑一次）
let bound = false;
export function bindNoteBoxes() {
  if (bound) return;
  bound = true;
  document.addEventListener("click", e => {
    const tg = e.target.closest(".nt-tg");
    if (tg) {
      const more = tg.closest(".nt").querySelector(".nt-more");
      more.classList.toggle("hidden");
      if (!more.classList.contains("hidden")) more.querySelector("input").focus();
      return;
    }
    const mg = e.target.closest(".nt-mgr");
    if (mg) openManager(mg.dataset.group);
  });
  document.addEventListener("change", e => {
    const s = e.target.closest(".nt-pick");
    if (!s || s.value === "") return;
    const item = getSet(s.dataset.group)[Number(s.value)];
    s.value = "";
    if (item) { setNoteBox(s.closest(".nt"), item); s.closest(".nt").querySelector('[data-nt="zh"]').focus(); }
  });
  document.addEventListener("input", e => {
    if (e.target.matches && e.target.matches(".nt [data-nt]")) syncTg(e.target.closest(".nt"));
  });
}

// ---------- ⚙️ 管理常用句子（审核备注 / 发货留言） ----------
const GROUP_LABEL = { review: "审核备注", ship: "发货留言", prize: "中奖留言" };
let customManager = {};   // 某些组自己管理（例如 prizes.html），给它一个函数
export function setManager(group, fn) { customManager[group] = fn; }
export function rowHTML(v) {
  const x = normNote(v);
  return `<div class="ntm-row">
    <div class="ntm-in">
      <input data-nt="zh" maxlength="${NOTE_MAX}" value="${esc(x.zh)}" placeholder="中文">
      <input data-nt="en" maxlength="${NOTE_MAX}" value="${esc(x.en)}" placeholder="English（选填）">
      <input data-nt="ms" maxlength="${NOTE_MAX}" value="${esc(x.ms)}" placeholder="Bahasa Melayu（选填）">
    </div>
    <div class="ntm-btn">
      <button type="button" class="btn btn-ghost" data-ntm="up" title="上移">↑</button>
      <button type="button" class="btn btn-ghost" data-ntm="del" title="删除">✕</button>
    </div>
  </div>`;
}
export function readRow(row) {
  const g = k => (row.querySelector(`[data-nt="${k}"]`) || {}).value || "";
  return normNote({ zh: g("zh"), en: g("en"), ms: g("ms") });
}
export function bindRowList(list) {
  list.addEventListener("click", e => {
    const b = e.target.closest("[data-ntm]");
    if (!b) return;
    const row = b.closest(".ntm-row");
    if (b.dataset.ntm === "del") row.remove();
    if (b.dataset.ntm === "up" && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
  });
}
function openManager(group) {
  if (customManager[group]) return customManager[group]();
  let dlg = document.getElementById("ntmDlg");
  if (!dlg) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="ntm-scrim hidden" id="ntmDlg">
        <div class="ntm-card">
          <h3 id="ntmTitle"></h3>
          <p class="meta" style="margin:0 0 10px">一行一句：中文必填，EN / BM 选填（留空的语言，会员会看到中文）。</p>
          <div id="ntmList"></div>
          <div class="actions">
            <button type="button" class="btn btn-ghost" id="ntmAdd">➕ 添加一句</button>
            <button type="button" class="btn btn-primary" id="ntmSave">💾 保存</button>
            <button type="button" class="btn btn-ghost" id="ntmClose">关闭</button>
          </div>
          <p class="msg" id="ntmMsg"></p>
        </div>
      </div>`);
    dlg = document.getElementById("ntmDlg");
    const list = document.getElementById("ntmList");
    bindRowList(list);
    document.getElementById("ntmAdd").addEventListener("click", () => {
      list.insertAdjacentHTML("beforeend", rowHTML(""));
      list.lastElementChild.querySelector("input").focus();
    });
    document.getElementById("ntmClose").addEventListener("click", () => dlg.classList.add("hidden"));
    dlg.addEventListener("click", e => { if (e.target === dlg) dlg.classList.add("hidden"); });
    document.getElementById("ntmSave").addEventListener("click", async () => {
      const g = dlg.dataset.group;
      const msg = document.getElementById("ntmMsg");
      const next = [...list.querySelectorAll(".ntm-row")].map(readRow).filter(x => x.zh);
      const btn = document.getElementById("ntmSave");
      btn.disabled = true;
      try {
        await setDoc(doc(db, "adminSettings", "noteSets"), { [g]: next, updatedAt: serverTimestamp() }, { merge: true });
        logAdmin("settings", `修改了常用${GROUP_LABEL[g] || "留言"}`, location.pathname.split("/").pop());
        SETS[g] = next; refreshPickers(g);
        list.innerHTML = next.map(rowHTML).join("");
        msg.textContent = "已保存 ✅"; msg.className = "msg ok";
      } catch (err) { msg.textContent = "保存失败：" + err.message; msg.className = "msg err"; }
      finally { btn.disabled = false; }
    });
  }
  dlg.dataset.group = group;
  document.getElementById("ntmTitle").textContent = `⚙️ 常用${GROUP_LABEL[group] || "留言"}`;
  document.getElementById("ntmList").innerHTML = getSet(group).map(rowHTML).join("") || rowHTML("");
  document.getElementById("ntmMsg").textContent = "";
  dlg.classList.remove("hidden");
}
