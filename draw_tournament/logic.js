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
  const isMode2 = st => modeOn(st) && st.modeConfig.selectedMode === 'mode2';
  const consolationN = st => Math.max(1, parseInt((st.modeConfig && st.modeConfig.mode2ConsolationCount) || 10, 10));
  const cands = r => (r && r.candidates) || [];
  const pendingOf = r => cands(r).filter(c => c.status === 'pending');
  const passedOf = r => cands(r).filter(c => c.status === 'pass');

  function countConsolation(st) {
    let n = 0;
    (st.rounds || []).forEach(r => cands(r).forEach(c => { if (c.rankKey === 'rankConsolation') n++; }));
    return n;
  }
  function consolationDone(st) { return countConsolation(st) >= consolationN(st); }

  // 当前要达到的人数：模式2 先到 N+3（安慰奖阶段），之后是 3（冠亚季）
  function targetOf(st) {
    if (!modeOn(st)) return null;
    if (isMode2(st) && !consolationDone(st)) return consolationN(st) + 3;
    return 3;
  }

  // 模式2：名单池 N+3 ~ 2(N+3)-1 人时，已经没法用 2~4 人一组刚好减到 N+3，直接开始安慰奖阶段
  function shouldStartConsolation(st, n) {
    if (!isMode2(st) || consolationDone(st)) return false;
    const T = consolationN(st) + 3;
    return n >= T && n < 2 * T;
  }

  // 'normal' | 'consolation' | 'third' | 'final'
  function getRoundStage(st, ri) {
    const r = st.rounds && st.rounds[ri];
    if (!r || !modeOn(st)) return 'normal';
    if (r.isConsolationStage && isMode2(st)) return 'consolation';
    // 还没开始抽的轮次，按人数判断是否直接进入安慰奖阶段
    if (cands(r).every(c => c.status === 'pending') && shouldStartConsolation(st, cands(r).length)) return 'consolation';
    const n = cands(r).length;
    if (n === 3) return 'third';
    if (n === 2) return 'final';
    return 'normal';
  }
  function isPodiumDecided(st, ri) {
    const stage = getRoundStage(st, ri);
    const r = st.rounds[ri];
    if (stage === 'third') return cands(r).some(c => c.rankKey === 'rankThird');
    if (stage === 'final') return cands(r).some(c => c.rankKey === 'rankChampion');
    return false;
  }
  function isTournamentFinished(st) {
    return (st.rounds || []).some(r => cands(r).some(c => c.rankKey === 'rankChampion'));
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
    if (stage === 'third' || stage === 'final') return pending;     // 决赛全员上台
    if (stage === 'consolation') return Math.min(MAX_GROUP, pending);
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

  // 路线图，例如 [87, 22, 6, 3] + 说明
  function roadmap(st, ri) {
    const r = st.rounds[ri];
    const stage = getRoundStage(st, ri);
    const steps = [];
    if (!r) return steps;
    const total = cands(r).length;
    const N = consolationN(st);
    if (stage === 'final') return [{ n: 2, label: '👑 冠亚军' }];
    if (stage === 'third') return [{ n: 3, label: '🥉 季军' }, { n: 2, label: '👑 冠亚军' }];
    if (stage === 'consolation') {
      const left = pendingOf(r).length - (N - cands(r).filter(c => c.rankKey === 'rankConsolation').length);
      const out = [{ n: total, label: `🎁 安慰奖 ×${N}` }];
      if (left > 3) out.push({ n: left, label: '加赛' });
      return out.concat([{ n: 3, label: '🥉 季军' }, { n: 2, label: '👑 冠亚军' }]);
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
    if (isMode2(st) && !consolationDone(st)) steps.push({ n: T, label: `🎁 安慰奖 ×${N}` });
    steps.push({ n: 3, label: '🥉 季军' }, { n: 2, label: '👑 冠亚军' });
    return steps;
  }

  function minimumBuyers(st) {
    if (!modeOn(st)) return 2;
    return isMode2(st) ? consolationN(st) + 3 : 3;
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

  // ---------- 开奖记录 ----------
  // type: poll(盲抽揭晓) | manual(手动晋级/判定) | bye(轮空) | out(手动淘汰) | redraw(重抽) | cleared(清空组) | undo(撤回/撤销)
  function logDraw(st, entry) {
    if (!Array.isArray(st.drawLog)) st.drawLog = st.drawLog ? Object.values(st.drawLog) : [];
    const clean = {};
    Object.keys(entry).forEach(k => { if (entry[k] !== undefined) clean[k] = entry[k]; });
    clean.ts = Date.now();
    st.drawLog.push(clean);
  }
  const STAGE_TEXT = { normal: '普通轮', consolation: '安慰奖阶段', third: '冠亚季争夺战', final: '冠亚军决战' };
  const RESULT_TEXT = { normal: '晋级', consolation: '🎁 安慰奖', third: '🥉 季军', final: '👑 冠军' };
  function personOf(c) { return { name: c.name || '', orderNo: c.orderNo || '' }; }

  const TYPE_TEXT = { poll: '盲抽揭晓', manual: '手动判定', bye: '轮空晋级', out: '手动淘汰', redraw: '重抽', cleared: '清空组', undo: '撤销' };
  const BY_TEXT = { public: '前台主播', admin: '后台', manual: '后台手动' };
  function fmtTime(ts) {
    const d = new Date(ts || Date.now()), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function membersText(e) {
    return (e.members || []).map(m => `${m.no != null ? '#' + m.no + ' ' : ''}${m.name}(${m.orderNo || '-'})`).join(' / ');
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

  function nextRoundLabel(st, n, isCons) {
    if (isCons) return `🎁 安慰奖遴选阶段 (${n}人，选${consolationN(st)}名安慰奖)`;
    if (n === 3) return PODIUM_THIRD_LABEL;
    if (n === 2) return PODIUM_FINAL_LABEL;
    return `第 ${st.rounds.length + 1} 轮 (${n}人角逐)`;
  }

  // 用 list 建立下一轮；返回新轮次 index
  function pushNextRound(st, list, delayMs) {
    const n = list.length;
    const isCons = shouldStartConsolation(st, n);
    const label = nextRoundLabel(st, n, isCons);
    const idx = st.rounds.length;
    st.rounds.push({
      roundName: label, stageName: label, isConsolationStage: isCons,
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
    if (stage === 'third' || stage === 'final') return null; // 决赛由 applyPodium 处理
    if (stage === 'consolation') {
      const awarded = cands(r).filter(c => c.rankKey === 'rankConsolation').length;
      if (awarded < consolationN(st)) return null;
      const rest = pendingOf(r);
      rest.forEach(c => { c.status = 'pass'; });
      return rest.length >= 2 ? pushNextRound(st, rest, delayMs) : null;
    }
    if (pendingOf(r).length > 0) return null;
    const winners = passedOf(r);
    if (winners.length < 2) return null;
    return pushNextRound(st, winners, delayMs);
  }

  function applyPodium(st, ri, winnerId, pollLabel) {
    const r = st.rounds[ri];
    const list = cands(r);
    const win = list.find(c => String(c.id) === String(winnerId));
    if (!win) return null;
    const now = Date.now();
    const others = list.filter(c => c !== win);
    win.status = 'pass'; win.manualPassed = true; win.passTimestamp = now;
    if (pollLabel) win.pollLabel = pollLabel;
    if (list.length === 3) {
      win.rankTitle = "🥉 季军"; win.rankKey = "rankThird";
      others.forEach(c => { c.status = 'pass'; c.passTimestamp = now; });
      st.latestEvent = { type: 'finalCongrat', timestamp: now, winnerNamesKey: 'third', winnerName: win.name };
      const idx = pushNextRound(st, others, 5000); // 前台先播 5 秒季军祝贺
      return { stage: 'third', name: win.name, newRoundIndex: idx };
    }
    const ru = others[0];
    win.rankTitle = "👑 冠军"; win.rankKey = "rankChampion";
    if (ru) { ru.status = 'pass'; ru.rankTitle = "🥈 亚军"; ru.rankKey = "rankRunnerUp"; ru.passTimestamp = now; }
    st.latestEvent = { type: 'finalCongrat', timestamp: now, winnerNamesKey: 'final', championName: win.name, runnerUpName: ru ? ru.name : '' };
    resetPoll(st);
    return { stage: 'final', name: win.name, runnerUp: ru ? ru.name : '' };
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
    if (stage === 'final') {
      const ru = cands(r).find(c => String(c.id) !== String(winnerId));
      if (ru) entry.runnerUp = personOf(ru);
    }
    logDraw(st, entry);
    if (stage === 'third' || stage === 'final') return applyPodium(st, ri, winnerId, pollLabel);
    if (stage === 'consolation' && !r.isConsolationStage) {     // 固定下来
      r.isConsolationStage = true;
      r.roundName = r.stageName = nextRoundLabel(st, cands(r).length, true);
    }

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
        if (stage === 'consolation') { c.rankTitle = "🎁 安慰奖"; c.rankKey = "rankConsolation"; }
      } else if (stage === 'consolation') {
        c.status = 'pending';                       // 没中的回到名单池
      } else {
        c.status = 'out'; c.eliminatedRoundIndex = ri;
      }
    });
    if (!st.passHistory.some(p => String(p.id) === String(win.id))) {
      st.passHistory.push({ id: win.id, name: win.name, orderNo: win.orderNo || '', pollLabel: win.pollLabel || '', roundIndex: ri, passTimestamp: now });
    }
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

  global.DrawLogic = {
    bumpRev, pollSignature, PRESENCE_PATH, animationLockMs, lockRemainingMs,
    PODIUM_THIRD_LABEL, PODIUM_FINAL_LABEL, MAX_GROUP, randomInt, shuffle,
    modeOn, isMode2, consolationN, targetOf, countConsolation, consolationDone,
    getRoundStage, isPodiumDecided, isTournamentFinished,
    plannedGroupSize, isGroupSizeFeasible, roadmap, minimumBuyers,
    resetPoll, pushNextRound, maybeAutoAdvance, applyWinner, logDraw, personOf, STAGE_TEXT,
    TYPE_TEXT, BY_TEXT, fmtTime, membersText, drawLogToCSV, parseCSVRows, parseBuyerCSV
  };
})(typeof window !== 'undefined' ? window : globalThis);
