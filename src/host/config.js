/**
 * dsh-parallel-dev — 配置的纯逻辑（不 import schemastery）。
 *
 * 为什么单独成文件：schema 需要 `@deepseek-ai/schemastery`，而单测
 * `scripts/check-host.mjs` 在没有 node_modules 的 worktree 里也要能跑。
 * 所以默认值、夹取、白名单校验放在这里，schema 放 `config-schema.js`。
 */

/** 8 个配置字段的默认值。默认全部保持 v0.2 的严格行为。 */
export const CONFIG_DEFAULTS = Object.freeze({
  injectPolicy: true,
  autoOpen: true,
  timelineEnabled: true,
  timelineMaxEntries: 60,
  gateMode: "enforce",
  requireEvidence: true,
  requireCommitMatch: true,
  blockSelfCertification: true,
});

/** 字段白名单（保持 CONFIG_DEFAULTS 的声明顺序）。 */
export const CONFIG_KEYS = Object.freeze(Object.keys(CONFIG_DEFAULTS));

/** 只接受布尔值的字段。 */
export const BOOLEAN_KEYS = Object.freeze([
  "injectPolicy",
  "autoOpen",
  "timelineEnabled",
  "requireEvidence",
  "requireCommitMatch",
  "blockSelfCertification",
]);

export const TIMELINE_MIN_ENTRIES = 10;
export const TIMELINE_MAX_ENTRIES = 500;

/** 门禁模式的合法取值。 */
export const GATE_MODES = Object.freeze(["enforce", "advise"]);

const CONFIG_KEYSET = new Set(CONFIG_KEYS);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 数字字段归一化：非有限数字回退默认；否则取整数并夹取到 10–500。
 * 夹取而不是报错 —— 这里服务的是读取路径（profile 里的值可能被手改坏）。
 */
export function normalizeTimelineMaxEntries(value, fallback = CONFIG_DEFAULTS.timelineMaxEntries) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value);
  if (integer < TIMELINE_MIN_ENTRIES) return TIMELINE_MIN_ENTRIES;
  if (integer > TIMELINE_MAX_ENTRIES) return TIMELINE_MAX_ENTRIES;
  return integer;
}

/** gateMode 非法值退回 enforce。 */
export function normalizeGateMode(value) {
  return value === "advise" ? "advise" : CONFIG_DEFAULTS.gateMode;
}

/**
 * 把任意来源的配置归一化成完整的 8 字段对象。
 *
 * 调用顺序：CONFIG_DEFAULTS 打底 → 叠加 loader config → 叠加 settings.describe
 * 的 value。每一层都可能缺字段或被手改，所以这里做「能用的用、不能用的回退」，
 * 永不抛错 —— 门禁和工具不能因为一条坏配置崩掉。
 */
export function normalizeConfig(input) {
  const out = { ...CONFIG_DEFAULTS };
  if (!isRecord(input)) return out;
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }
  out.timelineMaxEntries = normalizeTimelineMaxEntries(input.timelineMaxEntries);
  out.gateMode = normalizeGateMode(input.gateMode);
  return out;
}

function patchError(field, message) {
  return { ok: false, field, message };
}

/**
 * 校验一个写入 patch（契约 §3.4）。
 *
 * 与读取路径不同，写入必须严格：空 patch、未知 key、类型错误、越界一律拒绝，
 * 否则「保存成功」会悄悄把 profile 写坏。
 *
 * @param {unknown} patch
 * @returns {{ok: true, patch: object} | {ok: false, field: string|null, message: string}}
 */
export function validatePatch(patch) {
  if (!isRecord(patch)) return patchError(null, "patch 必须是 JSON 对象。");
  const keys = Object.keys(patch);
  if (keys.length === 0) return patchError(null, "patch 不能为空。");

  const clean = {};
  for (const key of keys) {
    if (!CONFIG_KEYSET.has(key)) return patchError(key, `未知配置项：${key}`);
    const value = patch[key];

    if (key === "timelineMaxEntries") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return patchError(key, "每任务保留条数必须是整数。");
      }
      if (value < TIMELINE_MIN_ENTRIES || value > TIMELINE_MAX_ENTRIES) {
        return patchError(key, `每任务保留条数必须在 ${TIMELINE_MIN_ENTRIES}–${TIMELINE_MAX_ENTRIES} 之间。`);
      }
      clean[key] = value;
      continue;
    }

    if (key === "gateMode") {
      if (value !== "enforce" && value !== "advise") {
        return patchError(key, "门禁模式只能是 enforce 或 advise。");
      }
      clean[key] = value;
      continue;
    }

    if (typeof value !== "boolean") return patchError(key, `${key} 必须是布尔值。`);
    clean[key] = value;
  }
  return { ok: true, patch: clean, field: null, message: null };
}

/**
 * 只保留白名单字段（用于把 settings.describe 的 user 覆盖层投影成稳定形状）。
 * 未知字段丢弃，不报错。
 */
export function pickKnownFields(input) {
  const out = {};
  if (!isRecord(input)) return out;
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  return out;
}
