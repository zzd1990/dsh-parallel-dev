/**
 * dsh-parallel-dev — host half.
 *
 * v0.1：把「验收通过」从模型的声称，变成一个**能被机器校验、且能被强制**的状态。
 *
 * 设计要点（v0.0 探针与源码调研之后修正过的版本）：
 *
 * 1. **不重造任务板。** 平台已提供 `team_task_create/list/get/update`，并且已经强制了
 *    状态机（pending → in_progress → completed）、依赖就绪检查、revision CAS。
 *    本插件只补平台没做的那一件事。
 *
 * 2. **平台没做的那件事：`complete` 不需要任何验收。** 任何 teammate 都能把自己的任务
 *    标成 completed，没有任何独立证据。这正是"实施/验收分离"在机制上的漏洞。
 *
 * 3. **用 `tools/pre-execute` 钩子把洞堵上。** 这是官方文档指定的策略扩展点
 *    （docs/cookbook/extension-cookbook.zh.md「钩子插件」）：
 *      ctx.on('tools/pre-execute', async (exec, next) => ({kind:'deny',reason}) | next())
 *    拦截 `team_task_update` 的 `complete` 动作，没有验收记录就**拒绝**。
 *    这不是"更强的建议"，是调用会被真的挡下来。
 *
 * 4. **验收记录绑 commit sha。** 记录里存 sha 与 worktree；完成任务时若 worktree 的
 *    HEAD 已经变了，说明验收后代码又被改过 —— 一样拒绝。
 *
 * 记录落盘在 `<项目根>/.pdev/verify/<task_id>.json`：可读、可 diff、可进版本库、跨会话存活。
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildGraph } from "./graph.js";
import { BOARD_HTML } from "./board-page.js";
import { PDEV_POLICY_NAME, PDEV_POLICY_ORDER, PDEV_POLICY_TEXT } from "./policy.js";

export const name = "dsh-parallel-dev";

// 硬依赖：工具注册表（钩子与工具都挂在它上面）。
// webServer 是可选依赖，按 cordis 教程用 ctx.get() 在使用处探测，不 inject。
export const inject = ["tools"];

/** 供单测：时间线的读回与合并。运行时走 HTTP 端点，导出只为可验证"重启后能恢复历史"。 */
export { readTimeline, mergedTimeline, currentTeamTasks };

/**
 * 本进程观察到的用户消息，按会话 id 缓存。
 *
 * 用途只有一个：**核对豁免请求里引用的"用户原话"是不是真的说过。**
 * 没有这层核对，任何模型都能声称"用户同意了"来绕过门禁，豁免机制就等于没有。
 */
const userMessages = new Map(); // sessionId -> [{ text, at, seq }]
const MAX_KEPT_PER_SESSION = 80;

/**
 * 任务状态变更时间线，按任务 id 缓存。
 *
 * 为什么现在就要存：平台的 `TeamTaskView` 只有 `revision` 和 `status`，
 * **没有状态变更时刻**。时间轴（v0.3 的视图 B）需要开始/结束时间，
 * 而这些时间点一旦错过就永远补不回来 —— 后期补时间戳等于数据丢失。
 * 所以从 v0.2 起就订阅 `team/task` 事件，把每次变更的时刻记下来。
 */
const taskTimeline = new Map(); // taskId -> [{ at, status, revision, subject, owner }]
const MAX_TIMELINE_PER_TASK = 60;

/** 插件加载期间记录的事实，供 preflight 汇报。 */
const boot = {
  version: "0.1.0",
  loadedAt: null,
  gateInstalled: false,
  boardRoute: "not attempted",
  policySection: "not attempted",
  toolRegistration: [],
};

/** 平台里代表"团队模式可用"的工具名。少任何一个，团队模式就跑不起来。 */
const TEAM_TOOLS = [
  "spawn_teammate",
  "send_message",
  "wait_agent",
  "list_agents",
  "team_task_create",
  "team_task_get",
  "team_task_list",
  "team_task_update",
];

function textRender(fn) {
  return (_args, value) => [{ type: "text", text: fn(value) }];
}

// ─────────────────────────────────────────────────────────────
// 基础设施
// ─────────────────────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, { ...opts, shell: false });
    } catch (err) {
      resolvePromise({ code: null, stdout: "", stderr: `spawn threw: ${err?.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, opts.timeoutMs ?? 15_000);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\nspawn error: ${err?.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * 取调用方会话的工作目录。
 *
 * v0.0 探针实测：`Session` 对象上没有 `cwd`（是 null）；真正的来源是
 * `session.header.cwd`（绝对路径，创建会话时确定）。
 * 注意不能信 `DSH_*` 环境变量 —— headless 下那些是从用户正在跑的桌面应用继承的。
 */
function sessionCwd(exec) {
  const session = exec?.agent?.session;
  const fromHeader = session?.header?.cwd;
  if (typeof fromHeader === "string" && isAbsolute(fromHeader)) return fromHeader;
  const folded = session?.headerFold?.cwd;
  if (typeof folded === "string" && isAbsolute(folded)) return folded;
  return null;
}

function pdevDir(projectRoot) {
  return join(projectRoot, ".pdev");
}
function verifyDir(projectRoot) {
  return join(pdevDir(projectRoot), "verify");
}

/**
 * 团队身份 —— 用来隔离验收记录。
 *
 * 为什么必须有它（v0.1 实测踩出来的真实缺陷）：任务 id 是**每个会话重新计数**的，
 * 都从 `task-1` 开始。而验收记录落在项目目录的磁盘上，跨会话存活。
 * 只按 task_id 命名的话，上一轮会话给 `task-1` 写的记录，会把这一轮**另一个** task-1
 * 放行 —— 门禁看起来在工作，实际放过的是一份毫不相干的旧记录。
 *
 * 团队身份取「成员列表里的 Lead id」：实施方与验收方看到的是同一份成员列表，
 * 所以两边算出来的 key 一致；单 Agent（无团队）时退回自己的会话 id。
 */
function teamKey(ctx, exec) {
  try {
    const teams = ctx.get("agentTeams");
    const members = teams?.listMembers?.(exec?.agent) ?? [];
    const lead = members.find((m) => m?.target === "lead" || m?.name === "lead");
    if (lead?.id) return `team-${lead.id}`;
  } catch { /* 退回会话 id */ }
  return `session-${exec?.agent?.session?.id ?? "unknown"}`;
}

function verifyPath(projectRoot, key, taskId) {
  return join(verifyDir(projectRoot), `${key}__${taskId}.json`);
}

function waiverPath(projectRoot, key, taskId) {
  return join(verifyDir(projectRoot), `${key}__${taskId}.waiver.json`);
}

async function readWaiver(projectRoot, key, taskId) {
  try {
    return JSON.parse(await readFile(waiverPath(projectRoot, key, taskId), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 从会话事件里抽出可读文本。
 * user/message 的 data 有两种形状（纯 text，或带 message 包装），都要认。
 */
function eventText(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data.text === "string") return data.text;
  const m = data.message;
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    if (typeof m.text === "string") return m.text;
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    }
  }
  if (Array.isArray(data.content)) {
    return data.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  }
  return "";
}

/** 用户原话里必须出现其中之一，才算"明确授权跳过验收"。 */
const WAIVER_KEYWORDS = [
  "豁免", "免验收", "不用验收", "不需要验收", "跳过验收", "免检", "不用检查",
  "waive", "waiver", "skip verification", "skip the verification", "no verification",
];

function hasWaiverIntent(text) {
  const lower = String(text ?? "").toLowerCase();
  return WAIVER_KEYWORDS.find((k) => lower.includes(k.toLowerCase())) ?? null;
}

/** 归一化：折叠空白，便于做人话级别的子串比对。 */
function normalize(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** 解析项目根：显式参数优先，其次会话 cwd。 */
function resolveProjectRoot(explicit, exec) {
  if (typeof explicit === "string" && explicit.trim()) {
    const p = explicit.trim();
    return { root: isAbsolute(p) ? p : resolve(sessionCwd(exec) ?? process.cwd(), p), source: "参数" };
  }
  const cwd = sessionCwd(exec);
  if (cwd) return { root: cwd, source: "session.header.cwd" };
  return { root: null, source: "缺失" };
}

async function readVerifyRecord(projectRoot, key, taskId) {
  try {
    const raw = await readFile(verifyPath(projectRoot, key, taskId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 列出该团队的验收记录（只看本团队，别的会话的旧记录不算数）。 */
/** 列出该团队的豁免记录。 */
async function listWaivers(projectRoot, key) {
  try {
    const names = await readdir(verifyDir(projectRoot));
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".waiver.json")) continue;
      if (key && !n.startsWith(`${key}__`)) continue;
      try { out.push(JSON.parse(await readFile(join(verifyDir(projectRoot), n), "utf8"))); } catch { /* 跳过坏文件 */ }
    }
    return out;
  } catch {
    return [];
  }
}

async function listVerifyRecords(projectRoot, key) {
  try {
    const names = await readdir(verifyDir(projectRoot));
    const out = [];
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      if (key && !n.startsWith(`${key}__`)) continue;
      try {
        out.push(JSON.parse(await readFile(join(verifyDir(projectRoot), n), "utf8")));
      } catch { /* 跳过坏文件 */ }
    }
    return out;
  } catch {
    return [];
  }
}

async function gitHead(dir) {
  if (!dir) return { sha: null, reason: "没有 worktree 路径" };
  const r = await run("git", ["rev-parse", "HEAD"], { cwd: dir });
  if (r.code !== 0) return { sha: null, reason: `git rev-parse 失败：${r.stderr || "未知"}` };
  return { sha: r.stdout, reason: null };
}

/**
 * 判断调用方是不是该任务的所有者 —— 也就是"自己验收自己"。
 *
 * 为什么必须查这个：「实施和验收必须是不同的人」是整套流程的核心价值。
 * 如果实施方能自己写验收记录，门禁就从"独立核对"退化成"点两下按钮"，
 * 有门禁和没门禁就没区别了。
 *
 * 判定链：任务板上的 ownerName ↔ 调用方所属成员的 target。
 * 任何一环拿不到就如实记为"未能判定"，不要假装通过了检查。
 */
async function checkSelfCertification(ctx, exec, taskId) {
  const out = { checked: false, selfCertified: false, ownerName: null, callerTarget: null, note: null };
  let teams;
  try { teams = ctx.get("agentTeams"); } catch { teams = undefined; }
  if (!teams?.getTask || !exec?.agent) {
    out.note = "拿不到 agentTeams 服务或调用方 agent，跳过自证检查";
    return out;
  }
  try {
    const task = teams.getTask(exec.agent, taskId);
    out.ownerName = task?.ownerName ?? null;
    const members = teams.listMembers?.(exec.agent) ?? [];
    const me = members.find((m) => m.id === exec.agent.id);
    out.callerTarget = me?.target ?? null;
    out.checked = true;
    if (!out.ownerName) out.note = "该任务当前没有 owner，无法判定自证";
    else if (!out.callerTarget) out.note = "拿不到调用方的成员标识，无法判定自证";
    else out.selfCertified = out.ownerName === out.callerTarget;
  } catch (err) {
    out.note = `自证检查失败：${err?.message}`;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 看板：任务读取与路由
// ─────────────────────────────────────────────────────────────

/** 演示数据：形状取自真实跑过的 16 任务案例（4 层、第一层 6 并行）。
 *  用途：任务板还空着时也能看到看板长什么样；也用于冒烟测试渲染。 */
const DEMO_TASKS = [
  { id:"T0", subject:"接口与数据契约",   status:"completed",   ownerName:"impl-contract", blockedBy:[],             writeScopes:["docs/","contracts/"], revision:3 },
  { id:"T1", subject:"存储层",           status:"completed",   ownerName:"impl-store",    blockedBy:["T0"],         writeScopes:["store/"],             revision:2 },
  { id:"T2", subject:"领域层",           status:"in_progress", ownerName:"impl-domain",   blockedBy:["T0"],         writeScopes:["domain/"],            revision:2 },
  { id:"T3", subject:"引擎适配层",       status:"in_progress", ownerName:"impl-engine",   blockedBy:["T0"],         writeScopes:["engine/"],            revision:2 },
  { id:"T4", subject:"前端基座",         status:"in_progress", ownerName:"impl-web-base", blockedBy:["T0"],         writeScopes:["web/"],               revision:2 },
  { id:"T5", subject:"两个模拟应用",     status:"pending",     ownerName:"impl-demo",     blockedBy:["T0"],         writeScopes:["demo-apps/"],         revision:1 },
  { id:"T6", subject:"部署件与 ops",     status:"pending",     ownerName:"impl-deploy",   blockedBy:["T0"],         writeScopes:["deploy/","ops/"],     revision:1 },
  { id:"T7", subject:"API 层",           status:"pending",     ownerName:"impl-store",    blockedBy:["T1","T2"],    writeScopes:["api/"],               revision:1 },
  { id:"T8", subject:"执行器与看门狗",   status:"pending",     ownerName:"impl-pipeline", blockedBy:["T7","T3"],    writeScopes:["worker/"],            revision:1 },
  { id:"T9", subject:"跨模块集成测试",   status:"pending",     ownerName:"impl-store",    blockedBy:["T7","T8"],    writeScopes:["tests/integration/"], revision:1 },
];

/**
 * 演示时间线：按真实跑过的那种节奏造一份（第一层 6 个并行、后面逐层收敛、中间若干次整改）。
 * 只用于演示模式，让时间轴不至于空白。
 */
function demoTimeline() {
  const t0 = Date.now() - 7 * 3600 * 1000;
  const H = (h) => new Date(t0 + h * 3600 * 1000).toISOString();
  const seq = (id, rows) => [id, rows.map(([at, status]) => ({ at, status, revision: null }))];
  return Object.fromEntries([
    seq("T0", [[H(0), "pending"], [H(0.2), "in_progress"], [H(0.9), "completed"]]),
    seq("T1", [[H(1.0), "in_progress"], [H(2.4), "completed"]]),
    seq("T2", [[H(1.0), "in_progress"], [H(2.8), "completed"]]),
    seq("T3", [[H(1.0), "in_progress"], [H(3.1), "needs_fix"], [H(4.0), "in_progress"], [H(4.6), "completed"]]),
    seq("T4", [[H(1.0), "in_progress"], [H(3.4), "completed"]]),
    seq("T5", [[H(1.1), "in_progress"], [H(2.2), "needs_fix"], [H(3.0), "in_progress"], [H(3.8), "completed"]]),
    seq("T6", [[H(1.1), "in_progress"], [H(2.6), "completed"]]),
    seq("T7", [[H(3.2), "in_progress"], [H(5.0), "completed"]]),
    seq("T8", [[H(5.1), "in_progress"], [H(6.2), "completed"]]),
    seq("T9", [[H(6.3), "in_progress"]]),
  ]);
}

// ─────────────────────────────────────────────────────────────
// 时间线落盘
// ─────────────────────────────────────────────────────────────

/**
 * 时间线落盘：append-only JSONL，放在 `<项目根>/.pdev/timeline.jsonl`。
 *
 * 为什么必须落盘（而不是只放内存）：平台的任务视图只有 revision 和 status，
 * **没有状态变更时刻**；而"什么时候开始、什么时候结束、整改了多久"这些时间点
 * 一旦错过就再也补不回来。内存版一重启就没了，等于白记。
 *
 * 用 append-only 是因为它崩溃安全：写到一半最多丢最后一行，不会毁掉整段历史。
 */
async function appendTimeline(root, entry) {
  if (!root) return;
  try {
    await mkdir(pdevDir(root), { recursive: true });
    await appendFile(timelinePath(root), JSON.stringify(entry) + "\n", "utf8");
  } catch (e) { console.error(`[dsh-parallel-dev] 时间线落盘失败（时间轴会缺这段历史）: ${e?.message}`); }
}

function timelinePath(root) {
  return join(pdevDir(root), "timeline.jsonl");
}

/** 读回历史，按任务分组并按时间排序。 */
async function readTimeline(root) {
  try {
    const raw = await readFile(timelinePath(root), "utf8");
    const out = {};
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!e?.task_id || !e?.at) continue;
        (out[e.task_id] ||= []).push(e);
      } catch { /* 跳过坏行 */ }
    }
    for (const k of Object.keys(out)) {
      out[k].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
    return out;
  } catch {
    return {};
  }
}

/** 内存 + 磁盘合并：磁盘是持久历史，内存有本进程最新的几条。 */
async function mergedTimeline(root) {
  const disk = root ? await readTimeline(root) : {};
  const merged = { ...disk };
  for (const [id, rows] of taskTimeline) {
    const seen = new Set((merged[id] ?? []).map((r) => `${r.at}|${r.status}|${r.revision ?? ""}`));
    const extra = rows.filter((r) => !seen.has(`${r.at}|${r.status}|${r.revision ?? ""}`));
    if (extra.length) {
      merged[id] = [...(merged[id] ?? []), ...extra]
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    }
  }
  return merged;
}

/**
 * 取当前团队的任务列表。
 *
 * HTTP 请求里没有"调用方 agent"，而 `agentTeams.listTasks(caller)` 需要 caller 是团队成员。
 * 所以枚举所有 agent，谁有团队就取谁的 —— 本地单人使用时命中的就是 Lead。
 */
/**
 * 取团队任务列表。
 *
 * `opts.sessionId` 决定看谁：
 *   - 给了会话 id → **只认这个会话的团队**。多个会话各开一个侧栏时必须各看各的，
 *     不能"谁先被遍历到就显示谁" —— 那会让两个会话看到同一块看板，而且顺序不保证稳定。
 *   - 没给 → 退回旧行为（第一个任务板非空的 agent）。独立看板页和未传 session 的旧客户端走这条。
 */
function currentTeamTasks(ctx, opts = {}) {
  let agentsSvc;
  try { agentsSvc = ctx.get("agents"); } catch { agentsSvc = undefined; }
  let teams;
  try { teams = ctx.get("agentTeams"); } catch { teams = undefined; }
  if (!agentsSvc?.list || !teams?.listTasks) return { tasks: [], note: "拿不到 agents / agentTeams 服务" };

  let agents = [];
  try { agents = agentsSvc.list() ?? []; } catch (err) { return { tasks: [], note: `agents.list 失败：${err?.message}` }; }

  // 顺便把会话工作目录带出来：HTTP 处理器里没有 exec，时间线落盘要靠它定位项目根
  const cwdOf = (a) => a?.session?.header?.cwd ?? null;
  /** @returns 任务数组；null 表示这个 agent 不是团队成员。 */
  const tasksOf = (agent) => {
    try { return teams.listTasks(agent) ?? []; } catch { return null; }
  };

  // ── ① 指定了会话：只认它 ──
  if (opts.sessionId) {
    // 两个都比对：`Agent.id` 本身就是 SessionId（见 core/agent 的类型定义），
    // 而运行时还有 `agent.session.id`。只认其中一个的话，一旦它们不是同一个字段，
    // 表现就是"侧栏永远是空的"—— 静默失效，很难查。
    const agent = agents.find((a) => a?.id === opts.sessionId || a?.session?.id === opts.sessionId);
    if (!agent) {
      return { tasks: [], agentId: null, agentCount: agents.length, cwd: null, sessionId: opts.sessionId,
        note: `会话 ${opts.sessionId} 当前没有对应的运行时 agent —— 可能还没开始跑，或已经结束了。` };
    }
    const tasks = tasksOf(agent);
    if (tasks === null) {
      return { tasks: [], agentId: agent?.id ?? null, agentCount: agents.length, cwd: cwdOf(agent),
        sessionId: opts.sessionId, note: "这个会话不是智能体团队的成员（没有 team 工具）。" };
    }
    return { tasks, agentId: agent?.id ?? null, agentCount: agents.length, cwd: cwdOf(agent),
      sessionId: opts.sessionId };
  }

  // ── ② 没指定会话：旧行为 ──
  for (const agent of agents) {
    const tasks = tasksOf(agent);
    if (tasks && tasks.length > 0) {
      return { tasks, agentId: agent?.id ?? null, agentCount: agents.length, cwd: cwdOf(agent) };
    }
  }
  // 任务板空的时候也尽量给一个 cwd，便于读历史时间线
  const anyCwd = agents.map(cwdOf).find(Boolean) ?? null;
  return { tasks: [], agentCount: agents.length, cwd: anyCwd,
    note: "所有 agent 的团队任务板都是空的（或都不是团队成员）" };
}

/** 同源栅栏：只接受本机来源的请求。看板是本地工具，不需要对外暴露。 */
function sameOriginOk(req) {
  const host = String(req?.headers?.host ?? "");
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req?.headers?.origin;
  if (origin === undefined) return true; // 同源导航不带 Origin
  try {
    const u = new URL(origin);
    return /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname);
  } catch { return false; }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// ─────────────────────────────────────────────────────────────
// 工具 1：pdev_preflight
// ─────────────────────────────────────────────────────────────

/**
 * 探测团队模式是否可用。
 *
 * 关键细节（v0.1 实测踩出来的，两次）：团队工具是用 `agent.ctx.tools.register(...)`
 * 注册到**每个 agent 的作用域**里的；而 `ToolRuntime.get(name, scope?)` 的 `scope`
 * **就是 agent**，不传等于看全局视图 —— 全局视图里看不到任何 agent 作用域的工具。
 *
 * 所以必须把调用方 agent 作为 scope 传进去。否则会误报"没有团队工具"，
 * 而工具其实好好的 —— **假阻断项比不检查更糟**，它会让人放弃正确的做法。
 */
function probeTeamCapability(ctx, exec) {
  const registry = (() => {
    try { return ctx.tools; } catch { return null; }
  })();
  const scope = exec?.agent ?? undefined;

  const lookup = (name) => {
    if (!registry?.get) return null;
    // 先按调用方 agent 的作用域查（正确做法），再退回全局视图
    if (scope !== undefined) {
      try { if (registry.get(name, scope) !== undefined) return "agent-scope"; } catch { /* 退回全局 */ }
    }
    try { if (registry.get(name) !== undefined) return "global"; } catch { /* 两个视图都没有 */ }
    return null;
  };

  const present = [];
  const missing = [];
  for (const t of TEAM_TOOLS) {
    const where = lookup(t);
    if (where) present.push(`${t}@${where}`);
    else missing.push(t);
  }

  let domainService = "absent";
  try {
    domainService = ctx.get("agentTeams") === undefined ? "absent" : "present";
  } catch { domainService = "threw"; }

  return {
    present,
    missing,
    ready: missing.length === 0,
    domainService, // agentTeams：团队领域服务。present 说明团队基础设施挂上了
    note: "工具查的是调用方 agent 的作用域表，退回到全局表",
  };
}

async function collectPreflight(ctx, exec, explicitRoot) {
  const { root, source } = resolveProjectRoot(explicitRoot, exec);
  const report = {
    when: new Date().toISOString(),
    plugin: `dsh-parallel-dev v${boot.version} (preflight)`,
    ok: true,
    blockers: [],
    warnings: [],
    project: { root, source },
  };

  // ① 团队能力：工具是否真的注册了
  const team = probeTeamCapability(ctx, exec);
  report.team = team;
  if (!team.ready) {
    report.ok = false;
    report.blockers.push({
      code: "TEAM_TOOLS_MISSING",
      message:
        `本会话没有团队工具，无法用智能体团队模式并行开发。缺少：${team.missing.join("、")}。` +
        `\n这通常是因为该 profile 未挂载 @deepseek-ai/dsh-experimental-agent-team（+ tool-agent-team）。` +
        `\n可选：换到挂了团队工具的 profile；或在用户明确同意后改用降级模式（单 Agent + 多角色模拟）。` +
        `\n**不要静默降级** —— 用户以为在跑团队模式、实际是单 Agent 自写自验，是这套流程最坏的失败方式。`,
    });
  }

  // ② 项目根是否已被另一个编排会话占用
  if (!root) {
    report.ok = false;
    report.blockers.push({
      code: "NO_PROJECT_ROOT",
      message:
        "拿不到项目根目录（session.header.cwd 为空）。请显式传 project_root 参数。" +
        "\n注意：不要用 DSH_* 环境变量——那些可能是从别的会话继承来的。",
    });
  } else {
    try {
      const stateRaw = await readFile(join(pdevDir(root), "state.json"), "utf8");
      const state = JSON.parse(stateRaw);
      const updatedAt = state?.updated_at ? Date.parse(state.updated_at) : NaN;
      const ageMin = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 60000 : null;
      report.occupancy = { stateFile: join(pdevDir(root), "state.json"), updatedAt: state?.updated_at ?? null, ageMinutes: ageMin === null ? null : Math.round(ageMin) };
      if (ageMin !== null && ageMin < 60) {
        report.warnings.push({
          code: "PROJECT_MAY_BE_BUSY",
          message:
            `项目根下已有 .pdev/state.json，且 ${Math.round(ageMin)} 分钟前刚更新过 —— ` +
            `可能正被另一个并行开发会话占用。两个会话往同一目录写会互相污染产物。` +
            `\n建议换一个隔离路径，或先向用户确认。`,
        });
      }
    } catch {
      report.occupancy = { stateFile: null, note: "没有 .pdev/state.json，看起来是新项目" };
    }

    // ③ git 可用性与仓库状态
    const gv = await run("git", ["--version"]);
    const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root });
    report.git = {
      available: gv.code === 0,
      version: gv.stdout || null,
      isRepo: top.code === 0,
      toplevel: top.code === 0 ? top.stdout : null,
    };
    if (gv.code !== 0) {
      report.ok = false;
      report.blockers.push({
        code: "NO_GIT",
        message: "跑不了 git，环境隔离（worktree + 分支）无法实施。这是并行开发的前提。",
      });
    } else if (top.code !== 0) {
      report.warnings.push({
        code: "NOT_A_GIT_REPO",
        message:
          "项目根不是 git 仓库。并行隔离只能用「每任务一个目录副本」的降级方案，" +
          "代价是没有版本历史、合并靠手工比对、容易把旧版错装成交付物。" +
          "建议先 git init 再开工。",
      });
    }

    // ④ 已有验收记录的覆盖情况
    const records = await listVerifyRecords(root, teamKey(ctx, exec));
    report.verification = {
      records: records.length,
      tasks: records.map((r) => ({ task_id: r.task_id, commit_sha: r.commit_sha, verdict: r.verdict, at: r.at })),
    };
  }

  report.summary = report.ok
    ? `可以开工（${report.warnings.length} 条提醒）`
    : `不能开工：${report.blockers.length} 个阻断项`;
  return report;
}

// ─────────────────────────────────────────────────────────────
// 门禁：拦截 team_task_update 的 complete
// ─────────────────────────────────────────────────────────────

/**
 * 判断一次 `team_task_update` 调用是否应该被拒绝。
 * 返回 null 表示放行；返回字符串表示拒绝理由。
 */
async function gateReason(ctx, exec) {
  const args = exec?.arguments ?? {};
  if (args.action !== "complete") return null;

  const taskId = args.task_id;
  if (!taskId) return null;

  const root = sessionCwd(exec);
  if (!root) {
    return (
      "无法校验验收记录：拿不到会话工作目录（session.header.cwd 为空）。" +
      "本插件要求完成任务前必须有独立验收记录，请检查会话创建时的 cwd。"
    );
  }

  const key = teamKey(ctx, exec);
  // 豁免优先：用户亲自指示豁免的任务，直接放行（但留痕，事后可审计）
  const waiver = await readWaiver(root, key, taskId);
  if (waiver?.waived) {
    console.log(`[dsh-parallel-dev] 放行 ${taskId}（用户豁免：${waiver.user_quote?.slice(0, 60)}）`);
    return null;
  }

  const rec = await readVerifyRecord(root, key, taskId);
  if (!rec) {
    return (
      `任务 ${taskId} 没有验收记录，不能标记为完成。\n\n` +
      `平台会允许这次调用，但那样「完成」只是一个声称 —— 没有人独立核对过交付物。\n` +
      `正确做法：派一个**一次性验收代理**（subagent，不用实施方自己）独立核对，然后调用\n` +
      `  pdev_verify_record(task_id="${taskId}", commit_sha=<被验的提交>, worktree=<代码所在目录>, ` +
      `verdict="passed", criteria=[...], evidence=[...])\n` +
      `记录写入后，本动作会被放行。\n\n` +
      `【用户豁免】如果用户已明确表示这个任务不需要验收，用 pdev_waive 登记豁免；\n` +
      `它会去会话记录里核对用户原话 —— 你引用的必须是用户真的说过的话。`
    );
  }

  if (rec.verdict !== "passed") {
    return (
      `任务 ${taskId} 的验收结论是 "${rec.verdict}"（${rec.verifier_id ?? "未知验收方"} 于 ${rec.at}），不是 passed，不能标记为完成。\n` +
      `请先整改，整改后重新验收并更新记录。`
    );
  }

  // 验收后代码又被改过吗？
  if (rec.worktree) {
    const head = await gitHead(rec.worktree);
    if (head.sha && head.sha !== rec.commit_sha) {
      return (
        `任务 ${taskId} 的代码在验收之后又被改过，不能标记为完成。\n` +
        `  验收记录的提交：${rec.commit_sha}\n` +
        `  当前 HEAD：    ${head.sha}（${rec.worktree}）\n\n` +
        `这说明验收过的版本已经不是交付的版本了 —— 这正是「验收通过」最容易失效的方式。\n` +
        `请对新版本重新验收，或把代码回退到被验收的提交。`
      );
    }
    if (!head.sha) {
      return (
        `任务 ${taskId} 的验收记录指向 worktree「${rec.worktree}」，但现在读不到它的 HEAD（${head.reason}）。\n` +
        `无法确认交付物就是被验收的那一份，因此拒绝。请检查该目录是否还在。`
      );
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────

export function apply(ctx) {
  boot.loadedAt = new Date().toISOString();
  console.log(`[dsh-parallel-dev] v${boot.version} loaded`);

  // ── 门禁：这一条是本插件的核心价值 ──────────────────────────────
  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      if (exec?.name !== "team_task_update") return next();
      const reason = await gateReason(ctx, exec);
      if (reason) {
        console.log(`[dsh-parallel-dev] 拒绝了 team_task_update(complete ${exec?.arguments?.task_id})`);
        return { kind: "deny", reason };
      }
      return next();
    } catch (err) {
      // 门禁自身出错时不要卡死流程，但要说清楚
      console.log(`[dsh-parallel-dev] gate error: ${err?.message}`);
      return next();
    }
  });
  boot.gateInstalled = true;

  // ── 观察用户消息：豁免核对的唯一依据 ────────────────────────────
  // ── 注入编排纪律：这就是"插件取代技能"的那一步 ──────────────────
  // 系统提示是"装了就有"的，不依赖用户手动加载技能，也不依赖模型主动选择。
  // 放在 TEAM_POLICY(600) 之后，紧挨团队政策，语义上连贯。
  try {
    ctx.inject(["systemPrompt"], (sctx) => {
      const section = sctx.systemPrompt?.section;
      if (typeof section !== "function") { boot.policySection = "跳过：systemPrompt.section 不可用"; return; }
      sctx.systemPrompt.section({
        name: PDEV_POLICY_NAME,
        order: PDEV_POLICY_ORDER,
        text: PDEV_POLICY_TEXT,
      });
      boot.policySection = `已注入（${PDEV_POLICY_NAME}，order ${PDEV_POLICY_ORDER}）`;
      console.log("[dsh-parallel-dev] policy section injected into system prompt");
    });
  } catch (err) {
    boot.policySection = `FAILED: ${err?.message}`;
    console.log(`[dsh-parallel-dev] policy injection failed: ${err?.message}`);
  }

  // ── 观察任务变更：时间轴的唯一数据来源 ──────────────────────────
  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type !== "team/task") return;
      const d = event.data ?? {};
      const task = d.task ?? d;
      const id = task?.id;
      if (!id) return;
      const list = taskTimeline.get(id) ?? [];
      const last = list[list.length - 1];
      const snapshot = {
        at: new Date(event.time ?? Date.now()).toISOString(),
        status: task.status ?? null,
        revision: task.revision ?? null,
        subject: task.subject ?? null,
        owner: task.ownerName ?? null,
        op: d.operation ?? d.kind ?? null,
      };
      // 同一 revision 的重复事件不重复记
      if (!last || last.revision !== snapshot.revision || last.status !== snapshot.status) {
        list.push(snapshot);
        while (list.length > MAX_TIMELINE_PER_TASK) list.shift();
        taskTimeline.set(id, list);
        // 落盘：跨重启保留历史（内存版一重启就没了）
        void appendTimeline(session?.header?.cwd ?? null, { task_id: id, ...snapshot });
      }
    } catch { /* 观察失败不影响主流程 */ }
  });

  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type !== "user/message") return;
      const id = session?.id ?? session?.header?.id;
      if (!id) return;
      const text = eventText(event.data);
      if (!text || !text.trim()) return;
      const list = userMessages.get(id) ?? [];
      list.push({ text, at: Date.now(), seq: event.seq ?? null });
      while (list.length > MAX_KEPT_PER_SESSION) list.shift();
      userMessages.set(id, list);
    } catch { /* 观察失败不影响主流程 */ }
  });

// ── 看板路由（v0.2 视图 A：纵向依赖图）──────────────────────────
  //
  // 关键：**不能在 apply 里用 ctx.get("webServer") 直接注册** ——
  // apply 运行时服务还没就绪，ctx.get 返回 undefined，路由会被静默跳过（实测 404 就是这么来的）。
  // 正确做法是 ctx.inject(['webServer'], cb)：服务可用时才执行回调，
  // 而且没挂 host-webserver 的 profile（如 headless）里插件不会被卡成 PENDING。
  try {
    ctx.inject(["webServer"], (sctx) => {
      const webServer = sctx.webServer;
      if (!webServer?.register) return;
      webServer.register({
        kind: "exact",
        path: "/pdev/board",
        handler: async (req, res) => {
          if (!sameOriginOk(req)) { res.writeHead(403); res.end("forbidden"); return; }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(BOARD_HTML) });
          res.end(BOARD_HTML);
        },
      });
      webServer.register({
        kind: "prefix",
        path: "/pdev/board/data",
        handler: async (req, res) => {
          if (!sameOriginOk(req)) { sendJson(res, 403, { error: "forbidden" }); return; }
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const demo = url.searchParams.get("demo") === "1";
            // ?session= 让每个会话各看各的团队；不传则退回旧行为（独立看板页用）
            const wantSession = url.searchParams.get("session") || null;
            const live = demo ? null : currentTeamTasks(ctx, { sessionId: wantSession });
            const { tasks, note, agentId, agentCount, cwd } = demo
              ? { tasks: DEMO_TASKS, note: "演示数据（形状取自真实案例）", agentId: null, agentCount: null, cwd: null }
              : live;
            const graph = buildGraph(tasks);
            // 时间线从磁盘读（磁盘是持久历史），内存只补本进程最新的几条
            const timeline = demo ? demoTimeline() : await mergedTimeline(cwd ?? null);
            sendJson(res, 200, {
              ...graph,
              timeline,
              meta: {
                taskCount: tasks.length,
                agentId, agentCount,
                source: note ?? "team task board",
                demo,
                timelineTracked: Object.keys(timeline).length,
                timelineFile: cwd ? join(pdevDir(cwd), "timeline.jsonl") : null,
                timelineSource: demo ? "demo" : "disk+memory",
                scopedToSession: wantSession,
                at: new Date().toISOString(),
              },
            });
          } catch (err) {
            sendJson(res, 500, { error: String(err?.message ?? err) });
          }
        },
      });
      boot.boardRoute = "registered at /pdev/board";
      console.log("[dsh-parallel-dev] board route /pdev/board registered");
    });
  } catch (err) {
    boot.boardRoute = `FAILED: ${err?.message}`;
    console.log(`[dsh-parallel-dev] board route failed: ${err?.message}`);
  }

  // ── 工具 1：pdev_preflight ──────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "pdev_preflight",
    description:
      "并行开发开工前的门禁检查。确认：本会话是否真有智能体团队工具（没有就不能用团队模式）、" +
      "项目根是否已被另一个编排会话占用、git 是否可用、已有验收记录的覆盖情况。" +
      "**开工前必须先跑这个**；返回的 blockers 不为空时不要擅自降级，要告诉用户。",
    parameters: {
      project_root: {
        type: "string",
        description: "项目根目录。省略时用调用会话的 cwd（session.header.cwd）。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          report: { type: "string", required: true, description: "预检报告的 JSON 文本。" },
        },
      },
      render: textRender((v) => v.report),
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.();
      return { report: JSON.stringify(await collectPreflight(ctx, exec, args?.project_root), null, 2) };
    },
  }));
  boot.toolRegistration.push("pdev_preflight");

  // ── 工具 2：pdev_verify_record ─────────────────────────────────
  ctx.tools.register(defineTool({
    name: "pdev_verify_record",
    description:
      "登记一份独立验收记录 —— 这是把任务标记为完成的**唯一凭据**。" +
      "必须由独立验收方（一次性验收代理，不能是实施方自己）在亲手核对交付物之后调用。" +
      "记录绑定 commit sha：验收之后代码若再变动，完成动作会被拒绝。",
    parameters: {
      task_id: { type: "string", required: true, description: "共享任务板上的任务 id（如 task-3）。" },
      commit_sha: { type: "string", required: true, description: "被验收的提交 sha（独立跑 git rev-parse HEAD 得到，不要抄实施方给的）。" },
      worktree: { type: "string", required: true, description: "交付物所在目录（该任务的 worktree 绝对路径）。" },
      verdict: {
        type: "string",
        required: true,
        description: "验收结论：passed | needs_fix | disputed。只有 passed 才能让任务完成。",
      },
      verifier_id: {
        type: "string",
        required: true,
        description: "验收方标识（一次性代理的名字/描述）。用于留痕，不能填实施方。",
      },
      criteria: {
        type: "array",
        items: { type: "string" },
        description: "逐条判据及结果，例如 '① 6 面结构一致 ✅ ② 明暗单调 ✅'。每条都要能指回具体证据。",
      },
      evidence: {
        type: "array",
        items: { type: "string" },
        description: "实际证据：命令与实际输出、文件+行号、截图路径。**没有证据的通过等于没验收。**",
      },
      notes: { type: "string", description: "补充说明：未覆盖的范围、已知局限、争议点。" },
      project_root: { type: "string", description: "项目根目录，省略时用会话 cwd。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          message: { type: "string", required: true },
          record_path: { type: "string", required: true },
        },
      },
      render: textRender((v) => `${v.ok ? "✅" : "❌"} ${v.message}\n记录文件：${v.record_path}`),
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.();

      const { root } = resolveProjectRoot(args?.project_root, exec);
      if (!root) {
        return { ok: false, message: "拿不到项目根目录，请显式传 project_root。", record_path: "(未写入)" };
      }

      const verdict = String(args.verdict ?? "").trim();
      if (!["passed", "needs_fix", "disputed"].includes(verdict)) {
        return { ok: false, message: `verdict 必须是 passed | needs_fix | disputed，收到 "${verdict}"。`, record_path: "(未写入)" };
      }
      const evidence = Array.isArray(args.evidence) ? args.evidence.filter((s) => String(s).trim()) : [];
      if (evidence.length === 0) {
        return {
          ok: false,
          message:
            "证据为空，拒绝登记。没有可定位证据的「通过」等于没验收 —— " +
            "请贴出实际命令与输出、文件行号或截图路径。",
          record_path: "(未写入)",
        };
      }

      // ── 自证检查：验收人不能就是任务所有者 ──────────────────────
      // 「实施和验收必须是不同的人」是这套流程的核心。若允许实施方自己登记
      // 验收记录，这里的门禁就退化成了「点两下按钮」，毫无意义。
      const ownership = await checkSelfCertification(ctx, exec, String(args.task_id));
      if (ownership.selfCertified) {
        return {
          ok: false,
          message:
            `拒绝登记：调用方就是任务 ${args.task_id} 的所有者（${ownership.ownerName}），` +
            `不能自己验收自己的交付物。\n` +
            `请派一个**独立的一次性验收代理**（subagent）去核对，由它来登记这份记录。\n` +
            `（判定依据：团队任务板上该任务的 ownerName 与调用方所属成员一致。` +
            `若这是误判，请在 notes 里说明情况并联系维护者。）`,
          record_path: "(未写入)",
        };
      }

      // 独立取证：自己跑一遍 git，不采信调用方转述的 HEAD
      const head = await gitHead(args.worktree);
      if (!head.sha) {
        return { ok: false, message: `读不到 ${args.worktree} 的 HEAD：${head.reason}`, record_path: "(未写入)" };
      }

      const record = {
        task_id: String(args.task_id),
        commit_sha: String(args.commit_sha),
        head_at_record_time: head.sha,
        sha_matches_now: head.sha === String(args.commit_sha),
        worktree: String(args.worktree),
        verdict,
        verifier_id: String(args.verifier_id),
        criteria: Array.isArray(args.criteria) ? args.criteria : [],
        evidence,
        notes: args.notes ? String(args.notes) : null,
        // 自证检查的留痕：事后能看出这份记录是谁登记的、当时任务归谁
        verifier_agent_id: exec?.agent?.id ?? null,
        task_owner_at_record: ownership.ownerName ?? null,
        self_certification_check: { checked: ownership.checked, note: ownership.note },
        at: new Date().toISOString(),
        session_id: exec?.agent?.session?.id ?? null,
      };

      const key = teamKey(ctx, exec);
      const dir = verifyDir(root);
      await mkdir(dir, { recursive: true });
      const path = verifyPath(root, key, record.task_id);
      record.team_key = key;
      await writeFile(path, JSON.stringify(record, null, 2) + "\n", "utf8");

      const warn = record.sha_matches_now
        ? ""
        : `\n⚠ 你填的 commit_sha (${record.commit_sha}) 与该 worktree 当前 HEAD (${head.sha}) 不一致。` +
          `记录已按你填的值写入，但完成任务时会以当前 HEAD 复核 —— 不一致会被拒绝。`;
      return {
        ok: true,
        message: `已登记 ${record.task_id} 的验收记录：${verdict}，${evidence.length} 条证据。${warn}`,
        record_path: path,
      };
    },
  }));
  boot.toolRegistration.push("pdev_verify_record");

  // ── 工具：pdev_board（看板地址与现状） ───────────────────────────
  ctx.tools.register(defineTool({
    name: "pdev_board",
    description:
      "给出并行开发看板的地址，并附上当前依赖图的关键结论（层数、最宽层、关键路径、被阻塞数）。" +
      "用户问「现在到哪了」「卡在哪」时用它，然后把地址给他 —— 看板是浏览器里实时刷新的，比文字汇报直观。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { report: { type: "string", required: true } },
      },
      render: textRender((v) => v.report),
    },
    execute: async (_args, exec) => {
      exec?.signal?.throwIfAborted?.();
      // 用调用方自己的会话定位团队 —— 多个会话并行时，这个工具必须回报"你的"看板
      const callerSession = exec?.agent?.session?.id ?? null;
      const { tasks, note, agentCount } = currentTeamTasks(ctx, { sessionId: callerSession });
      const g = buildGraph(tasks);
      const s = g.summary;
      const lines = [
        `看板地址：/pdev/board${callerSession ? `?session=${encodeURIComponent(callerSession)}` : ""}　（拼在你打开 DSH Web UI 的地址后面）`,
        boot.boardRoute === "registered at /pdev/board"
          ? "路由状态：已注册"
          : `路由状态：${boot.boardRoute}（若是「跳过」，说明当前 profile 没挂 host-webserver，看板用不了）`,
        "",
        `任务总数：${s.total}（已完成 ${s.completed}）`,
        `依赖层数：${s.layers} 层，最宽一层 ${s.maxWidth} 个并行`,
        `关键路径：${s.criticalPathLength} 层，还剩 ${s.criticalRemaining} 层 —— 总工期由它决定`,
        `被阻塞：${s.blocked}`,
        `关键路径：${g.criticalPath.join(" → ") || "（无）"}`,
        "",
        note ? `读取说明：${note}（可见 agent ${agentCount ?? "?"} 个）` : `已读到 ${tasks.length} 个任务`,
      ];
      return { report: lines.join("\n") };
    },
  }));
  boot.toolRegistration.push("pdev_board");

  // ── 工具 3：pdev_waive（用户亲自指示时的豁免通道） ───────────────
  ctx.tools.register(defineTool({
    name: "pdev_waive",
    description:
      "登记用户豁免：当**用户本人在对话里明确表示**某个任务不必验收时，用它放行。" +
      "必须引用用户在对话里说过的原话；插件会去会话记录里核对，并检查原话里是否含明确的豁免意思。" +
      "编造引用会被拒绝。豁免会留痕，最终验收报告应列出所有豁免项。",
    parameters: {
      task_id: { type: "string", required: true, description: "要豁免的任务 id。" },
      user_quote: {
        type: "string",
        required: true,
        description:
          "用户在对话里说过的原话片段，必须包含明确的豁免意思（如「豁免」「不用验收」「跳过验收」）。" +
          "请逐字引用，不要改写、不要转述。",
      },
      reason: { type: "string", description: "豁免的原因（可选，会写进记录）。" },
      project_root: { type: "string", description: "项目根目录，省略时用会话 cwd。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          message: { type: "string", required: true },
          waiver_path: { type: "string", required: true },
        },
      },
      render: textRender((v) => `${v.ok ? "✅" : "❌"} ${v.message}\n豁免记录：${v.waiver_path}`),
    },
    execute: async (args, exec) => {
      exec?.signal?.throwIfAborted?.();
      const { root } = resolveProjectRoot(args?.project_root, exec);
      if (!root) return { ok: false, message: "拿不到项目根目录，请显式传 project_root。", waiver_path: "(未写入)" };

      const taskId = String(args?.task_id ?? "").trim();
      const quote = normalize(args?.user_quote);
      if (!taskId) return { ok: false, message: "task_id 必填。", waiver_path: "(未写入)" };
      if (quote.length < 4) {
        return { ok: false, message: "user_quote 太短，无法核对。请逐字引用用户说过的一整句话。", waiver_path: "(未写入)" };
      }

      const sessionId = exec?.agent?.session?.id;
      const observed = sessionId ? (userMessages.get(sessionId) ?? []) : [];
      if (observed.length === 0) {
        return {
          ok: false,
          message:
            "本会话没有观察到任何用户消息，无法核对豁免授权。\n" +
            "（可能原因：插件是在用户发言之后才加载的，或本会话没有用户消息。）\n" +
            "请让用户在本会话里重新明确说一次豁免，再引用那句话。",
          waiver_path: "(未写入)",
        };
      }

      const hit = observed.find((m) => normalize(m.text).includes(quote));
      if (!hit) {
        const recent = observed.slice(-3).map((m) => `  · ${normalize(m.text).slice(0, 100)}`).join("\n");
        return {
          ok: false,
          message:
            `在会话记录里找不到这句用户原话：\n  「${quote}」\n\n` +
            `本会话最近几条用户消息是：\n${recent}\n\n` +
            "请逐字引用用户真实说过的话 —— 编造的引用不能作为豁免依据。",
          waiver_path: "(未写入)",
        };
      }

      const keyword = hasWaiverIntent(quote) ?? hasWaiverIntent(hit.text);
      if (!keyword) {
        return {
          ok: false,
          message:
            `这句话确实是用户说的，但里面没有明确的豁免意思：\n  「${quote}」\n\n` +
            "「用户提过这个任务」不等于「用户同意不验收」。请让用户明确说一句（例如「task-1 豁免验收」），再引用它。",
          waiver_path: "(未写入)",
        };
      }

      const key = teamKey(ctx, exec);
      const waiver = {
        task_id: taskId,
        waived: true,
        user_quote: quote,
        matched_keyword: keyword,
        matched_message_seq: hit.seq,
        matched_message_full: normalize(hit.text).slice(0, 2000),
        reason: args?.reason ? String(args.reason) : null,
        authorized_by: "user",
        recorded_by_agent: exec?.agent?.id ?? null,
        session_id: sessionId ?? null,
        team_key: key,
        at: new Date().toISOString(),
      };
      await mkdir(verifyDir(root), { recursive: true });
      const path = waiverPath(root, key, taskId);
      await writeFile(path, JSON.stringify(waiver, null, 2) + "\n", "utf8");
      console.log(`[dsh-parallel-dev] ${taskId} 已豁免（用户原话命中「${keyword}」）`);
      return {
        ok: true,
        message:
          `已登记 ${taskId} 的用户豁免（命中关键字「${keyword}」）。此后该任务的 complete 会被放行。\n` +
          `注意：豁免项应写进最终验收报告，不要让它悄悄过去。`,
        waiver_path: path,
      };
    },
  }));
  boot.toolRegistration.push("pdev_waive");

  // ── 工具 3：pdev_gate_status（只读，便于自查为什么被拒） ─────────
  ctx.tools.register(defineTool({
    name: "pdev_gate_status",
    description:
      "查看门禁当前状态：门禁是否装上了、哪些任务已有验收记录、每条记录的结论与绑定的提交。" +
      "任务被拒绝完成时用它自查。只读，不改变任何东西。",
    parameters: {
      project_root: { type: "string", description: "项目根目录，省略时用会话 cwd。" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          report: { type: "string", required: true },
        },
      },
      render: textRender((v) => v.report),
    },
    execute: async (args, exec) => {
      const { root, source } = resolveProjectRoot(args?.project_root, exec);
      const key = teamKey(ctx, exec);
      const records = root ? await listVerifyRecords(root, key) : [];
      const waivers = root ? await listWaivers(root, key) : [];
      const out = {
        plugin: `dsh-parallel-dev v${boot.version}`,
        loadedAt: boot.loadedAt,
        gateInstalled: boot.gateInstalled,
        policySection: boot.policySection,
        boardRoute: boot.boardRoute,
        tools: boot.toolRegistration,
        projectRoot: root,
        projectRootSource: source,
        interceptedTool: "team_task_update（action=complete）",
        verificationRecords: records.map((r) => ({
          task_id: r.task_id,
          verdict: r.verdict,
          commit_sha: r.commit_sha,
          worktree: r.worktree,
          verifier_id: r.verifier_id,
          evidenceCount: Array.isArray(r.evidence) ? r.evidence.length : 0,
          at: r.at,
        })),
        waivers: waivers.map((w) => ({
          task_id: w.task_id, user_quote: w.user_quote, matchedKeyword: w.matched_keyword, at: w.at,
        })),
        hint: "既没有验收记录、也没有用户豁免的任务，其 complete 动作会被门禁拒绝。豁免项应写进最终验收报告。",
      };
      return { report: JSON.stringify(out, null, 2) };
    },
  }));
  boot.toolRegistration.push("pdev_gate_status");

  console.log(`[dsh-parallel-dev] gate on tools/pre-execute installed; tools: ${boot.toolRegistration.join(", ")}`);
}
