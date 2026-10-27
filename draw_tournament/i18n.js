/* =========================================================================
 * Mochiishop 抽奖系统 · 中 / 英 / 马来文 切换（admin.html 与 index.html 共用）
 *
 * 做法：画面上的文字（包括之后才出现的提示、弹窗、进度条）会自动翻译；切回中文时还原。
 *   ① 整句规则（含数字的动态句子）→ ② 数字 + 单位 → ③ 词组字典（长的先配）
 *   带 translate="no" 的元素（买家名字等）不会被翻译。
 * ========================================================================= */
(function (global) {
  'use strict';
  const LANGS = ['zh', 'en', 'ms'];

  // ---------- ① 整句规则（整段文字完全符合才使用，名字等变量原样保留）----------
  const SENTENCES = [
    [/^🎖️ 入围奖阶段：已抽出 (\d+)\/(\d+) 位（每组 (\d+) 人，命中者得入围奖，其余回名单池）$/, '🎖️ Finalist stage: $1/$2 drawn\n(groups of $3 — the hit wins a finalist prize, the rest return to the pool)', '🎖️ Peringkat finalis: $1/$2 dicabut\n(kumpulan $3 orang — yang terkena menang hadiah finalis, yang lain kembali ke senarai)'],
    [/^🥉 季军阶段：已抽出 (\d+)\/(\d+) 位（每组 (\d+) 人，命中者得季军，其余回名单池）$/, '🥉 3rd-place stage: $1/$2 drawn\n(groups of $3 — the hit wins 3rd place, the rest return to the pool)', '🥉 Peringkat ketiga: $1/$2 dicabut\n(kumpulan $3 orang — yang terkena dapat tempat ketiga, yang lain kembali ke senarai)'],
    [/^👑 冠亚军决战：已抽出 (\d+)\/(\d+) 位冠军（每组 (\d+) 人，命中者为冠军）$/, '👑 Final: $1/$2 champions drawn\n(groups of $3 — the hit is a champion)', '👑 Final: $1/$2 johan dicabut\n(kumpulan $3 orang — yang terkena ialah johan)'],
    [/^冠军抽满后，其余 (\d+) 位为 🥈 亚军$/, 'When all champions are drawn, the other $1 are 🥈 runners-up', 'Selepas semua johan dicabut, $1 lagi ialah 🥈 naib johan'],
    [/^🎖️ 入围奖遴选阶段\s*\n?\((\d+)人，选(\d+)名入围奖\)$/, '🎖️ Finalist stage\n($1 pax, pick $2 finalists)', '🎖️ Peringkat finalis\n($1 orang, pilih $2 finalis)'],
    [/^🥉 季军遴选阶段\s*\n?\((\d+)人，选(\d+)名季军\)$/, '🥉 3rd-place stage\n($1 pax, pick $2)', '🥉 Peringkat ketiga\n($1 orang, pilih $2)'],
    [/^👑 冠亚军决战\s*\n?\((\d+)人，选(\d+)名冠军\)$/, '👑 Final\n($1 pax · champions: $2)', '👑 Final\n($1 orang · johan: $2)'],
    [/^🎖️ 入围奖遴选阶段 \((\d+)人，选(\d+)名入围奖\)$/, '🎖️ Finalist stage ($1 pax, pick $2)', '🎖️ Peringkat finalis ($1 orang, pilih $2)'],
    [/^⚠️ 晋级人数不足，暂时不能推进。\n当前模式需要晋级区至少 (\d+) 位（(.*)），目前只有 (\d+) 位。\n\n请继续盲抽名单池里的买家。$/, '⚠️ Not enough advanced buyers to continue.\nThis mode needs at least $1 advanced ($2); only $3 so far.\n\nKeep drawing from the pool.', '⚠️ Pembeli mara belum cukup untuk diteruskan.\nMod ini perlu sekurang-kurangnya $1 orang mara ($2); baru $3 orang.\n\nTeruskan cabutan dari senarai.', true],
    [/^⚠️ 晋级人数不足，暂时不能推进。\n模式2 需要晋级区至少 (\d+) 位（安慰奖 (\d+) \+ 冠亚季 3），目前只有 (\d+) 位。\n\n请继续盲抽名单池里的买家。$/, '⚠️ Not enough advanced buyers to continue.\nMode 2 needs at least $1 advanced ($2 consolation + top 3); only $3 so far.\n\nKeep drawing from the pool.', '⚠️ Pembeli mara belum cukup untuk diteruskan.\nMod 2 perlu sekurang-kurangnya $1 orang mara ($2 saguhati + 3 teratas); baru $3 orang.\n\nTeruskan cabutan dari senarai.'],
    [/^⚠️ 晋级人数不足，暂时不能推进。\n需要晋级区至少 (\d+) 位（冠亚季 3），目前只有 (\d+) 位。\n\n请继续盲抽名单池里的买家。$/, '⚠️ Not enough advanced buyers to continue.\nNeeds at least $1 advanced (top 3); only $2 so far.\n\nKeep drawing from the pool.', '⚠️ Pembeli mara belum cukup untuk diteruskan.\nPerlu sekurang-kurangnya $1 orang mara (3 teratas); baru $2 orang.\n\nTeruskan cabutan dari senarai.'],
    [/^🎲 名单池剩 (\d+) 人 · 已晋级 (\d+) 人 · 下一组(?:建议)? (\d+) 人$/, '🎲 Pool: $1 left · Advanced: $2 · Next group: $3', '🎲 Baki: $1 orang · Mara: $2 · Kumpulan seterusnya: $3 orang'],
    [/^✅ 本轮已抽完，共晋级 (\d+) 人$/, '✅ Round complete — $1 advanced', '✅ Pusingan selesai — $1 orang mara'],
    [/^🎁 安慰奖阶段：已抽出 (\d+)\/(\d+) 位（每组 (\d+) 人，命中者得安慰奖，其余回名单池）$/, '🎁 Consolation stage: $1/$2 drawn\n(groups of $3 — the hit wins a consolation prize, the rest return to the pool)', '🎁 Peringkat saguhati: $1/$2 dicabut\n(kumpulan $3 orang — yang terkena menang hadiah saguhati, yang lain kembali ke senarai)'],
    [/^🏁 比赛结束！👑 冠军：(.*)$/, '🏁 Event over! 👑 Champion: $1', '🏁 Pertandingan tamat! 👑 Johan: $1'],
    [/^🥉 季军已锁定：(.*)$/, '🥉 3rd place confirmed: $1', '🥉 Tempat ketiga disahkan: $1'],
    [/^模式1: 冠亚季 · (.*)$/, 'Mode 1: Top 3 · $1', 'Mod 1: 3 Teratas · $1', true],
    [/^模式2: 冠亚季\+安慰奖 · (.*)$/, 'Mode 2: Top 3 + Consolation · $1', 'Mod 2: 3 Teratas + Saguhati · $1', true],
    [/^❌ 第 (\d+) 轮淘汰$/, '❌ Round $1 eliminated', '❌ Tersingkir pusingan $1'],
    [/^POLL #(\d+) 已揭晓命中！$/, 'POLL #$1 revealed!', 'POLL #$1 telah didedahkan!'],
  ];

  // ---------- ② 数字 + 单位 ----------
  // 「十月」→ October / Oktober（自定义标题常用）
  const MONTH_NAMES = [null, ['January','Januari'],['February','Februari'],['March','Mac'],['April','April'],['May','Mei'],['June','Jun'],['July','Julai'],['August','Ogos'],['September','September'],['October','Oktober'],['November','November'],['December','Disember']];
  function MONTHS(x, col) {
    const zh = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    const n = /^\d+$/.test(x) ? parseInt(x, 10) : zh[x];
    const m = MONTH_NAMES[n];
    return m ? m[col - 1] + ' ' : x + '月';
  }
  const UNITS = [
    [/第\s*(\d+)\s*轮/g, 'Round $1', 'Pusingan $1'],
    [/共\s*(\d+)\s*人/g, '$1 in total', '$1 orang kesemuanya'],
    [/[（(]\s*剩\s*(\d+)\s*人\s*[)）]/g, '($1 left)', '(tinggal $1)'],
    [/[（(]\s*(\d+)\s*选\s*1\s*[)）]/g, '(1 of $1)', '(1 daripada $1)'],
    [/([一二三四五六七八九十]{1,3}|\d{1,2})\s*月(?=\s*(?:抽奖|份|晋级|决赛|直播))/g, (m, x) => MONTHS(x, 1), (m, x) => MONTHS(x, 2)],
    [/(\d+)\s*张订单/g, '$1 orders', '$1 pesanan'],
    [/(\d+)\s*条记录/g, '$1 records', '$1 rekod'],
    [/(\d+)\s*位买家/g, '$1 buyers', '$1 pembeli'],
    [/(\d+)\s*人/g, '$1 pax', '$1 orang'],
    [/(\d+)\s*位/g, '$1', '$1'],
    [/(\d+)\s*秒/g, '$1s', '$1 saat'],
    [/(\d+)\s*名/g, '$1', '$1'],
    [/×\s*(\d+)/g, '×$1', '×$1'],
  ];

  // ---------- ③ 词组字典 [中文, English, Bahasa Melayu] ----------
  const DICT = [
    ['🎖️ 入围奖遴选阶段', '🎖️ Finalist stage', '🎖️ Peringkat finalis'],
    ['🎖️ 入围奖阶段', '🎖️ Finalist stage', '🎖️ Peringkat finalis'],
    ['入围奖阶段', 'Finalist stage', 'Peringkat finalis'],
    ['🥉 季军遴选阶段', '🥉 3rd-place stage', '🥉 Peringkat ketiga'],
    ['🥉 季军阶段', '🥉 3rd-place stage', '🥉 Peringkat ketiga'],
    ['👑 冠亚军决战', '👑 Final', '👑 Final'],
    ['🎖️ 入围奖', '🎖️ Finalist', '🎖️ Finalis'],
    ['入围奖', 'finalist prize', 'hadiah finalis'],
    ['揭晓入围奖', 'Reveal Finalist', 'Dedahkan Finalis'],
    ['盲抽入围奖', 'Draw Finalist', 'Cabut Finalis'],
    ['已胜出入围奖名单', 'Finalist winners', 'Pemenang finalis'],
    ['入围奖得主全名单', 'All finalist winners', 'Semua pemenang finalis'],
    ['恭喜！获得入围奖', 'Congrats! Finalist prize', 'Tahniah! Hadiah finalis'],
    ['【入围奖遴选阶段】已选出', '[Finalist stage] Drawn', '[Peringkat finalis] Dicabut'],
    ['位入围奖得主 🎖️', 'finalist winners 🎖️', 'pemenang finalis 🎖️'],
    ['【季军遴选阶段】已选出', '[3rd-place stage] Drawn', '[Peringkat ketiga] Dicabut'],
    ['位季军 🥉', '3rd places 🥉', 'tempat ketiga 🥉'],
    ['🔥 👑 冠亚军决战开启！已选出', '🔥 👑 Final is live! Champions drawn:', '🔥 👑 Final bermula! Johan dicabut:'],
    ['位冠军', '', ''],
    ['🥈 冠军抽满后其余为亚军', '🥈 Once all champions are drawn, the rest are runners-up', '🥈 Selepas semua johan dicabut, selebihnya naib johan'],
    ['命中者得 🎖️ 入围奖，其余回名单池', 'the hit wins a 🎖️ finalist prize, the rest return to the pool', 'yang terkena menang 🎖️ finalis, yang lain kembali ke senarai'],
    ['命中者得 🥉 季军，其余回名单池', 'the hit wins 🥉 3rd place, the rest return to the pool', 'yang terkena dapat 🥉 tempat ketiga, yang lain kembali ke senarai'],
    ['命中者为 👑 冠军，其余回名单池', 'the hit is 👑 Champion, the rest return to the pool', 'yang terkena ialah 👑 Johan, yang lain kembali ke senarai'],
    ['🎖️ 入围', '🎖️ Finalist', '🎖️ Finalis'],
    ['🎁 安慰', '🎁 Consolation', '🎁 Saguhati'],
    ['↩️ 撤回入围奖', '↩️ Finalist undone', '↩️ Finalis dibatalkan'],
    ['↩️ 撤回季军', '↩️ 3rd place undone', '↩️ Tempat ketiga dibatalkan'],
    ['模式 3：冠亚季 + 入围奖 + 安慰奖模式', 'Mode 3: Top 3 + Finalists + Consolation', 'Mod 3: 3 Teratas + Finalis + Saguhati'],
    ['先抽安慰奖，再抽入围奖（命中者得奖，其余回池），最后冠亚季。晋级区需至少', 'Consolation first, then finalists (the hit wins, the rest return), then the top 3. Advanced list needs at least', 'Saguhati dahulu, kemudian finalis (yang terkena menang, yang lain kembali), akhir sekali 3 teratas. Senarai mara perlu sekurang-kurangnya'],
    ['位（安慰奖 + 入围奖 + 冠亚季 3）。', '(consolation + finalists + top 3).', 'orang (saguhati + finalis + 3 teratas).'],
    ['入围奖名额:', 'Finalist prizes:', 'Hadiah finalis:'],
    ['模式 4：自定义名额模式', 'Mode 4: Custom prizes', 'Mod 4: Hadiah suai'],
    ['所有名额自己设定（冠军、亚军至少 1 位，其余可填 0 = 不设）。顺序：安慰奖 → 入围奖 → 季军 → 冠亚军。晋级区需至少', 'Set every prize yourself (champion and runner-up at least 1, others can be 0 = none). Order: consolation → finalists → 3rd → final. Advanced list needs at least', 'Tetapkan semua hadiah sendiri (johan dan naib johan sekurang-kurangnya 1, lain boleh 0 = tiada). Susunan: saguhati → finalis → ketiga → final. Senarai mara perlu sekurang-kurangnya'],
    ['⚠️ 季军阶段无需推进。\n季军抽满后会自动进入冠亚军决战。', '⚠️ No need to advance in the 3rd-place stage.\nThe final starts automatically once 3rd place is drawn.', '⚠️ Tidak perlu mara dalam peringkat ketiga.\nFinal bermula automatik selepas tempat ketiga dicabut.'],
    ['还差', 'still needed:', 'masih diperlukan:'],
    ['，抽满后会自动进入下一阶段。', '— the next stage starts automatically once complete.', '— peringkat seterusnya bermula automatik selepas lengkap.'],
    ['继续盲抽下一位冠军。', 'Draw the next champion.', 'Cabut johan seterusnya.'],
    ['获得冠军！', 'is a Champion!', 'ialah Johan!'],
    ['安慰奖 ', 'Consolation ', 'Saguhati '],
    ['冠亚季 3', 'Top 3', '3 Teratas'],
    ['季军 ', '3rd ', 'Ketiga '],
    ['亚军 ', 'Runner-up ', 'Naib johan '],
    ['冠军 ', 'Champion ', 'Johan '],
    ['入围奖 ', 'Finalist ', 'Finalis '],
    // —— 页头 / 通用 ——
    ['Mochiishop 每月抽奖晋级榜', 'Mochiishop Monthly Draw Leaderboard', 'Papan Pendahulu Cabutan Bulanan Mochiishop'],
    ['Mochiishop 抽奖实时晋级大屏', 'Mochiishop Live Draw Board', 'Papan Cabutan Langsung Mochiishop'],
    ['Mochiishop 每月抽奖 - 直播控制台', 'Mochiishop Monthly Draw - Live Console', 'Konsol Cabutan Mochiishop'],
    ['Mochiishop 每月抽奖', 'Mochiishop Monthly Draw', 'Cabutan Bulanan Mochiishop'],
    ['直播实时同步 · 买家公开公示大屏', 'Live sync · Public results board', 'Segerak langsung · Papan keputusan awam'],
    ['香水盲抽 · Shopee直播分组PK控盘系统', 'Perfume blind draw · Shopee Live group PK console', 'Cabutan rawak minyak wangi · Konsol PK kumpulan Shopee Live'],
    ['云端毫秒级同步中...', 'Live cloud sync…', 'Segerak awan langsung…'],
    ['模式: 加载中', 'Mode: loading', 'Mod: memuatkan'],
    ['模式: 未启用规则', 'Mode: rules off', 'Mod: peraturan dimatikan'],
    ['模式: 冠亚季模式', 'Mode: Top 3', 'Mod: Top 3'],
    ['模式: 3+安慰奖模式(', 'Mode: Top 3 + Cons. (', 'Mod: Top 3 + Saguhati ('],
    ['🔑 管理员', '🔑 Admin', '🔑 Pentadbir'],
    ['🔓 管理员 (已解锁)', '🔓 Admin (unlocked)', '🔓 Pentadbir (dibuka)'],
    ['点击关闭', 'Tap to close', 'Ketik untuk tutup'],

    // —— PK 组 ——
    ['Shopee 直播间盲抽 PK 组', 'Shopee Live Blind Draw PK Group', 'Kumpulan PK Cabutan Rawak Shopee Live'],
    ['🔥 盲抽 PK 组', '🔥 PK Group', '🔥 Kumpulan PK'],
    ['当前直播盲抽 PK 组', 'Current live PK group', 'Kumpulan PK semasa'],
    ['🎯 本轮票选号', '🎯 Winning vote no.', '🎯 Nombor undian'],
    ['⏳ 正在等待票选号…', '⏳ Waiting for the vote number…', '⏳ Menunggu nombor undian…'],
    ['正在等待票选号…', 'Waiting for the\nvote number…', 'Menunggu\nnombor undian…'],
    ['请在直播间投票，选出你支持的号码', 'Vote in the live room for the number you support', 'Undi di siaran langsung untuk nombor pilihan anda'],
    ['盲抽即将在', 'Draw starts in', 'Cabutan bermula dalam'],
    ['秒后开始', '', ''],
    ['🔍 盲抽中…', '🔍 Drawing…', '🔍 Sedang mencabut…'],
    ['🎉 恭喜', '🎉 Congrats', '🎉 Tahniah'],
    ['✨ 新一轮盲抽即将开始 ✨', '✨ Next draw starting soon ✨', '✨ Cabutan seterusnya akan bermula ✨'],
    ['正在刷新名单…', 'Refreshing list…', 'Menyegarkan senarai…'],
    ['🎯 点击揭晓', '🎯 Reveal', '🎯 Dedahkan'],
    ['点击揭晓', 'Reveal', 'Dedahkan'],
    ['揭晓季军', 'Reveal 3rd Place', 'Dedahkan Tempat Ketiga'],
    ['揭晓冠军', 'Reveal Champion', 'Dedahkan Johan'],
    ['揭晓安慰奖', 'Reveal Consolation', 'Dedahkan Saguhati'],
    ['◀ 折叠', '◀ Collapse', '◀ Lipat'],
    ['▶ 展开', '▶ Expand', '▶ Kembang'],
    ['🔥 PK中', '🔥 In PK', '🔥 Dalam PK'],
    ['无订单号', 'No order no.', 'Tiada no. pesanan'],
    ['幸运买家', 'Lucky buyer', 'Pembeli bertuah'],

    // —— 统计 / 名单 ——
    ['本轮参选', 'This round', 'Pusingan ini'],
    ['本轮胜出/已晋级名单', 'Winners / Advanced this round', 'Pemenang / Mara pusingan ini'],
    ['已胜出安慰奖名单', 'Consolation winners', 'Pemenang saguhati'],
    ['本轮待定买家池', 'Buyers waiting this round', 'Pembeli menunggu pusingan ini'],
    ['本轮暂无晋级买家，直播抽出中...', 'No winners yet this round — drawing live…', 'Belum ada pemenang — cabutan sedang berlangsung…'],
    ['本轮全员判定完毕', 'Everyone in this round has been decided', 'Semua dalam pusingan ini telah ditentukan'],
    ['本轮抽奖名单同步中，请关注直播间...', 'Syncing this round\'s list — watch the live stream…', 'Menyegerak senarai pusingan ini — ikuti siaran langsung…'],
    ['暂无淘汰人员', 'No one eliminated yet', 'Belum ada yang tersingkir'],
    ['淘汰区', 'Eliminated', 'Tersingkir'],
    ['放大查看全部待定买家', 'Expand all waiting buyers', 'Besarkan semua pembeli menunggu'],
    ['没有符合的买家', 'No matching buyers', 'Tiada pembeli sepadan'],
    ['放大查看淘汰名单', 'Expand the eliminated list', 'Besarkan senarai tersingkir'],
    ['已淘汰', 'Eliminated', 'Tersingkir'],
    ['已晋级', 'Advanced', 'Mara'],
    ['待PK', 'Waiting', 'Menunggu'],
    ['安全过关', 'Safe', 'Selamat'],
    ['展开选拔过程 ▼', 'Show draw process ▼', 'Tunjuk proses cabutan ▼'],
    ['折叠选拔过程 ▲', 'Hide draw process ▲', 'Sembunyi proses cabutan ▲'],
    ['📋 抽奖比赛全程选拔细节记录', '📋 Full draw process record', '📋 Rekod penuh proses cabutan'],
    ['系统正在实时同步与整理买家数据，请留意直播间提示', 'Syncing buyer data — please follow the live stream', 'Menyegerak data pembeli — sila ikuti siaran langsung'],
    ['网页正在计算与更新中，敬请期待...', 'Updating… please stand by', 'Sedang dikemas kini… sila tunggu'],
    ['🔥 请各位买家/观众做好准备，激烈的角逐即将开始！', '🔥 Get ready, everyone — the draw is about to begin!', '🔥 Bersedia semua — cabutan akan bermula!'],

    // —— 汇总 / 名次 ——
    ['全场抽奖比赛 - 终极荣誉汇总榜', 'Final Results — Hall of Fame', 'Keputusan Akhir — Dewan Kemasyhuran'],
    ['全场抽奖比赛荣誉汇总', 'Final results', 'Keputusan akhir'],
    ['祝贺所有获奖买家！感谢大家的参与与支持！', 'Congratulations to all winners! Thank you for joining and supporting us!', 'Tahniah kepada semua pemenang! Terima kasih atas sokongan anda!'],
    ['祝贺所有获奖买家！', 'Congratulations to all winners!', 'Tahniah kepada semua pemenang!'],
    ['恭喜所有得奖买家，感谢大家参与！', 'Congratulations to all winners — thanks for joining!', 'Tahniah kepada semua pemenang — terima kasih kerana menyertai!'],
    ['🏁 比赛已结束，恭喜所有得奖买家！', '🏁 The event is over — congratulations to all winners!', '🏁 Pertandingan tamat — tahniah kepada semua pemenang!'],
    ['安慰奖得主全名单', 'All consolation winners', 'Semua pemenang saguhati'],
    ['保存为图片', 'Save as image', 'Simpan sebagai imej'],
    ['分享结果', 'Share results', 'Kongsi keputusan'],
    ['❌ 分享失败，请重试！', '❌ Share failed, please try again!', '❌ Gagal berkongsi, cuba lagi!'],
    ['❌ 生成图片失败，请重试！', '❌ Failed to create image, please try again!', '❌ Gagal mencipta imej, cuba lagi!'],
    ['⚠️ 您的浏览器不支持一键分享，请使用【保存为图片】', '⚠️ Your browser can\'t share directly — please use [Save as image]', '⚠️ Pelayar anda tidak boleh berkongsi terus — sila guna [Simpan sebagai imej]'],
    ['秒后自动切回大屏榜单...', 's — returning to the board…', ' saat — kembali ke papan…'],
    ['CHAMPION / 冠军', 'CHAMPION', 'JOHAN'],
    ['RUNNER-UP / 亚军', 'RUNNER-UP', 'NAIB JOHAN'],
    ['3RD PLACE / 季军', '3RD PLACE', 'TEMPAT KETIGA'],
    ['👑 冠军得主 / CHAMPION', '👑 CHAMPION', '👑 JOHAN'],
    ['🥈 亚军得主 / RUNNER-UP', '🥈 RUNNER-UP', '🥈 NAIB JOHAN'],
    ['🥉 季军得主 / 3RD PLACE', '🥉 3RD PLACE', '🥉 TEMPAT KETIGA'],
    ['🎯 成功晋级 / ADVANCED', '🎯 ADVANCED', '🎯 MARA'],
    ['🎁 安慰奖 / CONSOLATION', '🎁 CONSOLATION', '🎁 SAGUHATI'],
    ['💥 淘汰出局 / ELIMINATED', '💥 ELIMINATED', '💥 TERSINGKIR'],
    ['热烈祝贺！成功获得荣誉！', 'Congratulations on your prize!', 'Tahniah atas hadiah anda!'],
    ['恭喜！成功晋级', 'Congrats! Advanced', 'Tahniah! Mara'],
    ['恭喜！获得安慰奖', 'Congrats! Consolation prize', 'Tahniah! Hadiah saguhati'],
    ['很遗憾！抱憾离场', 'So sorry — eliminated', 'Maaf — tersingkir'],
    ['命中！', 'hit!', 'terkena!'],
    ['票选号 #', 'Vote no. #', 'Nombor undian #'],
    ['🥉 季军得主是：', '🥉 3rd place goes to:', '🥉 Tempat ketiga:'],
    ['(🔥 👑 冠亚军决战 2 选 1 开启中！)', '(🔥 👑 Final: 1 of 2 — now live!)', '(🔥 👑 Final: 1 daripada 2 — sedang berlangsung!)'],
    ['🔥 冠亚季军争夺战开启！当前仅剩 3 人角逐', '🔥 Top-3 showdown! 3 left —', '🔥 Pertarungan 3 teratas! Tinggal 3 orang —'],
    ['🥉 即将在直播间选出季军得主！', '🥉 3rd place will be drawn live!', '🥉 Tempat ketiga akan dicabut secara langsung!'],
    ['🔥 👑 冠亚军终极决战 2 选 1 开启中！', '🔥 👑 Grand final — 1 of 2!', '🔥 👑 Final besar — 1 daripada 2!'],
    ['🥈 即将选出冠军与亚军！', '🥈 Champion and runner-up coming up!', '🥈 Johan dan naib johan akan dipilih!'],
    ['抽奖晋级榜', 'Draw Leaderboard', 'Papan Pendahulu Cabutan'],
    ['🔥 冠亚季军争夺战开启！当前仅剩 3 人角逐，即将在直播间选出 🥉 季军得主！', '🔥 Top-3 showdown! 3 left — 🥉 3rd place will be drawn live!', '🔥 Pertarungan 3 teratas! Tinggal 3 orang — 🥉 tempat ketiga akan dicabut secara langsung!'],
    ['🔥 👑 冠亚军终极决战 2 选 1 开启中！即将选出冠军与亚军！', '🔥 👑 Grand final — 1 of 2! Champion and runner-up coming up!', '🔥 👑 Final besar — 1 daripada 2! Johan dan naib johan akan dipilih!'],
    ['【安慰奖遴选阶段】已选出', '[Consolation stage] Drawn', '[Peringkat saguhati] Dicabut'],
    ['位安慰奖得主 🎁', 'consolation winners 🎁', 'pemenang saguhati 🎁'],
    ['💥 绝地大逃杀（反向淘汰）开启！抽中票选号的人将被直接淘汰！', '💥 Reverse elimination! The hit number is eliminated!', '💥 Penyingkiran terbalik! Nombor terkena akan tersingkir!'],
    ['✅ 本轮淘汰已完成，其余成员安全过关！', '✅ Elimination done — everyone else is safe!', '✅ Penyingkiran selesai — yang lain selamat!'],
    ['新一轮对决开启', 'Next round begins', 'Pusingan baharu bermula'],
    ['将在', 'in', 'dalam'],

    // —— 阶段 / 名次（长的先写）——
    ['👑 冠亚军终极决战（2选1）！命中者为冠军', '👑 Grand final (1 of 2)! The hit is the Champion', '👑 Final besar (1 daripada 2)! Yang terkena ialah Johan'],
    ['👑 冠亚军终极决战（2选1）！点【👑 盲抽冠军】，命中者为冠军', '👑 Grand final (1 of 2)! Press [👑 Draw Champion] — the hit is the Champion', '👑 Final besar (1 daripada 2)! Tekan [👑 Cabut Johan] — yang terkena ialah Johan'],
    ['🔥 冠亚季争夺战（3人）！全员上台盲抽，命中者为 🥉 季军', '🔥 Top-3 showdown (3 left)! All 3 drawn — the hit takes 🥉 3rd place', '🔥 Pertarungan 3 teratas! Ketiga-tiga dicabut — yang terkena dapat 🥉 tempat ketiga'],
    ['🔥 冠亚季争夺战（3人）！点【🥉 盲抽季军】全员上台，命中者为季军', '🔥 Top-3 showdown (3 left)! Press [🥉 Draw 3rd Place] — the hit takes 3rd place', '🔥 Pertarungan 3 teratas! Tekan [🥉 Cabut Tempat Ketiga] — yang terkena dapat tempat ketiga'],
    ['选出季军后，余下 2 人进入 👑 冠亚军决战', 'After 3rd place, the other 2 go to the 👑 final', 'Selepas tempat ketiga, 2 lagi ke 👑 final'],
    ['也可直接点名单里的【🥉 季军】手动判定。选出季军后，余下 2 人自动进入【👑 冠亚军决战】', 'Or press [🥉 3rd] in the list to decide manually. The other 2 then go to the [👑 final] automatically', 'Atau tekan [🥉 Ketiga] dalam senarai. 2 lagi akan ke [👑 final] secara automatik'],
    ['也可直接点名单里的【👑 冠军】手动判定。另一位自动为【🥈 亚军】', 'Or press [👑 Champion] in the list to decide manually. The other becomes [🥈 runner-up]', 'Atau tekan [👑 Johan] dalam senarai. Seorang lagi menjadi [🥈 naib johan]'],
    ['余下 2 人进入冠亚军决战！', 'The other 2 go to the final!', '2 lagi ke final!'],
    ['如需更改，点【🔙 上一轮】撤销本轮判定。', 'To change, press [🔙 Back] to undo this decision.', 'Untuk menukar, tekan [🔙 Kembali] untuk batal keputusan ini.'],
    ['另一位为 🥈 亚军', 'the other is 🥈 runner-up', 'seorang lagi 🥈 naib johan'],
    ['，另一位为 🥈 亚军', ', the other is 🥈 runner-up', ', seorang lagi 🥈 naib johan'],
    ['，另一位为', ', the other is', ', seorang lagi'],
    ['🏆 冠亚季争夺战 (剩3人)', '🏆 Top-3 showdown (3 left)', '🏆 Pertarungan 3 teratas (tinggal 3)'],
    ['👑 冠亚军终极决战 (2选1)', '👑 Grand final (1 of 2)', '👑 Final besar (1 daripada 2)'],
    ['🏆 冠亚季争夺战', '🏆 Top-3 showdown', '🏆 Pertarungan 3 teratas'],
    ['👑 冠亚军终极决战', '👑 Grand final', '👑 Final besar'],
    ['👑 冠亚军决战', '👑 Final', '👑 Final'],
    ['冠亚季争夺战', 'Top-3 showdown', 'Pertarungan 3 teratas'],
    ['冠亚军决战', 'Final', 'Final'],
    ['👑 冠亚军', '👑 Final', '👑 Final'],
    ['🎁 安慰奖遴选阶段 (', '🎁 Consolation stage (', '🎁 Peringkat saguhati ('],
    ['🎁 安慰奖遴选阶段', '🎁 Consolation stage', '🎁 Peringkat saguhati'],
    ['🎁 安慰奖阶段', '🎁 Consolation stage', '🎁 Peringkat saguhati'],
    ['安慰奖阶段', 'Consolation stage', 'Peringkat saguhati'],
    ['名安慰奖)', 'consolation prizes)', 'hadiah saguhati)'],
    ['名安慰奖', 'consolation prizes', 'hadiah saguhati'],
    ['🎁 安慰奖', '🎁 Consolation', '🎁 Saguhati'],
    ['安慰奖', 'Consolation', 'Saguhati'],
    ['🥉 季军', '🥉 3rd Place', '🥉 Tempat Ketiga'],
    ['👑 冠军', '👑 Champion', '👑 Johan'],
    ['🥈 亚军', '🥈 Runner-up', '🥈 Naib Johan'],
    ['季军', '3rd Place', 'Tempat Ketiga'],
    ['冠军', 'Champion', 'Johan'],
    ['亚军', 'Runner-up', 'Naib Johan'],
    ['加赛', 'Playoff', 'Perlawanan tambahan'],
    ['人角逐)', 'competing)', 'bertanding)'],
    ['轮 (', ' (', ' ('],
    ['人，选', 'pax, pick', 'orang, pilih'],

    // —— 模式说明 / 进度 ——
    ['📋 当前模式规则与晋级流程', '📋 Rules & progress', '📋 Peraturan & kemajuan'],
    ['模式规则加载中...', 'Loading rules…', 'Memuatkan peraturan…'],
    ['💡 电脑：鼠标悬停查看 · 手机：点标签打开 / 关闭', '💡 Desktop: hover · Phone: tap the label to open / close', '💡 Komputer: hover · Telefon: ketik label untuk buka / tutup'],
    ['当前未启用模式规则，由后台手动控盘。', 'No mode rules — controlled manually by the host.', 'Tiada peraturan mod — dikawal secara manual.'],
    ['🥇 模式1：冠亚季排位', '🥇 Mode 1: Top 3', '🥇 Mod 1: 3 Teratas'],
    ['📍 当前进度 ·', '📍 Progress ·', '📍 Kemajuan ·'],
    ['🏁 已结束', '🏁 Finished', '🏁 Tamat'],
    ['已结束', 'Finished', 'Tamat'],
    ['名单池剩', 'Pool:', 'Baki:'],
    ['人 · 已晋级', 'pax · Advanced', 'orang · Mara'],
    ['· 已晋级', '· Advanced', '· Mara'],
    ['人 · 下一组', 'pax · Next group', 'orang · Kumpulan seterusnya'],
    ['· 下一组', '· Next group', '· Kumpulan seterusnya'],
    ['· 本轮已抽完', '· Round complete', '· Pusingan selesai'],
    ['3 人全员上台盲抽，命中者获得', 'All 3 are drawn — the hit wins', 'Ketiga-tiga dicabut — yang terkena menang'],
    ['，其余 2 人进入冠亚军决战', ', the other 2 go to the final', ', 2 lagi ke final'],
    ['2 人全员上台盲抽，命中者获得', 'Both are drawn — the hit wins', 'Kedua-duanya dicabut — yang terkena menang'],
    ['已抽出', 'Drawn', 'Dicabut'],
    ['位安慰奖 · 每组', 'consolation · groups of', 'saguhati · kumpulan'],
    ['人，命中者得安慰奖，其余回名单池）', '— the hit wins a consolation prize, the rest return to the pool)', '— yang terkena menang saguhati, yang lain kembali ke senarai)'],
    ['人，命中者得安慰奖，其余回名单池', '— the hit wins a consolation prize, the rest return to the pool', '— yang terkena menang saguhati, yang lain kembali ke senarai'],
    ['📍 路线：', '📍 Route: ', '📍 Laluan: '],
    ['📖 抽奖流程', '📖 How it works', '📖 Cara cabutan'],
    ['全部订单进入名单池（一张订单 = 一次机会）', 'All orders enter the pool (1 order = 1 chance)', 'Semua pesanan masuk senarai (1 pesanan = 1 peluang)'],
    ['每个 POLL 盲抽', 'Each POLL draws', 'Setiap POLL mencabut'],
    ['3~4 人', '3–4 people', '3–4 orang'],
    ['一组（Shopee 投票最多 4 个选项）', 'per group (Shopee polls allow up to 4 options)', 'sekumpulan (undian Shopee maksimum 4 pilihan)'],
    ['直播间投票选号码 → 后台设定票选号 → 主播点【揭晓】', 'Viewers vote for a number → host sets the vote no. → host presses [Reveal]', 'Penonton undi nombor → hos tetapkan nombor → hos tekan [Dedahkan]'],
    ['命中者', 'The hit', 'Yang terkena'],
    ['，同组其他人淘汰', ' advances; the rest of the group is eliminated', ' mara; yang lain dalam kumpulan tersingkir'],
    ['名单池抽完 →', 'Pool finished →', 'Senarai habis →'],
    ['自动进入下一轮', 'next round starts automatically', 'pusingan seterusnya bermula automatik'],
    ['，晋级者成为新名单池', ', winners form the new pool', ', pemenang menjadi senarai baharu'],
    ['人数到', 'At about', 'Pada kira-kira'],
    ['人左右 → 安慰奖阶段：命中者得安慰奖，其余回池，抽满', 'left → consolation stage: the hit wins a consolation prize, others return, until', 'orang → peringkat saguhati: yang terkena menang saguhati, yang lain kembali, sehingga'],
    ['位（已抽', 'are drawn (drawn:', 'dicabut (sudah:'],
    ['剩 3 人 → 全员盲抽，命中者为', '3 left → all drawn, the hit is', 'Tinggal 3 → semua dicabut, yang terkena ialah'],
    ['剩 2 人 → 全员盲抽，命中者为', '2 left → all drawn, the hit is', 'Tinggal 2 → semua dicabut, yang terkena ialah'],
    ['🔒 号码在揭晓时才随机分配，后台无法预先指定命中者', '🔒 Numbers are assigned randomly only at reveal — nobody can pre-select the winner', '🔒 Nombor diberi secara rawak semasa pendedahan — tiada siapa boleh memilih pemenang lebih awal'],
    ['普通轮', 'Regular round', 'Pusingan biasa'],
    ['晋级', 'advances', 'mara'],
    ['淘汰', 'eliminated', 'tersingkir'],

    // —— 前台控盘 / 提示 ——
    ['⚠️ 请先解锁管理员权限！', '⚠️ Please unlock admin first!', '⚠️ Sila buka kunci pentadbir dahulu!'],
    ['确认退出管理员控盘模式？', 'Exit host control mode?', 'Keluar mod kawalan hos?'],
    ['✅ 已解锁管理员大屏控盘模式！\n后台开奖按钮已锁定。', '✅ Host control unlocked!\nThe console reveal button is now locked.', '✅ Kawalan hos dibuka!\nButang pendedahan konsol dikunci.'],
    ['⚠️ 开奖已在进行中，请稍候...', '⚠️ Reveal in progress, please wait…', '⚠️ Pendedahan sedang berjalan, sila tunggu…'],
    ['⚠️ 正在设定票选号，请稍候...', '⚠️ Setting the vote number, please wait…', '⚠️ Sedang menetapkan nombor, sila tunggu…'],
    ['⚠️ 未拥有票选号！\n\n请等待直播间观众投票完成并设定好票选号后，再点击揭晓。', '⚠️ No vote number yet!\n\nWait for the live vote and for the number to be set, then press Reveal.', '⚠️ Belum ada nombor undian!\n\nTunggu undian selesai dan nombor ditetapkan, kemudian tekan Dedahkan.'],
    ['⚠️ 这一组已经在揭晓或已变更', '⚠️ This group is already being revealed or has changed', '⚠️ Kumpulan ini sedang didedahkan atau telah berubah'],
    ['❌ 揭晓失败：', '❌ Reveal failed: ', '❌ Pendedahan gagal: '],
    ['❌ 控盘失败：', '❌ Host control failed: ', '❌ Kawalan hos gagal: '],
    ['❌ 登录失败：请到 Firebase → Authentication → 设置 → 授权网域，添加', '❌ Sign-in failed: in Firebase → Authentication → Settings → Authorized domains, add', '❌ Log masuk gagal: di Firebase → Authentication → Settings → Authorized domains, tambah'],
    ['❌ 登录失败：', '❌ Sign-in failed: ', '❌ Log masuk gagal: '],
    ['❌ 账号', '❌ Account', '❌ Akaun'],
    ['没有控盘权限。', 'has no host permission.', 'tiada kebenaran hos.'],
    ['匿名登录失败:', 'Anonymous sign-in failed:', 'Log masuk tanpa nama gagal:'],

    // —— 开奖记录（共用）——
    ['盲抽揭晓', 'Draw reveal', 'Pendedahan cabutan'],
    ['手动判定', 'Manual decision', 'Keputusan manual'],
    ['轮空晋级', 'Bye (auto advance)', 'Mara tanpa lawan'],
    ['手动淘汰', 'Manual elimination', 'Penyingkiran manual'],
    ['重抽', 'Redraw', 'Cabut semula'],
    ['清空组', 'Group cleared', 'Kumpulan dikosongkan'],
    ['撤销', 'Undo', 'Batal'],
    ['前台主播', 'Host screen', 'Skrin hos'],
    ['后台手动', 'Console (manual)', 'Konsol (manual)'],
    ['后台', 'Console', 'Konsol'],
    ['时间', 'Time', 'Masa'],
    ['轮次', 'Round', 'Pusingan'],
    ['阶段', 'Stage', 'Peringkat'],
    ['类型', 'Type', 'Jenis'],
    ['组员（号码 名字(订单号)）', 'Members (No. Name (Order))', 'Ahli (No. Nama (Pesanan))'],
    ['组员（号码）', 'Members (No.)', 'Ahli (No.)'],
    ['票选号', 'Vote no.', 'No. undian'],
    ['结果', 'Result', 'Keputusan'],
    ['得主/当事人', 'Winner / Person', 'Pemenang / Individu'],
    ['订单号', 'Order no.', 'No. pesanan'],
    ['操作端', 'Done by', 'Oleh'],

    // —— 导入摘要 ——
    ['✅ 已导入', '✅ Imported', '✅ Diimport'],
    ['位有多张订单 = 多次机会', 'have multiple orders = more chances', 'ada beberapa pesanan = lebih peluang'],
    ['• 移除重复订单号', '• Removed duplicate order no.', '• Buang no. pesanan berulang'],
    ['行（同一订单只算一次）', 'rows (each order counts once)', 'baris (setiap pesanan dikira sekali)'],
    ['行没有订单号（已保留，请确认）', 'rows have no order no. (kept — please check)', 'baris tiada no. pesanan (disimpan — sila semak)'],
    ['• 跳过没有名字的', '• Skipped rows without a name:', '• Langkau baris tanpa nama:'],
    ['（', ' (', ' ('],
    ['，其中', ', of which', ', antaranya'],

    // ===================== 后台控制台 =====================
    ['抽奖直播控制台', 'Live Draw Console', 'Konsol Cabutan Langsung'],
    ['正在检查登录状态…', 'Checking sign-in…', 'Menyemak log masuk…'],
    ['🔐 使用 Google 登录', '🔐 Sign in with Google', '🔐 Log masuk dengan Google'],
    ['切换账号', 'Switch account', 'Tukar akaun'],
    ['请使用授权的 Google 账号登录后操作。', 'Please sign in with an authorised Google account.', 'Sila log masuk dengan akaun Google yang dibenarkan.'],
    ['当前账号', 'Account', 'Akaun'],
    ['没有控制台权限。', 'has no console permission.', 'tiada kebenaran konsol.'],
    ['请换成授权的 Google 账号。', 'Please switch to an authorised Google account.', 'Sila tukar ke akaun Google yang dibenarkan.'],
    ['确认退出登录？', 'Sign out?', 'Log keluar?'],
    ['· 退出', '· Out', '· Keluar'],
    ['📋 记录', '📋 Records', '📋 Rekod'],
    ['🔙 上一轮', '🔙 Back', '🔙 Kembali'],
    ['⏩ 锁定晋级并推进', '⏩ Next round', '⏩ Seterusnya'],
    ['❓ 玩法说明', '❓ How to play', '❓ Cara bermain'],
    ['重置所有轮次', 'Reset all rounds', 'Set semula semua pusingan'],
    ['本轮参选', 'This round', 'Pusingan ini'],
    ['本轮晋级/胜出', 'Advanced / won', 'Mara / menang'],
    ['本轮待PK', 'Waiting', 'Menunggu'],
    ['本轮已淘汰', 'Eliminated', 'Tersingkir'],
    ['本轮晋级区', 'Advanced this round', 'Mara pusingan ini'],
    ['本轮暂无胜出买家...', 'No winners yet this round…', 'Belum ada pemenang pusingan ini…'],
    ['本轮选拔已完成！', 'This round is complete!', 'Pusingan ini selesai!'],
    ['待 PK 买家名单池', 'Buyer pool', 'Senarai pembeli'],
    ['🔄 刷新 / 导入名单', '🔄 Refresh / import list', '🔄 Segar / import senarai'],
    ['点击刷新或导入买家名单', 'Refresh or import the buyer list', 'Segar atau import senarai pembeli'],
    ['比赛已经开始，名单已锁定，不可重新导入', 'The draw has started — the list is locked', 'Cabutan telah bermula — senarai dikunci'],
    ['随机盲抽组', 'Draw a group', 'Cabut kumpulan'],
    ['盲抽季军', 'Draw 3rd Place', 'Cabut Tempat Ketiga'],
    ['盲抽冠军', 'Draw Champion', 'Cabut Johan'],
    ['盲抽安慰奖', 'Draw Consolation', 'Cabut Saguhati'],
    ['重抽本组 (POLL #', 'Redraw (POLL #', 'Cabut semula (POLL #'],
    ['🔄 重抽本组名单', '🔄 Redraw this group', '🔄 Cabut semula kumpulan ini'],
    ['清空盲抽组', 'Clear group', 'Kosongkan kumpulan'],
    ['票选号:', 'Vote no.:', 'No. undian:'],
    ['前台未控盘，可在后台按【揭晓】', 'Host screen not in control — reveal here', 'Skrin hos tidak mengawal — dedah di sini'],
    ['🚫 前台已登入管理员', '🚫 Host screen has control', '🚫 Skrin hos sedang mengawal'],
    ['🏆 晋级', '🏆 Advance', '🏆 Mara'],
    ['🔥 抽奖流程', '🔥 How it works', '🔥 Cara cabutan'],
    ['🎲 随机盲抽组说明', '🎲 About group draws', '🎲 Tentang cabutan kumpulan'],
    ['普通轮次', 'Regular round', 'Pusingan biasa'],
    ['等待操作...', 'Waiting…', 'Menunggu…'],
    ['盲抽组已生成，请点击号码设定！', 'Group drawn — set the vote number!', 'Kumpulan dicabut — tetapkan nombor undian!'],
    ['等待前台动画倒计时 (', 'Waiting for screen animation (', 'Menunggu animasi skrin ('],
    ['选取中奖者中…', 'Picking the winner…', 'Memilih pemenang…'],
    ['(等待前台)', '(waiting for host screen)', '(menunggu skrin hos)'],
    ['已选票选号 #', 'Vote no. set #', 'Nombor ditetapkan #'],
    ['等待前台【揭晓】', 'waiting for [Reveal] on host screen', 'menunggu [Dedahkan] di skrin hos'],
    ['揭晓中（各画面跑马灯）…', 'Revealing (all screens)…', 'Sedang mendedahkan (semua skrin)…'],
    ['已揭晓命中！', 'revealed!', 'didedahkan!'],
    ['系统配置', 'Settings', 'Tetapan'],
    ['✏️ 标题显示配置', '✏️ Titles', '✏️ Tajuk'],
    ['📥 名单导入配置', '📥 List import', '📥 Import senarai'],
    ['🎮 抽奖模式规则', '🎮 Draw mode', '🎮 Mod cabutan'],
    ['📄 PDF 报告设置', '📄 PDF report', '📄 Laporan PDF'],
    ['💾 保存全部设置', '💾 Save all settings', '💾 Simpan semua tetapan'],
    ['取消关闭', 'Cancel', 'Batal'],
    ['取消', 'Cancel', 'Batal'],
    ['系统标题与显示配置', 'Titles & display', 'Tajuk & paparan'],
    ['🌐 开启前台网页对外公开显示', '🌐 Show the public page', '🌐 Paparkan halaman awam'],
    ['后台控制台标题:', 'Console title:', 'Tajuk konsol:'],
    ['前台公示大屏标题:', 'Public board title:', 'Tajuk papan awam:'],
    ['买家名单导入模式配置', 'Buyer list import', 'Import senarai pembeli'],
    ['默认链接导入 (Google Sheets 预设)', 'Default link (preset Google Sheet)', 'Pautan lalai (Google Sheet pratetap)'],
    ['修改链接导入 (自定义表格 CSV URL)', 'Custom link (sheet CSV URL)', 'Pautan tersuai (URL CSV)'],
    ['导入本地名单文件 (.csv / .txt)', 'Local file (.csv / .txt)', 'Fail tempatan (.csv / .txt)'],
    ['抽奖规则与玩法模式', 'Draw rules & mode', 'Peraturan & mod cabutan'],
    ['启用模式规则 (关闭后仅手动自由控盘)', 'Enable mode rules (off = fully manual)', 'Aktifkan peraturan mod (mati = manual sepenuhnya)'],
    ['模式 1：冠亚季排位模式', 'Mode 1: Top 3', 'Mod 1: 3 Teratas'],
    ['模式 2：冠亚季 + 安慰奖模式', 'Mode 2: Top 3 + Consolation', 'Mod 2: 3 Teratas + Saguhati'],
    ['剩3人时盲抽（或手动）选出【季军】，剩2人时盲抽（或手动）选出【冠军】，另一位为亚军。', 'At 3 left draw (or pick) [3rd], at 2 left draw (or pick) [Champion]; the other is runner-up.', 'Bila tinggal 3 cabut (atau pilih) [Ketiga], bila tinggal 2 cabut (atau pilih) [Johan]; seorang lagi naib johan.'],
    ['晋级区需至少', 'Advanced list needs at least', 'Senarai mara perlu sekurang-kurangnya'],
    ['位（安慰奖 N + 冠亚季 3）才能推进到安慰奖阶段。', '(N consolation + top 3) before the consolation stage.', 'orang (N saguhati + 3 teratas) sebelum peringkat saguhati.'],
    ['晋级区需至少包含 (N + 3) 人才能开启。', 'Needs at least N + 3 people.', 'Perlu sekurang-kurangnya N + 3 orang.'],
    ['安慰奖名额:', 'Consolation prizes:', 'Hadiah saguhati:'],
    ['PDF 报告导出内容与模板设置', 'PDF report content', 'Kandungan laporan PDF'],
    ['Main Title 1 (主标题 1):', 'Main Title 1:', 'Tajuk Utama 1:'],
    ['Main Title 2 (主标题 2):', 'Main Title 2:', 'Tajuk Utama 2:'],
    ['Sub Title (副标题):', 'Sub Title:', 'Subtajuk:'],
    ['Footer Text (页脚说明):', 'Footer Text:', 'Teks Kaki:'],
    ['盲抽参数设置', 'Draw settings', 'Tetapan cabutan'],
    ['快速调整抽奖参数，保存后实时生效。', 'Quick settings — applied immediately when saved.', 'Tetapan pantas — berkuat kuasa sebaik disimpan.'],
    ['⏱️ 盲抽倒计时时长 (秒)', '⏱️ Countdown (seconds)', '⏱️ Kiraan detik (saat)'],
    ['前台点击开始后倒数此秒数再开跑', 'Seconds of countdown on screen before the draw', 'Saat kiraan detik di skrin sebelum cabutan'],
    ['每组人数由系统自动安排', 'Group sizes are planned automatically', 'Saiz kumpulan dirancang secara automatik'],
    ['（最多 4 人，配合 Shopee 投票选项上限），保证每轮最后刚好落在模式目标人数。抽组时仍可手动修改。', ' (max 4, matching Shopee poll options) so each round lands exactly on the target. You can still change it when drawing.', ' (maksimum 4, ikut had pilihan undian Shopee) supaya setiap pusingan tepat pada sasaran. Masih boleh diubah semasa mencabut.'],
    ['🎲 启用混合模式', '🎲 Allow group draws', '🎲 Benarkan cabutan kumpulan'],
    ['打勾时该模式下所有阶段都支持抽组PK；不打勾时只能手动点晋级。', 'On: every stage can use group draws. Off: manual advance only.', 'Hidup: semua peringkat boleh cabut kumpulan. Mati: manual sahaja.'],
    ['💾 保存盲抽参数', '💾 Save draw settings', '💾 Simpan tetapan cabutan'],
    ['📋 开奖记录 / 历史存档', '📋 Records / archives', '📋 Rekod / arkib'],
    ['📋 开奖记录', '📋 Draw records', '📋 Rekod cabutan'],
    ['⬇️ 下载本场 CSV', '⬇️ Download CSV', '⬇️ Muat turun CSV'],
    ['🗑 清空本场记录', '🗑 Clear all records', '🗑 Kosongkan semua rekod'],
    ['🗑 删除选中', '🗑 Delete selected', '🗑 Padam yang dipilih'],
    ['全选', 'Select all', 'Pilih semua'],
    ['📚 历史存档', '📚 Archives', '📚 Arkib'],
    ['（每次【重置所有轮次】前自动保存）', ' (saved automatically before every reset)', ' (disimpan automatik sebelum setiap set semula)'],
    ['载入中…', 'Loading…', 'Memuatkan…'],
    ['还没有存档', 'No archives yet', 'Belum ada arkib'],
    ['本场还没有开奖记录', 'No records yet', 'Belum ada rekod'],
    ['· 🎲混合', '· 🎲 Mixed', '· 🎲 Campur'],
    ['· ✋仅手动', '· ✋ Manual', '· ✋ Manual'],
    ['① 全部买家进入名单池，每个 POLL 盲抽', '① All buyers enter the pool; each POLL draws', '① Semua pembeli masuk senarai; setiap POLL mencabut'],
    ['（系统自动安排，Shopee 投票最多 4 个选项）。', ' (planned automatically; Shopee polls allow up to 4 options).', ' (dirancang automatik; undian Shopee maksimum 4 pilihan).'],
    ['② 直播间投票 → 后台点票选号 → 前台主播点【揭晓】：命中者', '② Live vote → set the vote no. → host presses [Reveal]: the hit', '② Undian langsung → tetapkan nombor → hos tekan [Dedahkan]: yang terkena'],
    ['，其余', ', the rest', ', yang lain'],
    ['③ 名单池抽完 →', '③ Pool finished →', '③ Senarai habis →'],
    ['，上一轮晋级者成为新名单池。', ', last round\'s winners form the new pool.', ', pemenang pusingan lepas menjadi senarai baharu.'],
    ['模式 1', 'Mode 1', 'Mod 1'],
    ['模式 2', 'Mode 2', 'Mod 2'],
    ['：剩 3 人 → 盲抽 🥉 季军 → 剩 2 人 → 盲抽 👑 冠军，另一位 🥈 亚军。', ': 3 left → draw 🥉 3rd → 2 left → draw 👑 Champion; the other is 🥈 runner-up.', ': tinggal 3 → cabut 🥉 ketiga → tinggal 2 → cabut 👑 johan; seorang lagi 🥈 naib johan.'],
    ['：先进入 🎁 安慰奖阶段（命中者得安慰奖，其余回池，抽满 N 位），再进行冠亚季。', ': first the 🎁 consolation stage (the hit wins, others return, until N are drawn), then the top 3.', ': mula-mula 🎁 peringkat saguhati (yang terkena menang, yang lain kembali, sehingga N dicabut), kemudian 3 teratas.'],
    ['点【🔙 上一轮】可撤销决赛判定或删除最新一轮。', 'Press [🔙 Back] to undo a final decision or remove the latest round.', 'Tekan [🔙 Kembali] untuk batal keputusan final atau buang pusingan terkini.'],
    ['：系统建议 3~4 人一组，命中者晋级，其余淘汰。', ': 3–4 per group suggested; the hit advances, the rest are eliminated.', ': 3–4 sekumpulan dicadangkan; yang terkena mara, yang lain tersingkir.'],
    ['：4 人一组，命中者得安慰奖，其余回名单池。', ': groups of 4; the hit wins a consolation prize, the rest return to the pool.', ': kumpulan 4; yang terkena menang saguhati, yang lain kembali ke senarai.'],
    ['决战轮次（3/2人）', 'Final rounds (3/2)', 'Pusingan final (3/2)'],
    ['：全员上台，命中者得名次（🥉→👑）。', ': everyone is drawn; the hit takes the place (🥉→👑).', ': semua dicabut; yang terkena dapat tempat (🥉→👑).'],
    ['待定只剩 1 人', 'Only 1 left', 'Tinggal 1 orang'],
    ['已禁用，需手动点。', 'disabled — use manual buttons.', 'dilumpuhkan — guna butang manual.'],
    ['命中者晋级，其余淘汰', 'the hit advances, the rest are eliminated', 'yang terkena mara, yang lain tersingkir'],
    ['命中者得 🎁 安慰奖，其余回名单池', 'the hit wins a 🎁 consolation prize, the rest return to the pool', 'yang terkena menang 🎁 saguhati, yang lain kembali ke senarai'],
    ['已关闭【混合模式】，只能手动点晋级', 'Group draws are off — manual only', 'Cabutan kumpulan dimatikan — manual sahaja'],
    ['请先导入买家名单', 'Import the buyer list first', 'Import senarai pembeli dahulu'],
    ['请切换到最新一轮', 'Switch to the latest round', 'Tukar ke pusingan terkini'],
    ['比赛已结束', 'The event is over', 'Pertandingan tamat'],
    ['正在揭晓中，请稍候', 'Revealing, please wait', 'Sedang mendedahkan, sila tunggu'],
    ['本轮已判定，如需更改请点【🔙 上一轮】', 'Already decided — press [🔙 Back] to change', 'Sudah diputuskan — tekan [🔙 Kembali] untuk menukar'],
    ['本轮名单已抽完，请点【⏩ 推进】', 'Pool finished — press [⏩ Next round]', 'Senarai habis — tekan [⏩ Pusingan seterusnya]'],
    ['⏳ 正在读取最新名单…', '⏳ Reading the latest list…', '⏳ Membaca senarai terkini…'],
    ['✅ 已重置。', '✅ Reset done.', '✅ Set semula selesai.'],
    ['\n名单为空，请点【🔄 刷新 / 导入名单】导入。', '\nThe list is empty — press [🔄 Refresh / import list].', '\nSenarai kosong — tekan [🔄 Segar / import senarai].'],
    ['❌ 导入失败：', '❌ Import failed: ', '❌ Import gagal: '],
    ['⚠️ 读取最新名单失败：', '⚠️ Could not read the latest list: ', '⚠️ Gagal membaca senarai terkini: '],
    ['\n\n仍然要重置吗？\n（名单会是空的，之后可点【🔄 刷新 / 导入名单】再导入）', '\n\nReset anyway?\n(The list will be empty — import later with [🔄 Refresh / import list])', '\n\nTetap set semula?\n(Senarai akan kosong — import kemudian dengan [🔄 Segar / import senarai])'],
    ['⚠️ 表格里没有读到任何买家，仍然要重置吗？', '⚠️ No buyers found in the sheet. Reset anyway?', '⚠️ Tiada pembeli dalam helaian. Tetap set semula?'],
    ['⚠️ 确认重置所有数据？\n\n系统会：① 读取谷歌表格最新名单 ② 本场结果自动存档（可在【📋 记录】查看下载）③ 清空所有轮次并放入新名单。', '⚠️ Reset everything?\n\nThis will: ① read the latest Google Sheet list ② archive this event (see [📋 Records]) ③ clear all rounds and load the new list.', '⚠️ Set semula semua?\n\nIni akan: ① baca senarai Google Sheet terkini ② arkibkan acara ini (lihat [📋 Rekod]) ③ kosongkan semua pusingan dan muat senarai baharu.'],
    ['❌ 存档失败，已取消重置（数据没有被清空）：', '❌ Archive failed — reset cancelled (nothing was cleared): ', '❌ Arkib gagal — set semula dibatalkan (tiada yang dikosongkan): '],
    ['⚠️ 名单已导入且已锁定，如要换新名单请点【⚠️ 重置所有轮次】（会自动抓取最新名单）。', '⚠️ The list is already imported and locked. To load a new list press [⚠️ Reset all rounds] (it fetches the latest list).', '⚠️ Senarai sudah diimport dan dikunci. Untuk senarai baharu tekan [⚠️ Set semula semua pusingan].'],
    ['⚠️ 仅限在第 1 轮刷新/导入数据！', '⚠️ Import is only allowed in Round 1!', '⚠️ Import hanya dibenarkan dalam Pusingan 1!'],
    ['还没选择本地名单文件（设置 → 名单导入配置）', 'No local file selected (Settings → List import)', 'Tiada fail tempatan dipilih (Tetapan → Import senarai)'],
    ['读取文件失败', 'Could not read the file', 'Gagal membaca fail'],
    ['表格回应', 'Sheet responded', 'Helaian membalas'],
    ['（请确认表格已「发布到网络」）', ' (make sure the sheet is "Published to the web")', ' (pastikan helaian "Diterbitkan ke web")'],
    ['读到的是网页不是 CSV，请确认表格已「发布到网络」', 'Got a web page instead of CSV — make sure the sheet is "Published to the web"', 'Dapat halaman web bukan CSV — pastikan helaian "Diterbitkan ke web"'],
    ['✅ 盲抽参数已更新并生效！', '✅ Draw settings saved!', '✅ Tetapan cabutan disimpan!'],
    ['⚠️ 请先设定票选号！', '⚠️ Set the vote number first!', '⚠️ Tetapkan nombor undian dahulu!'],
    ['⚠️ 前台管理员已登录并接管揭晓，请在前台操作。', '⚠️ The host screen has control — reveal from the host screen.', '⚠️ Skrin hos sedang mengawal — dedahkan dari skrin hos.'],
    ['⚠️ 本组已经开奖。', '⚠️ This group has already been revealed.', '⚠️ Kumpulan ini sudah didedahkan.'],
    ['❌ 无法定位命中者，请重新设定票选号。', '❌ Could not find the hit — set the vote number again.', '❌ Tidak jumpa yang terkena — tetapkan nombor semula.'],
    ['⚠️ 开奖已确认，禁止修改票选号！', '⚠️ Already revealed — the vote number can\'t be changed!', '⚠️ Sudah didedahkan — nombor tidak boleh diubah!'],
    ['⚠️ 前台已点击揭晓，票选号已锁定，禁止修改！', '⚠️ Reveal started — the vote number is locked!', '⚠️ Pendedahan bermula — nombor dikunci!'],
    ['票选号超出当前组人数范围！', 'Vote number is outside this group\'s range!', 'Nombor di luar julat kumpulan ini!'],
    ['⏳ 请稍候！前台正在播放倒计时和盲抽动画。\n\n还需等待约', '⏳ Please wait — the screen is playing the countdown and draw animation.\n\nAbout', '⏳ Sila tunggu — skrin sedang memainkan animasi.\n\nKira-kira'],
    ['秒才能设定票选号。', 's left before you can set the vote number.', ' saat lagi sebelum nombor boleh ditetapkan.'],
    ['才能设定票选号。', 'left before you can set the vote number.', 'lagi sebelum nombor boleh ditetapkan.'],
    ['⚠️ 当前没有进行中的 POLL。\n请点【🎲 随机盲抽组】开始。', '⚠️ No POLL in progress.\nPress [🎲 Draw a group] to start.', '⚠️ Tiada POLL sedang berjalan.\nTekan [🎲 Cabut kumpulan] untuk mula.'],
    ['ℹ️ 决赛轮是全员上台，不需要重抽名单。', 'ℹ️ Everyone is drawn in final rounds — no redraw needed.', 'ℹ️ Semua dicabut dalam pusingan final — tiada cabut semula.'],
    ['⚠️ 确认清空当前盲抽组？\n\nPOLL #', '⚠️ Clear the current group?\n\nPOLL #', '⚠️ Kosongkan kumpulan semasa?\n\nPOLL #'],
    ['作废，', 'is cancelled;', 'dibatalkan;'],
    ['位组员留在名单池，下次重新抽组。', 'members stay in the pool for the next draw.', 'ahli kekal dalam senarai untuk cabutan seterusnya.'],
    ['⚠️ 当前没有盲抽组，确认继续执行清空操作？', '⚠️ There is no group. Clear anyway?', '⚠️ Tiada kumpulan. Tetap kosongkan?'],
    ['🗑️ 清空盲抽组（作废）', '🗑️ Group cleared (cancelled)', '🗑️ Kumpulan dikosongkan (dibatalkan)'],
    ['🔄 重抽本组名单', '🔄 Group redrawn', '🔄 Kumpulan dicabut semula'],
    ['❌ 手动淘汰', '❌ Manual elimination', '❌ Penyingkiran manual'],
    ['↩️ 撤回安慰奖', '↩️ Consolation undone', '↩️ Saguhati dibatalkan'],
    ['↩️ 撤回淘汰', '↩️ Elimination undone', '↩️ Penyingkiran dibatalkan'],
    ['↩️ 撤回晋级', '↩️ Advance undone', '↩️ Kemaraan dibatalkan'],
    ['↩️ 撤销本轮【', '↩️ Undo this round\'s [', '↩️ Batal ['],
    ['】判定？\n\n本轮所有人将回到待定，可重新选择。', '] decision?\n\nEveryone in this round goes back to waiting.', '] pusingan ini?\n\nSemua dalam pusingan ini kembali menunggu.'],
    ['↩️ 撤销', '↩️ Undo', '↩️ Batal'],
    ['判定', 'decision', 'keputusan'],
    ['↩️ 删除第', '↩️ Removed', '↩️ Buang'],
    ['轮，返回上一轮', ', back to the previous round', ', kembali ke pusingan sebelumnya'],
    ['确认返回上一轮？\n\n当前这一轮将被删除。', 'Go back one round?\n\nThe current round will be removed.', 'Kembali satu pusingan?\n\nPusingan semasa akan dibuang.'],
    ['⚠️ 请切换到最新一轮再推进。', '⚠️ Switch to the latest round first.', '⚠️ Tukar ke pusingan terkini dahulu.'],
    ['⚠️ 请切换到最新一轮再操作。', '⚠️ Switch to the latest round first.', '⚠️ Tukar ke pusingan terkini dahulu.'],
    ['⚠️ 还有进行中的 POLL，请先揭晓或清空盲抽组。', '⚠️ A POLL is still in progress — reveal or clear it first.', '⚠️ POLL masih berjalan — dedahkan atau kosongkan dahulu.'],
    ['⚠️ 冠亚季争夺战无需推进。\n抽出季军后会自动进入冠亚军决战。', '⚠️ No need to advance the top-3 round.\nThe final starts automatically after 3rd place.', '⚠️ Tidak perlu mara pusingan 3 teratas.\nFinal bermula automatik selepas tempat ketiga.'],
    ['🏁 比赛已结束，可点右上角【Export PDF】导出结果。', '🏁 The event is over — use [Export PDF] at the top right.', '🏁 Pertandingan tamat — guna [Export PDF] di kanan atas.'],
    ['⚠️ 请盲抽或手动选出 👑 冠军。', '⚠️ Draw or pick the 👑 Champion.', '⚠️ Cabut atau pilih 👑 Johan.'],
    ['⚠️ 安慰奖还差', '⚠️ Consolation prizes still needed:', '⚠️ Saguhati masih diperlukan:'],
    ['位，抽满后会自动进入冠亚季。', '— the top 3 starts automatically when full.', '— 3 teratas bermula automatik bila penuh.'],
    ['⚠️ 本轮还有', '⚠️ Still', '⚠️ Masih ada'],
    ['位买家没抽。\n\n现在推进的话，他们会全部淘汰。确定？', 'buyers not drawn.\n\nAdvancing now eliminates them all. Continue?', 'pembeli belum dicabut.\n\nMara sekarang akan menyingkirkan mereka. Teruskan?'],
    ['买家没抽。\n\n现在推进的话，他们会全部淘汰。确定？', 'not drawn.\n\nAdvancing now eliminates them all. Continue?', 'belum dicabut.\n\nMara sekarang akan menyingkirkan mereka. Teruskan?'],
    ['⚠️ 晋级人数不足 2 人，无法进入下一轮。', '⚠️ Fewer than 2 advanced — can\'t start the next round.', '⚠️ Kurang daripada 2 mara — tidak boleh mula pusingan seterusnya.'],
    ['⚠️ 这位买家正在 PK 组里，请先揭晓或清空盲抽组。', '⚠️ This buyer is in the current group — reveal or clear it first.', '⚠️ Pembeli ini dalam kumpulan semasa — dedahkan atau kosongkan dahulu.'],
    ['⚠️ 获奖名次不能用 ✕ 撤回。\n请到该决赛轮点【🔙 上一轮】撤销判定。', '⚠️ Prize places can\'t be undone with ✕.\nGo to that final round and press [🔙 Back].', '⚠️ Tempat hadiah tidak boleh dibatal dengan ✕.\nPergi ke pusingan final itu dan tekan [🔙 Kembali].'],
    ['⚠️ 冠亚季决赛轮人数已固定，不能再撤回买家加入。\n如需调整，请先【🔙 上一轮】回到之前的轮次。', '⚠️ Final rounds have a fixed number of people.\nTo adjust, press [🔙 Back] first.', '⚠️ Pusingan final mempunyai bilangan tetap.\nUntuk ubah, tekan [🔙 Kembali] dahulu.'],
    ['⚠️ 请切换到安慰奖那一轮再撤回。', '⚠️ Switch to the consolation round to undo.', '⚠️ Tukar ke pusingan saguhati untuk batal.'],
    ['↩️ 买家【', '↩️ Buyer [', '↩️ Pembeli ['],
    ['】已撤回，并回到当前轮次名单池！', '] has been returned to the current pool!', '] dikembalikan ke senarai semasa!'],
    ['⚠️ 本轮已判定。如需更改，请点【🔙 上一轮】撤销判定。', '⚠️ Already decided. Press [🔙 Back] to change.', '⚠️ Sudah diputuskan. Tekan [🔙 Kembali] untuk menukar.'],
    ['⚠️ 本轮正在盲抽中。\n请等揭晓完成，或先点【清空盲抽组】再手动判定。', '⚠️ A draw is in progress.\nWait for the reveal, or press [Clear group] first.', '⚠️ Cabutan sedang berjalan.\nTunggu pendedahan, atau tekan [Kosongkan kumpulan] dahulu.'],
    ['🥉 确认【', '🥉 Confirm [', '🥉 Sahkan ['],
    ['】为季军？\n\n其余 2 人将自动进入冠亚军决战。', '] as 3rd place?\n\nThe other 2 go to the final automatically.', '] sebagai tempat ketiga?\n\n2 lagi ke final secara automatik.'],
    ['👑 确认【', '👑 Confirm [', '👑 Sahkan ['],
    ['】为冠军？\n\n🥈 亚军：', '] as Champion?\n\n🥈 Runner-up: ', '] sebagai Johan?\n\n🥈 Naib johan: '],
    ['】锁定季军！\n\n已进入【', '] takes 3rd place!\n\nNow in [', '] dapat tempat ketiga!\n\nKini dalam ['],
    ['🏁 比赛结束！\n👑 冠军：', '🏁 Event over!\n👑 Champion: ', '🏁 Pertandingan tamat!\n👑 Johan: '],
    ['\n🥈 亚军：', '\n🥈 Runner-up: ', '\n🥈 Naib johan: '],
    ['\n\n可点右上角【Export PDF】导出结果。', '\n\nUse [Export PDF] at the top right.', '\n\nGuna [Export PDF] di kanan atas.'],
    ['✅ 本轮名单已抽完！\n\n已自动进入【', '✅ Pool finished!\n\nNow in [', '✅ Senarai habis!\n\nKini dalam ['],
    ['）\n\n系统建议本组', ')\n\nSuggested group size:', ')\n\nSaiz kumpulan dicadangkan:'],
    ['人（Shopee 投票最多 4 个选项）\n路线：', '(Shopee polls allow up to 4 options)\nRoute: ', '(undian Shopee maksimum 4 pilihan)\nLaluan: '],
    ['（Shopee 投票最多 4 个选项）\n路线：', ' (Shopee polls allow up to 4 options)\nRoute: ', ' (undian Shopee maksimum 4 pilihan)\nLaluan: '],
    ['\n\n本组人数：', '\n\nGroup size:', '\n\nSaiz kumpulan:'],
    ['⚠️ 每组人数需在 2 ~', '⚠️ Group size must be 2 –', '⚠️ Saiz kumpulan mesti 2 –'],
    ['之间。', '.', '.'],
    ['⚠️ 本组改成', '⚠️ With', '⚠️ Dengan'],
    ['人，后面的人数会对不上模式目标。\n请使用建议的', 'the later rounds won\'t match the target.\nPlease use the suggested', 'pusingan seterusnya tidak tepat pada sasaran.\nSila guna saiz dicadangkan'],
    ['，后面的人数会对不上模式目标。\n请使用建议的', ', the later rounds won\'t match the target.\nPlease use the suggested', ', pusingan seterusnya tidak tepat pada sasaran.\nSila guna saiz dicadangkan'],
    ['⚠️ 数据刚被前台更新，已同步最新画面。\n请确认后重新操作一次。', '⚠️ The host screen just updated the data — synced.\nPlease check and try again.', '⚠️ Skrin hos baru mengemas kini data — disegerakkan.\nSila semak dan cuba lagi.'],
    ['❌ 读取抽奖数据失败：', '❌ Could not read draw data: ', '❌ Gagal membaca data cabutan: '],
    ['\n请重新登录后刷新页面。', '\nPlease sign in again and refresh.', '\nSila log masuk semula dan muat semula.'],
    ['读取失败:', 'Read failed:', 'Gagal membaca:'],
    ['写入失败:', 'Write failed:', 'Gagal menulis:'],
    ['✅ 已删除存档', '✅ Archive deleted', '✅ Arkib dipadam'],
    ['❌ 删除失败：', '❌ Delete failed: ', '❌ Gagal memadam: '],
    ['❌ 读取存档失败：', '❌ Could not read archives: ', '❌ Gagal membaca arkib: '],
    ['这个存档没有开奖记录（可能是旧版本存的）', 'This archive has no records (probably saved by an older version)', 'Arkib ini tiada rekod (mungkin disimpan versi lama)'],
    ['张订单 · 👑', 'orders · 👑', 'pesanan · 👑'],
    ['· 👑', '· 👑', '· 👑'],
    ['条记录', 'records', 'rekod'],
    ['🎁 安慰奖', '🎁 Consolation', '🎁 Saguhati'],
    ['🔥 当前为【晋级模式】', '🔥 Advance mode', '🔥 Mod mara'],
    ['✅ 设置已保存！\n但您还未选择文件，请点击【🔄 刷新 / 导入名单】旁边的按钮上传本地文件。', '✅ Settings saved!\nNo file selected yet — upload one, then press [🔄 Refresh / import list].', '✅ Tetapan disimpan!\nTiada fail dipilih — muat naik, kemudian tekan [🔄 Segar / import senarai].'],
    ['❌ 登录失败：这个网址还没加入授权网域。\n\n请到 Firebase → draw-tournament → Authentication → 设置 → 授权网域，添加：\n', '❌ Sign-in failed: this address is not an authorised domain.\n\nIn Firebase → draw-tournament → Authentication → Settings → Authorized domains, add:\n', '❌ Log masuk gagal: alamat ini bukan domain yang dibenarkan.\n\nDi Firebase → draw-tournament → Authentication → Settings → Authorized domains, tambah:\n'],
    ['📋 OFFICIAL DRAW RECORD · 开奖记录', '📋 OFFICIAL DRAW RECORD', '📋 REKOD CABUTAN RASMI'],
    ['ℹ️ 为了让人数刚好落在目标，【', 'ℹ️ To land exactly on the target, [', 'ℹ️ Untuk tepat pada sasaran, ['],
    ['】本轮轮空，直接晋级。\n\n确定？', '] gets a bye and advances directly.\n\nContinue?', '] mara terus tanpa lawan.\n\nTeruskan?'],
    ['ℹ️ 待定池只剩 1 人，无法再 PK。\n请手动点【🏆 晋级】或【❌】处理这位买家。', 'ℹ️ Only 1 left — no PK possible.\nUse [🏆 Advance] or [❌] for this buyer.', 'ℹ️ Tinggal 1 — tiada PK.\nGuna [🏆 Mara] atau [❌] untuk pembeli ini.'],
    ['⚠️ 当前模式至少需要', '⚠️ This mode needs at least', '⚠️ Mod ini memerlukan sekurang-kurangnya'],
    ['位买家，名单只有', 'buyers; the list has only', 'pembeli; senarai hanya ada'],
    ['位。\n\n继续的话，部分奖项会抽不满。确定继续？', '.\n\nSome prizes won\'t be filled. Continue?', '.\n\nSesetengah hadiah tidak penuh. Teruskan?'],
    ['🎲 盲抽', '🎲 Draw', '🎲 Cabut'],
    ['🔄 重抽', '🔄 Redraw', '🔄 Cabut semula'],
    ['🔄 重新开始', '🔄 Restart', '🔄 Mula semula'],
    ['🎲 开始', '🎲 Start', '🎲 Mula'],
    ['盲抽 (POLL #', 'draw (POLL #', 'cabutan (POLL #'],
    ['全员', 'All', 'Semua'],
    ['人上台，命中者为【', 'are drawn; the hit becomes [', 'dicabut; yang terkena menjadi ['],
    ['上台，命中者为【', 'are drawn; the hit becomes [', 'dicabut; yang terkena menjadi ['],
    ['】，其余 2 人自动进入冠亚军决战。', '], the other 2 go to the final automatically.', '], 2 lagi ke final secara automatik.'],
    ['】，另一位自动为 🥈 亚军。', '], the other is 🥈 runner-up.', '], seorang lagi 🥈 naib johan.'],
    ['其余 2 人自动进入冠亚军决战。', 'the other 2 go to the final automatically.', '2 lagi ke final secara automatik.'],
    ['另一位自动为 🥈 亚军。', 'the other is 🥈 runner-up.', 'seorang lagi 🥈 naib johan.'],
    ['（命中者得 🎁 安慰奖，其余回名单池）', ' (the hit wins a 🎁 consolation prize, the rest return to the pool)', ' (yang terkena menang 🎁 saguhati, yang lain kembali ke senarai)'],
    ['（命中者晋级，其余淘汰）', ' (the hit advances, the rest are eliminated)', ' (yang terkena mara, yang lain tersingkir)'],
    ['⚠️ 本轮已判定。', '⚠️ Already decided.', '⚠️ Sudah diputuskan.'],
    ['🗑 删除这条开奖记录？\n\n', '🗑 Delete this record?\n\n', '🗑 Padam rekod ini?\n\n'],
    ['（只删除记录，不会改变比赛结果）', '(only the record is deleted — results don\'t change)', '(hanya rekod dipadam — keputusan tidak berubah)'],
    ['🗑 清空本场全部', '🗑 Clear all', '🗑 Kosongkan semua'],
    ['开奖记录？\n\n建议先点【⬇️ 下载本场 CSV】备份。\n', 'records?\n\nDownload a CSV backup first.\n', 'rekod?\n\nMuat turun sandaran CSV dahulu.\n'],
    ['⚠️ 再确认一次：清空后无法恢复。', '⚠️ Confirm again: this can\'t be undone.', '⚠️ Sahkan sekali lagi: tidak boleh dibatalkan.'],
    ['本场没有记录', 'No records', 'Tiada rekod'],
    ['🗑 删除存档【', '🗑 Delete archive [', '🗑 Padam arkib ['],
    ['】？\n\n删除后无法恢复，建议先下载 CSV。', ']?\n\nThis can\'t be undone — download a CSV first.', ']?\n\nTidak boleh dibatalkan — muat turun CSV dahulu.'],
    ['🗑 删除选中的', '🗑 Delete the selected', '🗑 Padam'],
    ['条开奖记录？\n\n（只删除记录，不会改变比赛结果）', 'records?\n\n(only the records are deleted — results don\'t change)', 'rekod yang dipilih?\n\n(hanya rekod dipadam — keputusan tidak berubah)'],
    ['请先勾选要删除的记录', 'Tick the records to delete first', 'Tandakan rekod untuk dipadam dahulu'],
    ['✅ 本场已存档，正在重置…', '✅ Event archived, resetting…', '✅ Acara diarkibkan, sedang set semula…'],
    ['❌ 保存失败：没有写入权限 (PERMISSION_DENIED)。\n\n请确认右上角登录的是授权的 Google 账号。', '❌ Save failed: no write permission (PERMISSION_DENIED).\n\nCheck you are signed in with an authorised Google account.', '❌ Simpan gagal: tiada kebenaran tulis (PERMISSION_DENIED).\n\nPastikan anda log masuk dengan akaun Google yang dibenarkan.'],
    ['❌ 保存失败：', '❌ Save failed: ', '❌ Simpan gagal: '],
    ['❌ 生成 PDF 失败，请重新点击导出！', '❌ PDF failed — please export again!', '❌ PDF gagal — sila eksport semula!'],
    ['⚠️ 请先选出晋级买家！', '⚠️ Pick the winners first!', '⚠️ Pilih pemenang dahulu!'],
    ['人', 'pax', 'orang'],
    ['共', 'Total', 'Jumlah'],
    ['安全', 'Safe', 'Selamat'],
    ['命中', 'Hit', 'Terkena'],
    ['未中', 'missed', 'tidak kena'],
    ['搜索', 'Search', 'Cari'],
    ['🔍 名字或订单号...', '🔍 Name or order no…', '🔍 Nama atau no. pesanan…'],
    ['留空则跟随语言自动切换', 'Leave empty to follow the language', 'Biarkan kosong untuk ikut bahasa'],
  ];
  // 开头/结尾带换行的词组，也加一份去掉空白的版本
  DICT.slice().forEach(d => { if (d[0].trim() !== d[0]) DICT.push([d[0].trim(), d[1].trim(), d[2].trim()]); });

  // ---------- 引擎 ----------
  const MAP = new Map(DICT.map(d => [d[0], d]));
  const ORDERED = DICT.filter(d => d[0].length >= 2).sort((a, b) => b[0].length - a[0].length);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const DICT_RE = new RegExp(ORDERED.map(d => esc(d[0])).join('|'), 'g');
  const HAS_ZH = /[一-鿿]/;

  let lang = 'zh';
  let storageKey = 'mochii_lang';

  function translate(text, to) {
    to = to || lang;
    if (to === 'zh' || !text || !HAS_ZH.test(text)) return text;
    const col = to === 'en' ? 1 : 2;
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const lead = m[1], body = m[2], trail = m[3];
    for (const [re, en, ms, deep] of SENTENCES) {
      if (!re.test(body)) continue;
      const tpl = col === 1 ? en : ms;
      if (!deep) return lead + body.replace(re, tpl) + trail;
      const g = body.match(re).slice(1).map(x => phrases(x, col));
      return lead + tpl.replace(/\$(\d)/g, (_, i) => g[i - 1] || '') + trail;
    }
    return lead + phrases(body, col) + trail;
  }
  const PRE_UNITS = UNITS.slice(0, 5);    // 第 N 轮、共 N 人：先处理
  const POST_UNITS = UNITS.slice(5);      // 其他数字单位：词组之后
  const PUNCT = [[/（/g, ' ('], [/）/g, ') '], [/，/g, ', '], [/。/g, '. '], [/：/g, ': '], [/！/g, '! '], [/？/g, '? '], [/【/g, '['], [/】/g, ']'], [/、/g, ', '], [/ {2,}/g, ' '], [/ ([).,:!?\]])/g, '$1'], [/\( /g, '(']];
  function phrases(body, col) {
    if (MAP.has(body.trim())) return MAP.get(body.trim())[col];
    let out = body;
    for (const [re, en, ms] of PRE_UNITS) out = out.replace(re, col === 1 ? en : ms);
    out = out.replace(DICT_RE, (k, off, str) => {
      let v = MAP.get(k)[col];
      const before = str[off - 1], after = str[off + k.length];
      if (before && /[0-9A-Za-z)\]]/.test(before) && /^[A-Za-z0-9(\[]/.test(v)) v = ' ' + v;   // 数字/英文与译文之间补空格
      if (after && /[0-9A-Za-z(\[]/.test(after) && /[A-Za-z0-9)\]:]$/.test(v)) v = v + ' ';
      return v;
    });
    for (const [re, en, ms] of POST_UNITS) out = out.replace(re, col === 1 ? en : ms);
    if (!HAS_ZH.test(out)) for (const [re, to] of PUNCT) out = out.replace(re, to);   // 全部译完才换标点（名字旁的标点保留）
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]+$/, '');
  }

  // —— 画面翻译 ——
  const ORIG = new WeakMap();      // 文字节点 → 原始中文
  const LAST = new WeakMap();      // 文字节点 → 上次翻译结果
  const ATTRS = ['placeholder', 'title'];
  const SKIP = 'script,style,textarea,[translate="no"],.no-i18n,.pk-card-name,.passed-card-name,.pk-card-order,.passed-card-order';

  function skipNode(el) { return !el || (el.closest && el.closest(SKIP)); }

  function applyText(node) {
    const cur = node.nodeValue;
    if (LAST.get(node) !== cur) ORIG.set(node, cur);   // 页面自己改了文字 → 记新的原文
    const orig = ORIG.get(node);
    if (orig == null || !HAS_ZH.test(orig)) return;
    const next = lang === 'zh' ? orig : translate(orig);
    if (next !== cur) node.nodeValue = next;
    LAST.set(node, next);
  }
  function applyAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const key = 'data-i18n-' + a;
      const cur = el.getAttribute(a);
      if (el.getAttribute(key + '-last') !== cur) el.setAttribute(key, cur);
      const orig = el.getAttribute(key);
      if (!HAS_ZH.test(orig || '')) continue;
      const next = lang === 'zh' ? orig : translate(orig);
      if (next !== cur) el.setAttribute(a, next);
      el.setAttribute(key + '-last', next);
    }
  }
  function applyTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skipNode(root.parentElement)) applyText(root); return; }
    if (root.nodeType !== 1 || skipNode(root)) return;
    applyAttrs(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => (n.nodeType === 1 ? (skipNode(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_ACCEPT)
    });
    let n;
    while ((n = walker.nextNode())) { if (n.nodeType === 3) applyText(n); else applyAttrs(n); }
  }

  let observer = null, applying = false;
  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(muts => {
      if (applying) return;
      applying = true;
      try {
        for (const m of muts) {
          if (m.type === 'characterData') { if (!skipNode(m.target.parentElement)) applyText(m.target); }
          else if (m.type === 'attributes') { if (!skipNode(m.target)) applyAttrs(m.target); }
          else m.addedNodes.forEach(applyTree);
        }
      } finally { applying = false; }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function highlightButtons() {
    LANGS.forEach(l => {
      const b = document.getElementById('langBtn-' + l);
      if (!b) return;
      b.style.background = l === lang ? '#f59e0b' : '';
      b.style.color = l === lang ? '#0f172a' : '';
      b.style.fontWeight = l === lang ? '800' : '';
      b.classList.toggle('lang-active', l === lang);
    });
  }

  function setLang(l) {
    lang = LANGS.includes(l) ? l : 'zh';
    try { localStorage.setItem(storageKey, lang); } catch (e) {}
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    applying = true;
    try { applyTree(document.body); } finally { applying = false; }
    highlightButtons();
  }

  function init(key) {
    storageKey = key || storageKey;
    try { lang = localStorage.getItem(storageKey) || 'zh'; } catch (e) { lang = 'zh'; }
    const go = () => { startObserver(); setLang(lang); };
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  }

  // 原生确认框 / 输入框也翻译
  const _confirm = global.confirm, _prompt = global.prompt;
  global.confirm = msg => _confirm.call(global, translate(String(msg == null ? '' : msg)));
  global.prompt = (msg, def) => _prompt.call(global, translate(String(msg == null ? '' : msg)), def);

  global.I18N = { init, setLang, translate, get lang() { return lang; }, DICT };
})(typeof window !== 'undefined' ? window : globalThis);
