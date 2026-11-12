// 🧺 打包管理「⚠️ 需要处理」（2026-11-13）
// 打包管理页（member-system/pack.html）和总览（member-system/index.html）共用同一套算法，数字才会一样
// 资料 = pkAdmin batch 回传的 { parcels, pending, shift } + 时间段 range
import { esc } from "./admin-common.js";

const DAY = 86400000;
const pad = n => String(n).padStart(2, "0");
const fmtT = ms => { if (!ms) return "-"; const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const noHtml = no => { const s = String(no || ""); return `<span class="no">${esc(s.slice(0, -4))}<b>${esc(s.slice(-4))}</b></span>`; };
const nameOf = (email, byName) => byName || (email === "mail@themochiishop.com" ? "店主" : String(email || "").split("@")[0] || "-");
const whoOf = p => p.uid ? (p.member || p.username || "会员") : (p.username || "-");
const left = p => p.items.filter(i => i.can);
const warnsOf = p => p.items.filter(i => !i.can);
const itemsTxt = arr => (arr || []).map(x => esc(x.title || x.id) + (x.reason ? `（${esc(x.reason)}）` : "")).join("、");

// 直播场次：晚上 8 点到隔天早上 8 点（back = 往前几天）
export function liveRange(now = new Date(), back = 0) {
  const a = new Date(now), b = new Date(now);
  if (now.getHours() >= 20) { a.setHours(20, 0, 0, 0); b.setDate(b.getDate() + 1); b.setHours(8, 0, 0, 0); }
  else { a.setDate(a.getDate() - 1); a.setHours(20, 0, 0, 0); b.setHours(8, 0, 0, 0); }
  return { from: a.getTime() - back * DAY, to: b.getTime() - back * DAY };
}

// 每一项：{ type, hi（黄色 = 要处理）, icon, html, no?, act? }
export const ISSUE_LABEL = {
  nmMissing: "迎新礼没放入", nmLinked: "迎新礼还没寄出", undone: "撤销后还没重新打包",
  shiftLeft: "收工时没打包", noFinish: "这一场还没收工", warn: "要先处理才能放", skipped: "有东西没放",
};
export function packIssues({ parcels = [], pending = [], shift = null, range = null }, now = Date.now()) {
  const out = [];
  const seen = new Set();
  pending.forEach(g => g.items.forEach(i => {
    if (i.kind === "nm" && i.issueOrder && !seen.has(i.id)) { seen.add(i.id);
      out.push({ type: "nmMissing", hi: true, icon: "🎉", html: `<b>迎新礼没放入</b>：${esc(g.member || "会员")} 的 ${esc(i.title)}：${esc(i.sub || "")}`,
        act: `<a class="btn btn-ghost" href="newmember.html#records" style="padding:5px 10px;font-size:.8rem">去处理</a>`, no: i.issueOrder }); }
  }));
  pending.forEach(g => g.items.forEach(i => {
    const lp = i.kind === "nm" && i.linkedOrder && i.can ? parcels.find(p => p.orderNo === i.linkedOrder && p.done) : null;
    if (lp) out.push({ type: "nmLinked", hi: true, icon: "🎉", no: lp.orderNo, html: `<b>迎新礼那包已打包，但迎新礼还没寄出</b>：${esc(g.member || "会员")} 的 ${esc(i.title)} 要放 ${noHtml(lp.orderNo)}。请确认有没有放进去，再到新会员奖励处理。`,
      act: `<a class="btn btn-ghost" href="newmember.html#records" style="padding:5px 10px;font-size:.8rem">去处理</a>` });
  }));
  parcels.filter(p => p.undone && !p.done).forEach(p => out.push({ type: "undone", hi: true, icon: "↩️", no: p.orderNo,
    html: `<b>撤销后还没重新打包</b>：${noHtml(p.orderNo)} ${esc(whoOf(p))} · ${esc(nameOf(p.undone.by, p.undone.byName))} ${fmtT(p.undone.at)} 撤销` }));
  if (shift) shift.remaining.forEach(x => { const p = parcels.find(y => y.orderNo === x.orderNo); if (p && !p.done) out.push({ type: "shiftLeft", hi: true, icon: "🏁", no: x.orderNo,
    html: `<b>收工时没打包</b>：${noHtml(x.orderNo)} ${esc(x.username || "")} · 原因：${esc(x.reason)}` }); });
  else if (range && parcels.length && range.to < now && parcels.some(p => !p.done)) out.push({ type: "noFinish", hi: true, icon: "🏁", html: `<b>这一场还没收工</b>：还有 ${parcels.filter(p => !p.done).length} 包没打包，也没有人按「🏁 收工」` });
  parcels.filter(p => !p.done && warnsOf(p).length).forEach(p => warnsOf(p).filter(i => !i.issueOrder).forEach(i => out.push({ type: "warn", hi: false, icon: i.icon, no: p.orderNo,
    html: `<b>要先处理才能放</b>：${noHtml(p.orderNo)} ${esc(whoOf(p))} · ${esc(i.title)}：${esc(i.warn || i.sub || "")}` })));
  parcels.filter(p => p.done && p.packed && p.packed.skipped && p.packed.skipped.some(x => x.kind !== "nm")).forEach(p => out.push({ type: "skipped", hi: false, icon: "❌", no: p.orderNo,
    html: `<b>这包有东西没放</b>（留到下一单）：${noHtml(p.orderNo)} ${esc(whoOf(p))} · ${itemsTxt(p.packed.skipped.filter(x => x.kind !== "nm"))}` }));
  return out;
}
// 总览用：黄色几项 + 每一类几项（「这一场还没收工」不写数字）
export function issueSummary(list) {
  const hi = list.filter(x => x.hi), by = {};
  hi.forEach(x => by[x.type] = (by[x.type] || 0) + 1);
  return { n: hi.length, notes: list.length - hi.length,
    text: Object.entries(by).map(([t, c]) => t === "noFinish" ? ISSUE_LABEL[t] : `${ISSUE_LABEL[t]} ${c}`).join(" · ") };
}
