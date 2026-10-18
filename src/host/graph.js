/**
 * 看板的图计算层 —— 纯函数，不碰 ctx。
 *
 * 设计文档第四节说清楚了：DAG 的"效果"是四件事，看板必须把它们画出来：
 *   1. 并行宽度（每层有多少个能同时跑）—— 拆解质量
 *   2. 关键路径（最长依赖链）—— 总工期下限
 *   3. 阻塞半径（一个节点卡住拖累谁）—— 排错时先救谁
 *   4. 收敛结构（多个上游汇到一个下游）—— 集成风险点在哪
 *
 * 还有一条普通 DAG 不画、但真实存在的约束：**同泳道排队**。
 * 两个任务逻辑上无依赖，却因为共用同一个 agent/worktree 而不能同时跑。
 * 不画出来就会误判并行度，所以这里单独算一组虚线边。
 */

/** 状态排序权重，用于同层内稳定展示。 */
const STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2, deleted: 3 };

function statusOf(t) {
  return String(t?.status ?? "pending");
}

/**
 * 分层：层号 = 1 + max(所有前置的层号)，无前置为 0。
 * 用迭代而不是递归，防止脏数据形成环时栈溢出。
 */
function computeLayers(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layer = new Map();
  let remaining = tasks.map((t) => t.id);
  let guard = 0;
  while (remaining.length > 0 && guard++ < tasks.length + 2) {
    const next = [];
    for (const id of remaining) {
      const t = byId.get(id);
      const deps = (t?.blockedBy ?? []).filter((d) => byId.has(d));
      const unresolved = deps.filter((d) => !layer.has(d));
      if (unresolved.length > 0) {
        next.push(id);
        continue;
      }
      layer.set(id, deps.length === 0 ? 0 : Math.max(...deps.map((d) => layer.get(d))) + 1);
    }
    remaining = next;
  }
  // 环里的节点永远解不开：兜底放到最后一层，并标出来
  const cyclic = [...remaining];
  const maxLayer = layer.size > 0 ? Math.max(...layer.values()) : -1;
  for (const id of cyclic) layer.set(id, maxLayer + 1);
  return { layer, cyclic };
}

/** 分组：按层号 -> 该层的任务 id（层内按状态、再按 id 排序） */
function groupByLayer(tasks, layer) {
  const buckets = new Map();
  for (const t of tasks) {
    const l = layer.get(t.id) ?? 0;
    if (!buckets.has(l)) buckets.set(l, []);
    buckets.get(l).push(t);
  }
  const layers = [...buckets.keys()].sort((a, b) => a - b);
  return layers.map((l) => ({
    layer: l,
    tasks: buckets
      .get(l)
      .sort((a, b) => (STATUS_ORDER[statusOf(a)] ?? 9) - (STATUS_ORDER[statusOf(b)] ?? 9)
        || String(a.id).localeCompare(String(b.id))),
  }));
}

/** 真依赖边 */
function computeEdges(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const edges = [];
  for (const t of tasks) {
    for (const d of t.blockedBy ?? []) {
      if (ids.has(d)) edges.push({ from: d, to: t.id, kind: "dep" });
    }
  }
  return edges;
}

/**
 * 同泳道排队边：同一个 owner（= 同一个 agent / worktree）上的任务必须串行。
 * 按层号排序后相邻两个之间连一条虚线 —— 这条边不是依赖，是**排期约束**。
 */
function computeLaneEdges(tasks, layer) {
  const lanes = new Map();
  for (const t of tasks) {
    const lane = t.ownerName ?? "(未分配)";
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(t);
  }
  const edges = [];
  const laneInfo = [];
  for (const [lane, list] of lanes) {
    const sorted = [...list].sort((a, b) => (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0)
      || String(a.id).localeCompare(String(b.id)));
    laneInfo.push({ lane, tasks: sorted.map((t) => t.id), count: sorted.length });
    for (let i = 0; i + 1 < sorted.length; i++) {
      edges.push({ from: sorted[i].id, to: sorted[i + 1].id, kind: "lane", lane });
    }
  }
  laneInfo.sort((a, b) => a.lane.localeCompare(b.lane));
  return { laneEdges: edges, lanes: laneInfo };
}

/**
 * 层内排序：重心法（分层图布局的经典一步）。
 *
 * 为什么需要它（实测看出来的）：只按状态排序会让**关键路径在层间来回横跳** ——
 * 父节点在最右、子节点在最左，红线要绕一大圈才接上，读者会以为连错了。
 * 按"父节点在本层中的平均位置"排序能大幅减少连边交叉，关键路径也顺下来了。
 */
function orderWithinLayers(layerRows, edges) {
  const pos = new Map();                       // taskId -> 在所在层里的序号
  const parents = new Map();
  for (const e of edges) {
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to).push(e.from);
  }
  const children = new Map();
  for (const e of edges) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from).push(e.to);
  }

  /** 按给定"参考位置"重排一层；拿不到参考位置的保持原序垫后。 */
  const sortBy = (row, refs) => {
    const keyed = row.tasks.map((t, i) => {
      const rs = (refs.get(t.id) ?? []).filter((d) => pos.has(d)).map((d) => pos.get(d));
      return { t, i, bary: rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : null };
    });
    keyed.sort((a, b) => {
      if (a.bary === null && b.bary === null) return a.i - b.i;
      if (a.bary === null) return 1;
      if (b.bary === null) return -1;
      return a.bary - b.bary;
    });
    row.tasks = keyed.map((k) => k.t);
    row.tasks.forEach((task, i) => pos.set(task.id, i));
  };

  // 第一层按 id 稳定排序
  if (layerRows.length > 0) {
    layerRows[0].tasks.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    layerRows[0].tasks.forEach((task, i) => pos.set(task.id, i));
  }
  // 向下扫（看父节点）+ 向上扫（看子节点）：只扫一遍遇到"所有节点共享同一个父"就退化成原序，
  // 反向那一遍能把真正的相对位置拉开。各两轮让它收敛。
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i < layerRows.length; i++) sortBy(layerRows[i], parents);
    for (let i = layerRows.length - 2; i >= 0; i--) sortBy(layerRows[i], children);
  }
  return layerRows;
}

/**
 * 关键路径对齐：把关键路径上的节点挪到"紧挨它关键父节点"的位置。
 *
 * 为什么单独做这一步：重心法遇到"第一层只有一个节点"这种很常见的情况就失效了
 * （所有子节点重心相同），于是层内顺序退回原序，关键路径在层间来回横跳，
 * 红线绕一大圈，看起来像连错了。把脊椎拉直，读者一眼就能顺着它往下读。
 */
function alignCriticalPath(layerRows, criticalPath) {
  if (!criticalPath || criticalPath.length < 2) return layerRows;
  const rowOf = new Map();
  layerRows.forEach((row, li) => row.tasks.forEach((t) => rowOf.set(t.id, li)));
  for (let i = 1; i < criticalPath.length; i++) {
    const childId = criticalPath[i], parentId = criticalPath[i - 1];
    const ci = rowOf.get(childId), pi = rowOf.get(parentId);
    if (ci === undefined || pi === undefined || ci !== pi + 1) continue;
    const row = layerRows[ci];
    const at = row.tasks.findIndex((t) => t.id === childId);
    if (at < 0) continue;
    const want = Math.min(layerRows[pi].tasks.findIndex((t) => t.id === parentId), row.tasks.length - 1);
    if (want < 0 || want === at) continue;
    const [node] = row.tasks.splice(at, 1);
    row.tasks.splice(want, 0, node);
  }
  return layerRows;
}

/**
 * 关键路径：从最深的节点回溯，每步选层号最大的前置。
 * 总工期由它决定 —— 想缩短工期只能缩短它，加 agent 没用。
 */
function computeCriticalPath(tasks, layer) {
  if (tasks.length === 0) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let deepest = tasks[0].id;
  for (const t of tasks) {
    if ((layer.get(t.id) ?? 0) > (layer.get(deepest) ?? 0)) deepest = t.id;
  }
  const path = [];
  let cur = deepest;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    const t = byId.get(cur);
    const deps = (t?.blockedBy ?? []).filter((d) => byId.has(d));
    if (deps.length === 0) break;
    cur = deps.reduce((best, d) => ((layer.get(d) ?? 0) > (layer.get(best) ?? 0) ? d : best), deps[0]);
  }
  return path.reverse();
}

/** 阻塞半径：该节点的全部下游。悬停时高亮它，回答"这个卡住会拖累谁"。 */
function computeDownstream(tasks) {
  const children = new Map();
  for (const t of tasks) children.set(t.id, []);
  for (const t of tasks) {
    for (const d of t.blockedBy ?? []) {
      if (children.has(d)) children.get(d).push(t.id);
    }
  }
  const out = {};
  for (const t of tasks) {
    const seen = new Set();
    const stack = [...(children.get(t.id) ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    out[t.id] = [...seen];
  }
  return out;
}

/**
 * 等待带：相邻两层之间跨过多少条依赖边。
 * 过带边越多说明耦合越重 —— 这层卡住，影响面越大。这是"耦合度指标"。
 */
function computeBands(layerRows, edges) {
  const bands = [];
  for (let i = 0; i + 1 < layerRows.length; i++) {
    const upper = new Set(layerRows.slice(0, i + 1).flatMap((r) => r.tasks.map((t) => t.id)));
    const lower = new Set(layerRows.slice(i + 1).flatMap((r) => r.tasks.map((t) => t.id)));
    const crossing = edges.filter((e) => upper.has(e.from) && lower.has(e.to));
    bands.push({
      afterLayer: layerRows[i].layer,
      crossing: crossing.length,
      waiting: [...lower].length,
      edges: crossing.map((e) => `${e.from}→${e.to}`),
    });
  }
  return bands;
}

/** 汇总统计：给顶栏用。关键路径进度比完成计数更能说明"还剩多远"。 */
function computeSummary(tasks, layerRows, criticalPath) {
  const counts = { pending: 0, in_progress: 0, completed: 0, deleted: 0 };
  for (const t of tasks) counts[statusOf(t)] = (counts[statusOf(t)] ?? 0) + 1;
  const alive = tasks.filter((t) => statusOf(t) !== "deleted");
  const doneCritical = criticalPath.filter((id) => {
    const t = tasks.find((x) => x.id === id);
    return t && statusOf(t) === "completed";
  }).length;
  return {
    total: alive.length,
    counts,
    completed: counts.completed,
    // 还没做完的任务数（含 pending / in_progress / review / needs_fix）。
    // 单独给出来是因为消费方要判断"这轮并行开发结束了没有" —— 全部完成就不该再打扰用户。
    unfinished: alive.length - counts.completed,
    layers: layerRows.length,
    maxWidth: layerRows.reduce((m, r) => Math.max(m, r.tasks.length), 0),
    criticalPathLength: criticalPath.length,
    criticalRemaining: criticalPath.length - doneCritical,
    criticalDone: doneCritical,
    blocked: alive.filter((t) => statusOf(t) === "pending"
      && (t.blockedBy ?? []).some((d) => {
        const dep = tasks.find((x) => x.id === d);
        return dep && statusOf(dep) !== "completed";
      })).length,
  };
}

/**
 * 入口：把平台的任务视图转成看板需要的全部数据。
 * @param tasks 平台的 TeamTaskView 数组
 */
export function buildGraph(tasks) {
  const alive = (tasks ?? []).filter((t) => statusOf(t) !== "deleted");
  const { layer, cyclic } = computeLayers(alive);
  const edges = computeEdges(alive);
  let layerRows = orderWithinLayers(groupByLayer(alive, layer), edges);
  const criticalPath = computeCriticalPath(alive, layer);
  layerRows = alignCriticalPath(layerRows, criticalPath);
  const { laneEdges, lanes } = computeLaneEdges(alive, layer);
  return {
    summary: computeSummary(alive, layerRows, criticalPath),
    layers: layerRows.map((r) => ({ layer: r.layer, tasks: r.tasks.map((t) => t.id) })),
    nodes: Object.fromEntries(alive.map((t) => [t.id, {
      id: t.id,
      subject: t.subject ?? "(无标题)",
      status: statusOf(t),
      owner: t.ownerName ?? null,
      revision: t.revision ?? null,
      writeScopes: t.writeScopes ?? [],
      blockedBy: t.blockedBy ?? [],
      layer: layer.get(t.id) ?? 0,
    }])),
    edges,
    laneEdges,
    lanes,
    criticalPath,
    bands: computeBands(layerRows, edges),
    downstream: computeDownstream(alive),
    cyclic,
  };
}
