/**
 * dsh-parallel-dev — 门禁决策的纯逻辑（不依赖任何服务 / 文件系统）。
 *
 * 把「该不该放行」从 IO 里剥出来，单测才能覆盖全部分支：
 * `scripts/check-host.mjs` 只 import 纯模块。
 *
 * 六种决策码（契约 §5.6）：
 *   waiver         用户豁免，直接放行
 *   no_record      没有验收记录
 *   not_passed     验收结论不是 passed
 *   head_unreadable 读不到被验收 worktree 的 HEAD
 *   sha_drift      验收后代码又被改过
 *   ok             全部通过
 */

export const GATE_CODES = Object.freeze([
  "waiver",
  "no_record",
  "not_passed",
  "head_unreadable",
  "sha_drift",
  "ok",
]);

function taskSubject(taskId) {
  return typeof taskId === "string" && taskId.length > 0 ? `任务 ${taskId} ` : "该任务";
}

/**
 * 判定一次 `team_task_update(action=complete)` 是否应该被放行。
 *
 * @param {object} prefs 归一化后的 8 字段配置（见 config.js normalizeConfig）
 * @param {object} context
 * @param {object|null} [context.waiver] 豁免记录
 * @param {object|null} [context.record] 验收记录
 * @param {{sha: string|null, reason?: string}|null} [context.head] worktree 的 HEAD
 * @param {string} [context.taskId] 任务 id（只用于文案，可省略）
 * @returns {{action: "allow"|"deny"|"advise", code: string, reason: string|null}}
 *
 * `gateMode` 只影响 deny 的落地方式：
 *   enforce → action="deny"（调用会被真的拒绝）
 *   advise  → action="advise"（放行，只留一行 console 提醒）
 * 因此除 `waiver` / `ok` 外的四种失败码在两种模式下都会出现。
 */
export function decideGate(prefs, context = {}) {
  const { waiver, record, head, taskId } = context ?? {};
  const mode = prefs?.gateMode === "advise" ? "advise" : "enforce";
  const denied = (code, reason) => ({
    action: mode === "enforce" ? "deny" : "advise",
    code,
    reason,
  });
  const subject = taskSubject(taskId);

  // 1. 用户豁免优先：用户亲自指示过的任务直接放行（记录已落盘，可审计）。
  if (waiver?.waived) return { action: "allow", code: "waiver", reason: null };

  // 2. 没有验收记录。
  if (!record) {
    return denied("no_record", `${subject}没有验收记录，不能标记为完成。`);
  }

  // 3. 验收结论不是 passed。
  if (record.verdict !== "passed") {
    const verifier = record.verifier_id ?? "未知验收方";
    const at = record.at ?? "未知时间";
    return denied(
      "not_passed",
      `${subject}的验收结论是 "${record.verdict}"（${verifier} 于 ${at}），不是 passed，不能标记为完成。`,
    );
  }

  // 4. 验收后代码又改过（只在配置要求、且记录带 worktree 时检查）。
  if (prefs?.requireCommitMatch === true && record.worktree) {
    if (!head?.sha) {
      return denied(
        "head_unreadable",
        `${subject}的验收记录指向 worktree「${record.worktree}」，` +
          `但现在读不到它的 HEAD（${head?.reason ?? "未知原因"}）。` +
          `无法确认交付物就是被验收的那一份，因此拒绝。`,
      );
    }
    if (head.sha !== record.commit_sha) {
      return denied(
        "sha_drift",
        `${subject}的代码在验收之后又被改过，不能标记为完成。\n` +
          `  验收记录的提交：${record.commit_sha}\n` +
          `  当前 HEAD：    ${head.sha}（${record.worktree}）\n\n` +
          `这说明验收过的版本已经不是交付的版本了 —— 这正是「验收通过」最容易失效的方式。`,
      );
    }
  }

  // 5. 全部通过。
  return { action: "allow", code: "ok", reason: null };
}
