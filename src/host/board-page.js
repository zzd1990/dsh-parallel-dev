/**
 * 看板页面 —— 自包含 HTML（内联 CSS + JS + SVG），无构建步骤。
 *
 * 设计文档第四节的两条硬要求，落在这里：
 *   1. **纵向布局**：层 = 行，依赖从上到下。理由是宽度被并发上限钳住、深度没有上界，
 *      "宽有界、深无界"的数据就该往纵深排。
 *   2. **三种边都要画**：实线=真依赖，虚线=同泳道排队（普通 DAG 不画，但它是真实排期约束），
 *      关键路径作为贯穿的脊椎单独强调。
 *
 * 页面只负责画；图和统计由 host 半边算好（src/host/graph.js），避免两边算两套。
 */

export const BOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parallel Dev · 依赖图</title>
<style>
  /* ── 调色板 ──
     默认浅色：看板多数时候嵌在侧栏里，而 DSH 应用是浅色，深色看板嵌进去像贴了块黑补丁。
     两档覆盖：显式 data-theme="dark"，以及 auto 模式下跟随系统。
     被侧栏承载时由客户端把应用当前主题通过 ?theme= 传进来，和宿主保持一致。 */
  :root {
    --bg:#ffffff; --panel:#f7f8fa; --card:#ffffff; --line:#e3e6ec; --line-soft:#eef0f4;
    --line-strong:#c9cfda; --fg:#1a1d23; --dim:#5c6373; --faint:#8a919f;
    --pending:#9aa1ad; --progress:#1f6feb; --completed:#1a7f37; --review:#0d7d8a; --needsfix:#b26a00;
    --critical:#d92d20; --lane:#7c3aed; --edge:#b8bfcc;
    --accent-soft:rgba(31,111,235,.10); --accent-mid:rgba(31,111,235,.22); --accent-strong:rgba(31,111,235,.55);
    --hatch:rgba(255,255,255,.45);
    --band-bg:#fbfcfd; --btn-bg:#f2f4f7; --btn-hover:#e8ebf0; --needsfix-line:#e8d9b8;
    --lane-0:#7c3aed; --lane-1:#0d9488; --lane-2:#db2777; --lane-3:#a16207; --lane-4:#2563eb;
    --lane-5:#ea580c; --lane-6:#6d28d9; --lane-7:#059669; --lane-8:#dc2626; --lane-9:#0284c7;
  }
  :root[data-theme="dark"] {
    --bg:#0f1115; --panel:#151a22; --card:#1b2130; --line:#252c38; --line-soft:#1b212b;
    --line-strong:#3a4a68; --fg:#e6e8ec; --dim:#8b93a3; --faint:#5b6373;
    --pending:#6b7382; --progress:#4a9eff; --completed:#3fb950; --review:#39c5cf; --needsfix:#e3a008;
    --critical:#ff6b6b; --lane:#7c5cff; --edge:#59637a;
    --accent-soft:rgba(74,158,255,.28); --accent-mid:rgba(74,158,255,.55); --accent-strong:rgba(74,158,255,.6);
    --hatch:rgba(0,0,0,.35);
    --band-bg:#121720; --btn-bg:#1d242f; --btn-hover:#252d3a; --needsfix-line:#3a3320;
    --lane-0:#7c5cff; --lane-1:#2dd4bf; --lane-2:#f472b6; --lane-3:#facc15; --lane-4:#60a5fa;
    --lane-5:#fb923c; --lane-6:#a78bfa; --lane-7:#34d399; --lane-8:#f87171; --lane-9:#38bdf8;
  }
  /* auto：没有显式选择时跟随系统 */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]):not([data-theme="dark"]) {
      --bg:#0f1115; --panel:#151a22; --card:#1b2130; --line:#252c38; --line-soft:#1b212b;
      --line-strong:#3a4a68; --fg:#e6e8ec; --dim:#8b93a3; --faint:#5b6373;
      --pending:#6b7382; --progress:#4a9eff; --completed:#3fb950; --review:#39c5cf; --needsfix:#e3a008;
      --critical:#ff6b6b; --lane:#7c5cff; --edge:#59637a;
      --accent-soft:rgba(74,158,255,.28); --accent-mid:rgba(74,158,255,.55); --accent-strong:rgba(74,158,255,.6);
      --hatch:rgba(0,0,0,.35);
      --band-bg:#121720; --btn-bg:#1d242f; --btn-hover:#252d3a; --needsfix-line:#3a3320;
      --lane-0:#7c5cff; --lane-1:#2dd4bf; --lane-2:#f472b6; --lane-3:#facc15; --lane-4:#60a5fa;
      --lane-5:#fb923c; --lane-6:#a78bfa; --lane-7:#34d399; --lane-8:#f87171; --lane-9:#38bdf8;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--panel); border-bottom:1px solid var(--line);
    padding:10px 16px; display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  header h1 { font-size:14px; margin:0; font-weight:600; letter-spacing:.02em; }
  .kpis { display:flex; gap:16px; flex-wrap:wrap; align-items:center; }
  .kpi { display:flex; gap:6px; align-items:baseline; }
  .kpi b { font-size:15px; font-weight:600; }
  .kpi span { color:var(--dim); font-size:11px; }
  .kpi.warn b { color:var(--needsfix); }
  .kpi.crit b { color:var(--critical); }
  button { background:var(--btn-bg); color:var(--fg); border:1px solid var(--line); border-radius:6px;
    padding:5px 11px; font-size:12px; cursor:pointer; }
  button:hover { background:var(--btn-hover); }
  main { padding:16px; }
  .legend { display:flex; gap:18px; flex-wrap:wrap; color:var(--dim); font-size:11.5px;
    margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid var(--line); }
  .legend i { display:inline-block; width:22px; height:0; border-top:2px solid var(--fg);
    vertical-align:middle; margin-right:5px; }
  .legend i.dash { border-top-style:dashed; }
  .legend i.crit { border-top-color:var(--critical); border-top-width:3px; }
  .legend .dot { display:inline-block; width:9px; height:9px; border-radius:2px;
    vertical-align:middle; margin-right:5px; }
  #stage { position:relative; }
  .band { position:relative; border:1px solid var(--line); border-radius:8px; background:var(--band-bg);
    margin-bottom:0; }
  .band .bandlabel { position:absolute; left:10px; top:8px; font-size:11px; color:var(--faint);
    letter-spacing:.04em; }
  .band .bandlabel b { color:var(--dim); }
  .gap { position:relative; }
  .gap .gaptext { position:absolute; left:14px; top:50%; transform:translateY(-50%);
    font-size:11px; color:var(--faint); background:var(--bg); padding:1px 8px; border-radius:9px;
    border:1px solid var(--line); white-space:nowrap; }
  .gap .gaptext.hot { color:var(--needsfix); border-color:var(--needsfix-line); }
  .node { position:absolute; border-radius:6px; border:1px solid var(--line); background:var(--card);
    padding:6px 9px 6px 12px; overflow:hidden; cursor:default; transition:opacity .12s, box-shadow .12s; }
  .node .bar { position:absolute; left:0; top:0; bottom:0; width:4px; }
  .node .id { font-size:10.5px; color:var(--faint); letter-spacing:.04em; display:flex; gap:6px; align-items:center; }
  .node .id em { font-style:normal; color:var(--critical); font-size:10px; }
  .node .sub { font-size:12.5px; margin:1px 0 2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .node .meta { font-size:10px; color:var(--faint); display:flex; gap:8px; }
  .node .meta span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .node.onCritical { box-shadow:inset 0 0 0 1px var(--critical); }
  .node.dimmed { opacity:.18; }
  .node.hl { box-shadow:0 0 0 2px var(--accent-mid); }
  svg { position:absolute; inset:0; pointer-events:none; overflow:visible; }
  .empty { color:var(--dim); padding:30px; text-align:center; }
  .err { color:var(--needsfix); padding:14px; }
  .stale { font-size:11px; color:var(--faint); margin-left:auto; }
  /* ── 紧凑模式：窄容器（侧栏 iframe 约 360-480px）下的迷你依赖图 ── */
  body.compact main { padding:8px; }
  body.compact header { padding:8px 10px; gap:10px; }
  body.compact header h1 { font-size:12px; }
  body.compact .legend { display:none; }
  body.compact button, body.compact .stale { font-size:11px; }
  .crow { display:flex; align-items:flex-start; gap:6px; padding:3px 0; }
  .crow .clab { flex:0 0 34px; font-size:10px; color:var(--faint); padding-top:3px; text-align:right; }
  .crow .cchips { flex:1; display:flex; flex-wrap:wrap; gap:4px; }
  .chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--line);
    background:var(--card); border-radius:4px; padding:2px 6px 2px 4px; font-size:10.5px;
    white-space:nowrap; max-width:100%; cursor:default; position:relative; }
  .chip .cbar { width:3px; height:11px; border-radius:1px; }
  .chip .cid { color:var(--faint); }
  .chip.crit { box-shadow:inset 0 0 0 1px var(--critical); }
  .chip.dimmed { opacity:.2; }
  .chip.hl { box-shadow:0 0 0 1.5px var(--accent-strong); }
  .cjoin { display:flex; align-items:center; gap:6px; padding:1px 0 1px 40px; font-size:10px; color:var(--faint); }
  .cjoin .ln { flex:0 0 1px; height:10px; background:var(--line); }
  .csum { margin-top:10px; padding-top:8px; border-top:1px solid var(--line);
    font-size:11px; color:var(--dim); display:flex; gap:12px; flex-wrap:wrap; }
  .cmsgs { margin-top:6px; font-size:10.5px; color:var(--faint); }
  /* ── 嵌入模式（?embed=1）：被侧栏 iframe 承载时用 ──
       宿主已经显示了 tab 芯片「并行开发」，页面再画一遍大标题就是重复；
       外边距也要收掉，否则嵌进去像套了两层壳。KPI、视图切换、刷新都保留 —— 那些是有用的。 */
  /* 嵌入模式用主题自己的背景色，不要设成 transparent。
     曾经设成 transparent 想让侧栏底色透上来 —— 浅色下看着没问题（白≈透明），
     但暗色下就露馅：层带/卡片按暗色调色板变暗，页面却还是白的，看着像半成品。
     浏览器实测发现的。 */
  body.embed { background:var(--bg); }
  body.embed header { padding:6px 10px; gap:10px; border-bottom:1px solid var(--line); }
  body.embed header h1 { display:none; }
  body.embed main { padding:8px 10px 14px; }
  body.embed .legend { margin-bottom:10px; padding-bottom:8px; gap:12px; font-size:11px; }
  body.embed .stale { display:none; }

  /* ── 视图 B：并发时间轴 ── */
  .views { display:flex; gap:6px; }
  .views button.on { background:var(--accent-soft); border-color:var(--line-strong); color:var(--fg); }
  body.compact .views { display:none; }
  .tl { position:relative; }
  .tl .axis { position:relative; height:22px; margin-left:150px; border-bottom:1px solid var(--line); }
  .tl .axis span { position:absolute; top:2px; font-size:10px; color:var(--faint); transform:translateX(-50%); }
  .tl .conc { position:relative; height:56px; margin-left:150px; border-bottom:1px solid var(--line); }
  .tl .conc .cbar { position:absolute; bottom:0; background:var(--accent-soft); border-top:2px solid var(--progress); }
  .tl .conc .climit { position:absolute; left:0; right:0; border-top:1px dashed var(--line-strong); }
  .tl .conc .clab { position:absolute; left:2px; top:2px; font-size:10px; color:var(--faint); }
  .tl .lane { display:flex; align-items:center; border-bottom:1px solid var(--line-soft); }
  .tl .lane .ln { flex:0 0 150px; font-size:11px; color:var(--dim); padding:5px 8px 5px 0;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tl .lane .ln b { color:var(--faint); font-weight:400; }
  .tl .lane .track { position:relative; flex:1; height:26px; }
  .tl .lane .seg { position:absolute; top:7px; height:12px; border-radius:2px; }
  .tl .lane .seg.fix { background-image:repeating-linear-gradient(45deg,var(--hatch) 0 3px,transparent 3px 6px); }
  .tl .lane .crit { position:absolute; top:0; bottom:0; width:2px; background:var(--critical); opacity:.35; }
  .tl .lane .dur { position:absolute; right:4px; top:5px; font-size:10px; color:var(--faint); }
  .tl .grid { position:absolute; top:0; bottom:0; width:1px; background:var(--line-soft); }
</style>
</head>
<body>
<header>
  <h1>Parallel Dev · 依赖图</h1>
  <div class="kpis" id="kpis"></div>
  <div class="views">
    <button id="v-dag" class="on">依赖图</button>
    <button id="v-tl">时间轴</button>
  </div>
  <button id="refresh">刷新</button>
  <button id="theme" title="切换明暗">◐</button>
  <span class="stale" id="stale"></span>
</header>
<main>
  <div class="legend">
    <span><i></i>真依赖（blocked_by）</span>
    <span><i class="dash"></i>同泳道排队（同一个 agent，必须串行）</span>
    <span><i class="crit"></i>关键路径（决定总工期）</span>
    <span><span class="dot" style="background:var(--pending)"></span>待处理</span>
    <span><span class="dot" style="background:var(--progress)"></span>进行中</span>
    <span><span class="dot" style="background:var(--completed)"></span>已完成</span>
    <span style="color:var(--faint)">· 悬停节点看阻塞半径</span>
  </div>
  <div id="stage"><div class="empty">加载中…</div></div>
</main>
<script>
const STATUS_COLOR = { pending:'var(--pending)', in_progress:'var(--progress)',
  completed:'var(--completed)', review:'var(--review)', needs_fix:'var(--needsfix)', deleted:'var(--faint)' };
const STATUS_TEXT = { pending:'待处理', in_progress:'进行中', completed:'已完成',
  review:'待验收', needs_fix:'需整改', deleted:'已删除' };
// 泳道色同样走变量：浅色和暗色各有一组，避免在浅底上看不清
const LANE_COLORS = Array.from({ length: 10 }, (_, i) => 'var(--lane-' + i + ')');

let DATA = null;
// NODE_H 要装得下三行：id(≈16) + 标题(≈22) + meta(≈15) + 上下内边距(12) ≈ 65，留点余量取 68。
// 实测 56 会把 meta 那行裁掉一半。
const NODE_W = 178, NODE_H = 68, BAND_PAD_TOP = 30, BAND_PAD_BOTTOM = 14, BAND_PAD_X = 18;
const ROW_GAP = 18, BAND_GAP_H = 46;

function laneColor(owner) {
  if (!owner) return 'var(--pending)';
  let h = 0; for (let i = 0; i < owner.length; i++) h = (h * 31 + owner.charCodeAt(i)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

/** 窄容器判定：侧栏 iframe 里 window.innerWidth 就是 iframe 宽度。 */
function isCompact() { return (typeof window === 'undefined' ? false : (window.innerWidth || 9999) < 560); }

/**
 * 紧凑渲染 —— 侧栏缩略图。
 *
 * 侧栏只有约 360px，画不下完整依赖图。这里只保留"形状"：
 * 每层一行、任务是带状态色的小芯片、层间标注过带边数。
 * 目标是扫一眼就知道：几层、哪层宽、卡在哪 —— 细节留给完整看板。
 */
function renderCompact(d) {
  const stage = document.getElementById('stage');
  if (!d.layers || d.layers.length === 0) {
    stage.innerHTML = '<div class="empty" style="padding:16px;font-size:12px">任务板还空着。<br>建了任务这里就会出现依赖图缩略。</div>';
    renderKpis(d); return;
  }
  const crit = new Set(d.criticalPath || []);
  let html = '';
  d.layers.forEach((layer, li) => {
    const chips = layer.tasks.map(id => {
      const t = d.nodes[id];
      if (!t) return '';
      const short = t.subject.length > 9 ? t.subject.slice(0, 9) + '…' : t.subject;
      return '<span class="chip' + (crit.has(id) ? ' crit' : '') + '" data-id="' + id + '" title="'
        + escapeHtml(t.id + ' · ' + t.subject + ' · ' + (STATUS_TEXT[t.status] || t.status)
          + (t.owner ? ' · ' + t.owner : '')) + '">'
        + '<span class="cbar" style="background:' + STATUS_COLOR[t.status] + '"></span>'
        + '<span class="cid">' + id + '</span>' + escapeHtml(short) + '</span>';
    }).join('');
    html += '<div class="crow"><div class="clab">层' + layer.layer + '·' + layer.tasks.length + '</div>'
      + '<div class="cchips">' + chips + '</div></div>';
    const band = d.bands[li];
    if (band && li < d.layers.length - 1) {
      html += '<div class="cjoin"><span class="ln"></span>↓ ' + band.crossing
        + ' 条边过带 · ' + band.waiting + ' 个在等</div>';
    }
  });
  const s = d.summary || {};
  html += '<div class="csum"><span>完成 <b>' + s.completed + '/' + s.total + '</b></span>'
    + '<span>关键路径剩 <b style="color:var(--critical)">' + s.criticalRemaining + '</b> 层</span>'
    + (s.blocked ? '<span style="color:var(--needsfix)">阻塞 <b>' + s.blocked + '</b></span>' : '')
    + '</div>';
  html += '<div class="cmsgs">悬停芯片看详情 · 点「完整看板」展开依赖图</div>';
  html += '<div style="margin-top:8px"><button id="expand">完整看板</button></div>';
  stage.innerHTML = html;
  wireCompactHover();
  const ex = document.getElementById('expand');
  if (ex && ex.addEventListener) ex.addEventListener('click', () => {
    if (typeof window !== 'undefined' && window.open) window.open(location.pathname + location.search, '_blank');
  });
  renderKpis(d);
}

/** 紧凑模式下悬停芯片：高亮它的下游。 */
function wireCompactHover() {
  const chips = [...document.querySelectorAll('.chip')];
  chips.forEach(c => {
    c.addEventListener('mouseenter', () => {
      const down = new Set(DATA.downstream[c.dataset.id] || []);
      down.add(c.dataset.id);
      chips.forEach(o => {
        o.classList.toggle('dimmed', !down.has(o.dataset.id));
        o.classList.toggle('hl', o.dataset.id === c.dataset.id);
      });
      const t = DATA.nodes[c.dataset.id];
      showBlast(t, down.size - 1);
    });
    c.addEventListener('mouseleave', () => {
      chips.forEach(o => o.classList.remove('dimmed', 'hl'));
      hideBlast();
    });
  });
}

let VIEW = 'dag';   // 'dag' | 'timeline'

/**
 * 状态区间：把时间线折成 [start, end, status] 片段。
 *
 * 一个容易错的地方：**只有"仍在进行"的状态才允许延伸到时间轴末尾**。
 * 已完成的末段如果也延伸，看起来就像那个任务还在跑 —— 实测把并发峰值算成了 10（任务总数），
 * 而并发曲线恰恰是这张图的重点，算错就完全失去意义。
 */
const ACTIVE_STATUS = new Set(['in_progress', 'needs_fix', 'review']);

function segmentsOf(rows, rangeEnd) {
  const segs = [];
  for (let i = 0; i < rows.length; i++) {
    const start = Date.parse(rows[i].at);
    const last = i + 1 >= rows.length;
    // 末段且状态不是"进行中" → 任务已经停下，不画延伸段
    if (last && !ACTIVE_STATUS.has(rows[i].status)) continue;
    const end = last ? rangeEnd : Date.parse(rows[i + 1].at);
    if (!(end > start)) continue;
    segs.push({ start, end, status: rows[i].status });
  }
  return segs;
}

/**
 * 视图 B：并发时间轴。
 *
 * DAG 是"应该怎样"，时间轴是"实际怎样"。缺了它就看不出瓶颈在哪一段 ——
 * 这张图直接暴露"6 个 agent 只在头 3 小时用满、后面 9 小时大面积闲置"这类问题，
 * 而那是优化并行度的唯一依据：想缩短工期只能缩短关键路径，不是加 agent。
 */
function renderTimeline(d) {
  const stage = document.getElementById('stage');
  const tl = d.timeline || {};
  const ids = Object.keys(tl).filter(id => (tl[id] || []).length > 0);
  if (ids.length === 0) {
    stage.innerHTML = '<div class="empty" style="padding:24px;font-size:12.5px">还没有任务状态变更记录。<br>'
      + '<span style="color:var(--faint)">插件从 v0.2 起订阅 team/task 事件记录时间戳 —— 平台的 TeamTaskView 只有 revision 和 status，没有状态变更时刻，错过就补不回来。'
      + '所以真实任务开始流转后，这里才会有内容。</span></div>';
    return;
  }

  let t0 = Infinity, t1 = -Infinity;
  for (const id of ids) for (const row of tl[id]) {
    const ts = Date.parse(row.at);
    if (ts < t0) t0 = ts;
    if (ts > t1) t1 = ts;
  }
  const rangeEnd = Math.max(t1, Date.now() - 60000);
  const span = Math.max(rangeEnd - t0, 60_000);
  const pct = (ts) => ((ts - t0) / span) * 100;

  // 并发曲线：分桶统计同时在进行中的任务数
  const BUCKETS = 60;
  const conc = new Array(BUCKETS).fill(0);
  const segsById = {};
  for (const id of ids) {
    segsById[id] = segmentsOf(tl[id], rangeEnd);
    for (const s of segsById[id]) {
      if (!ACTIVE_STATUS.has(s.status)) continue;   // 只有真正在跑的才算并发
      // 采样点判定，不用区间覆盖：floor/ceil 的桶边界会把相邻两段各多算一格，
      // 实测让峰值从 6 虚高到 7 —— 并发曲线是这张图的重点，不能有这种偏差。
      for (let i = 0; i < BUCKETS; i++) {
        const ts = t0 + ((i + 0.5) / BUCKETS) * span;
        if (ts >= s.start && ts < s.end) conc[i]++;
      }
    }
  }
  const peak = Math.max(...conc, 1);
  const critIdx = new Set(d.criticalPath || []);

  // 按泳道分组
  const lanes = (d.lanes && d.lanes.length) ? d.lanes
    : [{ lane: '(未分配)', tasks: ids }];

  const fmtDur = (ms) => {
    const h = ms / 3600000;
    return h >= 1 ? h.toFixed(1) + 'h' : Math.round(ms / 60000) + 'm';
  };

  // 时间轴刻度
  let ticks = '';
  for (let i = 0; i <= 6; i++) {
    const ts = t0 + (span * i) / 6;
    const dt = new Date(ts);
    ticks += '<span style="left:' + (i / 6 * 100) + '%">'
      + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + '</span>';
  }
  let grid = '';
  for (let i = 1; i < 6; i++) grid += '<div class="grid" style="left:' + (i / 6 * 100) + '%"></div>';

  let concBars = '';
  for (let i = 0; i < BUCKETS; i++) {
    if (conc[i] === 0) continue;
    const w = 100 / BUCKETS;
    concBars += '<div class="cbar" style="left:' + (i * w) + '%;width:' + w + '%;height:'
      + (conc[i] / peak * 85) + '%"></div>';
  }

  let rows = '';
  for (const lane of lanes) {
    const laneTasks = lane.tasks.filter(id => tl[id] && tl[id].length);
    if (laneTasks.length === 0) continue;
    for (const id of laneTasks) {
      const t = d.nodes[id] || { id, subject: id, status: 'pending' };
      let segsHtml = '';
      for (const s of segsById[id]) {
        const left = pct(s.start), right = pct(s.end);
        const w = Math.max(right - left, 0.35);
        const isFix = s.status === 'needs_fix' || s.status === 'review';
        segsHtml += '<div class="seg' + (isFix ? ' fix' : '') + '" style="left:' + left + '%;width:' + w
          + '%;background:' + (STATUS_COLOR[s.status] || 'var(--faint)') + '" title="'
          + escapeHtml((STATUS_TEXT[s.status] || s.status)) + '"></div>';
      }
      const segs = segsById[id];
      const first = segs[0], last = segs[segs.length - 1];
      const dur = (first && last) ? (last.end - first.start) : 0;
      const critLine = critIdx.has(id) ? '<div class="crit" style="left:' + pct(first ? first.start : t0) + '%"></div>' : '';
      rows += '<div class="lane"><div class="ln">' + escapeHtml(lane.lane) + ' <b>' + id + '</b></div>'
        + '<div class="track">' + grid + segsHtml + critLine
        + (dur ? '<span class="dur">' + fmtDur(dur) + '</span>' : '') + '</div></div>';
    }
  }

  stage.innerHTML = '<div class="tl">'
    + '<div class="conc"><span class="clab">并发（峰值 ' + peak + '）</span>'
    + '<div class="climit" style="bottom:' + (1 / peak * 100) + '%"></div>' + concBars + '</div>'
    + '<div class="axis">' + ticks + '</div>'
    + rows
    + '</div>'
    + '<div class="csum">'
    + '<span>跨度 <b>' + fmtDur(span) + '</b></span>'
    + '<span>并发峰值 <b>' + peak + '</b></span>'
    + '<span>任务 <b>' + ids.length + '</b></span>'
    + '</div>'
    + '<div class="cmsgs">横条按状态着色，斜纹段是待验收/需整改 —— 返工成本一眼可见。</div>';
}

function setView(v) {
  VIEW = v;
  const a = document.getElementById('v-dag'), b = document.getElementById('v-tl');
  if (a && a.classList) { if (v === 'dag') a.classList.add('on'); else a.classList.remove('on'); }
  if (b && b.classList) { if (v === 'tl') b.classList.add('on'); else b.classList.remove('on'); }
  render();
}

function render() {
  document.body.classList.toggle('compact', isCompact());
  if (!DATA) return;
  if (isCompact()) { if (VIEW === 'timeline') return renderTimeline(DATA); return renderCompact(DATA); }
  if (VIEW === 'timeline') return renderTimeline(DATA);
  const stage = document.getElementById('stage');
  const d = DATA;
  if (!d.layers || d.layers.length === 0) {
    stage.innerHTML = '<div class="empty">任务板上还没有任务。让 Lead 用 team_task_create 建任务后这里就会出现依赖图。</div>';
    renderKpis(d); return;
  }

  const maxWidth = Math.max(...d.layers.map(l => l.tasks.length));
  const width = Math.max(720, BAND_PAD_X * 2 + maxWidth * NODE_W + Math.max(0, maxWidth - 1) * ROW_GAP);
  stage.style.width = width + 'px';

  // ── 第 1 遍：只算位置 ──
  // 拆成两遍是因为关键路径的竖直对齐需要"所有层的位置都已经确定"才能做。
  const pos = {};
  const bandTops = [];
  let y = 0;
  d.layers.forEach((layer, li) => {
    const n = layer.tasks.length;
    const bandH = BAND_PAD_TOP + NODE_H + BAND_PAD_BOTTOM;
    bandTops.push({ top: y, bandH, n });
    const step = n > 1 ? (width - BAND_PAD_X * 2 - NODE_W) / (n - 1) : 0;
    layer.tasks.forEach((id, i) => {
      const x = n === 1 ? (width - NODE_W) / 2 : BAND_PAD_X + i * step;
      pos[id] = { x: x, cx: x + NODE_W / 2, top: y + BAND_PAD_TOP, bottom: y + BAND_PAD_TOP + NODE_H };
    });
    y += bandH;
    const band = d.bands[li];
    if (band && li < d.layers.length - 1) y += BAND_GAP_H;
  });

  // ── 第 2 遍：关键路径竖直对齐 ──
  // 单节点层默认居中，而多节点层从左排，于是"层0 的 T0 居中、层1 的 T1 在最左"——
  // 红线必须先拐一个大弯。把单节点层贴到关键父节点正下方，脊椎就成一条直线。
  const clampX = (x) => Math.min(Math.max(x, BAND_PAD_X), Math.max(BAND_PAD_X, width - NODE_W - BAND_PAD_X));
  for (let li = 1; li < d.layers.length; li++) {
    const row = d.layers[li];
    if (row.tasks.length !== 1) continue;
    const id = row.tasks[0];
    const ci = d.criticalPath.indexOf(id);
    if (ci <= 0) continue;
    const parent = pos[d.criticalPath[ci - 1]];
    if (!parent) continue;
    const nx = clampX(parent.cx - NODE_W / 2);
    pos[id].x = nx;
    pos[id].cx = nx + NODE_W / 2;
  }
  // 首层也要对齐：它是单节点、且在关键路径上时，把它挪到关键子节点正上方。
  // 漏掉这一步，脊椎会在最上面拐一下（实测 T0 居中 597、T1 在 1087，差 490px）。
  if (d.layers.length > 1 && d.layers[0].tasks.length === 1) {
    const head = d.layers[0].tasks[0];
    if (d.criticalPath[0] === head && d.criticalPath.length > 1) {
      const child = pos[d.criticalPath[1]];
      if (child) {
        const nx = clampX(child.cx - NODE_W / 2);
        pos[head].x = nx;
        pos[head].cx = nx + NODE_W / 2;
      }
    }
  }

  // ── 第 3 遍：出图 ──
  let html = '', svg = '';
  y = 0;
  d.layers.forEach((layer, li) => {
    const n = layer.tasks.length;
    const bandH = bandTops[li].bandH;
    html += '<div class="band" style="height:' + bandH + 'px">'
      + '<div class="bandlabel">层 ' + layer.layer + ' · <b>' + n + ' 并行</b></div>';
    layer.tasks.forEach((id) => {
      const t = d.nodes[id];
      const pt = pos[id];
      if (!t || !pt) return;
      const crit = d.criticalPath.indexOf(id) >= 0;
      // top 用 BAND_PAD_TOP（相对层带），不是绝对 y —— 层带是 position:relative，
      // 再叠绝对 y 会把节点推出带外（这个 bug 实测让层 1 之后的节点全部不可见）。
      html += '<div class="node' + (crit ? ' onCritical' : '') + '" data-id="' + id + '" style="left:' + pt.x
        + 'px;top:' + BAND_PAD_TOP + 'px;width:' + NODE_W + 'px;height:' + NODE_H + 'px">'
        + '<span class="bar" style="background:' + laneColor(t.owner) + '"></span>'
        + '<div class="id">' + id + (crit ? '<em>关键</em>' : '') + '</div>'
        + '<div class="sub" title="' + escapeHtml(t.subject) + '">' + escapeHtml(t.subject) + '</div>'
        + '<div class="meta"><span style="color:' + STATUS_COLOR[t.status] + '">'
        + (STATUS_TEXT[t.status] || t.status) + '</span>'
        + (t.owner ? '<span>' + escapeHtml(t.owner) + '</span>' : '<span>未分配</span>')
        + '<span>r' + (t.revision ?? '-') + '</span></div>'
        + '</div>';
    });
    html += '</div>';
    y += bandH;
    const band = d.bands[li];
    if (band && li < d.layers.length - 1) {
      const hot = band.crossing > 0;
      html += '<div class="gap" style="height:' + BAND_GAP_H + 'px"><div class="gaptext'
        + (hot ? ' hot' : '') + '">' + band.crossing + ' 条边过带 · ' + band.waiting + ' 个任务在等</div></div>';
      y += BAND_GAP_H;
    }
  });

  // ── 画边：用平滑贝塞尔，扇形汇聚比正交折线好读得多 ──
  const edgePath = (a, b) => {
    const dy = Math.max(b.top - a.bottom, 8);
    const c = dy * 0.55;
    return 'M' + a.cx + ' ' + a.bottom
      + ' C' + a.cx + ' ' + (a.bottom + c) + ' ' + b.cx + ' ' + (b.top - c) + ' ' + b.cx + ' ' + b.top;
  };
  const arrowPath = (b) =>
    'M' + (b.cx - 4.5) + ' ' + (b.top - 8) + ' L' + b.cx + ' ' + b.top + ' L' + (b.cx + 4.5) + ' ' + (b.top - 8);

  const drawEdges = (list, dashed, color, opacity) => {
    list.forEach(e => {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      const attrs = 'class="edge" data-from="' + e.from + '" data-to="' + e.to + '"';
      svg += '<path ' + attrs + ' d="' + edgePath(a, b) + '" fill="none" stroke="' + color
        + '" stroke-width="' + (dashed ? 1.2 : 1.3) + '"'
        + (dashed ? ' stroke-dasharray="4 5"' : '') + ' opacity="' + opacity + '"></path>';
      svg += '<path ' + attrs + ' d="' + arrowPath(b) + '" fill="' + color + '" opacity="' + opacity + '"></path>';
    });
  };
  // 同泳道虚线画在底层、更淡，避免和真依赖抢注意力
  drawEdges(d.laneEdges || [], true, 'var(--lane)', 0.35);
  drawEdges(d.edges || [], false, 'var(--edge)', 0.7);

  // 关键路径脊椎画在最上层，最粗最亮
  if (d.criticalPath && d.criticalPath.length > 1) {
    for (let i = 0; i + 1 < d.criticalPath.length; i++) {
      const a = pos[d.criticalPath[i]], b = pos[d.criticalPath[i + 1]];
      if (!a || !b) continue;
      svg += '<path d="' + edgePath(a, b) + '" fill="none" stroke="var(--critical)" stroke-width="3.2" '
        + 'opacity="0.9" stroke-linecap="round"></path>';
      svg += '<path d="' + arrowPath(b) + '" fill="var(--critical)" opacity="0.9" transform="scale(1)"></path>';
    }
  }

  stage.innerHTML = html + '<svg width="' + width + '" height="' + y + '">' + svg + '</svg>';
  wireHover();
  renderKpis(d);
}

function wireHover() {
  const nodes = [...document.querySelectorAll('.node')];
  const edges = [...document.querySelectorAll('.edge')];
  nodes.forEach(n => {
    n.addEventListener('mouseenter', () => {
      const id = n.dataset.id;
      const down = new Set(DATA.downstream[id] || []);
      down.add(id);
      nodes.forEach(o => {
        o.classList.toggle('dimmed', !down.has(o.dataset.id));
        o.classList.toggle('hl', o.dataset.id === id);
      });
      edges.forEach(e => {
        const on = down.has(e.dataset.from) && down.has(e.dataset.to);
        e.style.opacity = on ? '1' : '0.05';
      });
      const t = DATA.nodes[id];
      showBlast(t, down.size - 1);
    });
    n.addEventListener('mouseleave', () => {
      nodes.forEach(o => o.classList.remove('dimmed', 'hl'));
      edges.forEach(e => { e.style.opacity = ''; });
      hideBlast();
    });
  });
}

let blastEl = null;
function showBlast(t, count) {
  hideBlast();
  blastEl = document.createElement('div');
  blastEl.className = 'stale';
  blastEl.style.cssText = 'position:fixed;right:16px;bottom:16px;background:var(--panel);border:1px solid var(--line);'
    + 'border-radius:8px;padding:10px 12px;font-size:12px;max-width:320px;z-index:9';
  blastEl.innerHTML = '<b>' + t.id + '</b> ' + escapeHtml(t.subject)
    + '<br><span style="color:var(--dim)">卡住会拖累 ' + count + ' 个下游任务</span>'
    + (t.writeScopes && t.writeScopes.length ? '<br><span style="color:var(--faint)">写范围: '
      + t.writeScopes.map(escapeHtml).join(', ') + '</span>' : '');
  document.body.appendChild(blastEl);
}
function hideBlast() { if (blastEl) { blastEl.remove(); blastEl = null; } }

function renderKpis(d) {
  const s = d.summary || {};
  const el = document.getElementById('kpis');
  el.innerHTML =
    kpi(s.completed + '/' + s.total, '完成', '') +
    kpi(s.criticalRemaining + ' 层', '关键路径还剩', s.criticalRemaining > 0 ? 'crit' : '') +
    kpi(s.layers + ' 层 / 最宽 ' + s.maxWidth, '结构', '') +
    kpi(String(s.blocked || 0), '被阻塞', (s.blocked || 0) > 0 ? 'warn' : '');
}
function kpi(v, label, cls) {
  return '<span class="kpi ' + cls + '"><b>' + v + '</b><span>' + label + '</span></span>';
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function load() {
  try {
    const q = location.search || '';
    const r = await fetch('/pdev/board/data' + q, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    DATA = await r.json();
    if (DATA.error) throw new Error(DATA.error);
    document.getElementById('stale').textContent = '更新于 ' + new Date().toLocaleTimeString();
    render();
  } catch (e) {
    document.getElementById('stage').innerHTML = '<div class="err">读取任务板失败：' + escapeHtml(e.message)
      + '<br><span style="color:var(--dim)">如果提示 403，说明请求没过同源栅栏。</span></div>';
  }
}
// 嵌入模式：由侧栏 iframe 用 ?embed=1 打开
const EMBED = new URLSearchParams(location.search).get('embed') === '1';
if (EMBED) document.body.classList.add('embed');

/**
 * 主题。
 *
 * 优先级：URL 的 ?theme=（侧栏会把宿主当前主题传进来）> 本地记忆 > 跟随系统。
 * 数据属性不加 = 跟随系统（CSS 的媒体查询接管），加了 light/dark 就是显式选择。
 *
 * 嵌入模式下**隐藏切换按钮**：那时候主题归宿主管，页面里再放一个开关只会打架。
 */
const THEME_KEY = 'pdev-board-theme';
function resolveTheme() {
  const fromUrl = new URLSearchParams(location.search).get('theme');
  if (fromUrl === 'light' || fromUrl === 'dark') return fromUrl;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch (e) { /* 隐私模式读不到，忽略 */ }
  return 'auto';
}
let THEME = resolveTheme();
function applyTheme() {
  if (THEME === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = THEME;
  const btn = document.getElementById('theme');
  if (btn) {
    const darkNow = THEME === 'dark'
      || (THEME === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    btn.textContent = darkNow ? '☀' : '☾';
  }
}
applyTheme();

document.getElementById('refresh').addEventListener('click', load);
document.getElementById('theme').addEventListener('click', () => {
  // 从"当前看起来是什么"出发，切到对面
  const darkNow = document.documentElement.dataset.theme === 'dark'
    || (THEME === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  THEME = darkNow ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, THEME); } catch (e) { /* 忽略 */ }
  applyTheme();
  render();
});
if (EMBED) { const tb = document.getElementById('theme'); if (tb) tb.style.display = 'none'; }
document.getElementById('v-dag').addEventListener('click', () => setView('dag'));
document.getElementById('v-tl').addEventListener('click', () => setView('timeline'));
load();
setInterval(load, 5000);
let _lastCompact = isCompact();
window.addEventListener('resize', () => {
  const now = isCompact();
  if (now !== _lastCompact) { _lastCompact = now; render(); }
});
</script>
</body>
</html>`;
