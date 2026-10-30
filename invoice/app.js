(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const STORE_KEY = "mochii_docs_v5";

  const fmt = n => {
    const num = Number(n) || 0;
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const state = {
    po:  { rows: [{ desc: "PLUSH TOY SET", qty: 1, price: 1376 }] },
    inv: { rows: [{ desc: "PLUSH TOY SET", qty: 1, price: 1376 }] }
  };

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.po?.rows?.length)  state.po.rows  = saved.po.rows;
      if (saved.inv?.rows?.length) state.inv.rows = saved.inv.rows;
      if (saved.fields) {
        for (const [id, val] of Object.entries(saved.fields)) {
          const el = document.getElementById(id);
          if (el) el.value = val;
        }
      }
    } catch (e) { console.warn("load failed", e); }
  }

  function saveState() {
    const fields = {};
    $$("input[id]").forEach(el => { fields[el.id] = el.value; });
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, fields }));
  }

  function buildRow(doc, data = { desc: "", qty: 1, price: 0 }) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="idx"></td>
      <td><input class="desc" type="text" value="${escapeAttr(data.desc)}"></td>
      <td><input class="qty" type="number" min="0" step="1" value="${data.qty}"></td>
      <td><input class="price" type="number" min="0" step="0.01" value="${data.price}"></td>
      <td class="total">0.00</td>
      <td class="col-del no-print"><button class="del" title="删除">×</button></td>
    `;
    tr.querySelector(".qty").addEventListener("input", () => onRowChange(doc, tr));
    tr.querySelector(".price").addEventListener("input", () => onRowChange(doc, tr));
    tr.querySelector(".desc").addEventListener("input", () => onRowChange(doc, tr));
    tr.querySelector(".del").addEventListener("click", () => {
      tr.remove();
      syncRowsFromDom(doc);
      render(doc);
      saveState();
    });
    return tr;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function onRowChange(doc, tr) {
    syncRowsFromDom(doc);
    render(doc);
    saveState();
  }

  function syncRowsFromDom(doc) {
    const tbody = $(`#${doc}-items tbody`);
    state[doc].rows = $$("tr", tbody).map(tr => ({
      desc:  tr.querySelector(".desc").value,
      qty:   Number(tr.querySelector(".qty").value)  || 0,
      price: Number(tr.querySelector(".price").value) || 0
    }));
  }

  function render(doc) {
    const tbody = $(`#${doc}-items tbody`);
    const rows = state[doc].rows;
    tbody.innerHTML = "";
    rows.forEach(r => tbody.appendChild(buildRow(doc, r)));

    let subtotal = 0;
    $$("tr", tbody).forEach((tr, i) => {
      tr.querySelector(".idx").textContent = i + 1;
      const qty = Number(tr.querySelector(".qty").value) || 0;
      const price = Number(tr.querySelector(".price").value) || 0;
      const line = qty * price;
      tr.querySelector(".price").value = price ? fmt(price) : "";
      tr.querySelector(".total").textContent = fmt(line);
      subtotal += line;
    });

    const tax = Number($(`#${doc}-tax`)?.value) || 0;
    const ship = Number($(`#${doc}-shipping`)?.value) || 0;
    const other = Number($(`#${doc}-other`)?.value) || 0;
    const total = subtotal + tax + ship + other;

    $(`[data-sum="${doc}-subtotal"]`).textContent = fmt(subtotal);
    $(`[data-sum="${doc}-total"]`).textContent = "RM " + fmt(total);
  }

  const tabPO = $("#tab-po");
  const tabInv = $("#tab-inv");
  const pagePO = $("#page-po");
  const pageInv = $("#page-inv");

  function showTab(which) {
    const isPO = which === "po";
    tabPO.classList.toggle("active", isPO);
    tabInv.classList.toggle("active", !isPO);
    pagePO.classList.toggle("hidden", !isPO);
    pageInv.classList.toggle("hidden", isPO);
  }
  tabPO.addEventListener("click", () => showTab("po"));
  tabInv.addEventListener("click", () => showTab("inv"));

  $("#btn-add").addEventListener("click", () => {
    const active = pagePO.classList.contains("hidden") ? "inv" : "po";
    state[active].rows.push({ desc: "", qty: 1, price: 0 });
    render(active);
    saveState();
  });

  $("#btn-clear").addEventListener("click", () => {
    if (!confirm("确定清空当前页面的数据？（仅本机）")) return;
    const active = pagePO.classList.contains("hidden") ? "inv" : "po";
    state[active].rows = [{ desc: "", qty: 1, price: 0 }];
    render(active);
    saveState();
  });

  ["po", "inv"].forEach(doc => {
    ["tax", "shipping", "other"].forEach(field => {
      const el = $(`#${doc}-${field}`);
      if (el) el.addEventListener("input", () => { render(doc); saveState(); });
    });
  });

  // ---------------- 下载 PDF ----------------
  $("#btn-download").addEventListener("click", () => {
    const isPO = !pagePO.classList.contains("hidden");
    const targetId = isPO ? "pdf-po-area" : "pdf-inv-area";
    const filename = isPO ? "Purchase-Order.pdf" : "Invoice.pdf";
    const element = document.getElementById(targetId);

    const opt = {
      margin:       [8, 8, 8, 8],
      filename:     filename,
      image:        { type: 'jpeg', quality: 1 },
      html2canvas:  { scale: 2, useCORS: true, scrollY: 0 },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    const btn = $("#btn-download");
    const originalText = btn.innerHTML;
    btn.innerHTML = "生成中...";
    btn.disabled = true;

    html2pdf().set(opt).from(element).save().then(() => {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }).catch(err => {
      console.error(err);
      alert("生成失败，请重试！");
      btn.innerHTML = originalText;
      btn.disabled = false;
    });
  });

  loadState();
  render("po");
  render("inv");
})();
