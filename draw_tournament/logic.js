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
      candidates: list.map((c, i) => ({ id: `R${idx + 1}_${c.name}_${c.orderNo}_${i}`, name: c.name, orderNo: c.orderNo || '', pollLabel: c.pollLabel || '', status: 'pending' }))
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
  function applyWinner(st, ri, winnerId, pollLabel, groupIds) {
    const r = st.rounds[ri];
    if (!r) return null;
    const stage = getRoundStage(st, ri);
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

  global.DrawLogic = {
    PODIUM_THIRD_LABEL, PODIUM_FINAL_LABEL, MAX_GROUP,
    modeOn, isMode2, consolationN, targetOf, countConsolation, consolationDone,
    getRoundStage, isPodiumDecided, isTournamentFinished,
    plannedGroupSize, isGroupSizeFeasible, roadmap, minimumBuyers,
    resetPoll, pushNextRound, maybeAutoAdvance, applyWinner
  };
})(typeof window !== 'undefined' ? window : globalThis);
