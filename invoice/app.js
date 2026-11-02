// =====================================================================
//  MOCHII SHOP · PO / Invoice
//  - 资料先存在这台设备（草稿），登录管理员后：客户/供应商名单、常用货品、
//    单据记录存到 Firebase（member-system 项目），手机和电脑同步
// =====================================================================

// ---------- 店铺资料（改这里，两张单都会一起改） ----------
const COMPANY = {
  name: "MOCHII SHOP",
  reg: "202503305565",
  tin: "D60478876020",
  addr: ["36 JALAN SS 8/4, TAMAN SRI SAUJANA", "81900 KOTA TINGGI, JOHOR"],
  tel: "017-750 3767",
  email: "mail@themochiishop.com",
  web: "themochiishop.com",
};
const DELIVER_DEFAULT = {
  name: "MOCHII SHOP", a1: "36 JALAN SS 8/4", a2: "TAMAN SRI SAUJANA",
  postcode: "81900", city: "KOTA TINGGI", state: "JOHOR", attn: "MAH KIEN LOONG", phone: "017-750 3767",
};
const PO_PAY_DEFAULT = "From: MOCHII SHOP (Maybank) 5013 3855 4207\nTo: ";
const PO_TNC_DEFAULT =
  "1. Goods must match the description, quantity and price stated in this purchase order.\n" +
  "2. Defective or incorrect items may be returned for replacement or refund.";
const INV_PAY_DEFAULT =
  "Bank: Maybank\nAccount name: MOCHII SHOP\nAccount no.: 5013 3855 4207\n" +
  "Please send the payment receipt to WhatsApp 017-750 3767.\nThank you for supporting Mochii Shop!";
const STATES = ["JOHOR", "MELAKA", "NEGERI SEMBILAN", "SELANGOR", "KUALA LUMPUR", "PUTRAJAYA", "PULAU PINANG",
  "PERAK", "PAHANG", "KEDAH", "KELANTAN", "TERENGGANU", "PERLIS", "SABAH", "SARAWAK", "LABUAN"];

const PREFIX = { po: "PO-", inv: "INV-" };
const SAFE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";   // 不用 0 O 1 I L
const STORE_KEY = "mochii_docs_v12";
const SHEET_H = 1060;                              // A4 比例（750 宽）
const FB = "https://www.gstatic.com/firebasejs/11.0.2/";

// ---------- 小工具 ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
const round2 = n => Math.round(n * 100) / 100;
const fmt = v => num(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const p2 = n => String(n).padStart(2, "0");
const dstr = d => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
const today = () => dstr(new Date());
function parseD(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const blankRow = () => ({ desc: "", qty: 1, price: "" });
const randNo = t => PREFIX[t] + Array.from(crypto.getRandomValues(new Uint32Array(6)), x => SAFE[x % SAFE.length]).join("");
let toastTimer;
function toast(msg, ms = 2600) {
  const el = $("#toast");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------- 英文大写金额 ----------
const ONES = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE",
  "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
function under1000(n) {
  const out = [];
  if (n >= 100) { out.push(ONES[Math.floor(n / 100)] + " HUNDRED"); n %= 100; }
  if (n >= 20) out.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : ""));
  else if (n > 0) out.push(ONES[n]);
  return out.join(" ");
}
function toWords(n) {
  if (!n) return "ZERO";
  const out = [];
  for (const [v, w] of [[1e9, "BILLION"], [1e6, "MILLION"], [1e3, "THOUSAND"]]) {
    if (n >= v) { out.push(under1000(Math.floor(n / v)) + " " + w); n %= v; }
  }
  if (n) out.push(under1000(n));
  return out.join(" ");
}
function amountWords(total) {
  const cents = Math.round(total * 100);
  if (cents <= 0) return "";
  const rm = Math.floor(cents / 100), sen = cents % 100;
  let s = "RINGGIT MALAYSIA ";
  if (rm) s += toWords(rm);
  if (sen) s += (rm ? " AND " : "") + "SEN " + toWords(sen);
  return s + " ONLY";
}

// ---------- 状态 ----------
function newState(t) {
  const base = { no: randNo(t), date: today(), shipping: "", other: "", rows: [blankRow()], savedNo: null };
  if (t === "po") return {
    ...base, delivery: "", req: "MAH KIEN LOONG", terms: "Bank transfer · upon delivery", ref: "",
    payNote: PO_PAY_DEFAULT, tnc: PO_TNC_DEFAULT, vendor: {}, deliver: { ...DELIVER_DEFAULT },
  };
  return { ...base, due: "Due upon receipt", payNote: INV_PAY_DEFAULT, paid: false, bill: {}, shipSame: true, ship: {} };
}
const state = { tab: "inv", po: newState("po"), inv: newState("inv") };
function loadDraft() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!s) return;
    if (s.po) state.po = { ...newState("po"), ...s.po };
    if (s.inv) state.inv = { ...newState("inv"), ...s.inv };
    if (s.tab === "po" || s.tab === "inv") state.tab = s.tab;
  } catch (e) { console.warn("草稿载入失败", e); }
}
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }, 250);
}

// ---------- 纸张模板 ----------
function partyCol(key, label) {
  return `<div class="pcol">${key === "ship" ? `<div class="paid-stamp" id="paid-inv">PAID</div>` : ""}
    <div class="bar"><span>${label}</span><span class="hint no-pdf">✎ 点击编辑</span></div>
    <div class="box party" data-party="${key}" tabindex="0" role="button"></div></div>`;
}
function dateCell(f, withToday = true) {
  return `<div class="cf"><input data-f="${f}" placeholder="dd/mm/yyyy" autocomplete="off">${withToday ? `<button type="button" class="mini no-pdf" data-today="${f}">今天</button>` : ""}</div>`;
}
function sheetHTML(t) {
  const po = t === "po", C = COMPANY;
  return `
  <div class="sheet-body">
    <div class="grid">
      <div class="co">
        <img src="logo.png" class="logo" alt="">
        <div>
          <div class="co-name">${C.name}</div>
          <div class="co-sub">Reg. No. ${C.reg} · TIN: ${C.tin}</div>
          <div class="co-addr">${C.addr.join("<br>")}<br>Tel / WhatsApp: ${C.tel}<br>${C.email} · ${C.web}</div>
        </div>
      </div>
      <div>
        <div class="doc-title">${po ? "PURCHASE ORDER" : "INVOICE"}</div>
        <table class="meta">
          <tr><th>DATE</th><td>${dateCell("date")}</td></tr>
          <tr><th>${po ? "PO NO." : "INVOICE NO."}</th><td><div class="cf"><input data-f="no" class="b" autocomplete="off"><button type="button" class="mini no-pdf" data-act="dice" title="重新生成单号">🎲</button></div></td></tr>
          ${po ? `<tr><th>DELIVERY DATE</th><td>${dateCell("delivery")}</td></tr>`
               : `<tr><th>DUE DATE</th><td>${dateCell("due", false)}</td></tr>`}
        </table>
        ${po ? "" : `<div class="quick no-pdf"><span>到期：</span>
          <button type="button" data-due="0">收到即付</button><button type="button" data-due="7">+7 天</button>
          <button type="button" data-due="14">+14 天</button><button type="button" data-due="30">+30 天</button>
          <label class="paid-chk"><input type="checkbox" data-f="paid"> 已付款（盖 PAID 章）</label></div>`}
      </div>
    </div>

    <div class="grid mt">
      ${partyCol(po ? "vendor" : "bill", po ? "VENDOR" : "BILL TO")}
      ${partyCol(po ? "deliver" : "ship", po ? "DELIVER TO" : "SHIP TO")}
    </div>

    ${po ? `<table class="tri mt">
      <tr><th>REQUISITIONER</th><th>PAYMENT TERMS</th><th>REFERENCE</th></tr>
      <tr><td><input data-f="req" autocomplete="off"></td><td><input data-f="terms" autocomplete="off"></td><td><input data-f="ref" autocomplete="off"></td></tr>
    </table>` : ""}

    <table class="items mt">
      <colgroup><col style="width:9%"><col style="width:49%"><col style="width:10%"><col style="width:16%"><col style="width:16%"></colgroup>
      <thead><tr><th>NO.</th><th class="l">DESCRIPTION</th><th>QTY</th><th class="r">UNIT PRICE (RM)</th><th class="r">AMOUNT (RM)</th></tr></thead>
      <tbody></tbody>
    </table>
    <button type="button" class="add-row no-pdf" data-act="addRow">＋ 添加一行</button>

    <div class="grid mt">
      <div>
        <div class="bar">${po ? "PAYMENT TO VENDOR" : "PAYMENT DETAILS"}</div>
        <div class="box"><textarea data-f="payNote" rows="2"></textarea></div>
        ${po ? `<div class="bar mt-s">TERMS AND CONDITIONS</div><div class="box"><textarea data-f="tnc" rows="2"></textarea></div>` : ""}
      </div>
      <div>
        <table class="totals">
          <tr><th>SUBTOTAL</th><td data-sum="sub">0.00</td></tr>
          <tr><th>SST <span class="na">(Not Applicable)</span></th><td>-</td></tr>
          <tr><th>SHIPPING</th><td><input data-f="shipping" class="money" type="number" step="0.01" min="0" placeholder="0.00" inputmode="decimal"></td></tr>
          <tr><th>OTHER</th><td><input data-f="other" class="money" type="number" step="0.01" placeholder="0.00" inputmode="decimal"></td></tr>
          <tr class="grand"><th>TOTAL</th><td data-sum="total">RM 0.00</td></tr>
        </table>
      </div>
    </div>
    <div class="words mt-s"><b>AMOUNT IN WORDS:</b> <span data-sum="words">-</span></div>

    <div class="sign">
      <div>
        <div class="st">${po ? "Accepted by vendor:" : "Received by:"}</div>
        <div class="sp"></div><div class="sl"></div>
        <div class="sm">Name:</div><div class="sm">Date:</div>
      </div>
      <div class="sign-r">
        <div class="st">${po ? "Authorized by:" : "Authorized signature:"}</div>
        <div class="sp stamp"><img src="signcop.png" alt=""></div><div class="sl"></div>
        <div class="sm">${C.name}</div><div class="sm">Date: <span data-bind="date"></span></div>
      </div>
    </div>
  </div>
  <div class="foot">
    <div>${po ? "" : "Goods sold are non-refundable and non-exchangeable.<br>"}For any enquiries about this ${po ? "purchase order" : "invoice"}, please contact us on WhatsApp ${C.tel}.</div>
    <div class="pg">Page 1 of 1</div>
  </div>`;
}

// ---------- 画面 ----------
const sheetOf = t => $(`#sheet-${t}`);
function autosize(el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; }

function build(t) {
  sheetOf(t).innerHTML = sheetHTML(t);
  fill(t);
}
function fill(t) {
  const s = state[t], sh = sheetOf(t);
  $$("[data-f]", sh).forEach(el => {
    const f = el.dataset.f;
    if (el.type === "checkbox") el.checked = !!s[f]; else el.value = s[f] ?? "";
  });
  $$("textarea", sh).forEach(autosize);
  renderParties(t); renderRows(t); syncBinds(t); calc(t);
}
function syncBinds(t) {
  $$('[data-bind="date"]', sheetOf(t)).forEach(e => { e.textContent = state[t].date || ""; });
  if (t === "inv") $("#paid-inv").classList.toggle("on", !!state.inv.paid);
}
function setField(t, f, v) {
  state[t][f] = v;
  const el = $(`[data-f="${f}"]`, sheetOf(t));
  if (el) el.value = v;
  syncBinds(t); persist();
}

function renderParties(t) {
  const s = state[t];
  $$("[data-party]", sheetOf(t)).forEach(box => {
    const key = box.dataset.party;
    if (t === "inv" && key === "ship" && s.shipSame) { box.innerHTML = '<span class="same">Same as bill to</span>'; return; }
    const p = s[key] || {};
    if (!p.name && !p.a1) { box.innerHTML = '<span class="ph">（点击填写）</span>'; return; }
    const lines = [`<b>${esc(p.name)}</b>`];
    if (p.regNo) lines.push(`IC / Reg. No.: ${esc(p.regNo)}`);
    if (p.a1) lines.push(esc(p.a1));
    if (p.a2) lines.push(esc(p.a2));
    const loc = [[p.postcode, p.city].filter(Boolean).join(" "), p.state].filter(Boolean).join(", ");
    if (loc) lines.push(esc(loc));
    if (p.attn) lines.push(`Attn: ${esc(p.attn)}`);
    if (p.phone) lines.push(`${key === "deliver" ? "Tel" : "WhatsApp"}: ${esc(p.phone)}`);
    box.innerHTML = lines.join("<br>");
  });
}

function renderRows(t) {
  const rows = state[t].rows;
  $(".items tbody", sheetOf(t)).innerHTML =
    rows.map((r, i) => `<tr data-i="${i}">
      <td>${i + 1}</td>
      <td><input class="desc" list="productList" value="${esc(r.desc)}" autocomplete="off"></td>
      <td><input class="qty" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.qty)}"></td>
      <td><input class="price" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${esc(r.price)}"></td>
      <td class="amt"><span class="v"></span><button type="button" class="row-del" title="删除这一行">×</button></td>
    </tr>`).join("") +
    Array.from({ length: Math.max(0, 3 - rows.length) }, () => `<tr class="filler"><td>&nbsp;</td><td></td><td></td><td></td><td></td></tr>`).join("");
}

function totals(t) {
  const s = state[t];
  const sub = round2(s.rows.reduce((a, r) => a + num(r.qty) * num(r.price), 0));
  return { sub, total: round2(sub + num(s.shipping) + num(s.other)) };
}
function calc(t) {
  const sh = sheetOf(t), s = state[t];
  $$(".items tbody tr[data-i]", sh).forEach(tr => {
    const r = s.rows[+tr.dataset.i];
    $(".amt .v", tr).textContent = (r && (r.desc || num(r.price))) ? fmt(num(r.qty) * num(r.price)) : "";
  });
  const { sub, total } = totals(t);
  $('[data-sum="sub"]', sh).textContent = fmt(sub);
  $('[data-sum="total"]', sh).textContent = "RM " + fmt(total);
  $('[data-sum="words"]', sh).textContent = amountWords(total) || "-";
  checkOverflow();
}

// 手机：纸张缩小到刚好放得下；超过一页 A4 时提醒
function fitSheets() {
  const s = Math.min(1, (Math.min(window.innerWidth, 800) - 16) / 750);
  $$(".sheet-wrap").forEach(w => {
    w.style.setProperty("--s", s);
    w.style.height = ($(".sheet", w).offsetHeight * s) + "px";
  });
}
function isOverflow(t) { return sheetOf(t).offsetHeight > SHEET_H + 2; }
function checkOverflow() {
  $("#overflowWarn").classList.toggle("hidden", !isOverflow(state.tab));
  fitSheets();
}

function switchTab(t) {
  state.tab = t;
  $$(".tabs .tab").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  $("#page-po").classList.toggle("hidden", t !== "po");
  $("#page-inv").classList.toggle("hidden", t !== "inv");
  $$("textarea", sheetOf(t)).forEach(autosize);
  checkOverflow(); persist();
}

// ---------- 纸张上的操作 ----------
function addRow(t) {
  state[t].rows.push(blankRow());
  renderRows(t); calc(t); persist();
  $(`tr[data-i="${state[t].rows.length - 1}"] .desc`, sheetOf(t))?.focus();
}
async function newNumber(t) {
  state[t].no = await uniqueNo(t);
  setField(t, "no", state[t].no);
}
function autofillPrice(t, input) {
  const tr = input.closest("tr[data-i]");
  const r = state[t].rows[+tr.dataset.i];
  const p = products.find(x => x.desc.toUpperCase() === input.value.trim().toUpperCase());
  if (p && !(num(r.price) > 0)) {
    r.price = p.price;
    $(".price", tr).value = p.price;
    calc(t); persist();
  }
}

function bindSheet(t) {
  const sh = sheetOf(t);
  sh.addEventListener("input", e => {
    const el = e.target, s = state[t];
    if (el.dataset.f) {
      s[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value;
      if (el.tagName === "TEXTAREA") autosize(el);
      syncBinds(t); calc(t); persist();
      return;
    }
    const tr = el.closest("tr[data-i]");
    if (!tr) return;
    const r = s.rows[+tr.dataset.i];
    for (const k of ["desc", "qty", "price"]) if (el.classList.contains(k)) r[k] = el.value;
    calc(t); persist();
  });
  sh.addEventListener("change", e => {
    const el = e.target;
    if (el.type === "checkbox" && el.dataset.f) { state[t][el.dataset.f] = el.checked; syncBinds(t); persist(); }
    if (el.classList.contains("desc")) autofillPrice(t, el);
  });
  sh.addEventListener("click", e => {
    const b = e.target.closest("button, [data-party]");
    if (!b) return;
    if (b.dataset.party) { openParty(t, b.dataset.party); return; }
    if (b.dataset.today) { setField(t, b.dataset.today, today()); return; }
    if (b.dataset.due != null) {
      const n = +b.dataset.due;
      setField(t, "due", n ? dstr(addDays(parseD(state[t].date) || new Date(), n)) : "Due upon receipt");
      return;
    }
    if (b.dataset.act === "dice") { newNumber(t); return; }
    if (b.dataset.act === "addRow") { addRow(t); return; }
    if (b.classList.contains("row-del")) {
      const i = +b.closest("tr").dataset.i;
      state[t].rows.splice(i, 1);
      if (!state[t].rows.length) state[t].rows.push(blankRow());
      renderRows(t); calc(t); persist();
    }
  });
  // Enter：品项里跳下一格，最后一格自动加新行
  sh.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing) return;
    const el = e.target;
    if (el.dataset && el.dataset.party) { e.preventDefault(); openParty(t, el.dataset.party); return; }
    const tr = el.closest("tr[data-i]");
    if (!tr || el.tagName !== "INPUT") return;
    e.preventDefault();
    const order = ["desc", "qty", "price"];
    const k = order.find(c => el.classList.contains(c));
    const i = +tr.dataset.i;
    if (k !== "price") $("." + order[order.indexOf(k) + 1], tr).focus();
    else if (i < state[t].rows.length - 1) $(`tr[data-i="${i + 1}"] .desc`, sh).focus();
    else addRow(t);
  });
}

// ---------- Firebase（登录管理员才用） ----------
let fb = null, user = null, isAdmin = false;
let contacts = [], products = [];

async function initFirebase() {
  try {
    const [cfg, au, fs] = await Promise.all([
      import("../member-system/js/firebase-config.js"),
      import(FB + "firebase-auth.js"),
      import(FB + "firebase-firestore.js"),
    ]);
    fb = { auth: cfg.auth, db: cfg.db, ...au, ...fs };
  } catch (e) {
    console.warn(e);
    $("#authBox").textContent = "⚠️ 连不上 Firebase（还是可以开单和下载）";
    return;
  }
  fb.onAuthStateChanged(fb.auth, async u => {
    user = u; isAdmin = false;
    if (u) { try { isAdmin = (await fb.getDoc(fb.doc(fb.db, "admins", u.uid))).exists(); } catch (e) {} }
    renderAuth();
    if (isAdmin) loadLists();
  });
}
function renderAuth() {
  const box = $("#authBox");
  if (!user) {
    box.innerHTML = `<span>未登录（名单、记录不会同步）</span><button type="button" id="btnLogin">🔑 登录</button>`;
    $("#btnLogin").onclick = () => fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider()).catch(e => toast("登录失败：" + e.message));
    return;
  }
  box.innerHTML = `<span>${isAdmin ? "✅" : "⚠️ 不是管理员："} ${esc(user.email || "")}</span><button type="button" id="btnLogout">登出</button>`;
  $("#btnLogout").onclick = () => fb.signOut(fb.auth);
}
function needAdmin() {
  if (isAdmin) return true;
  toast(fb ? "请先用管理员帐号登录（右上角 🔑）" : "连不上 Firebase，这个功能暂时不能用");
  return false;
}
async function loadLists() {
  try {
    const [cs, ps] = await Promise.all([
      fb.getDocs(fb.collection(fb.db, "invoiceContacts")),
      fb.getDocs(fb.collection(fb.db, "invoiceProducts")),
    ]);
    contacts = cs.docs.map(d => ({ id: d.id, ...d.data() }));
    products = ps.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.desc);
    renderProductList();
  } catch (e) { toast("名单载入失败：" + e.message); }
}
function renderProductList() {
  $("#productList").innerHTML = products
    .sort((a, b) => String(a.desc).localeCompare(String(b.desc)))
    .map(p => `<option value="${esc(p.desc)}">RM ${fmt(p.price)}</option>`).join("");
}
async function uniqueNo(t) {
  for (let i = 0; i < 6; i++) {
    const n = randNo(t);
    if (!isAdmin) return n;
    try { if (!(await fb.getDoc(fb.doc(fb.db, "invoiceDocs", n))).exists()) return n; } catch (e) { return n; }
  }
  return randNo(t);
}
function partyName(t) { return ((t === "po" ? state.po.vendor : state.inv.bill) || {}).name || ""; }

// 下载 / 分享时存到记录；单号被别张用过就停下
async function saveRecord(t) {
  if (!isAdmin) { toast("没有登录管理员，这张单没有存到记录"); return true; }
  const s = state[t];
  const ref = fb.doc(fb.db, "invoiceDocs", s.no);
  try {
    const snap = await fb.getDoc(ref);
    if (snap.exists() && s.savedNo !== s.no) {
      alert(`单号 ${s.no} 已经用过了（${snap.data().party || "其他单"}）。\n请按单号旁边的 🎲 换一个再下载。`);
      return false;
    }
    const { savedNo, ...data } = s;
    await fb.setDoc(ref, {
      type: t, no: s.no, date: s.date, party: partyName(t), total: totals(t).total,
      data: JSON.parse(JSON.stringify(data)), by: user.email || "",
      updatedAt: fb.serverTimestamp(), ...(snap.exists() ? {} : { createdAt: fb.serverTimestamp() }),
    }, { merge: true });
    s.savedNo = s.no; persist();
    saveProducts(t);
    return true;
  } catch (e) {
    toast("存记录失败：" + e.message);
    return true;
  }
}
async function saveProducts(t) {
  const rows = state[t].rows.filter(r => r.desc.trim() && num(r.price) > 0);
  if (!rows.length) return;
  try {
    const batch = fb.writeBatch(fb.db);
    rows.forEach(r => {
      const desc = r.desc.trim();
      const id = desc.toUpperCase().replace(/\//g, "／").slice(0, 300);
      batch.set(fb.doc(fb.db, "invoiceProducts", id), { desc, price: num(r.price), updatedAt: fb.serverTimestamp() });
      const old = products.find(p => p.id === id);
      if (old) Object.assign(old, { desc, price: num(r.price) }); else products.push({ id, desc, price: num(r.price) });
    });
    await batch.commit();
    renderProductList();
  } catch (e) { console.warn("常用货品没存到", e); }
}

// ---------- 弹窗：客户 / 供应商 ----------
const PARTY = {
  "po.vendor": { title: "供应商资料 · Vendor", list: "vendor", listLabel: "供应商", bank: true },
  "po.deliver": { title: "送货地址 · Deliver to", attn: true, noReg: true },
  "inv.bill": { title: "客户资料 · Bill to", list: "customer", listLabel: "客户" },
  "inv.ship": { title: "收货资料 · Ship to", list: "customer", listLabel: "客户", same: true, attn: true },
};
const PF = ["name", "regNo", "a1", "a2", "postcode", "city", "state", "attn", "phone", "bank"];
const UPPER = ["name", "a1", "a2", "city"];
let pm = null;

function setStateOptions(cur) {
  const list = cur && !STATES.includes(cur) ? [...STATES, cur] : STATES;
  $("#pm_state").innerHTML = `<option value="">—</option>` + list.map(s => `<option>${esc(s)}</option>`).join("");
  $("#pm_state").value = cur || "";
}
function fillPartyForm(p) {
  PF.forEach(f => { if (f !== "state") $("#pm_" + f).value = p[f] || ""; });
  setStateOptions(p.state || "");
}
function renderPick() {
  const cfg = PARTY[pm.k];
  const list = contacts.filter(c => c.kind === cfg.list).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  $("#pmPick").innerHTML = `<option value="">＋ 新的${cfg.listLabel}</option>` +
    list.map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.city ? " · " + esc(c.city) : ""}</option>`).join("");
  $("#pmDel").classList.add("hidden");
}
function openParty(t, key) {
  const k = `${t}.${key}`, cfg = PARTY[k];
  pm = { t, key, k };
  $("#pmTitle").textContent = cfg.title;
  $("#pmSameRow").classList.toggle("hidden", !cfg.same);
  $("#pmSame").checked = !!(cfg.same && state.inv.shipSame);
  $("#pmFields").classList.toggle("hidden", $("#pmSame").checked);
  $("#pmPickRow").classList.toggle("hidden", !(cfg.list && isAdmin));
  $("#pmKeepRow").classList.toggle("hidden", !(cfg.list && isAdmin));
  $("#pmAttnRow").classList.toggle("hidden", !cfg.attn);
  $("#pmBankRow").classList.toggle("hidden", !cfg.bank);
  $("#pmRegRow").classList.toggle("hidden", !!cfg.noReg);
  $("#pmKeep").checked = true;
  if (cfg.list) renderPick();
  fillPartyForm(state[t][key] || {});
  $("#partyModal").classList.remove("hidden");
  setTimeout(() => ($("#pmSame").checked ? $("#pmSave") : $("#pm_name")).focus(), 30);
}
function closeModals() { $$(".modal").forEach(m => m.classList.add("hidden")); pm = null; }

$("#pmSame").addEventListener("change", () => $("#pmFields").classList.toggle("hidden", $("#pmSame").checked));
$("#pmPick").addEventListener("change", () => {
  const c = contacts.find(x => x.id === $("#pmPick").value);
  fillPartyForm(c || {});
  $("#pmDel").classList.toggle("hidden", !c);
});
$("#pmDel").addEventListener("click", async () => {
  const c = contacts.find(x => x.id === $("#pmPick").value);
  if (!c || !confirm(`从名单删除「${c.name}」？（已经开过的单不会受影响）`)) return;
  try {
    await fb.deleteDoc(fb.doc(fb.db, "invoiceContacts", c.id));
    contacts = contacts.filter(x => x.id !== c.id);
    renderPick(); fillPartyForm({});
    toast("已从名单删除");
  } catch (e) { toast("删除失败：" + e.message); }
});
$("#pmSave").addEventListener("click", async () => {
  if (!pm) return;
  const { t, key, k } = pm, cfg = PARTY[k];
  if (cfg.same) state.inv.shipSame = $("#pmSame").checked;
  if (!(cfg.same && state.inv.shipSame)) {
    const p = {};
    PF.forEach(f => {
      if (f === "attn" && !cfg.attn) return;
      if (f === "bank" && !cfg.bank) return;
      if (f === "regNo" && cfg.noReg) return;
      let v = $("#pm_" + f).value.trim();
      if (UPPER.includes(f)) v = v.toUpperCase();
      if (v) p[f] = v;
    });
    state[t][key] = p;
    // 供应商有填银行：自动更新 PO 的付款资料 "To:" 那一行
    if (cfg.bank && p.name) {
      const lines = state.po.payNote.split("\n");
      const toLine = `To: ${p.name}${p.bank ? ` (${p.bank})` : ""}`;
      const i = lines.findIndex(l => /^to:/i.test(l.trim()));
      if (i >= 0) lines[i] = toLine; else lines.push(toLine);
      setField("po", "payNote", lines.join("\n"));
      $$("textarea", sheetOf("po")).forEach(autosize);
    }
    if (cfg.list && isAdmin && $("#pmKeep").checked && p.name) {
      try {
        const old = contacts.find(c => c.kind === cfg.list && c.name === p.name);
        const data = { kind: cfg.list, ...Object.fromEntries(PF.map(f => [f, p[f] || ""])), updatedAt: fb.serverTimestamp() };
        if (old) { await fb.setDoc(fb.doc(fb.db, "invoiceContacts", old.id), data, { merge: true }); Object.assign(old, p); }
        else { const ref = await fb.addDoc(fb.collection(fb.db, "invoiceContacts"), data); contacts.push({ id: ref.id, kind: cfg.list, ...p }); }
      } catch (e) { toast("名单没存到：" + e.message); }
    }
  }
  renderParties(t); calc(t); persist();
  closeModals();
});

// ---------- 弹窗：记录 ----------
let recCache = [], recType = "all";
async function openRecords() {
  if (!needAdmin()) return;
  $("#recModal").classList.remove("hidden");
  $("#recList").innerHTML = '<p class="empty">载入中…</p>';
  try {
    const snap = await fb.getDocs(fb.query(fb.collection(fb.db, "invoiceDocs"), fb.orderBy("updatedAt", "desc"), fb.limit(150)));
    recCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderRecords();
  } catch (e) { $("#recList").innerHTML = `<p class="empty">载入失败：${esc(e.message)}</p>`; }
}
function renderRecords() {
  const q = $("#recSearch").value.trim().toLowerCase();
  const list = recCache.filter(r => (recType === "all" || r.type === recType) &&
    (!q || [r.no, r.party, r.date].some(x => String(x || "").toLowerCase().includes(q))));
  $("#recList").innerHTML = list.length ? list.map(r => `
    <div class="rec" data-id="${esc(r.id)}">
      <span class="tg ${r.type}">${r.type === "po" ? "PO" : "INV"}</span>
      <div class="mid"><b>${esc(r.no)}</b> · ${esc(r.party || "—")}
        <div class="sub">${esc(r.date || "")} · RM ${fmt(r.total)}${r.data && r.data.paid ? " · PAID" : ""}</div></div>
      <div class="act"><button type="button" class="btn" data-ract="open">打开</button><button type="button" class="btn danger" data-ract="del">删除</button></div>
    </div>`).join("") : '<p class="empty">没有记录</p>';
}
$("#recSearch").addEventListener("input", renderRecords);
$("#recSeg").addEventListener("click", e => {
  const b = e.target.closest("[data-rt]");
  if (!b) return;
  recType = b.dataset.rt;
  $$("#recSeg button").forEach(x => x.classList.toggle("on", x === b));
  renderRecords();
});
$("#recList").addEventListener("click", async e => {
  const b = e.target.closest("[data-ract]");
  if (!b) return;
  const r = recCache.find(x => x.id === b.closest(".rec").dataset.id);
  if (!r) return;
  if (b.dataset.ract === "open") {
    const label = r.type === "po" ? "Purchase Order" : "Invoice";
    if (!confirm(`打开 ${r.no}？\n目前「${label}」画面上的内容会被取代。`)) return;
    state[r.type] = { ...newState(r.type), ...(r.data || {}), no: r.no, savedNo: r.no };
    build(r.type); switchTab(r.type); persist(); closeModals();
    toast(`已打开 ${r.no}`);
  } else {
    if (!confirm(`永久删除记录 ${r.no}？\n（已经下载或传出去的 PDF 不受影响）`)) return;
    try {
      await fb.deleteDoc(fb.doc(fb.db, "invoiceDocs", r.id));
      recCache = recCache.filter(x => x.id !== r.id);
      if (state[r.type].savedNo === r.no) { state[r.type].savedNo = null; persist(); }
      renderRecords(); toast("已删除记录");
    } catch (err) { toast("删除失败：" + err.message); }
  }
});

// 关闭弹窗：✕、取消、点外面、Esc
$$(".modal").forEach(m => m.addEventListener("click", e => {
  if (e.target === m || e.target.closest("[data-close]")) closeModals();
}));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModals(); });

// ---------- PDF ----------
function fileName(t) {
  const name = partyName(t).replace(/[\\/:*?"<>|]/g, "").trim();
  return `${state[t].no}${name ? "_" + name : ""}.pdf`;
}
// html2canvas 画输入框不准：下载前把输入框换成文字
function prepareExport(sh) {
  document.body.classList.add("exporting");
  $$("input:not([type=checkbox]), textarea", sh).forEach(el => {
    if (el.closest(".no-pdf")) return;
    const cs = getComputedStyle(el);
    const sp = document.createElement("span");
    sp.className = "pv";
    let v = el.value;
    if (el.classList.contains("money")) v = v === "" ? "0.00" : fmt(v);
    else if (el.classList.contains("price")) v = v === "" ? "" : fmt(v);
    sp.textContent = v;
    sp.style.textAlign = cs.textAlign;
    sp.style.fontWeight = cs.fontWeight;
    if (el.tagName === "TEXTAREA") { sp.style.display = "block"; sp.style.whiteSpace = "pre-wrap"; }
    else { sp.style.display = "inline-block"; sp.style.width = el.offsetWidth + "px"; }
    el.after(sp);
    el.classList.add("pv-hide");
  });
}
function restoreExport(sh) {
  $$(".pv", sh).forEach(x => x.remove());
  $$(".pv-hide", sh).forEach(x => x.classList.remove("pv-hide"));
  document.body.classList.remove("exporting");
  fitSheets();
}
function pdfOptions(name) {
  return {
    margin: 0, filename: name,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2.5, useCORS: true, scrollX: 0, scrollY: 0, backgroundColor: "#ffffff", windowWidth: 1000 },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: "avoid-all" },
  };
}
let busy = false;
async function exportPdf(mode) {
  if (busy) return;
  const t = state.tab, sh = sheetOf(t), s = state[t];
  if (isOverflow(t) && !confirm("内容超过一页 A4，PDF 下面会被切掉。\n还是要继续吗？")) return;
  if (!s.no.trim()) setField(t, "no", await uniqueNo(t));
  busy = true;
  const btn = mode === "share" ? $("#btnShare") : $("#btnDownload");
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "生成中…";
  try {
    if ((await saveRecord(t)) === false) return;
    const name = fileName(t);
    window.scrollTo(0, 0);
    prepareExport(sh);
    let blob;
    try { blob = await html2pdf().set(pdfOptions(name)).from(sh).outputPdf("blob"); }
    finally { restoreExport(sh); }
    const file = new File([blob], name, { type: "application/pdf" });
    if (mode === "share" && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); }
      catch (e) { if (e.name !== "AbortError") throw e; }
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      if (isAdmin) toast(`✅ 已下载，并存到记录：${s.no}`);
    }
  } catch (e) {
    console.error(e);
    alert("生成 PDF 失败，请再试一次。\n" + (e.message || e));
  } finally {
    busy = false; btn.disabled = false; btn.textContent = old;
  }
}

// ---------- 工具栏 ----------
$$(".tabs .tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$("#btnNew").addEventListener("click", async () => {
  const t = state.tab;
  if (!confirm("开一张新的空白单？\n目前画面上没下载的内容会清掉。")) return;
  state[t] = newState(t);
  state[t].no = await uniqueNo(t);
  build(t); switchTab(t); persist();
  toast(`新单 ${state[t].no}`);
});
$("#btnCopy").addEventListener("click", async () => {
  const t = state.tab;
  const s = state[t];
  s.no = await uniqueNo(t);
  s.date = today();
  s.savedNo = null;
  if (t === "inv") { s.paid = false; if (parseD(s.due)) s.due = "Due upon receipt"; }
  if (t === "po") s.delivery = "";
  fill(t); persist();
  toast(`已复制成新单 ${s.no}（日期改成今天）`);
});
$("#btnRecords").addEventListener("click", openRecords);
$("#btnDownload").addEventListener("click", () => exportPdf("download"));
$("#btnShare").addEventListener("click", () => exportPdf("share"));
try {
  if (navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.pdf", { type: "application/pdf" })] }))
    $("#btnShare").classList.remove("hidden");
} catch (e) {}
window.addEventListener("resize", fitSheets);

// ---------- 开始 ----------
loadDraft();
["po", "inv"].forEach(t => { build(t); bindSheet(t); });
switchTab(state.tab);
initFirebase();
