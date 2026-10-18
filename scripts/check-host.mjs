#!/usr/bin/env node
/**
 * dsh-parallel-dev — Host 纯逻辑单测（契约 §9 T1）。
 *
 * 只 import 三个纯模块：config.js / gate-decision.js / team-key.js。
 * 它们都不 import `@deepseek-ai/schemastery` 或任何 Harness 包，所以在没有
 * node_modules 的 worktree 里也能直接跑：
 *
 *   node scripts/check-host.mjs
 *
 * 退出码非 0 表示有测试失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG_DEFAULTS, CONFIG_KEYS, normalizeConfig, validatePatch } from "../src/host/config.js";
import { GATE_CODES, decideGate } from "../src/host/gate-decision.js";
import { teamKey } from "../src/host/team-key.js";

// ─────────────────────────────────────────────────────────────
// 配置默认值
// ─────────────────────────────────────────────────────────────

test("CONFIG_DEFAULTS：8 个字段齐全且取值符合契约 §3.1", () => {
  assert.deepEqual(CONFIG_KEYS, [
    "injectPolicy",
    "autoOpen",
    "timelineEnabled",
    "timelineMaxEntries",
    "gateMode",
    "requireEvidence",
    "requireCommitMatch",
    "blockSelfCertification",
  ]);
  assert.deepEqual(CONFIG_DEFAULTS, {
    injectPolicy: true,
    autoOpen: true,
    timelineEnabled: true,
    timelineMaxEntries: 60,
    gateMode: "enforce",
    requireEvidence: true,
    requireCommitMatch: true,
    blockSelfCertification: true,
  });
});

// ─────────────────────────────────────────────────────────────
// normalizeConfig：回退与夹取
// ─────────────────────────────────────────────────────────────

test("normalizeConfig：空 / 非对象输入回落默认值", () => {
  for (const input of [undefined, null, 42, "x", [], true]) {
    assert.deepEqual(normalizeConfig(input), CONFIG_DEFAULTS);
  }
});

test("normalizeConfig：合法覆盖被保留，未知字段被丢弃", () => {
  const value = normalizeConfig({
    injectPolicy: false,
    autoOpen: false,
    timelineEnabled: false,
    timelineMaxEntries: 120,
    gateMode: "advise",
    requireEvidence: false,
    requireCommitMatch: false,
    blockSelfCertification: false,
    unknown: "ignored",
  });
  assert.deepEqual(value, {
    injectPolicy: false,
    autoOpen: false,
    timelineEnabled: false,
    timelineMaxEntries: 120,
    gateMode: "advise",
    requireEvidence: false,
    requireCommitMatch: false,
    blockSelfCertification: false,
  });
});

test("normalizeConfig：错误类型回退默认，不做隐式转换", () => {
  const value = normalizeConfig({
    injectPolicy: "false",
    autoOpen: 0,
    timelineEnabled: null,
    timelineMaxEntries: "30",
    gateMode: "off",
    requireEvidence: 1,
    requireCommitMatch: "yes",
    blockSelfCertification: {},
  });
  assert.deepEqual(value, CONFIG_DEFAULTS);
});

test("normalizeConfig：timelineMaxEntries 取整并夹取到 10–500", () => {
  const clamp = (input) => normalizeConfig({ timelineMaxEntries: input }).timelineMaxEntries;
  assert.equal(clamp(5), 10); // 下界
  assert.equal(clamp(-100), 10);
  assert.equal(clamp(10), 10);
  assert.equal(clamp(12.9), 12); // 取整数
  assert.equal(clamp(500), 500);
  assert.equal(clamp(999), 500); // 上界
  assert.equal(clamp(Number.NaN), 60);
  assert.equal(clamp(Number.POSITIVE_INFINITY), 60);
  assert.equal(clamp("30"), 60);
});

test("normalizeConfig：gateMode 非法值退回 enforce", () => {
  assert.equal(normalizeConfig({ gateMode: "advise" }).gateMode, "advise");
  assert.equal(normalizeConfig({ gateMode: "enforce" }).gateMode, "enforce");
  assert.equal(normalizeConfig({ gateMode: "nope" }).gateMode, "enforce");
  assert.equal(normalizeConfig({ gateMode: 0 }).gateMode, "enforce");
});

// ─────────────────────────────────────────────────────────────
// validatePatch：写路径必须严格
// ─────────────────────────────────────────────────────────────

test("validatePatch：合法 patch 通过且保持类型", () => {
  const cases = [
    { autoOpen: false },
    { injectPolicy: false, timelineEnabled: false },
    { timelineMaxEntries: 10 },
    { timelineMaxEntries: 500 },
    { gateMode: "advise" },
    { gateMode: "enforce" },
    { requireEvidence: false, requireCommitMatch: false, blockSelfCertification: false },
  ];
  for (const patch of cases) {
    const result = validatePatch(patch);
    assert.equal(result.ok, true, JSON.stringify(patch));
    assert.deepEqual(result.patch, patch);
    assert.equal(result.field, null);
  }
});

test("validatePatch：空 patch / 非对象 patch 被拒", () => {
  for (const patch of [{}, null, undefined, "x", 1, [], true]) {
    const result = validatePatch(patch);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.field, null);
    assert.ok(result.message.length > 0);
  }
});

test("validatePatch：未知 key 被拒并指出字段", () => {
  const result = validatePatch({ autoOpen: false, evil: true });
  assert.equal(result.ok, false);
  assert.equal(result.field, "evil");
});

test("validatePatch：布尔字段类型错误被拒", () => {
  for (const key of ["injectPolicy", "autoOpen", "timelineEnabled", "requireEvidence", "requireCommitMatch", "blockSelfCertification"]) {
    const result = validatePatch({ [key]: "false" });
    assert.equal(result.ok, false, key);
    assert.equal(result.field, key);
  }
});

test("validatePatch：timelineMaxEntries 非整数 / 越界被拒", () => {
  for (const value of [9, 501, 12.5, Number.NaN, "30", null, true]) {
    const result = validatePatch({ timelineMaxEntries: value });
    assert.equal(result.ok, false, String(value));
    assert.equal(result.field, "timelineMaxEntries");
  }
});

test("validatePatch：gateMode 非法值被拒", () => {
  const result = validatePatch({ gateMode: "off" });
  assert.equal(result.ok, false);
  assert.equal(result.field, "gateMode");
});

// ─────────────────────────────────────────────────────────────
// decideGate：六种 code × enforce/advise
// ─────────────────────────────────────────────────────────────

const PASSED_RECORD = Object.freeze({
  verdict: "passed",
  commit_sha: "abc123",
  worktree: "/tmp/worktree",
  verifier_id: "verifier-a",
  at: "2026-10-18T14:00:00.000Z",
});
const HEAD_OK = Object.freeze({ sha: "abc123", reason: null });

function prefsWith(overrides = {}) {
  return normalizeConfig(overrides);
}

test("GATE_CODES：与契约 §5.6 完全一致", () => {
  assert.deepEqual(GATE_CODES, ["waiver", "no_record", "not_passed", "head_unreadable", "sha_drift", "ok"]);
});

const DECISION_CASES = [
  {
    name: "waiver",
    prefs: {},
    context: { waiver: { waived: true }, record: null, head: null },
    code: "waiver",
    allow: true,
  },
  {
    name: "no_record",
    prefs: {},
    context: { waiver: null, record: null, head: null },
    code: "no_record",
    allow: false,
  },
  {
    name: "not_passed",
    prefs: {},
    context: { waiver: null, record: { ...PASSED_RECORD, verdict: "needs_fix" }, head: HEAD_OK },
    code: "not_passed",
    allow: false,
  },
  {
    name: "head_unreadable",
    prefs: {},
    context: { waiver: null, record: PASSED_RECORD, head: { sha: null, reason: "目录不存在" } },
    code: "head_unreadable",
    allow: false,
  },
  {
    name: "sha_drift",
    prefs: {},
    context: { waiver: null, record: PASSED_RECORD, head: { sha: "def456" } },
    code: "sha_drift",
    allow: false,
  },
  {
    name: "ok",
    prefs: {},
    context: { waiver: null, record: PASSED_RECORD, head: HEAD_OK },
    code: "ok",
    allow: true,
  },
];

test("decideGate：六种 code 在 enforce 下分别为 allow / deny", () => {
  for (const item of DECISION_CASES) {
    const decision = decideGate(prefsWith({ gateMode: "enforce", ...item.prefs }), { taskId: "task-7", ...item.context });
    assert.equal(decision.code, item.code, item.name);
    assert.equal(decision.action, item.allow ? "allow" : "deny", item.name);
    if (item.allow) assert.equal(decision.reason, null, item.name);
    else assert.ok(decision.reason.length > 0, item.name);
  }
});

test("decideGate：advise 模式下四种失败码只 advise、不 deny；allow 仍 allow", () => {
  for (const item of DECISION_CASES) {
    const decision = decideGate(prefsWith({ gateMode: "advise", ...item.prefs }), { taskId: "task-7", ...item.context });
    assert.equal(decision.code, item.code, item.name);
    assert.equal(decision.action, item.allow ? "allow" : "advise", item.name);
    if (item.allow) assert.equal(decision.reason, null, item.name);
    else assert.ok(decision.reason.length > 0, item.name);
  }
});

test("decideGate：失败文案带任务 id，便于定位", () => {
  const decision = decideGate(prefsWith(), { waiver: null, record: null, head: null, taskId: "task-42" });
  assert.match(decision.reason, /task-42/);
});

test("decideGate：requireCommitMatch=false 时不读 HEAD，直接通过", () => {
  const decision = decideGate(
    prefsWith({ requireCommitMatch: false }),
    { waiver: null, record: PASSED_RECORD, head: null, taskId: "task-1" },
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.code, "ok");
});

test("decideGate：requireCommitMatch=true 但记录没有 worktree 时跳过 HEAD 校验", () => {
  const decision = decideGate(
    prefsWith({ requireCommitMatch: true }),
    { waiver: null, record: { ...PASSED_RECORD, worktree: null }, head: null, taskId: "task-1" },
  );
  assert.equal(decision.action, "allow");
  assert.equal(decision.code, "ok");
});

// ─────────────────────────────────────────────────────────────
// teamKey：契约 §5.11 的 6 行行为表（mock ctx，不依赖真实团队）
// ─────────────────────────────────────────────────────────────

const LEAD_TEAM_MEMBERS = Object.freeze([
  { id: "lead-1", target: "lead" },
  { id: "impl-a", target: "impl-contract" },
]);

/**
 * 造一个最小 ctx。
 * @param {object} options
 * @param {(agent: object) => object[]} [options.listMembers] 省略 = 服务存在但一律抛「不是成员」
 * @param {object[]|undefined} [options.roots] undefined = agents 服务不可用
 * @param {(sid: string, owner: object) => boolean} [options.isOwnedBy]
 * @param {boolean} [options.teamsUnavailable]
 */
function mockCtx({ listMembers, roots, isOwnedBy, teamsUnavailable = false } = {}) {
  return {
    get(name) {
      if (name === "agentTeams") {
        if (teamsUnavailable) throw new Error("agentTeams service unavailable");
        return {
          listMembers(agent) {
            if (typeof listMembers === "function") return listMembers(agent);
            throw new Error("is not a member of an active Agent Team");
          },
        };
      }
      if (name === "agents") {
        if (roots === undefined) throw new Error("agents service unavailable");
        return { roots: () => roots, isOwnedBy };
      }
      throw new Error(`unknown service: ${name}`);
    },
  };
}

function agentOf(id, sessionId = id) {
  return { id, session: { id: sessionId } };
}

test("teamKey 行为表 ①：团队 Lead → team-<leadId>", () => {
  const lead = agentOf("lead-agent");
  const ctx = mockCtx({ listMembers: () => LEAD_TEAM_MEMBERS, roots: [lead] });
  assert.equal(teamKey(ctx, { agent: lead }), "team-lead-1");
});

test("teamKey 行为表 ②：团队成员（teammate）→ team-<leadId>", () => {
  const teammate = agentOf("impl-agent");
  const ctx = mockCtx({ listMembers: () => LEAD_TEAM_MEMBERS });
  assert.equal(teamKey(ctx, { agent: teammate }), "team-lead-1");
});

test("teamKey 行为表 ③：无团队的根会话 → session-<rootSessionId>（与旧行为一致）", () => {
  const root = agentOf("root-agent", "root-session-1");
  const ctx = mockCtx({ roots: [root] });
  assert.equal(teamKey(ctx, { agent: root }), "session-root-session-1");
});

test("teamKey 行为表 ④：团队 Lead 下的一次性 subagent → team-<leadId>（修复点）", () => {
  const lead = agentOf("lead-agent", "lead-session");
  const subagent = agentOf("sub-agent", "sub-session");
  const ctx = mockCtx({
    listMembers: (agent) => {
      if (agent === lead) return LEAD_TEAM_MEMBERS;
      throw new Error("is not a member of an active Agent Team");
    },
    roots: [lead],
    isOwnedBy: (sid, owner) => sid === "sub-session" && owner === lead,
  });
  assert.equal(teamKey(ctx, { agent: subagent }), "team-lead-1");
});

test("teamKey 行为表 ⑤：无团队根会话下的 subagent → session-<rootSessionId>（与根一致）", () => {
  const root = agentOf("root-agent", "root-session-2");
  const subagent = agentOf("sub-agent", "sub-session");
  const ctx = mockCtx({
    roots: [root],
    isOwnedBy: (sid, owner) => sid === "sub-session" && owner === root,
  });
  assert.equal(teamKey(ctx, { agent: subagent }), "session-root-session-2");
});

test("teamKey 行为表 ⑥：agents / agentTeams 都不可用 → 旧回退 session-<自己>，且不抛错", () => {
  const subagent = agentOf("sub-agent", "sub-session");
  const ctx = mockCtx({ teamsUnavailable: true, roots: undefined });
  assert.doesNotThrow(() => teamKey(ctx, { agent: subagent }));
  assert.equal(teamKey(ctx, { agent: subagent }), "session-sub-session");
});

test("teamKey：ctx.get 两个服务都缺失时也退回 session-<自己>", () => {
  const ctx = { get() { throw new Error("no services"); } };
  assert.equal(teamKey(ctx, { agent: agentOf("solo", "solo-session") }), "session-solo-session");
});
