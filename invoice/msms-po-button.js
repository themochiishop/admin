// =====================================================================
//  MSMS → 开单系统【生成 PO 单】跳转
//  放进 MSMS 后台订单详情页使用。下面的 order 字段名是示例，
//  请对照 MSMS 实际订单资料改成真正的字段名（金额如果存「分」要先 ÷100）。
// =====================================================================

const INVOICE_URL = "https://admin.themochiishop.com/invoice/";

// 付款阶段：deposit 定金 30%｜balance 尾款 70%｜full 全款 100%
const STAGES = {
  deposit: { terms: "30% Deposit · WorldFirst to Alipay", suffix: "D" },
  balance: { terms: "70% Balance Payment · WorldFirst to Alipay", suffix: "B" },
  full: { terms: "100% Full Payment · WorldFirst to Alipay", suffix: "F" },
};

/**
 * @param {object} order  MSMS 订单
 *   order.no            订单号，如 "MSMS-20261119-01"
 *   order.supplier      { name, phone, alipayAccount, alipayRealName }
 *   order.items         [{ name, qty, unitPrice }]   单价用「元」
 *   order.depositPaid   已付定金（元），开尾款单时用
 * @param {"deposit"|"balance"|"full"} stage
 */
export function buildPoUrl(order, stage) {
  const st = STAGES[stage];
  if (!st) throw new Error("stage 只能是 deposit / balance / full");

  const p = new URLSearchParams();
  p.set("from", "msms");
  p.set("ref", order.no);
  p.set("no", `PO-${String(order.no).replace(/^MSMS-?/i, "MSMS").replace(/[^A-Za-z0-9-]/g, "")}-${st.suffix}`);
  p.set("curr", "CNY");
  p.set("terms", st.terms);
  p.set("deposit", stage === "balance" ? Number(order.depositPaid || 0).toFixed(2) : "0.00");

  const s = order.supplier || {};
  if (s.name) p.set("vName", s.name);
  if (s.phone) p.set("vPhone", s.phone);
  p.set("vBank", "Alipay (支付宝)");
  if (s.alipayAccount) p.set("vAcct", s.alipayAccount);
  if (s.alipayRealName) p.set("vAcctName", s.alipayRealName);

  const items = (order.items || []).map(it => ({
    desc: String(it.name || ""),
    qty: Number(it.qty) || 0,
    price: Number(it.unitPrice || 0).toFixed(2),
  }));
  if (items.length) p.set("items", JSON.stringify(items));

  return `${INVOICE_URL}?${p.toString()}`;
}

/** 按钮点下去：开新分页（手机也可用） */
export function openPo(order, stage) {
  window.open(buildPoUrl(order, stage), "_blank", "noopener");
}

// ---------- React 用法示例 ----------
// 定金模式：未付定金显示「生成定金 PO」，已付定金显示「生成尾款 PO」
// 全额模式：显示「生成全款 PO」
//
// {order.paymentMode === "deposit" && !order.depositPaid && (
//   <button onClick={() => openPo(order, "deposit")}>生成定金 PO</button>
// )}
// {order.paymentMode === "deposit" && order.depositPaid > 0 && (
//   <button onClick={() => openPo(order, "balance")}>生成尾款 PO</button>
// )}
// {order.paymentMode === "full" && (
//   <button onClick={() => openPo(order, "full")}>生成全款 PO</button>
// )}
