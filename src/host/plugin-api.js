/**
 * dsh-parallel-dev — 设置页的 Host 接口（契约 §4.2 / §4.3 / §5.8 / §5.9）。
 *
 * 两个只读/写入接口：
 *   GET  /pdev/plugin/status  插件自身状态 + 配置视图 + 插件事件
 *   POST /pdev/plugin/config  写配置（settings.update，带修订号保护）
 *
 * 边界（契约 §0）：这里只展示「插件自身」——版本、运行条件、安装信息、
 * 插件事件、配置。**绝不出现任务、团队、验收记录、豁免记录、门禁决定流水**；
 * 那些是看板的职责。事件环形缓冲也只记插件自身。
 */
import { CONFIG_DEFAULTS, validatePatch } from "./config.js";
import { PDEV_POLICY_NAME, PDEV_POLICY_ORDER } from "./policy.js";

export const PLUGIN_NAME = "dsh-parallel-dev";
export const PLUGIN_VERSION = "0.3.0";
export const PLUGIN_DESCRIPTION =
  "DSH 并行开发编排插件：让「智能体团队模式并行开发」从建议变成有门禁、可校验的机制。";
export const NODE_ENGINE = ">=20";

/** 插件事件环形缓冲容量（契约 §5.8）。 */
export const MAX_EVENTS = 50;

/** 状态页工具列表的展示顺序（契约 §4.2 示例顺序，与注册顺序无关）。 */
const TOOL_ORDER = [
  "pdev_preflight",
  "pdev_verify_record",
  "pdev_waive",
  "pdev_gate_status",
  "pdev_board",
];

/** POST 请求体上限：配置 patch 很小，1MB 足够且能挡住误发的巨型请求。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 插件事件环形缓冲。只记插件自身（加载、门禁安装、提示词、路由、配置保存、
 * 时间线落盘失败……），不记任务流水。
 */
export function createEventLog(max = MAX_EVENTS) {
  const events = [];
  return {
    log(level, message) {
      const safeLevel = level === "warn" || level === "error" ? level : "info";
      events.push({ at: new Date().toISOString(), level: safeLevel, message: String(message ?? "") });
      if (events.length > max) events.splice(0, events.length - max);
    },
    /** 时间升序返回（页面自己倒序展示）。 */
    list() {
      return events.slice();
    },
    get size() {
      return events.length;
    },
  };
}

/**
 * 组装配置视图（契约 §3.5）。接口与页面共用同一形状。
 *
 * @param {object} input
 * @param {object} [input.value] 生效值（已 normalize）
 * @param {object} [input.user] profile 覆盖层
 * @param {number|null} [input.revision]
 * @param {boolean} [input.writable]
 * @param {string|null} [input.readonlyReason]
 * @param {"settings"|"captured"} [input.source]
 * @param {string} [input.entryId]
 */
export function buildConfigView(input = {}) {
  const source = input?.value;
  const value = { ...CONFIG_DEFAULTS };
  if (source && typeof source === "object" && !Array.isArray(source)) {
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (source[key] !== undefined) value[key] = source[key];
    }
  }

  const user = {};
  if (input?.user && typeof input.user === "object" && !Array.isArray(input.user)) {
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(input.user, key)) user[key] = input.user[key];
    }
  }

  const writable = input?.writable === true;
  const readonlyReason = writable
    ? null
    : typeof input?.readonlyReason === "string" && input.readonlyReason
      ? input.readonlyReason
      : "当前 profile 的设置服务不可用";

  return {
    value,
    defaults: { ...CONFIG_DEFAULTS },
    user,
    revision: Number.isSafeInteger(input?.revision) ? input.revision : null,
    writable,
    readonlyReason,
    source: input?.source === "settings" ? "settings" : "captured",
    entryId: typeof input?.entryId === "string" && input.entryId ? input.entryId : "parallel-dev",
  };
}

/** 读一个 JSON 请求体；解析失败 / 超限都 reject，由调用方转成 400。 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(new Error("请求体过大"));
        try { req.destroy?.(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", (error) => fail(error));
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "未知错误");
}

function errorCode(error) {
  if (typeof error !== "object" || error === null) return null;
  return typeof error.code === "string" ? error.code : null;
}

function isConflict(error) {
  return (
    errorCode(error) === "SETTINGS_CONFLICT" ||
    error?.name === "SettingsConflictError" ||
    errorCode(error) === "settings-stale"
  );
}

/**
 * 组装两个 HTTP handler。
 *
 * 所有外部事实通过 deps 注入（服务探测、路径、配置读写），这样 index.js 负责
 * 接线、本文件负责协议形状，错误路径也只在这里收口。
 */
export function createPluginApi(deps) {
  const d = deps ?? {};
  const logEvent = typeof d.logEvent === "function" ? d.logEvent : () => {};

  function safeConfigView() {
    try {
      const view = d.configView?.();
      return view && typeof view === "object" ? view : fallbackView();
    } catch (error) {
      logEvent("error", `读取配置状态失败：${errorMessage(error)}`);
      return fallbackView();
    }
  }

  function fallbackView() {
    let entryId = "parallel-dev";
    try {
      const value = d.entryId?.();
      if (typeof value === "string" && value) entryId = value;
    } catch { /* 保持默认 */ }
    return buildConfigView({
      value: CONFIG_DEFAULTS,
      user: {},
      revision: null,
      writable: false,
      readonlyReason: "当前无法读取配置状态",
      source: "captured",
      entryId,
    });
  }

  function safeTools() {
    try {
      const tools = d.tools?.();
      if (!Array.isArray(tools)) return [];
      const order = new Map(TOOL_ORDER.map((name, index) => [name, index]));
      return tools
        .filter((tool) => tool && typeof tool.name === "string")
        .map((tool) => ({
          name: tool.name,
          summary: String(tool.summary ?? ""),
          rank: order.get(tool.name) ?? TOOL_ORDER.length,
        }))
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        .map(({ name, summary }) => ({ name, summary }));
    } catch {
      return [];
    }
  }

  function safeServices() {
    const names = ["tools", "webServer", "settings", "systemPrompt", "agentTeams"];
    const out = {};
    let raw = {};
    try {
      raw = d.services?.() ?? {};
    } catch {
      raw = {};
    }
    for (const name of names) out[name] = raw?.[name] === true;
    return out;
  }

  function safePaths() {
    let raw = {};
    try {
      raw = d.paths?.() ?? {};
    } catch {
      raw = {};
    }
    const pathOf = (key) => (typeof raw?.[key] === "string" && raw[key] ? raw[key] : null);
    return {
      packageDir: pathOf("packageDir"),
      profileDir: pathOf("profileDir"),
      patchFile: pathOf("patchFile"),
      dataDir: pathOf("dataDir"),
    };
  }

  function uptimeMs(boot) {
    const loadedAt = boot?.loadedAt;
    if (typeof loadedAt !== "string") return null;
    const started = Date.parse(loadedAt);
    if (!Number.isFinite(started)) return null;
    return Math.max(0, Date.now() - started);
  }

  /** 契约 §4.2 的完整响应体。 */
  function buildStatus() {
    const boot = d.boot ?? {};
    const policyStatus = ["injected", "disabled", "skipped", "failed"].includes(boot.policyStatus)
      ? boot.policyStatus
      : "skipped";
    const boardStatus = ["registered", "failed", "skipped"].includes(boot.boardStatus)
      ? boot.boardStatus
      : "skipped";
    return {
      plugin: {
        name: PLUGIN_NAME,
        version: PLUGIN_VERSION,
        description: PLUGIN_DESCRIPTION,
        loadedAt: typeof boot.loadedAt === "string" ? boot.loadedAt : null,
        uptimeMs: uptimeMs(boot),
        nodeVersion: process.version,
        nodeEngine: NODE_ENGINE,
      },
      host: {
        gateInstalled: boot.gateInstalled === true,
        tools: safeTools(),
        policy: {
          status: policyStatus,
          name: PDEV_POLICY_NAME,
          order: PDEV_POLICY_ORDER,
          detail: typeof boot.policySection === "string" ? boot.policySection : "not attempted",
        },
        board: {
          status: boardStatus,
          path: "/pdev/board",
          detail: typeof boot.boardRoute === "string" ? boot.boardRoute : "not attempted",
        },
        services: safeServices(),
      },
      config: safeConfigView(),
      paths: safePaths(),
      events: (d.events?.list?.() ?? []).slice(-MAX_EVENTS),
    };
  }

  function forbidden(res) {
    d.sendJson(res, 403, { ok: false, code: "forbidden", message: "forbidden" });
  }

  /** GET /pdev/plugin/status */
  async function handleStatus(req, res) {
    try {
      if (typeof d.sameOriginOk === "function" && !d.sameOriginOk(req)) return forbidden(res);
      if (req?.method !== "GET") {
        d.sendJson(res, 405, { ok: false, code: "method-not-allowed", message: "只支持 GET。" });
        return;
      }
      d.sendJson(res, 200, buildStatus());
    } catch (error) {
      logEvent("error", `插件状态接口未处理异常：${errorMessage(error)}`);
      try {
        d.sendJson(res, 500, { ok: false, code: "internal", message: "读取插件状态失败。" });
      } catch { /* 响应可能已经开始写 */ }
    }
  }

  /**
   * POST /pdev/plugin/config
   * 请求：{ patch: {...}, expectedRevision?: number }
   * 200 | 400 invalid | 409 stale | 503 settings-unavailable
   */
  async function handleConfig(req, res) {
    try {
      if (typeof d.sameOriginOk === "function" && !d.sameOriginOk(req)) return forbidden(res);
      if (req?.method !== "POST") {
        d.sendJson(res, 405, { ok: false, code: "method-not-allowed", message: "只支持 POST。" });
        return;
      }

      // POST 额外要求（契约 §4.1）：content-type 必须是 JSON；带 Origin 时 host 必须完全一致。
      const contentType = String(req?.headers?.["content-type"] ?? "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        d.sendJson(res, 400, {
          ok: false,
          code: "invalid",
          message: "content-type 必须是 application/json。",
          field: null,
        });
        return;
      }
      const origin = req?.headers?.origin;
      if (origin !== undefined) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost === null || originHost !== String(req?.headers?.host ?? "")) {
          forbidden(res);
          return;
        }
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        d.sendJson(res, 400, {
          ok: false,
          code: "invalid",
          message: `请求体解析失败：${errorMessage(error)}`,
          field: null,
        });
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        d.sendJson(res, 400, { ok: false, code: "invalid", message: "请求体必须是 JSON 对象。", field: null });
        return;
      }

      const validated = validatePatch(body.patch);
      if (!validated || validated.ok !== true) {
        d.sendJson(res, 400, {
          ok: false,
          code: "invalid",
          message: validated?.message ?? "配置 patch 非法。",
          field: validated?.field ?? null,
        });
        return;
      }

      let expectedRevision;
      if (body.expectedRevision !== undefined && body.expectedRevision !== null) {
        if (
          typeof body.expectedRevision !== "number" ||
          !Number.isSafeInteger(body.expectedRevision) ||
          body.expectedRevision < 0
        ) {
          d.sendJson(res, 400, {
            ok: false,
            code: "invalid",
            message: "expectedRevision 必须是非负整数。",
            field: "expectedRevision",
          });
          return;
        }
        expectedRevision = body.expectedRevision;
      }

      try {
        const config = await d.updateConfig?.(validated.patch, expectedRevision);
        logEvent("info", `配置已保存：${Object.keys(validated.patch).join("、")}`);
        d.sendJson(res, 200, { ok: true, config });
      } catch (error) {
        if (isConflict(error)) {
          logEvent("warn", "配置保存失败：修订冲突（配置已被其他地方修改）");
          let config = null;
          try {
            d.invalidatePrefs?.();
            config = safeConfigView();
          } catch { /* 落回下面的兜底 */ }
          d.sendJson(res, 409, {
            ok: false,
            code: "stale",
            message: "配置已被其他地方修改，请刷新后重试。",
            config,
          });
          return;
        }
        if (errorCode(error) === "settings-unavailable") {
          logEvent("warn", "配置保存失败：设置服务不可用");
          d.sendJson(res, 503, {
            ok: false,
            code: "settings-unavailable",
            message: errorMessage(error) || "当前 profile 的设置服务不可用。",
          });
          return;
        }
        logEvent("warn", `配置保存失败：${errorMessage(error)}`);
        d.sendJson(res, 400, {
          ok: false,
          code: "invalid",
          message: errorMessage(error),
          field: null,
        });
      }
    } catch (error) {
      logEvent("error", `配置接口未处理异常：${errorMessage(error)}`);
      try {
        d.sendJson(res, 500, { ok: false, code: "internal", message: "保存配置失败。" });
      } catch { /* 响应可能已经开始写 */ }
    }
  }

  return { handleStatus, handleConfig, buildStatus };
}
