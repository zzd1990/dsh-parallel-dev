/**
 * dsh-parallel-dev — 配置 schema。
 *
 * 单独成文件的原因（契约 §3.1）：这里 import `@deepseek-ai/schemastery`，
 * 而单测环境（worktree 无 node_modules）不能加载它。纯逻辑放 `config.js`。
 *
 * 8 个字段全部 `.volatile()`：设置页保存后即时生效，不重载插件。
 * 保存由 `settings.update()` 写进当前 profile 的 `cordis.patch.yml`，本插件
 * 不直接写那个文件。
 */
import z from "@deepseek-ai/schemastery";

export const Config = z.object({
  injectPolicy: z.boolean().default(true).volatile(),
  autoOpen: z.boolean().default(true).volatile(),
  timelineEnabled: z.boolean().default(true).volatile(),
  timelineMaxEntries: z.number().step(1).min(10).max(500).default(60).volatile(),
  gateMode: z.union([z.const("enforce"), z.const("advise")]).default("enforce").volatile(),
  requireEvidence: z.boolean().default(true).volatile(),
  requireCommitMatch: z.boolean().default(true).volatile(),
  blockSelfCertification: z.boolean().default(true).volatile(),
});
