// =====================================================================
//  MOCHII SHOP · PO / Invoice
// =====================================================================

// ---------- 防止同一页载入两次 ----------
// 如果 index.html 不小心引入了两次 app.js（例如 app.js 和 app.js?v=…），按钮会绑两次，
// 按一次「下载 PDF」就会生成两份（其中一份排版错乱）。第二份直接停止。
if (window.__mochiiInvoiceLoaded) throw new Error("app.js 已经载入过一次（index.html 里可能有两行 app.js），这次跳过");
window.__mochiiInvoiceLoaded = true;

// ---------- 手机也照电脑版显示 ----------
// 手机打开时把页面当成 1000px 宽的电脑画面（整页缩小显示，可以双指放大），
// 不再用手机排版，避免放大后上面的菜单和单据对不齐。
const DESKTOP_WIDTH = 1000;
(function forceDesktopLayout() {
  if (window.screen && Math.min(screen.width, screen.height) >= DESKTOP_WIDTH) return; // 电脑本来就够宽
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) { meta = document.createElement("meta"); meta.name = "viewport"; document.head.appendChild(meta); }
  meta.setAttribute("content", `width=${DESKTOP_WIDTH}, user-scalable=yes`);
})();

// ---------- 店铺资料 ----------
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
  postcode: "81900", city: "KOTA TINGGI", state: "JOHOR", phone: "017-750 3767",
};
// ESES 中国集运仓（进仓编号 S0661，一定要保留）
const DELIVER_CN_DEFAULT = {
  name: "邓述胜 (S0661)", a1: "广州市白云区白云湖街道夏花一路181号7栋4楼(S0661)", a2: "广东省 广州市 白云区 白云湖街道",
  postcode: "510440", city: "GUANGZHOU", state: "GUANGDONG (CHINA)", attn: "ESES 中国集运仓（转 MOCHII SHOP）", phone: "15915834405",
};
// 付款来源跟着收款方式：WorldFirst 收款才写 WorldFirst；其他 CNY 单只写 MOCHII SHOP。
const PO_PAY_FROM = { RM: "From: MOCHII SHOP (Maybank) 5013 3855 4207", CNY: "From: MOCHII SHOP" };
const PO_PAY_FROM_WF = "From: MOCHII SHOP (WorldFirst)";
const PO_PAY_DEFAULT = PO_PAY_FROM.RM + "\nTo: ";
const PO_TNC_DEFAULT =
  "1. Goods must match the description, quantity and price stated in this purchase order.\n" +
  "2. Defective or incorrect items may be returned for replacement or refund.";
// 交货条件：CNY（中国供应商）＝送到 ESES 广州仓、国内运费供应商负责
const PO_DTERMS = { RM: "Delivered to Mochii Shop", CNY: "To ESES Guangzhou · freight by supplier" };
const PO_DTERMS_OLD = ["To ESES Guangzhou warehouse · freight by supplier"];
const PO_TNC_CNY_HEAD_V1 =
  "1. Goods must match agreed specifications and quality standards.\n" +
  "2. Deliver to designated China consolidation warehouse (ESES - Ref: S0661) with MSMS Reference No. clearly marked.\n";
const PO_TNC_CNY_HEAD =
  "1. Goods must match agreed specifications and quality standards.\n" +
  "2. Supplier delivers to ESES China consolidation warehouse (Ref: S0661) at own cost; mark MSMS Reference No. on parcels.\n";
const PO_TNC_CNY = PO_TNC_CNY_HEAD + "3. Payment settled in CNY to the supplier's nominated account.";
const PO_TNC_CNY_WF = PO_TNC_CNY_HEAD + "3. Payment settled in CNY via WorldFirst to supplier's authorized Alipay account.";
const PO_TNC_BY = { RM: PO_TNC_DEFAULT, CNY: PO_TNC_CNY };
const PO_TNC_ALL = [PO_TNC_DEFAULT, PO_TNC_CNY, PO_TNC_CNY_WF,
  // 旧版默认也当作没改过
  PO_TNC_CNY_HEAD_V1 + "3. Payment settled in CNY via WorldFirst to supplier's authorized Alipay account.",
  PO_TNC_CNY_HEAD_V1 + "3. Payment settled in CNY to the supplier's nominated account."];
const DEPOSIT_RATE = 0.3; // 定金固定 30%
const INV_PAY_DEFAULT =
  "Bank: Maybank\nAccount name: MOCHII SHOP\nAccount no.: 5013 3855 4207\n" +
  "Please send the payment receipt to WhatsApp 017-750 3767.\nThank you for supporting Mochii Shop!";
const STATES = ["JOHOR", "MELAKA", "NEGERI SEMBILAN", "SELANGOR", "KUALA LUMPUR", "PUTRAJAYA", "PULAU PINANG",
  "PERAK", "PAHANG", "KEDAH", "KELANTAN", "TERENGGANU", "PERLIS", "SABAH", "SARAWAK", "LABUAN",
  "GUANGDONG (CHINA)", "ZHEJIANG (CHINA)", "FUJIAN (CHINA)", "JIANGSU (CHINA)", "SHANGHAI (CHINA)", "CHINA (OTHER)"];

const PREFIX = { po: "PO-", inv: "INV-" };
const SAFE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const STORE_KEY = "mochii_docs_v12";
const SHEET_H = 1060;
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
  if (!el) return;
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// ---------- 英文大写金额（支持 RM 与 CNY） ----------
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
function amountWords(total, curr = "RM") {
  const cents = Math.round(total * 100);
  if (cents <= 0) return "";
  const whole = Math.floor(cents / 100), frac = cents % 100;
  const isCny = curr === "CNY";
  let s = isCny ? "CHINESE YUAN " : "RINGGIT MALAYSIA ";
  if (whole) s += toWords(whole);
  if (frac) s += (whole ? " AND " : "") + (isCny ? "CENTS " : "SEN ") + toWords(frac);
  return s + " ONLY";
}

// ---------- 状态 ----------
function newState(t) {
  const base = { no: randNo(t), date: today(), currency: "RM", payNow: "", shipping: "", other: "", deposit: "", rows: [blankRow()], savedNo: null };
  if (t === "po") return {
    ...base, delivery: "", req: "MOCHII SHOP", terms: "Bank transfer · upon delivery", dterms: PO_DTERMS.RM, ref: "",
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
// PO 标题加中文小字，给中国供应商看（Invoice 不加）。
const ZH = (en, zh, on = true) => on ? `<span>${en}<span class="zh" style="font-size:.8em;font-weight:normal;opacity:.85;margin-left:.35em;letter-spacing:0;white-space:nowrap">${zh}</span></span>` : en;
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
        <div class="doc-title">${po ? ZH("PURCHASE ORDER", "采购订单") : "INVOICE"}</div>
        <table class="meta">
          <tr><th>${ZH("DATE", "日期", po)}</th><td>${dateCell("date")}</td></tr>
          <tr><th>${po ? ZH("PO NO.", "单号") : "INVOICE NO."}</th><td><div class="cf"><input data-f="no" class="b" autocomplete="off"><button type="button" class="mini no-pdf" data-act="dice" title="重新生成单号">🎲</button></div></td></tr>
          ${po ? `<tr data-row="delivery"><th style="white-space:nowrap">${ZH("DELIVERY DATE", "交货日期")}</th><td>${dateCell("delivery")}</td></tr>`
               : `<tr><th>DUE DATE</th><td>${dateCell("due", false)}</td></tr>`}
        </table>
        ${po ? "" : `<div class="quick no-pdf"><span>到期：</span>
          <button type="button" data-due="0">收到即付</button><button type="button" data-due="7">+7 天</button>
          <button type="button" data-due="14">+14 天</button><button type="button" data-due="30">+30 天</button>
          <label class="paid-chk"><input type="checkbox" data-f="paid"> 已付款（盖 PAID 章）</label></div>`}
      </div>
    </div>

    <div class="grid mt">
      ${partyCol(po ? "vendor" : "bill", po ? ZH("VENDOR", "供应商") : "BILL TO")}
      ${partyCol(po ? "deliver" : "ship", po ? ZH("DELIVER TO", "收货地址") : "SHIP TO")}
    </div>

    ${po ? `<table class="tri mt">
      <tr><th style="width:19%">${ZH("REQUISITIONER", "采购方")}</th><th style="width:31%">${ZH("PAYMENT TERMS", "付款条件")}</th><th style="width:30%">${ZH("DELIVERY TERMS", "交货条件")}</th><th style="width:20%">${ZH("REFERENCE", "订单编号")}</th></tr>
      <tr><td><input data-f="req" autocomplete="off"></td><td><input data-f="terms" autocomplete="off"></td><td><input data-f="dterms" autocomplete="off"></td><td><input data-f="ref" placeholder="MSMS 单号" autocomplete="off"></td></tr>
    </table>
    <div class="quick no-pdf"><span>付款阶段：</span>
      <button type="button" data-term="30% Deposit">30% 定金</button>
      <button type="button" data-term="70% Balance Payment">70% 尾款</button>
      <button type="button" data-term="100% Full Payment">100% 全款</button>
    </div>` : ""}

    <table class="items mt">
      <colgroup><col style="width:9%"><col style="width:49%"><col style="width:10%"><col style="width:16%"><col style="width:16%"></colgroup>
      <thead><tr><th>${ZH("NO.", "序号", po)}</th><th class="l">${ZH("DESCRIPTION", "品名", po)}</th><th>${ZH("QTY", "数量", po)}</th><th class="r">UNIT PRICE (<span data-curr-lbl>RM</span>)${po ? '<span class="zh" style="font-size:.8em;font-weight:normal;opacity:.85;margin-left:.35em;white-space:nowrap">单价</span>' : ""}</th><th class="r">AMOUNT (<span data-curr-lbl>RM</span>)${po ? '<span class="zh" style="font-size:.8em;font-weight:normal;opacity:.85;margin-left:.35em;white-space:nowrap">金额</span>' : ""}</th></tr></thead>
      <tbody></tbody>
    </table>
    <button type="button" class="add-row no-pdf" data-act="addRow">＋ 添加一行</button>

    <div class="grid mt">
      <div>
        <div class="bar">${po ? ZH("PAYMENT TO VENDOR", "付款资料") : "PAYMENT DETAILS"}</div>
        <div class="box"><textarea data-f="payNote" rows="2"></textarea></div>
        ${po ? `<div class="bar mt-s">${ZH("TERMS AND CONDITIONS", "条款")}</div><div class="box tnc-box"><div class="tnc-view" data-tnc-view tabindex="0" role="button" title="点击修改" style="cursor:text;min-height:1.4em"></div><div class="no-pdf tnc-edit" hidden><textarea data-f="tnc" rows="2"></textarea></div></div>` : ""}
      </div>
      <div>
        <table class="totals">
          <tr><th>${ZH("SUBTOTAL", "小计", po)}</th><td data-sum="sub">0.00</td></tr>
          <tr><th>SST <span class="na">(Not Applicable)</span></th><td>-</td></tr>
          <tr><th>${ZH("SHIPPING", "运费", po)}</th><td><input data-f="shipping" class="money" type="number" step="0.01" min="0" placeholder="0.00" inputmode="decimal"></td></tr>
          <tr><th>${ZH("OTHER", "其他", po)}</th><td><input data-f="other" class="money" type="number" step="0.01" placeholder="0.00" inputmode="decimal"></td></tr>
          ${po ? `<tr id="depRow-${t}"><th style="white-space:nowrap">${ZH("LESS: DEPOSIT PAID", "减：已付定金")}</th><td><input data-f="deposit" class="money" type="number" step="0.01" min="0" placeholder="0.00" inputmode="decimal"></td></tr>` : ""}
          <tr class="grand"><th data-sum="grandLbl">TOTAL</th><td data-sum="total">RM 0.00</td></tr>
          ${po ? `<tr data-sum="nowRow" style="display:none"><th><b data-sum="nowLbl">DEPOSIT</b></th><td><b data-sum="now">0.00</b></td></tr>` : ""}
        </table>
      </div>
    </div>
    <div class="words mt-s"><b>${po ? ZH("AMOUNT IN WORDS", "大写金额") + ":" : "AMOUNT IN WORDS:"}</b> <span data-sum="words">-</span></div>

    <div class="sign">
      <div>
        <div class="st">${po ? ZH("Accepted by vendor:", "供应商确认") : "Received by:"}</div>
        <div class="sp"></div><div class="sl"></div>
        <div class="sm">Name:</div><div class="sm">Date:</div>
      </div>
      <div class="sign-r">
        <div class="st">${po ? ZH("Authorized by:", "采购方授权") : "Authorized signature:"}</div>
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

// ---------- 币种切换（按钮和 MSMS 导入共用） ----------
// PO：条款和付款说明的 From 行，只有还是「默认内容」时才跟着换；自己改过的不动。
// 送货地址不跟着换（手动切币种不会盖掉已填的地址）。
function poDefaultsFor(s, curr) {
  const tnc = String(s.tnc ?? "").trim();
  if (!tnc || PO_TNC_ALL.includes(tnc)) s.tnc = PO_TNC_BY[curr] || PO_TNC_DEFAULT;
  const dt = String(s.dterms ?? "").trim();
  if (!dt || Object.values(PO_DTERMS).includes(dt) || PO_DTERMS_OLD.includes(dt)) s.dterms = PO_DTERMS[curr] || PO_DTERMS.RM;
  const lines = String(s.payNote ?? "").split("\n");
  const fromLines = [...Object.values(PO_PAY_FROM), PO_PAY_FROM_WF];
  if (!lines[0].trim() || fromLines.includes(lines[0].trim())) lines[0] = PO_PAY_FROM[curr] || PO_PAY_FROM.RM;
  if (!lines.some(l => /^to:/i.test(l.trim()))) lines.push("To: ");
  s.payNote = lines.join("\n");
}
function setCurrency(t, curr) {
  if (curr !== "RM" && curr !== "CNY") return;
  const s = state[t];
  s.currency = curr;
  if (t === "po") {
    poDefaultsFor(s, curr);
    const sh = sheetOf(t);
    for (const f of ["tnc", "payNote", "dterms"]) {
      const el = $(`[data-f="${f}"]`, sh);
      if (el) { el.value = s[f]; autosize(el); }
    }
  }
  syncBinds(t); calc(t); persist();
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
  const curr = state[t].currency || "RM";
  $$('[data-bind="date"]', sheetOf(t)).forEach(e => { e.textContent = state[t].date || ""; });
  $$('[data-curr-lbl]', sheetOf(t)).forEach(e => { e.textContent = curr; });
  if (t === state.tab) {
    $$("#currTabs [data-curr]").forEach(b => b.classList.toggle("on", b.dataset.curr === curr));
  }
  if (t === "inv" && $("#paid-inv")) $("#paid-inv").classList.toggle("on", !!state.inv.paid);
}
function setField(t, f, v) {
  state[t][f] = v;
  const el = $(`[data-f="${f}"]`, sheetOf(t));
  if (el) el.value = v;
  syncBinds(t); calc(t); persist();
}

function renderParties(t) {
  const s = state[t];
  $$("[data-party]", sheetOf(t)).forEach(box => {
    const key = box.dataset.party;
    if (t === "inv" && key === "ship" && s.shipSame) { box.innerHTML = '<span class="same">Same as bill to</span>'; return; }
    const p = s[key] || {};
    if (!p.name && !p.a1) { box.innerHTML = '<span class="ph">（点击填写）</span>'; return; }
    const lines = [`<b>${esc(p.name)}</b>`];
    if (p.regNo) lines.push(`Reg. / ID No.: ${esc(p.regNo)}`);
    if (p.a1) lines.push(esc(p.a1));
    if (p.a2) lines.push(esc(p.a2));
    const loc = [[p.postcode, p.city].filter(Boolean).join(" "), p.state].filter(Boolean).join(", ");
    if (loc) lines.push(esc(loc));
    if (p.attn) lines.push(`Attn: ${esc(p.attn)}`);
    if (p.phone) lines.push(`${key === "deliver" ? "Tel" : "Contact"}: ${esc(p.phone)}`);
    if (key === "vendor" && p.wechat) lines.push(`WeChat: ${esc(p.wechat)}`);
    if (key === "vendor" && (p.acct || p.acctName)) lines.push(`Payee: ${esc(vendorToLine(p).replace(/^To:\s*/, ""))}`);
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
  const dep = t === "po" ? round2(num(s.deposit)) : 0;
  const total = Math.max(0, round2(sub + num(s.shipping) + num(s.other) - dep));
  // 30% 定金单：付款阶段是 30% 定金、还没扣过定金时，另算「本次应付」
  // 定金单：付款阶段写 Deposit、还没扣过定金时，另算「本次应付」
  // 金额以 MSMS 传来的实际定金为准（供应商自填，最多 30%）；没传就按 30% 算
  const isDepositStage = t === "po" && /deposit/i.test(s.terms || "") && dep <= 0;
  const payNow = num(s.payNow);
  const pm = String(s.terms || "").match(/(\d{1,3})\s*%\s*deposit/i);
  const rate = pm && +pm[1] > 0 && +pm[1] <= 100 ? +pm[1] / 100 : DEPOSIT_RATE;
  const now = isDepositStage ? (payNow > 0 ? Math.min(round2(payNow), total) : round2(total * rate)) : total;
  return { sub, dep, total, now, isDepositStage };
}
function calc(t) {
  const sh = sheetOf(t), s = state[t];
  const curr = s.currency || "RM";
  $$(".items tbody tr[data-i]", sh).forEach(tr => {
    const r = s.rows[+tr.dataset.i];
    $(".amt .v", tr).textContent = (r && (r.desc || num(r.price))) ? fmt(num(r.qty) * num(r.price)) : "";
  });
  const { sub, dep, total, now, isDepositStage } = totals(t);
  $('[data-sum="sub"]', sh).textContent = fmt(sub);
  if (t === "po") {
    const depRow = $(`#depRow-${t}`, sh);
    if (depRow) depRow.classList.toggle("zero-dep", dep <= 0);
    $('[data-sum="grandLbl"]', sh).innerHTML = dep > 0 ? ZH("BALANCE DUE", "应付余额") : ZH("TOTAL", "合计");
    const nowRow = $('[data-sum="nowRow"]', sh);
    if (nowRow) {
      nowRow.style.display = isDepositStage ? "" : "none";
      $('[data-sum="now"]', sh).textContent = `${curr} ` + fmt(now);
      const pct = total > 0 ? Math.round(now / total * 100) : 0;
      $('[data-sum="nowLbl"]', sh).innerHTML = ZH(`DEPOSIT (${pct}%)`, "本次定金");
    }
  }
  $('[data-sum="total"]', sh).textContent = `${curr} ` + fmt(total);
  // 大写金额跟实际要付的钱走：定金单写 30% 的金额
  $('[data-sum="words"]', sh).textContent = amountWords(now ?? total, curr) || "-";
  if (t === "po") renderTnc(t);
  checkOverflow();
}

// 条款：编号在左、换行的字跟第一行文字对齐（显示和 PDF 用这个；点一下才变成可修改的输入框）。
function renderTnc(t) {
  const view = $("[data-tnc-view]", sheetOf(t));
  if (!view) return;
  const text = String(state[t].tnc ?? "");
  view.innerHTML = text.trim() ? text.split("\n").map(line => {
    const m = line.match(/^(\s*\d+[.)])\s+(.*)$/);
    return m ? `<div style="display:flex;gap:.35em"><span style="flex:none">${esc(m[1].trim())}</span><span style="flex:1;min-width:0">${esc(m[2])}</span></div>`
             : `<div style="white-space:pre-wrap">${esc(line) || "&nbsp;"}</div>`;
  }).join("") : '<span class="ph" style="opacity:.5">（点击填写）</span>';
}
function bindTnc(t) {
  // 用事件委托：重开单（build）换掉内容后照样有效。
  const sh = sheetOf(t);
  const open = () => {
    const view = $("[data-tnc-view]", sh), wrap = $(".tnc-edit", sh), ta = wrap && $("textarea", wrap);
    if (!view || !ta) return;
    view.hidden = true; wrap.hidden = false; autosize(ta); ta.focus();
  };
  sh.addEventListener("click", e => { if (e.target.closest("[data-tnc-view]")) open(); });
  sh.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-tnc-view]")) { e.preventDefault(); open(); } });
  sh.addEventListener("focusout", e => {
    if (!e.target.matches('.tnc-edit textarea')) return;
    const view = $("[data-tnc-view]", sh), wrap = $(".tnc-edit", sh);
    wrap.hidden = true; view.hidden = false; renderTnc(t); checkOverflow();
  });
}

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
  $$(".tabs .tab[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  $("#page-po").classList.toggle("hidden", t !== "po");
  $("#page-inv").classList.toggle("hidden", t !== "inv");
  syncBinds(t);
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
    if (b.dataset.term != null) { setField(t, "terms", b.dataset.term); return; }
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

// ---------- Firebase ----------
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
    if (u) { try { const g = await import("/js/admin-guard.js"); isAdmin = g.can(await g.getAccess(u), "invoice"); } catch (e) {} }
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
    applyMsmsVendorMatch();
  } catch (e) { toast("名单载入失败：" + e.message); }
}
function renderProductList() {
  $("#productList").innerHTML = products
    .sort((a, b) => String(a.desc).localeCompare(String(b.desc)))
    .map(p => `<option value="${esc(p.desc)}">${fmt(p.price)}</option>`).join("");
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
      type: t, no: s.no, date: s.date, currency: s.currency || "RM", party: partyName(t), total: totals(t).total,
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
  "po.deliver": { title: "送货地址 · Deliver to", attn: true, noReg: true, preset: true },
  "inv.bill": { title: "客户资料 · Bill to", list: "customer", listLabel: "客户" },
  "inv.ship": { title: "收货资料 · Ship to", list: "customer", listLabel: "客户", same: true, attn: true },
};
const PF = ["name", "regNo", "a1", "a2", "postcode", "city", "state", "attn", "phone", "bank", "acct", "acctName"];
const BANK_FIELDS = ["bank", "acct", "acctName"];
const UPPER = ["name", "a1", "a2", "city", "acctName"];
const BANKS = {
  "中国跨境收款 (WorldFirst 直付)": ["Alipay (支付宝)", "WeChat Pay (微信支付)", "China Bank Account (中国大陆银行卡)"],
  "马来西亚银行": ["Maybank", "CIMB Bank", "Public Bank", "RHB Bank", "Hong Leong Bank", "AmBank", "UOB Malaysia",
    "OCBC Bank", "HSBC Bank", "Standard Chartered", "Bank Islam", "Bank Rakyat", "BSN", "Affin Bank",
    "Alliance Bank", "Bank Muamalat", "Agrobank", "MBSB Bank", "Al Rajhi Bank", "Citibank"],
  "数字银行": ["GXBank", "AEON Bank", "Boost Bank", "KAF Digital Bank", "Ryt Bank"],
  "电子钱包 / DuitNow": ["Touch 'n Go eWallet", "ShopeePay", "GrabPay", "Boost", "BigPay", "DuitNow (手机号 / IC)"],
};
const BANK_LIST = Object.values(BANKS).flat();
const OTHER = "__other";
let pm = null;

function setStateOptions(cur) {
  const list = cur && !STATES.includes(cur) ? [...STATES, cur] : STATES;
  $("#pm_state").innerHTML = `<option value="">—</option>` + list.map(s => `<option>${esc(s)}</option>`).join("");
  $("#pm_state").value = cur || "";
}
function setBank(name) {
  $("#pm_bankSel").innerHTML = `<option value="">— 选择 —</option>` +
    Object.entries(BANKS).map(([g, list]) => `<optgroup label="${esc(g)}">${list.map(b => `<option>${esc(b)}</option>`).join("")}</optgroup>`).join("") +
    `<option value="${OTHER}">其他（自己输入）</option>`;
  const known = !name || BANK_LIST.includes(name);
  $("#pm_bankSel").value = known ? (name || "") : OTHER;
  $("#pm_bankOther").value = known ? "" : name;
  $("#pm_bankOther").classList.toggle("hidden", known);
}
function readBank() {
  return $("#pm_bankSel").value === OTHER ? $("#pm_bankOther").value.trim() : $("#pm_bankSel").value;
}
$("#pm_bankSel").addEventListener("change", () => {
  const other = $("#pm_bankSel").value === OTHER;
  $("#pm_bankOther").classList.toggle("hidden", !other);
  if (other) $("#pm_bankOther").focus();
});
function fillPartyForm(p) {
  PF.forEach(f => { if (f !== "state" && f !== "bank") $("#pm_" + f).value = p[f] || ""; });
  setStateOptions(p.state || "");
  setBank(p.bank || "");
}
function vendorToLine(p) {
  const who = p.acctName || p.name || "";
  return `To: ${who}${p.bank ? ` (${p.bank})` : ""}${p.acct ? ` ${p.acct}` : ""}`.trimEnd();
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
  $("#pmPresetRow").classList.toggle("hidden", !cfg.preset);
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

$("#btnPresetMy").addEventListener("click", () => { fillPartyForm(DELIVER_DEFAULT); toast("已填入大马店铺地址"); });
$("#btnPresetCn").addEventListener("click", () => { fillPartyForm(DELIVER_CN_DEFAULT); toast("已填入中国集运仓模板，请核对仓库详情"); });

$("#pmSame").addEventListener("change", () => $("#pmFields").classList.toggle("hidden", $("#pmSame").checked));
$("#pmPick").addEventListener("change", () => {
  const c = contacts.find(x => x.id === $("#pmPick").value);
  fillPartyForm(c || {});
  $("#pmDel").classList.toggle("hidden", !c);
});
$("#pmDel").addEventListener("click", async () => {
  if (!window.ownerOnly || !window.ownerOnly()) return;
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
      if (BANK_FIELDS.includes(f) && !cfg.bank) return;
      if (f === "regNo" && cfg.noReg) return;
      let v = (f === "bank" ? readBank() : $("#pm_" + f).value).trim();
      if (UPPER.includes(f)) v = v.toUpperCase();
      if (v) p[f] = v;
    });
    if (cfg.bank && p.name && p.name === COMPANY.name.toUpperCase()) {
      if (!confirm(`供应商名字是「${p.name}」，和自己的店名一样。\n确定没有填错吗？`)) return;
    }
    if (cfg.bank) { const old = state[t][key] || {}; if (old.attn && !p.attn) p.attn = old.attn; if (old.wechat) p.wechat = old.wechat; }
    state[t][key] = p;
    if (cfg.bank && p.name) {
      const lines = state.po.payNote.split("\n");
      const i = lines.findIndex(l => /^to:/i.test(l.trim()));
      if (i >= 0) lines[i] = vendorToLine(p); else lines.push(vendorToLine(p));
      setField("po", "payNote", lines.join("\n"));
      $$("textarea", sheetOf("po")).forEach(autosize);
    }
    if (cfg.list && isAdmin && $("#pmKeep").checked && p.name) {
      try {
        const old = contacts.find(c => c.kind === cfg.list && c.name === p.name);
        const data = { kind: cfg.list, ...Object.fromEntries(PF.map(f => [f, p[f] || ""])), updatedAt: fb.serverTimestamp() };
        if (old) {
          await fb.setDoc(fb.doc(fb.db, "invoiceContacts", old.id), data, { merge: true });
          PF.forEach(f => { old[f] = p[f] || ""; });
        }
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
  $("#recList").innerHTML = list.length ? list.map(r => {
    const c = r.currency || (r.data && r.data.currency) || "RM";
    return `
    <div class="rec" data-id="${esc(r.id)}">
      <span class="tg ${r.type}">${r.type === "po" ? "PO" : "INV"}</span>
      <div class="mid"><b>${esc(r.no)}</b> · ${esc(r.party || "—")}
        <div class="sub">${esc(r.date || "")} · ${esc(c)} ${fmt(r.total)}${r.data && r.data.paid ? " · PAID" : ""}</div></div>
      <div class="act"><button type="button" class="btn" data-ract="open">打开</button><button type="button" class="btn danger owner-only" data-ract="del">删除</button></div>
    </div>`;
  }).join("") : '<p class="empty">没有记录</p>';
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
    if (!window.ownerOnly || !window.ownerOnly()) return;
    if (!confirm(`永久删除记录 ${r.no}？\n（已经下载或传出去的 PDF 不受影响）`)) return;
    try {
      await fb.deleteDoc(fb.doc(fb.db, "invoiceDocs", r.id));
      recCache = recCache.filter(x => x.id !== r.id);
      if (state[r.type].savedNo === r.no) { state[r.type].savedNo = null; persist(); }
      renderRecords(); toast("已删除记录");
    } catch (err) { toast("删除失败：" + err.message); }
  }
});

$$(".modal").forEach(m => m.addEventListener("click", e => {
  if (e.target === m || e.target.closest("[data-close]")) closeModals();
}));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModals(); });

// ---------- PDF ----------
function fileName(t) {
  const name = partyName(t).replace(/[\\/:*?"<>|]/g, "").trim();
  return `${state[t].no}${name ? "_" + name : ""}.pdf`;
}
function prepareExport(sh) {
  document.body.classList.add("exporting");
  // 交货日期没填：PDF 上不显示这一行
  const dRow = $('[data-row="delivery"]', sh);
  if (dRow && !String(state.po.delivery || "").trim()) dRow.classList.add("pv-hide");
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
    html2canvas: { scale: 2.5, useCORS: true, scrollX: 0, scrollY: 0, x: 0, y: 0, backgroundColor: "#ffffff", windowWidth: 750 },
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
    const stage = document.createElement("div");
    stage.style.cssText = "position:absolute;left:0;top:0;width:750px;z-index:-1;background:#fff;";
    const copy = sh.cloneNode(true);
    copy.removeAttribute("id");
    $$("[id]", copy).forEach(x => x.removeAttribute("id"));
    stage.appendChild(copy);
    document.body.appendChild(stage);
    let blob;
    try { blob = await html2pdf().set(pdfOptions(name)).from(copy).outputPdf("blob"); }
    finally { stage.remove(); restoreExport(sh); }
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

// ---------- 打印预览 ----------
function openPreview() {
  const t = state.tab, sh = sheetOf(t);
  prepareExport(sh);
  const copy = sh.cloneNode(true);
  copy.removeAttribute("id");
  $$("[id]", copy).forEach(x => x.removeAttribute("id"));
  restoreExport(sh);

  const stage = $("#pvStage");
  stage.innerHTML = "";
  stage.appendChild(copy);
  $("#previewModal").classList.remove("hidden");
  fitPreview();
}
function fitPreview() {
  const modal = $("#previewModal");
  if (!modal || modal.classList.contains("hidden")) return;
  const wrap = $("#pvStageWrap"), stage = $("#pvStage");
  const avail = wrap.clientWidth - 24;
  const s = Math.min(1, avail / 750);
  stage.style.transform = `scale(${s})`;
  stage.style.width = "750px";
  stage.style.height = (1060 * s) + "px";
}

// ---------- 工具栏 ----------
$$(".tabs .tab[data-tab]").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$$("#currTabs [data-curr]").forEach(b => b.addEventListener("click", () => {
  setCurrency(state.tab, b.dataset.curr);
  toast(`币种已切换为 ${b.dataset.curr}`);
}));
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
$("#btnPreview").addEventListener("click", openPreview);
$("#btnDoPrint").addEventListener("click", () => window.print());
$("#btnPvDownload").addEventListener("click", () => { closeModals(); exportPdf("download"); });
$("#btnDownload").addEventListener("click", () => exportPdf("download"));
$("#btnShare").addEventListener("click", () => exportPdf("share"));
try {
  if (navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.pdf", { type: "application/pdf" })] }))
    $("#btnShare").classList.remove("hidden");
} catch (e) {}
window.addEventListener("resize", () => { fitSheets(); fitPreview(); });

// ---------- MSMS 跳转自动填单 ----------
// 链接：/invoice/?from=msms&ref=MSMS-…&vName=…&vAcct=…&terms=…&deposit=…&items=[…]&no=PO-…
// 只认 from=msms（付中国供应商货款）。其他情况完全照原本本地开单。
let msmsNotice = "";
let msmsVendorMatch = ""; // 等名单载入后，按供应商名称带出收款资料
let msmsHandoff = "";     // MSMS 一次性编号：收款资料不走网址，等 MSMS 分页直接交过来
const MSMS_ORIGIN = "https://supply.themochiishop.com";
function clearQuery() {
  try { window.history.replaceState({}, document.title, window.location.pathname); } catch (e) {}
}
function initMsmsBridge() {
  let q;
  try { q = new URLSearchParams(window.location.search); } catch (e) { return; }
  if (q.get("from") !== "msms") return;
  const str = (k, max = 200) => String(q.get(k) ?? "").trim().slice(0, max);

  // 草稿保护：本地有没保存的 PO 先问
  const cur = state.po;
  const dirty = !cur.savedNo && (
    (cur.vendor && (cur.vendor.name || cur.vendor.acct)) ||
    (cur.rows || []).some(r => String(r.desc || "").trim() || num(r.price) > 0));
  if (dirty && !confirm("检测到本地有未保存的 PO 草稿，是否覆盖为 MSMS 导入的订单数据？")) {
    clearQuery();
    msmsNotice = "已取消导入，保留原本的草稿";
    return;
  }

  const curr = str("curr", 3).toUpperCase() === "RM" ? "RM" : "CNY";
  const po = newState("po");
  po.currency = curr;

  const no = str("no", 40).toUpperCase();
  if (/^PO-[A-Z0-9][A-Z0-9-]{2,38}$/.test(no)) po.no = no;
  po.ref = str("ref", 60);
  po.terms = str("terms", 120);
  const dep = num(q.get("deposit"));
  po.deposit = dep > 0 ? dep.toFixed(2) : "";
  const payNow = num(q.get("payNow"));
  po.payNow = payNow > 0 ? payNow.toFixed(2) : "";

  const vendor = {
    name: str("vName").toUpperCase(),
    phone: str("vPhone", 40),
    bank: str("vBank", 60) || "Alipay (支付宝)",
    acct: str("vAcct", 80),
    acctName: str("vAcctName").toUpperCase(),
  };
  po.vendor = Object.fromEntries(Object.entries(vendor).filter(([, v]) => v));
  po.deliver = { ...DELIVER_CN_DEFAULT };

  let itemsBad = false;
  const rawItems = q.get("items");
  if (rawItems) {
    try {
      const arr = JSON.parse(rawItems);
      if (!Array.isArray(arr)) throw new Error("not array");
      const rows = arr.slice(0, 50).map(x => ({
        desc: String(x && x.desc != null ? x.desc : "").trim().slice(0, 200),
        qty: Math.max(0, Math.round(num(x && x.qty))),
        price: num(x && x.price) > 0 ? num(x.price).toFixed(2) : "",
      })).filter(r => r.desc || r.price);
      if (rows.length) po.rows = rows;
    } catch (e) { itemsBad = true; }
  }

  po.payNote = PO_PAY_FROM[curr] + "\n" + (po.vendor.name || po.vendor.acct ? vendorToLine(po.vendor) : "To: ");
  po.tnc = PO_TNC_BY[curr];
  po.dterms = PO_DTERMS[curr];

  if (po.vendor.name && !po.vendor.acct) msmsVendorMatch = po.vendor.name;
  const h = str("h", 64);
  if (/^[0-9a-f-]{36}$/i.test(h)) msmsHandoff = h;
  state.po = po;
  state.tab = "po";
  clearQuery();
  // 马上写进草稿（不等 250ms）：就算页面把 app.js 载入两次，第二次也读得到导入的单
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  msmsNotice = itemsBad
    ? "⚠️ 已从 MSMS 导入，但品项资料读不到，请自己填品项"
    : `✅ 已从 MSMS 导入 ${po.ref || po.no}，请核对后再下载`;
}

// MSMS 只传供应商名称（不传支付宝实名／账号）；名单里有同名供应商就带出收款资料和地址。
function applyMsmsVendorMatch() {
  const name = msmsVendorMatch;
  if (!name) return;
  msmsVendorMatch = "";
  const v = state.po.vendor || {};
  if (String(v.name || "").toUpperCase() !== name.toUpperCase() || v.acct) return;
  const c = contacts.find(x => x.kind === "vendor" && String(x.name || "").trim().toUpperCase() === name.toUpperCase());
  if (!c) { toast(`名单里没有「${name}」，请点 VENDOR 填一次收款资料（勾「存到名单」下次自动带出）`, 5000); return; }
  const p = { ...v };
  PF.forEach(f => { if (f !== "attn" && c[f] && !p[f]) p[f] = c[f]; });
  state.po.vendor = p;
  const lines = String(state.po.payNote || "").split("\n");
  const i = lines.findIndex(l => /^to:/i.test(l.trim()));
  if (i >= 0) lines[i] = vendorToLine(p); else lines.push(vendorToLine(p));
  state.po.payNote = lines.join("\n");
  const el = $('[data-f="payNote"]', sheetOf("po"));
  if (el) { el.value = state.po.payNote; autosize(el); }
  renderParties("po"); calc("po"); persist();
  toast(`已从名单带出「${name}」的收款资料`);
}

// MSMS 直接交来的收款资料（WorldFirst 支付宝实名＋账号，或供应商收款资料）。只认 MSMS 网站、打开我的那个分页、同一个编号。
function applyMsmsContact(contact) {
  if (!contact || typeof contact !== "object") return false;
  const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const name = clean(contact.contactName, 80).toUpperCase(), phone = clean(contact.phone, 40), wechat = clean(contact.wechat, 64);
  if (!name && !phone && !wechat) return false;
  const p = { ...(state.po.vendor || {}) };
  if (name) p.attn = name;
  if (phone) p.phone = phone;
  if (wechat) p.wechat = wechat;
  state.po.vendor = p;
  renderParties("po"); persist();
  return true;
}
function applyMsmsPayee(payee, contact) {
  const gotContact = applyMsmsContact(contact);
  if (!payee || typeof payee !== "object") { toast(gotContact ? "已带入供应商联系资料；MSMS 里还没有收款资料，请点 VENDOR 填写" : "MSMS 里这个供应商还没有收款资料，请点 VENDOR 填写"); return; }
  const clean = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const acct = clean(payee.acct, 300), acctName = clean(payee.acctName, 120).toUpperCase(), bank = clean(payee.bank, 60);
  if (!acct && !acctName) return;
  msmsVendorMatch = ""; // MSMS 的资料为准，名单不再盖过
  const p = { ...(state.po.vendor || {}), acct, acctName, bank };
  // 供应商名称＝收款人实名（店名放括号），和付款对象一致，方便万里汇／会计核对
  const shop = String(p.shop || p.name || "").trim();
  if (acctName && shop && shop.toUpperCase() !== acctName) { p.shop = shop; p.name = `${acctName} (${shop})`; }
  else if (acctName && !shop) p.name = acctName;
  if (!bank) delete p.bank;
  if (!acct) delete p.acct;
  if (!acctName) delete p.acctName;
  state.po.vendor = p;
  const lines = String(state.po.payNote || "").split("\n");
  const i = lines.findIndex(l => /^to:/i.test(l.trim()));
  if (i >= 0) lines[i] = vendorToLine(p); else lines.push(vendorToLine(p));
  if (payee.source === "worldfirst" && state.po.currency === "CNY") {
    // WorldFirst 收款：付款来源、付款条件、条款第 3 条都写 WorldFirst（自己改过的不动）
    if ([...Object.values(PO_PAY_FROM), PO_PAY_FROM_WF].includes(lines[0].trim())) lines[0] = PO_PAY_FROM_WF;
    if (state.po.terms && !/worldfirst/i.test(state.po.terms)) state.po.terms = state.po.terms + " · via WorldFirst";
    if (PO_TNC_ALL.includes(String(state.po.tnc || "").trim())) state.po.tnc = PO_TNC_CNY_WF;
    for (const f of ["terms", "tnc"]) { const e = $(`[data-f="${f}"]`, sheetOf("po")); if (e) { e.value = state.po[f]; autosize(e); } }
  }
  state.po.payNote = lines.join("\n");
  const el = $('[data-f="payNote"]', sheetOf("po"));
  if (el) { el.value = state.po.payNote; autosize(el); }
  renderParties("po"); calc("po"); persist();
  toast(payee.source === "worldfirst" ? "✅ 已从 MSMS 带入 WorldFirst 支付宝资料" : "✅ 已从 MSMS 带入供应商收款资料");
}
function initMsmsHandoff() {
  const nonce = msmsHandoff, opener = window.opener;
  if (!nonce || !opener) return;
  const onMessage = e => {
    if (e.origin !== MSMS_ORIGIN || e.source !== opener) return;
    const d = e.data;
    if (!d || d.type !== "msms-po-payee" || d.nonce !== nonce) return;
    window.removeEventListener("message", onMessage);
    applyMsmsPayee(d.payee, d.contact);
  };
  window.addEventListener("message", onMessage);
  setTimeout(() => window.removeEventListener("message", onMessage), 120000);
  try { opener.postMessage({ type: "msms-po-ready", nonce }, MSMS_ORIGIN); } catch (e) {}
}

// ---------- 开始 ----------
loadDraft();
initMsmsBridge();
["po", "inv"].forEach(t => { build(t); bindSheet(t); });
bindTnc("po");
switchTab(state.tab);
if (msmsNotice) toast(msmsNotice, 4500);
initMsmsHandoff();
initFirebase();
