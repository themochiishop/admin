/* =========================================================================
 * Mochiishop 每月抽奖 · 赛制核心逻辑（admin.html 与 index.html 共用）
 *
 * 流程：
 *   1. 第 1 轮：全部买家进入待 PK 池
 *   2. 每个 POLL 盲抽 2~4 人一组（Shopee 投票最多 4 个选项，系统自动安排 3~4 人）
 *   3. 直播间投票 → 后台输入票选号 → 前台主播点【揭晓】→ 命中者进晋级区，其余淘汰
 *   4. 待 PK 池抽完 → 自动进入下一轮，上一轮的晋级者成为新的名单池
 *   5. 直到模式目标：
 *        模式 1：剩 3 人 → 盲抽 🥉 季军 → 剩 2 人 → 盲抽 👑 冠军（另一位 🥈 亚军）
 *        模式 2：剩 N+3 人 → 🎁 安慰奖阶段（命中者得安慰奖，其余回池，抽满 N 位）
 *               → 剩 3 人 → 季军 → 冠亚军
 *        模式 3：冠亚季 + 入围奖 F + 安慰奖 C：剩 C+F+3 → 安慰奖阶段 → 剩 F+3 → 🎖️ 入围奖阶段 → 季军 → 冠亚军
 *        模式 4：全部名额自定义（冠军 / 亚军 / 季军 / 入围 / 安慰），逻辑同上
 *   奖项阶段（安慰 → 入围 → 季军）：每组命中者得奖，其余回名单池，直到该奖项抽满；
 *   冠亚军决战：命中者为冠军，冠军抽满后其余为亚军。
 *   系统会自动计算每轮分几组，保证刚好落在目标人数，不会剩下 1 个人抽不了。
 * ========================================================================= */
(function (global) {
  const PODIUM_THIRD_LABEL = "🏆 冠亚季争夺战 (剩3人)";
  const PODIUM_FINAL_LABEL = "👑 冠亚军终极决战 (2选1)";
  const MAX_GROUP = 4;          // Shopee 投票最多 4 个选项
  const PAIR_PENALTY = 1;       // 2 人一组：可以，但尽量少用
  const BYE_PENALTY = 8;        // 1 人轮空：除非没有别的办法

  // ---------- 公平随机 ----------
  // 0 ≤ x < n 的均匀随机整数（浏览器加密随机数，拒绝采样避免取模偏差）
  function randomInt(n) {
    const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
    if (!c) return Math.floor(Math.random() * n);
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { c.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }
  // Fisher–Yates 洗牌：每种排列机会完全相同（不修改原数组）
  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 基本读取 ----------
  const modeOn = st => !!(st.modeConfig && st.modeConfig.enabled);
  const modeOf = st => (st.modeConfig && st.modeConfig.selectedMode) || 'mode1';
  const cands = r => (r && r.candidates) || [];
  const pendingOf = r => cands(r).filter(c => c.status === 'pending');
  const passedOf = r => cands(r).filter(c => c.status === 'pass');

  // ---------- 奖项名额 ----------
  // 奖项阶段由低到高；最后是冠亚军决战（final）
  const TIERS = ['consolation', 'finalist', 'third'];
  const RANK_KEY = { consolation: 'rankConsolation', finalist: 'rankFinalist', third: 'rankThird', champion: 'rankChampion', runnerUp: 'rankRunnerUp' };
  const RANK_TITLE = { consolation: '🎁 安慰奖', finalist: '🎖️ 入围奖', third: '🥉 季军', champion: '👑 冠军', runnerUp: '🥈 亚军' };
  const num = (v, d, min) => { const n = parseInt(v, 10); return Math.max(min, isNaN(n) ? d : n); };
  // 每个奖项几人
  function prizePlan(st) {
    const mc = st.modeConfig || {};
    const m = modeOf(st);
    if (m === 'mode2') return { consolation: num(mc.mode2ConsolationCount, 10, 1), finalist: 0, third: 1, runnerUp: 1, champion: 1 };
    if (m === 'mode3') return { consolation: num(mc.mode3ConsolationCount, 10, 1), finalist: num(mc.mode3FinalistCount, 5, 1), third: 1, runnerUp: 1, champion: 1 };
    if (m === 'mode4') return { consolation: num(mc.mode4ConsolationCount, 10, 0), finalist: num(mc.mode4FinalistCount, 5, 0), third: num(mc.mode4ThirdCount, 1, 0), runnerUp: num(mc.mode4RunnerUpCount, 1, 1), champion: num(mc.mode4ChampionCount, 1, 1) };
    return { consolation: 0, finalist: 0, third: 1, runnerUp: 1, champion: 1 };
  }
  const isClassicPodium = P => P.third === 1 && P.runnerUp === 1 && P.champion === 1;
  const finalSize = st => { const P = prizePlan(st); return P.runnerUp + P.champion; };
  // 已发出的某奖项人数（exceptRi：不算这一轮）
  function countRank(st, key, exceptRi) {
    let n = 0;
    (st.rounds || []).forEach((r, i) => { if (i !== exceptRi) cands(r).forEach(c => { if (c.rankKey === key) n++; }); });
    return n;
  }
  function tierLeft(st, tier, exceptRi) { return Math.max(0, prizePlan(st)[tier] - countRank(st, RANK_KEY[tier], exceptRi)); }
  // 从第 idx 个奖项开始（含冠亚军）还需要多少人
  function remainingFrom(st, idx, exceptRi) {
    let n = finalSize(st);
    for (let i = idx; i < TIERS.length; i++) n += tierLeft(st, TIERS[i], exceptRi);
    return n;
  }
  // 下一个要抽的奖项（全部抽完 → 'final'）
  function nextTierIndex(st, exceptRi) {
    for (let i = 0; i < TIERS.length; i++) if (tierLeft(st, TIERS[i], exceptRi) > 0) return i;
    return TIERS.length;
  }

  // 兼容旧版本
  const isMode2 = st => modeOn(st) && prizePlan(st).consolation > 0;
  const consolationN = st => prizePlan(st).consolation;
  function countConsolation(st) { return countRank(st, 'rankConsolation'); }
  function consolationDone(st) { return countConsolation(st) >= consolationN(st); }

  // 普通轮要减到几人：所有还没发的奖项 + 冠亚军
  function targetOf(st) {
    if (!modeOn(st)) return null;
    return remainingFrom(st, 0);
  }

  // n 人的新一轮是哪个阶段（null = 普通轮）
  //   奖项阶段：人数在 T ~ 2T-1 之间（已经没法用 2~4 人一组刚好减到 T）就直接开始
  function freshStage(st, n, exceptRi) {
    if (!modeOn(st)) return null;
    const idx = nextTierIndex(st, exceptRi);
    if (idx >= TIERS.length) return (n >= 2 && n <= finalSize(st)) ? 'final' : null;
    const T = remainingFrom(st, idx, exceptRi);
    return (n >= T && n < 2 * T) ? TIERS[idx] : null;
  }
  function shouldStartConsolation(st, n) { return freshStage(st, n) === 'consolation'; }

  // 'normal' | 'consolation' | 'finalist' | 'third' | 'final'
  function getRoundStage(st, ri) {
    const r = st.rounds && st.rounds[ri];
    if (!r || !modeOn(st)) return 'normal';
    if (r.awardTier) return r.awardTier;                     // 开始抽之后固定下来
    if (r.isConsolationStage) return 'consolation';          // 旧数据
    return freshStage(st, cands(r).length, ri) || 'normal';
  }
  // 这一轮的奖项还差几位（tier 阶段 / 冠军）
  function stageNeed(st, ri) {
    const stage = getRoundStage(st, ri);
    if (stage === 'final') return Math.max(0, prizePlan(st).champion - countRank(st, 'rankChampion', ri));
    if (TIERS.includes(stage)) return tierLeft(st, stage, ri);
    return 0;
  }
  function stageGot(st, ri) {
    const stage = getRoundStage(st, ri);
    const key = stage === 'final' ? 'rankChampion' : RANK_KEY[stage];
    return key ? cands(st.rounds[ri]).filter(c => c.rankKey === key).length : 0;
  }
  // 季军 / 冠军这一轮是否已经抽满
  function isPodiumDecided(st, ri) {
    const stage = getRoundStage(st, ri);
    if (stage !== 'third' && stage !== 'final') return false;
    return stageGot(st, ri) >= stageNeed(st, ri);
  }
  function isTournamentFinished(st) {
    const champs = countRank(st, 'rankChampion');
    if (!champs) return false;
    return !modeOn(st) || champs >= prizePlan(st).champion;
  }
  // 名额说明，例：安慰奖 10 + 入围奖 5 + 冠亚季 3
  function planText(st) {
    const P = prizePlan(st), out = [];
    if (P.consolation) out.push(`安慰奖 ${P.consolation}`);
    if (P.finalist) out.push(`入围奖 ${P.finalist}`);
    if (isClassicPodium(P)) out.push('冠亚季 3');
    else { if (P.third) out.push(`季军 ${P.third}`); out.push(`亚军 ${P.runnerUp}`, `冠军 ${P.champion}`); }
    return out.join(' + ');
  }

  // ---------- 分组规划 ----------
  // m 人平均分成 g 组时：几组 2 人、几组 1 人（轮空）
  function partition(m, g) {
    if (g <= 0) return { pairs: 0, byes: 0 };
    const q = Math.floor(m / g), extra = m % g;
    const count = size => (size === q + 1 ? extra : 0) + (size === q ? g - extra : 0);
    return { pairs: count(2), byes: count(1) };
  }
  function stepCost(m, g) {
    const p = partition(m, g);
    return (g - p.byes) + p.pairs * PAIR_PENALTY + p.byes * BYE_PENALTY; // 投票次数 + 惩罚
  }

  // 从 m 人走到 T 人最少要多少代价；choice[m] = 本轮最佳组数
  const _memo = {};
  function planTable(T) {
    if (_memo[T]) return _memo[T];
    _memo[T] = { cost: { [T]: 0 }, choice: {} };
    return _memo[T];
  }
  function costTo(m, T) {
    const tb = planTable(T);
    if (m < T) return Infinity;
    if (tb.cost[m] !== undefined) return tb.cost[m];
    // 自下而上补齐，避免深递归
    for (let x = T + 1; x <= m; x++) {
      if (tb.cost[x] !== undefined) continue;
      let best = Infinity, bestG = null;
      for (let g = Math.max(T, Math.ceil(x / MAX_GROUP)); g < x; g++) {
        const c = stepCost(x, g) + tb.cost[g];
        if (c < best) { best = c; bestG = g; }
      }
      tb.cost[x] = best; tb.choice[x] = bestG;
    }
    return tb.cost[m];
  }

  // 本轮还剩 r 人待 PK、已有 w 人晋级：剩下的人最好再分几组
  function bestRemainingGroups(r, w, T) {
    if (r <= 0) return { g: 0, cost: (T == null || w === T || costTo(w, T) < Infinity) ? 0 : Infinity };
    if (T == null) return { g: Math.ceil(r / MAX_GROUP), cost: 0 };
    let best = { g: null, cost: Infinity };
    for (let g = Math.ceil(r / MAX_GROUP); g <= r; g++) {
      const next = w + g;
      if (next < T) continue;
      const c = stepCost(r, g) + costTo(next, T);
      if (c < best.cost) best = { g, cost: c };
    }
    return best;
  }

  // 下一组建议抽几人
  function plannedGroupSize(st, ri) {
    const r = st.rounds[ri];
    const stage = getRoundStage(st, ri);
    const pending = pendingOf(r).length;
    if (pending === 0) return 0;
    if (stage !== 'normal') return Math.min(MAX_GROUP, pending);    // 奖项阶段 / 决赛：最多 4 人一组（3 人季军、2 人决赛 = 全员上台）
    const plan = bestRemainingGroups(pending, passedOf(r).length, targetOf(st));
    if (!plan.g) return Math.min(MAX_GROUP, pending);
    return Math.ceil(pending / plan.g);
  }

  // 手动改人数时检查：抽 s 人之后，后面还能不能刚好落在目标人数
  function isGroupSizeFeasible(st, ri, s) {
    const r = st.rounds[ri];
    const stage = getRoundStage(st, ri);
    const pending = pendingOf(r).length;
    if (s < 1 || s > Math.min(MAX_GROUP, pending)) return false;
    if (stage !== 'normal') return true;
    const T = targetOf(st);
    if (T == null) return true;
    return bestRemainingGroups(pending - s, passedOf(r).length + 1, T).cost < Infinity;
  }

  function tierStepLabel(tier, k) {
    if (tier === 'consolation') return `🎁 安慰奖 ×${k}`;
    if (tier === 'finalist') return `🎖️ 入围奖 ×${k}`;
    return k === 1 ? '🥉 季军' : `🥉 季军 ×${k}`;
  }
  // 从第 idx 个奖项开始的路线（含冠亚军决战）
  function tailSteps(st, idx, exceptRi) {
    const out = [];
    for (let i = idx; i < TIERS.length; i++) {
      const k = tierLeft(st, TIERS[i], exceptRi);
      if (k > 0) out.push({ n: remainingFrom(st, i, exceptRi), label: tierStepLabel(TIERS[i], k) });
    }
    out.push({ n: finalSize(st), label: '👑 冠亚军' });
    return out;
  }
  // 路线图，例如 [87, 22, 6, 3] + 说明
  function roadmap(st, ri) {
    const r = st.rounds[ri];
    const stage = getRoundStage(st, ri);
    const steps = [];
    if (!r) return steps;
    const total = cands(r).length;
    if (stage === 'final') return [{ n: total, label: '👑 冠亚军' }];
    if (TIERS.includes(stage)) {
      const idx = TIERS.indexOf(stage);
      const k = tierLeft(st, stage, ri);
      const out = [{ n: total, label: tierStepLabel(stage, k) }];
      const left = pendingOf(r).length - (k - stageGot(st, ri));
      const nextT = remainingFrom(st, idx + 1, ri);
      if (left > nextT && freshStage(st, left) == null) out.push({ n: left, label: '加赛' });
      return out.concat(tailSteps(st, idx + 1, ri));
    }
    steps.push({ n: total, label: `第 ${ri + 1} 轮` });
    const T = targetOf(st);
    if (T == null) return steps;
    const plan = bestRemainingGroups(pendingOf(r).length, passedOf(r).length, T);
    if (plan.cost === Infinity) return steps;
    let m = passedOf(r).length + plan.g, k = ri + 2;
    while (m > T) {
      steps.push({ n: m, label: `第 ${k++} 轮` });
      costTo(m, T);
      m = planTable(T).choice[m];
      if (!m) break;
    }
    return steps.concat(tailSteps(st, 0));
  }

  function minimumBuyers(st) {
    if (!modeOn(st)) return 2;
    const P = prizePlan(st);
    return P.consolation + P.finalist + P.third + P.runnerUp + P.champion;
  }

  // ---------- 名单导入 ----------
  // 标准 CSV 解析（支持引号、引号内逗号/换行、"" 转义）
  function parseCSVRows(text) {
    const rows = []; let row = [], field = '', q = false;
    const t = String(text || '').replace(/^\ufeff/, '');
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) {
        if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && t[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x !== ''));
  }

  /**
   * 买家名单 → 候选人
   *   一张订单 = 一次机会（同一买家多张订单就多次机会）
   *   同一订单号重复出现只算一次
   * 表头可选：第一行含「买家姓名 / Name」时自动识别「订单号 / Order」所在列，否则第 1 列名字、第 2 列订单号
   */
  function parseBuyerCSV(text) {
    const rows = parseCSVRows(text);
    let nameCol = 0, orderCol = 1, start = 0;
    if (rows.length) {
      const h = rows[0].map(x => x.toLowerCase());
      const ni = h.findIndex(x => /买家姓名|买家|姓名|^name$|buyer|username/.test(x));
      if (ni !== -1) {
        nameCol = ni; start = 1;
        let oi = h.findIndex(x => /订单号|单号|order\s*(no|id|number|sn)|^order$/.test(x));
        if (oi === -1) oi = h.findIndex(x => /订单|order/.test(x));
        if (oi !== -1) orderCol = oi;
      }
    }
    const seen = new Set();
    const out = []; let dup = 0, noOrder = 0, noName = 0;
    for (let i = start; i < rows.length; i++) {
      const name = (rows[i][nameCol] || '').trim();
      const order = (rows[i][orderCol] || '').trim();
      if (!name) { noName++; continue; }
      if (order) {
        const key = order.toUpperCase();
        if (seen.has(key)) { dup++; continue; }
        seen.add(key);
      } else noOrder++;
      out.push({ id: `b${out.length}`, name, orderNo: order, status: 'pending' });
    }
    const perName = {};
    out.forEach(c => { perName[c.name] = (perName[c.name] || 0) + 1; });
    const buyers = Object.keys(perName).length;
    const multi = Object.values(perName).filter(n => n > 1).length;
    const lines = [`✅ 已导入 ${out.length} 张订单（${buyers} 位买家${multi ? `，其中 ${multi} 位有多张订单 = 多次机会` : ''}）`];
    if (dup) lines.push(`• 移除重复订单号 ${dup} 行（同一订单只算一次）`);
    if (noOrder) lines.push(`⚠️ ${noOrder} 行没有订单号（已保留，请确认）`);
    if (noName) lines.push(`• 跳过没有名字的 ${noName} 行`);
    return { candidates: out, summary: lines.join('\n'), stats: { orders: out.length, buyers, multi, dup, noOrder, noName } };
  }

  // ---------- 公开显示 ----------
  // 订单号：显示前 6 位（日期，例如 241027 = 2024-10-27 下单）+ 中间 **** + 后 4 位尾数
  //   例：241027ABCD1234 → 241027****1234
  function maskOrder(o) {
    const t = String(o || '').trim();
    if (!t) return '';
    if (t.length <= 6) return t;
    if (t.length <= 10) return t.slice(0, 6) + '*'.repeat(t.length - 6);   // 太短时只遮后段，避免露出全部
    return t.slice(0, 6) + '****' + t.slice(-4);
  }
  // 表格链接 → CSV 链接（贴 pubhtml 网页链接也可以），并加时间戳避免拿到缓存的旧名单
  function toCsvUrl(url) {
    let u = String(url || '').trim();
    if (!u) return '';
    if (/\/pubhtml/.test(u)) {
      u = u.replace('/pubhtml', '/pub');
      u += (u.includes('?') ? '&' : '?') + 'output=csv';
    } else if (/\/pub\?/.test(u) && !/output=csv/.test(u)) {
      u += '&output=csv';
    }
    return u + (u.includes('?') ? '&' : '?') + '_ts=' + Date.now();
  }
  // 揭晓按钮文字（依当前阶段）
  function revealLabel(st, ri) {
    const stage = getRoundStage(st, ri == null ? (st.drawRoundIndex || 0) : ri);
    if (stage === 'third') return { icon: '🥉', text: '揭晓季军' };
    if (stage === 'final') return { icon: '👑', text: '揭晓冠军' };
    if (stage === 'consolation') return { icon: '🎁', text: '揭晓安慰奖' };
    if (stage === 'finalist') return { icon: '🎖️', text: '揭晓入围奖' };
    return { icon: '🎯', text: '点击揭晓' };
  }

  // ---------- 开奖记录 ----------
  // type: poll(盲抽揭晓) | manual(手动晋级/判定) | bye(轮空) | out(手动淘汰) | redraw(重抽) | cleared(清空组) | undo(撤回/撤销)
  function logDraw(st, entry) {
    if (!Array.isArray(st.drawLog)) st.drawLog = st.drawLog ? Object.values(st.drawLog) : [];
    const clean = {};
    Object.keys(entry).forEach(k => { if (entry[k] !== undefined) clean[k] = entry[k]; });
    clean.ts = Date.now();
    clean.id = clean.ts.toString(36) + Math.random().toString(36).slice(2, 7);
    st.drawLog.push(clean);
  }
  const STAGE_TEXT = { normal: '普通轮', consolation: '安慰奖阶段', finalist: '入围奖阶段', third: '冠亚季争夺战', final: '冠亚军决战' };
  const RESULT_TEXT = { normal: '晋级', consolation: '🎁 安慰奖', finalist: '🎖️ 入围奖', third: '🥉 季军', final: '👑 冠军' };
  function personOf(c) { return { name: c.name || '', orderNo: c.orderNo || '' }; }

  const TYPE_TEXT = { poll: '盲抽揭晓', manual: '手动判定', bye: '轮空晋级', out: '手动淘汰', redraw: '重抽', cleared: '清空组', undo: '撤销' };
  const BY_TEXT = { public: '前台主播', admin: '后台', manual: '后台手动' };
  function fmtTime(ts) {
    const d = new Date(ts || Date.now()), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function membersText(e, mask) {
    const o = x => (mask ? maskOrder(x) : x) || '-';
    return (e.members || []).map(m => `${m.no != null ? '#' + m.no + ' ' : ''}${m.name}(${o(m.orderNo)})`).join(' / ');
  }
  // 开奖记录 → CSV（带 BOM，Excel 打开中文不乱码）
  function drawLogToCSV(log, title) {
    const esc = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const head = ['时间', '轮次', '阶段', 'POLL', '类型', '组员（号码 名字(订单号)）', '票选号', '结果', '得主/当事人', '订单号', '亚军', '操作端'];
    const rows = (log || []).map(e => [fmtTime(e.ts), e.round ? `第 ${e.round} 轮` : '', e.stage || '', e.poll ? '#' + e.poll : '',
      TYPE_TEXT[e.type] || e.type, membersText(e), e.trigger ? '#' + e.trigger : '', e.result || '',
      e.winner ? e.winner.name : '', e.winner ? e.winner.orderNo : '', e.runnerUp ? `${e.runnerUp.name}(${e.runnerUp.orderNo})` : '', BY_TEXT[e.by] || e.by || '']);
    const lines = [];
    if (title) lines.push(esc(title));
    lines.push(head.map(esc).join(','));
    rows.forEach(r => lines.push(r.map(esc).join(',')));
    return '\ufeff' + lines.join('\r\n');
  }

  // ---------- 状态变更 ----------
  function resetPoll(st) {
    st.activeGroupIds = []; st.activeGroupMembers = [];
    st.pkStage = 'voting'; st.triggerNumber = null; st.settled = false; st.pkLocked = false;
    st.isDrawingScramble = false; st.currentPollFinished = false; st.currentPollNumber = 0;
    st.isReverseElimination = false; st.antiCheatVoucherHash = null;
  }

  // 轮次名称；need = 这一阶段要抽几位
  function nextRoundLabel(st, n, stage, need, roundNo) {
    const P = prizePlan(st);
    if (stage === true) stage = 'consolation';               // 旧调用
    if (stage === 'consolation') return `🎁 安慰奖遴选阶段 (${n}人，选${need == null ? P.consolation : need}名安慰奖)`;
    if (stage === 'finalist') return `🎖️ 入围奖遴选阶段 (${n}人，选${need == null ? P.finalist : need}名入围奖)`;
    if (stage === 'third') {
      const k = need == null ? P.third : need;
      return (k === 1 && n === 3) ? PODIUM_THIRD_LABEL : `🥉 季军遴选阶段 (${n}人，选${k}名季军)`;
    }
    if (stage === 'final') return (isClassicPodium(P) && n === 2) ? PODIUM_FINAL_LABEL : `👑 冠亚军决战 (${n}人，选${need == null ? P.champion : need}名冠军)`;
    return `第 ${roundNo || st.rounds.length + 1} 轮 (${n}人角逐)`;
  }

  // 用 list 建立下一轮；返回新轮次 index
  function pushNextRound(st, list, delayMs) {
    const n = list.length;
    const idx = st.rounds.length;
    const stage = freshStage(st, n, idx);
    const label = nextRoundLabel(st, n, stage);
    st.rounds.push({
      roundName: label, stageName: label,
      candidates: list.map((c, i) => ({ id: `R${idx + 1}_${i}`, name: c.name, orderNo: c.orderNo || '', pollLabel: c.pollLabel || '', status: 'pending' }))
    });
    resetPoll(st);
    st.passHistory = [];
    st.latestRoundEvent = { timestamp: Date.now(), roundIndex: idx, roundTitle: label, delay: delayMs || 0 };
    return idx;
  }

  // 本轮是否该结束并自动进入下一轮；进入了就返回新 index
  function maybeAutoAdvance(st, ri, delayMs) {
    if (!modeOn(st) || ri !== st.rounds.length - 1) return null;
    const r = st.rounds[ri];
    const stage = getRoundStage(st, ri);
    if (stage === 'final') return null;                       // 决赛由 applyFinal 处理
    if (TIERS.includes(stage)) {
      if (stageGot(st, ri) < stageNeed(st, ri)) return null;
      const rest = pendingOf(r);
      if (rest.length < 2) return null;
      rest.forEach(c => { c.status = 'pass'; });
      return pushNextRound(st, rest, delayMs);
    }
    if (pendingOf(r).length > 0) return null;
    const winners = passedOf(r);
    if (winners.length < 2) return null;
    const T = targetOf(st);
    if (T != null && winners.length < T) return null;     // 人数不够模式要求，不自动推进
    return pushNextRound(st, winners, delayMs);
  }

  // 冠亚军决战：命中者为冠军；冠军抽满后，其余全部为亚军
  function applyFinal(st, ri, winnerId, pollLabel) {
    const r = st.rounds[ri];
    const win = cands(r).find(c => String(c.id) === String(winnerId));
    if (!win) return null;
    const now = Date.now();
    const setRank = (c, k) => { c.status = 'pass'; c.passTimestamp = now; c.rankKey = RANK_KEY[k]; c.rankTitle = RANK_TITLE[k]; };
    setRank(win, 'champion'); win.manualPassed = true;
    if (pollLabel) win.pollLabel = pollLabel;
    const need = stageNeed(st, ri);
    let got = stageGot(st, ri);
    let rest = pendingOf(r);
    if (got < need && rest.length <= need - got) { rest.forEach(c => setRank(c, 'champion')); got = need; rest = []; }   // 剩下的刚好都是冠军
    if (got < need) {
      st.latestEvent = { type: 'finalCongrat', timestamp: now, winnerNamesKey: 'champion', winnerName: win.name };
      resetPoll(st);
      return { stage: 'final', name: win.name, partial: true };
    }
    rest.forEach(c => setRank(c, 'runnerUp'));
    const champs = cands(r).filter(c => c.rankKey === 'rankChampion').map(c => c.name);
    const rus = cands(r).filter(c => c.rankKey === 'rankRunnerUp').map(c => c.name);
    st.latestEvent = { type: 'finalCongrat', timestamp: now, winnerNamesKey: 'final', championName: champs.join(' / '), runnerUpName: rus.join(' / ') };
    resetPoll(st);
    return { stage: 'final', name: champs.join(' / '), runnerUp: rus.join(' / ') };
  }

  /**
   * 揭晓 / 手动判定的唯一入口
   *   groupIds：同组其他人（揭晓时 = 本组全部；手动点晋级时 = [winnerId]）
   * 返回 { stage, name, newRoundIndex? }
   */
  function applyWinner(st, ri, winnerId, pollLabel, groupIds, source) {
    const r = st.rounds[ri];
    if (!r) return null;
    const stage = getRoundStage(st, ri);

    // —— 先写开奖记录（结算后组员资料会被清空）——
    const winC = cands(r).find(c => String(c.id) === String(winnerId));
    if (!winC) return null;
    const isPoll = (groupIds || []).length > 1;
    const entry = {
      type: isPoll ? 'poll' : (String(pollLabel || '').startsWith('BYE') ? 'bye' : 'manual'),
      round: ri + 1, stage: STAGE_TEXT[stage],
      poll: isPoll ? (st.currentPollNumber || null) : null,
      trigger: isPoll ? (st.triggerNumber || null) : null,
      winner: personOf(winC), result: RESULT_TEXT[stage], by: source || 'admin'
    };
    if (isPoll) {
      entry.members = (st.activeGroupMembers || []).map(m => {
        const c = cands(r).find(x => String(x.id) === String(m.id)) || m;
        return { name: c.name || '', orderNo: c.orderNo || '', no: m.displayNumber == null ? null : m.displayNumber };
      });
    }
    if (stage === 'final' && stageGot(st, ri) + 1 >= stageNeed(st, ri)) {
      const ru = cands(r).filter(c => String(c.id) !== String(winnerId) && c.status === 'pending');
      if (ru.length === 1) entry.runnerUp = personOf(ru[0]);
      else if (ru.length > 1) entry.runnerUp = { name: ru.map(c => c.name).join(' / '), orderNo: ru.map(c => c.orderNo || '').join(' / ') };
    }
    logDraw(st, entry);
    if (!r.awardTier && modeOn(st)) {                         // 开始抽了：阶段固定下来
      if (stage !== 'normal') r.roundName = r.stageName = nextRoundLabel(st, cands(r).length, stage, stageNeed(st, ri), ri + 1);
      r.awardTier = stage;
    }
    if (stage === 'final') return applyFinal(st, ri, winnerId, pollLabel);

    const now = Date.now();
    const ids = (groupIds && groupIds.length ? groupIds : [winnerId]).map(String);
    const win = cands(r).find(c => String(c.id) === String(winnerId));
    if (!win) return null;
    if (!st.passHistory) st.passHistory = [];

    ids.forEach(id => {
      const c = cands(r).find(x => String(x.id) === id);
      if (!c) return;
      if (c === win) {
        c.status = 'pass'; c.pollLabel = pollLabel || c.pollLabel || ''; c.passTimestamp = now;
        if (TIERS.includes(stage)) { c.rankTitle = RANK_TITLE[stage]; c.rankKey = RANK_KEY[stage]; }
      } else if (TIERS.includes(stage)) {
        c.status = 'pending';                       // 没中的回到名单池
      } else {
        c.status = 'out'; c.eliminatedRoundIndex = ri;
      }
    });
    if (!st.passHistory.some(p => String(p.id) === String(win.id))) {
      st.passHistory.push({ id: win.id, name: win.name, orderNo: win.orderNo || '', pollLabel: win.pollLabel || '', roundIndex: ri, passTimestamp: now });
    }
    if (stage === 'third') st.latestEvent = { type: 'finalCongrat', timestamp: now, winnerNamesKey: 'third', winnerName: win.name };
    resetPoll(st);
    const newIdx = maybeAutoAdvance(st, ri, 5000);
    return { stage, name: win.name, newRoundIndex: newIdx };
  }

  // ---------- 并发安全 ----------
  // 每次写入整份数据都把版本号 +1；后台写入前比对版本号，避免用旧数据覆盖前台刚揭晓的结果
  function bumpRev(st) { st.rev = (st.rev || 0) + 1; return st; }
  // 识别"同一组 POLL"
  function pollSignature(st) {
    return `${st.currentPollNumber || 0}|${(st.activeGroupIds || []).map(String).join(',')}`;
  }
  const PRESENCE_PATH = 'draw_presence/publicAdminActive';
  // 前台控盘心跳：每 20 秒更新一次时间；超过 75 秒没更新（关掉、断网、睡眠）就当作已离开
  const PRESENCE_BEAT_MS = 20000, PRESENCE_TTL_MS = 75000;
  function presenceActive(val, serverNow) {
    if (val === true) return true;                                   // 旧版本写入的 true
    return !!(val && typeof val === 'object' && val.ts && serverNow - val.ts < PRESENCE_TTL_MS);
  }

  // ---------- 订单平台 ----------
  // 5 开头 → TikTok，2 开头 → Shopee
  function platformOf(orderNo) {
    const c = String(orderNo || '').trim().charAt(0);
    return c === '5' ? 'T' : c === '2' ? 'S' : '';
  }

  // 抽组后前台动画时长：洗牌转场 1.6 秒 + 倒计时 N 秒 + 名字滚动 3 秒 + 0.4 秒缓冲
  // 这段时间内不能设定票选号（观众还没看到这一组是谁）
  function animationLockMs(st) {
    const n = parseInt((st.modeConfig && st.modeConfig.drawCountdownSeconds) || 5, 10) || 5;
    return Math.round((1.6 + n + 3 + 0.4) * 1000);
  }
  function lockRemainingMs(st) {
    if (!st.groupGeneratedAt || !(st.activeGroupIds || []).length) return 0;
    return Math.max(0, st.groupGeneratedAt + animationLockMs(st) - Date.now());
  }

  // ---------- 揭晓（所有画面同步跑马灯）----------
  // 跑马灯节奏：22 步，由快到慢，最后一步停在命中者
  const MARQUEE_STEPS = 22;
  function marqueeDelays() {
    const out = [];
    for (let k = 0; k < MARQUEE_STEPS; k++) out.push(Math.round(90 + 430 * Math.pow(k / (MARQUEE_STEPS - 1), 2.2)));
    return out;
  }
  const MARQUEE_MS = marqueeDelays().reduce((a, b) => a + b, 0);   // 约 5 秒
  const REVEAL_SETTLE_MS = MARQUEE_MS + 2500;                       // 跑马灯结束后停留 2.5 秒再结算
  // n 张卡、命中者在第 w 张：返回每一步亮哪一张（最后一步 = w）
  function marqueeSequence(n, w) {
    const start = ((w - (MARQUEE_STEPS - 1)) % n + n) % n;
    return Array.from({ length: MARQUEE_STEPS }, (_, k) => (start + k) % n);
  }

  // 开始揭晓：随机分配号码，进入「揭晓中」。返回命中者 id（找不到返回 null）
  function beginReveal(st) {
    const members = st.activeGroupMembers || [];
    if (!members.length || !st.triggerNumber) return null;
    const nums = shuffle(Array.from({ length: members.length }, (_, i) => i + 1));
    st.activeGroupMembers = members.map((m, i) => ({ ...m, displayNumber: nums[i] }));
    const win = st.activeGroupMembers.find(m => m.displayNumber === st.triggerNumber);
    if (!win) return null;
    st.pkStage = 'revealing';
    st.settled = true; st.pkLocked = true; st.currentPollFinished = true; st.isDrawingScramble = false;
    st.revealAt = Date.now();
    return String(win.id);
  }
  // 揭晓结算（跑马灯播完后）
  function settleReveal(st, by) {
    if (st.pkStage !== 'revealing') return null;
    const m = (st.activeGroupMembers || []).find(x => x.displayNumber === st.triggerNumber);
    if (!m) return null;
    const ri = st.drawRoundIndex || 0;
    const pollLabel = `POLL #${st.currentPollNumber || 1} (#${st.triggerNumber})`;
    return applyWinner(st, ri, m.id, pollLabel, st.activeGroupIds || [], by);
  }

  // ---------- 进度提示（后台与前台共用）----------
  // audience: 'admin'（给控盘的人看）| 'public'（给观众看）
  function progressInfo(st, ri, audience) {
    const r = st.rounds && st.rounds[ri];
    if (!r || !cands(r).length || !modeOn(st)) return null;
    const pub = audience === 'public';
    const stage = getRoundStage(st, ri);
    const route = roadmap(st, ri).map(x => `${x.label} ${x.n}人`).join(' → ');
    const nextSize = plannedGroupSize(st, ri);
    const list = cands(r);
    if (isTournamentFinished(st)) {
      let champ = '';
      (st.rounds || []).forEach(x => cands(x).forEach(c => { if (c.rankKey === 'rankChampion') champ = c.name; }));
      return { kind: 'done', title: `🏁 比赛结束！👑 冠军：${champ}`, sub: pub ? '恭喜所有得奖买家，感谢大家参与！' : '如需更改，点【🔙 上一轮】撤销本轮判定。' };
    }
    const P = prizePlan(st);
    if (stage === 'consolation' || stage === 'finalist') {
      const need = stageNeed(st, ri), got = stageGot(st, ri);
      const title = stage === 'consolation'
        ? `🎁 安慰奖阶段：已抽出 ${got}/${need} 位（每组 ${nextSize || 4} 人，命中者得安慰奖，其余回名单池）`
        : `🎖️ 入围奖阶段：已抽出 ${got}/${need} 位（每组 ${nextSize || 4} 人，命中者得入围奖，其余回名单池）`;
      return { kind: stage, title, sub: `📍 ${route}` };
    }
    if (stage === 'third' && !(stageNeed(st, ri) === 1 && list.length === 3)) {
      const need = stageNeed(st, ri), got = stageGot(st, ri);
      return { kind: 'third', title: `🥉 季军阶段：已抽出 ${got}/${need} 位（每组 ${nextSize || 4} 人，命中者得季军，其余回名单池）`, sub: `📍 ${route}` };
    }
    if (stage === 'final' && !(isClassicPodium(P) && list.length === 2)) {
      const need = stageNeed(st, ri), got = stageGot(st, ri);
      return { kind: 'final', title: `👑 冠亚军决战：已抽出 ${got}/${need} 位冠军（每组 ${nextSize || 4} 人，命中者为冠军）`, sub: `冠军抽满后，其余 ${Math.max(0, pendingOf(r).length - (need - got))} 位为 🥈 亚军` };
    }
    if (stage === 'third') {
      const decided = list.find(c => c.rankKey === 'rankThird');
      if (decided) return { kind: 'third', title: `🥉 季军已锁定：${decided.name}`, sub: pub ? '余下 2 人进入冠亚军决战！' : '如需更改，点【🔙 上一轮】撤销本轮判定。' };
      return { kind: 'third', title: pub ? '🔥 冠亚季争夺战（3人）！全员上台盲抽，命中者为 🥉 季军' : '🔥 冠亚季争夺战（3人）！点【🥉 盲抽季军】全员上台，命中者为季军',
        sub: pub ? '选出季军后，余下 2 人进入 👑 冠亚军决战' : '也可直接点名单里的【🥉 季军】手动判定。选出季军后，余下 2 人自动进入【👑 冠亚军决战】' };
    }
    if (stage === 'final') {
      return { kind: 'final', title: pub ? '👑 冠亚军终极决战（2选1）！命中者为冠军' : '👑 冠亚军终极决战（2选1）！点【👑 盲抽冠军】，命中者为冠军',
        sub: pub ? '另一位为 🥈 亚军' : '也可直接点名单里的【👑 冠军】手动判定。另一位自动为【🥈 亚军】' };
    }
    const pend = list.filter(c => c.status === 'pending').length;
    const won = list.filter(c => c.status === 'pass').length;
    return { kind: 'normal',
      title: pend > 0 ? `🎲 名单池剩 ${pend} 人 · 已晋级 ${won} 人 · 下一组${pub ? '' : '建议'} ${nextSize} 人` : `✅ 本轮已抽完，共晋级 ${won} 人`,
      sub: `📍 路线：${route}` };
  }

  global.DrawLogic = {
    MARQUEE_STEPS, MARQUEE_MS, REVEAL_SETTLE_MS, marqueeDelays, marqueeSequence, beginReveal, settleReveal, progressInfo,
    bumpRev, pollSignature, PRESENCE_PATH, PRESENCE_BEAT_MS, presenceActive, platformOf, animationLockMs, lockRemainingMs,
    PODIUM_THIRD_LABEL, PODIUM_FINAL_LABEL, MAX_GROUP, randomInt, shuffle,
    modeOn, isMode2, consolationN, targetOf, countConsolation, consolationDone,
    TIERS, RANK_KEY, RANK_TITLE, prizePlan, isClassicPodium, planText, countRank, tierLeft, stageNeed, stageGot, nextRoundLabel,
    getRoundStage, isPodiumDecided, isTournamentFinished,
    plannedGroupSize, isGroupSizeFeasible, roadmap, minimumBuyers,
    resetPoll, pushNextRound, maybeAutoAdvance, applyWinner, logDraw, personOf, STAGE_TEXT,
    TYPE_TEXT, BY_TEXT, fmtTime, membersText, drawLogToCSV, parseCSVRows, parseBuyerCSV, maskOrder, revealLabel, toCsvUrl
  };
})(typeof window !== 'undefined' ? window : globalThis);
