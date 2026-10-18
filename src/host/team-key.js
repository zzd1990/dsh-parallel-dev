/**
 * dsh-parallel-dev — 验收记录的归属 key（命名空间）。
 *
 * 单独成文件（v0.3 契约 §5.11）：这是纯逻辑，且必须能被单测直接用 mock ctx
 * 覆盖；不能和 `index.js` 混在一起（后者依赖 `@deepseek-ai/dsh-tools`，
 * worktree 没有 node_modules 时加载不了）。
 *
 * 为什么 key 重要：验收记录按 key 分命名空间落盘
 * （`<项目根>/.pdev/verify/<key>__<task_id>.json`）。登记方与 complete 的
 * 门禁必须算出同一个 key，否则「验收过了」和「找不到记录」会同时发生。
 */

/**
 * 一个 agent「自己作为团队成员」会算出的 key；不是成员返回 null。
 *
 * 注意：`listMembers` 对非团队成员会抛错，所以整段包在 try/catch 里，
 * 「不是成员」是正常路径，不是异常。
 *
 * @param {object} ctx 插件上下文（只需要 `get`）
 * @param {object|undefined} agent 一个 agent
 * @returns {string|null}
 */
export function keyForAgent(ctx, agent) {
  try {
    const members = ctx.get("agentTeams")?.listMembers?.(agent) ?? [];
    const lead = members.find((m) => m?.target === "lead" || m?.name === "lead");
    if (lead?.id) return `team-${lead.id}`;
  } catch {
    /* 不是团队成员 */
  }
  return null;
}

/**
 * 验收记录的归属 key。
 *
 * v0.3 修复（实测缺陷）：一次性验收 subagent 不是团队成员，旧逻辑回退成
 * `session-<subagent会话id>`，于是记录落在 subagent 的命名空间里；Lead 调
 * complete 时按 `team-<leadId>` 找不到记录，门禁拒绝 —— 整个验收流程走不通。
 *
 * 新算法：先按旧逻辑取自己的 key（Lead / teammate / 无团队根会话行为完全不变）；
 * 取不到时，找到该 agent 所属的根会话，返回「根会话自己会算出的 key」：
 *   - 团队根 → `team-<leadId>`
 *   - 无团队根 → `session-<rootSessionId>`（与根自己一致）
 * 所有服务调用都 try/catch，任何一环缺失都退回旧行为，绝不抛错。
 *
 * @param {object} ctx 插件上下文（只需要 `get`）
 * @param {{agent?: object}|undefined} exec 工具执行上下文
 * @returns {string}
 */
export function teamKey(ctx, exec) {
  const agent = exec?.agent;
  const own = keyForAgent(ctx, agent);
  if (own) return own; // Lead / teammate：完全不变

  const sid = agent?.session?.id ?? agent?.id;

  // 一次性 subagent：找到它所属的根会话，按「根会话自己会算出的 key」返回。
  try {
    const agents = ctx.get("agents");
    const roots = agents?.roots?.() ?? [];
    const root =
      roots.find((r) => r?.id === sid) ??
      roots.find((r) => {
        try {
          return agents.isOwnedBy?.(sid, r) === true;
        } catch {
          return false;
        }
      });
    if (root) {
      const rootKey = keyForAgent(ctx, root);
      if (rootKey) return rootKey;
      return `session-${root?.session?.id ?? root?.id ?? sid}`;
    }
  } catch {
    /* agents 服务不可用 */
  }

  return `session-${sid ?? "unknown"}`;
}
