// 🏅 签到达人礼物：库存提醒（剩 20、剩 10 各提醒一次）
// 礼物 = 后台「额外福利 › 每日签到」选的奖品（settings/perks.checkin.m30.giftRewardId）
// 「好的，我会添加库存」→ 记下 settings/perks.checkin.stockAck = { level, stock }，同一级、库存没变多就不再提醒
// 「已添加库存」→ 填数量，奖品库存加上去，清掉 stockAck
// 用在：会员系统总览、额外福利页、侧边栏「额外福利」红点、控制台首页
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc, updateDoc, increment, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

export const CI_STOCK_LEVELS = [20, 10];
const levelOf = n => (n <= 10 ? 10 : n <= 20 ? 20 : null);

// 回传 { show, level, stock, reward, rewardId } 或 null（没设定礼物 / 没设库存 / 签到没开）
export async function ciStockState() {
  try {
    const p = await getDoc(doc(db, "settings", "perks"));
    const c = (p.exists() ? p.data().checkin : null) || {};
    const rid = c.m30 && c.m30.giftRewardId;
    if (c.active !== true || !rid) return null;
    const r = await getDoc(doc(db, "rewards", rid));
    if (!r.exists() || typeof r.data().stock !== "number") return null;
    const stock = r.data().stock, level = levelOf(stock);
    const ack = c.stockAck || null;
    // 已经按过「好的」：同一级、而且库存没有比当时多（中间补过货又跌回来就再提醒）
    const acked = ack && ack.level === level && stock <= ack.stock;
    return { show: !!level && !acked, level, stock, reward: { id: rid, ...r.data() }, rewardId: rid };
  } catch (e) { console.warn("ci stock", e); return null; }
}

export function ciStockBannerHTML(st) {
  if (!st || !st.show) return "";
  return `<div class="ci-stock-bar" data-ci-stock>
    <div>📦 <b>签到达人礼物「${escH(st.reward.name || "")}」库存只剩 ${st.stock} 个</b>${st.stock <= 0 ? "（新的签到达人礼物会标「补货中」）" : ""}
      <div class="meta">剩 20、剩 10 各提醒一次。会员签满 30 天时会自动扣 1 个库存。</div></div>
    <div class="actions" style="margin:0">
      <button class="btn btn-primary" data-ci-stock-add>✅ 已添加库存</button>
      <button class="btn btn-ghost" data-ci-stock-ack>好的，我会添加库存</button>
    </div>
  </div>`;
}
// 在 root 里接上两个按钮；onDone() 在处理完后呼叫（重新整理画面）
export function bindCiStockBanner(root, st, onDone) {
  const bar = root.querySelector("[data-ci-stock]");
  if (!bar || !st) return;
  bar.querySelector("[data-ci-stock-add]").onclick = async () => {
    const v = prompt(`「${st.reward.name || ""}」补了多少个？（现在库存 ${st.stock}）`, "");
    if (v === null) return;
    const n = parseInt(v, 10);
    if (!(n > 0) || n > 100000) { alert("请填大于 0 的数量"); return; }
    try {
      await updateDoc(doc(db, "rewards", st.rewardId), { stock: increment(n), updatedAt: serverTimestamp() });
      await setDoc(doc(db, "settings", "perks"), { checkin: { stockAck: deleteField() } }, { merge: true });
      onDone && onDone();
    } catch (e) { alert("更新失败：" + e.message); }
  };
  bar.querySelector("[data-ci-stock-ack]").onclick = async () => {
    try {
      await setDoc(doc(db, "settings", "perks"), { checkin: { stockAck: { level: st.level, stock: st.stock, at: serverTimestamp() } } }, { merge: true });
      onDone && onDone();
    } catch (e) { alert("保存失败：" + e.message); }
  };
}
// 侧边栏「额外福利」旁边的红点（!）
export async function refreshCiStockBadge() {
  const el = document.getElementById("perksBadge");
  if (!el) return;
  const st = await ciStockState();
  el.textContent = "!";
  el.hidden = !(st && st.show);
  el.title = st && st.show ? `签到达人礼物库存剩 ${st.stock}` : "";
}
function escH(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
