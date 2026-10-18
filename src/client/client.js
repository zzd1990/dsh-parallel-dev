/**
 * dsh-parallel-dev — 浏览器半边。
 *
 * 两件事：
 *
 * 1. **侧栏看板面板**：不自己画画，iframe 承载 `/pdev/board?embed=1`。
 *    web 页本来就是响应式的：容器 <560px 渲染紧凑迷你图，≥560px 渲染完整依赖图，
 *    再宽还有时间轴。渲染代码只剩一份，改一次两处都变。
 *
 * 2. **设置页「并行开发配置」**（v0.3）：只展示/配置**插件自身**——
 *    插件状态、运行条件、安装信息、插件提供的能力、最近插件事件，以及 8 项配置。
 *    不展示任何任务、团队、验收记录；那些是看板的职责。
 *
 * 仍然手写而不引入构建链：客户端插件就是 `window.__ModuleLoader__.load({id, factory})`
 * 这个外壳，用 `React.createElement` 代替 JSX 就完全不需要打包。
 *
 * 注册契约（读源码确认的）：看板是 **page type**（不是"把文件/URL 打开成 tab"的 viewer），
 * 所以不声明 `patterns`/`canOpen`，按 `kind` 打开，靠 `guide` 在侧栏入口列表里出现一个胶囊。
 */
window.__ModuleLoader__.load({
  id: "dsh-parallel-dev",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** 这个实现的唯一身份；正文与标题的座位 key 都用它。 */
    const TAB_ID = "dsh-parallel-dev:board";
    /** 类型判别符，`openTab` 按它打开。 */
    const TAB_KIND = "parallel-dev-board";
    /** 看板页地址；`embed=1` 去掉外边距与重复标题，`theme=` 由下面按宿主主题拼。 */
    const BOARD_URL = "/pdev/board?embed=1";

    /** 客户端版本，与 package.json / Host 保持一致（契约 §6.1）。 */
    const CLIENT_VERSION = "0.3.0";

    /**
     * 注入给设置页的客户端信息。
     *
     * 用**同一个对象**（而不是每次 inject 重新拼一个字面量），这样 apply() 里
     * tab 注册成功后原地把 `tabRegistered` 置 true，设置页读到的一定是最新值。
     */
    const clientInfo = { version: CLIENT_VERSION, tabRegistered: false };

    // ─────────────────────────────────────────────────────────────
    // 文案表（契约 §7，冻结）
    // ─────────────────────────────────────────────────────────────

    const TEXT = Object.freeze({
      nav: "并行开发配置",
      title: "并行开发配置",
      subtitle: "让「智能体团队模式并行开发」从建议变成有门禁、可校验的机制",
      statusTitle: "插件状态",
      conditionsTitle: "运行条件",
      pathsTitle: "安装信息",
      featuresTitle: "插件提供",
      eventsTitle: "最近插件事件",
      configTitle: "配置",
      refresh: "重新检查",
      copyDiag: "复制诊断信息",
      save: "保存",
      saving: "保存中…",
      reset: "恢复默认",
      saved: "已保存 · 修订 {n}",
      confirmWeaken: "确认保存（会放宽门禁）",
      weakenBanner: "当前配置会放宽验收门禁：{fields}。这会让「完成」的可信度下降，请确认这是你要的。",
      readonlyBanner: "当前 profile 的设置服务不可用，本页只能查看。修改请编辑 profile 的 cordis.patch.yml。",
      conflict: "配置已被其他地方修改，已刷新为最新值，请重新修改。",
      loadError: "读不到插件状态：{message}。可能原因：Host 半边还没重启、当前 profile 没挂 host-webserver，或 /pdev/plugin/status 注册失败。",
      loading: "正在读取插件状态…",
      emptyEvents: "本进程还没有插件事件。",
      expand: "展开全部",
      collapse: "收起",
      registered: "已注册",
      injected: "已注入",
      disabled: "已关闭",
      skipped: "已跳过",
      failed: "失败",
      present: "可用",
      absent: "不可用",
    });

    /** 把 `{name}` 占位符替换成值；缺字段时保留原样，方便一眼看出漏传。 */
    function format(template, vars) {
      return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, function (whole, key) {
        return vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole;
      });
    }

    // ─────────────────────────────────────────────────────────────
    // 配置模型（契约 §3.1 / §3.2，只用于渲染与比较，不负责持久化）
    // ─────────────────────────────────────────────────────────────

    const CONFIG_DEFAULTS = Object.freeze({
      injectPolicy: true,
      autoOpen: true,
      timelineEnabled: true,
      timelineMaxEntries: 60,
      gateMode: "enforce",
      requireEvidence: true,
      requireCommitMatch: true,
      blockSelfCertification: true,
    });

    const CONFIG_KEYS = Object.freeze([
      "injectPolicy",
      "autoOpen",
      "timelineEnabled",
      "timelineMaxEntries",
      "gateMode",
      "requireEvidence",
      "requireCommitMatch",
      "blockSelfCertification",
    ]);

    /** 配置分组与字段说明（契约 §7「配置分组」）；页面顺序即此数组顺序。 */
    const CONFIG_GROUPS = Object.freeze([
      {
        title: "功能",
        fields: [
          { key: "injectPolicy", type: "switch", label: "注入编排纪律到系统提示", desc: "让模型自动遵守团队并行开发纪律" },
          { key: "autoOpen", type: "switch", label: "自动打开看板", desc: "检测到未完成任务时在侧栏打开看板" },
        ],
      },
      {
        title: "时间线",
        fields: [
          { key: "timelineEnabled", type: "switch", label: "记录任务时间线", desc: "保存状态变更时刻，供看板时间轴使用" },
          { key: "timelineMaxEntries", type: "number", label: "每任务保留条数", desc: "内存中每个任务最多保留多少条（10–500）" },
        ],
      },
      {
        title: "验收门禁",
        fields: [
          { key: "gateMode", type: "radio", label: "门禁模式", desc: "拦截 / 仅提醒（不拒绝，只记录）" },
          { key: "requireEvidence", type: "checkbox", label: "要求可定位证据", desc: "没有证据的验收记录不接受" },
          { key: "requireCommitMatch", type: "checkbox", label: "验收后代码不得改动", desc: "提交与验收时不一致就拒绝完成" },
          { key: "blockSelfCertification", type: "checkbox", label: "禁止自己验收自己", desc: "实施方不能给自己登记验收记录" },
        ],
      },
    ]);

    /** key → 字段元信息，400 的字段错误与放宽提示都要用 label。 */
    const FIELD_META = {};
    CONFIG_GROUPS.forEach(function (group) {
      group.fields.forEach(function (field) { FIELD_META[field.key] = field; });
    });

    /** 运行条件（契约 §7「运行条件影响」）。 */
    const SERVICES = Object.freeze([
      { key: "tools", label: "工具注册（tools）", impact: "插件无法加载（硬依赖）" },
      { key: "webServer", label: "Web 服务（webServer）", impact: "看板页与本页数据接口不可用" },
      { key: "settings", label: "设置服务（settings）", impact: "配置只读，只能改 cordis.patch.yml" },
      { key: "systemPrompt", label: "系统提示（systemPrompt）", impact: "无法注入编排纪律，其它功能正常" },
      { key: "agentTeams", label: "智能体团队（agentTeams）", impact: "团队任务相关工具不可用" },
    ]);

    /** 设置页刷新间隔（契约 §6.3）。 */
    const STATUS_POLL_MS = 10_000;
    /** 事件默认展示条数 / 展开后的上限。 */
    const EVENTS_DEFAULT = 8;
    const EVENTS_MAX = 20;

    // ─────────────────────────────────────────────────────────────
    // 通用小工具
    // ─────────────────────────────────────────────────────────────

    function isObject(value) {
      return value !== null && typeof value === "object";
    }

    /** 页面上显示一个值；空值统一显示破折号，避免出现 "undefined"。 */
    function str(value) {
      return value === undefined || value === null || value === "" ? "—" : String(value);
    }

    function pad2(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function fmtTime(value) {
      if (!value) return "—";
      const date = new Date(value);
      if (isNaN(date.getTime())) return String(value);
      return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
        + " " + pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
    }

    function fmtUptime(ms) {
      const total = Number(ms);
      if (!Number.isFinite(total) || total < 0) return "—";
      const seconds = Math.floor(total / 1000);
      if (seconds < 60) return seconds + " 秒";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + " 分钟";
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + " 小时 " + (minutes % 60) + " 分钟";
      return Math.floor(hours / 24) + " 天 " + (hours % 24) + " 小时";
    }

    /** 把服务端返回的 config.value / config.defaults 补齐成完整 8 字段。 */
    function configValue(raw) {
      const out = {};
      for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
        const key = CONFIG_KEYS[i];
        const has = isObject(raw) && Object.prototype.hasOwnProperty.call(raw, key);
        out[key] = normalizeField(key, has ? raw[key] : CONFIG_DEFAULTS[key]);
      }
      return out;
    }

    function normalizeField(key, value) {
      if (key === "timelineMaxEntries") {
        const n = Number(value);
        if (!Number.isFinite(n)) return CONFIG_DEFAULTS[key];
        return Math.min(500, Math.max(10, Math.round(n)));
      }
      if (key === "gateMode") return value === "advise" ? "advise" : "enforce";
      if (value === true || value === false) return value;
      return CONFIG_DEFAULTS[key];
    }

    /** 表单里数字字段用**字符串**保存，允许用户把输入框清空；提交前再解析。 */
    function formFromValue(value) {
      const form = {};
      for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
        const key = CONFIG_KEYS[i];
        form[key] = key === "timelineMaxEntries" ? String(value[key]) : value[key];
      }
      return form;
    }

    function parseTimelineMax(raw) {
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
      const text = String(raw === undefined || raw === null ? "" : raw).trim();
      if (text === "") return null;
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }

    function timelineValid(raw) {
      const n = parseTimelineMax(raw);
      return typeof n === "number" && Number.isInteger(n) && n >= 10 && n <= 500;
    }

    function formToValue(form) {
      const out = {};
      for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
        const key = CONFIG_KEYS[i];
        out[key] = key === "timelineMaxEntries" ? parseTimelineMax(form[key]) : form[key];
      }
      return out;
    }

    /** 表单相对已保存值是否有改动（数字字段按数值比较，不因 "60" vs 60 误判）。 */
    function formDirty(form, saved) {
      if (!isObject(form) || !isObject(saved)) return false;
      for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
        const key = CONFIG_KEYS[i];
        const left = key === "timelineMaxEntries" ? parseTimelineMax(form[key]) : form[key];
        if (left !== saved[key]) return true;
      }
      return false;
    }

    /** 返回表单里所有会放宽门禁的字段（中文标签），空数组表示不放宽。 */
    function weakenFields(form) {
      const out = [];
      if (form.gateMode === "advise") out.push("门禁模式改为「仅提醒」");
      if (form.requireEvidence === false) out.push("关闭「要求可定位证据」");
      if (form.requireCommitMatch === false) out.push("关闭「验收后代码不得改动」");
      if (form.blockSelfCertification === false) out.push("关闭「禁止自己验收自己」");
      return out;
    }

    /** 读 JSON；不是 JSON（例如 404 的纯文本）时返回 null，不抛错。 */
    function readJsonSafe(response) {
      return response.text().then(function (text) {
        if (!text) return null;
        try { return JSON.parse(text); } catch (error) { return null; }
      });
    }

    function messageOf(error) {
      if (!error) return "未知错误";
      if (error.message) return error.message;
      return String(error);
    }

    // ─────────────────────────────────────────────────────────────
    // 侧栏看板面板（v0.2 行为保持不变）
    // ─────────────────────────────────────────────────────────────

    /**
     * 宿主当前主题。
     *
     * DSH 在 `<body>` 上挂 `data-ds-dark-theme` 表示暗色（见 ui-theme 的 boot-theme）。
     * 看板页自己有浅色/暗色两套调色板，把宿主的主题传进去，嵌在侧栏里才不会像贴了块补丁。
     */
    function appTheme() {
      try {
        return document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "light";
      } catch (error) {
        return "light";
      }
    }

    /** 跟随宿主主题：用户切明暗时 iframe 也要跟着换。 */
    function useAppTheme() {
      const [theme, setTheme] = React.useState(appTheme);
      React.useEffect(() => {
        const observer = new MutationObserver(() => setTheme(appTheme()));
        observer.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
        return () => observer.disconnect();
      }, []);
      return theme;
    }

    /**
     * 面板正文：一个铺满的 iframe。
     *
     * 尺寸用绝对定位铺满而不是 `height:100%`：侧栏给组件的容器不保证有确定高度，
     * `height:100%` 会塌成 0；绝对定位 + 一个 minHeight 兜底更稳。
     *
     * `sessionId` 由座位注入（`inject: (sessionId) => ({ sessionId })`）——
     * **必须传给 iframe**，否则多个会话的侧栏会请求同一个地址，
     * 服务端只能退回"全局第一个团队"，两个会话就都看到别人的看板了。
     */
    function BoardPanel(props) {
      const theme = useAppTheme();
      const sessionId = props && props.sessionId;
      const src = BOARD_URL + "&theme=" + theme
        + (sessionId ? "&session=" + encodeURIComponent(String(sessionId)) : "");
      return h("div", {
        style: { position: "relative", width: "100%", height: "100%", minHeight: "320px" },
      }, h("iframe", {
        src: src,
        title: "并行开发看板",
        style: {
          position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
          width: "100%", height: "100%", border: 0, background: "transparent",
        },
      }));
    }

    /** tab 芯片上的短标题。 */
    function BoardTitle() {
      return h("span", null, "并行开发");
    }

    // ─────────────────────────────────────────────────────────────
    // 自动打开（v0.3：配置优先，localStorage 旧标记迁移）
    // ─────────────────────────────────────────────────────────────

    /** 本次浏览器会话是否已经自动开过（关掉页面就重置——下次会话再给一次机会）。 */
    const FIRED_KEY = "pdev-auto-open-fired";
    /** v0.2 的用户拒绝标记；v0.3 起由配置 autoOpen 接管，启动时迁移。 */
    const OPTOUT_KEY = "pdev-auto-open-off";
    /** 自动打开后多久内被关掉算"用户不要"。 */
    const DISMISS_WINDOW_MS = 60_000;
    /** 轮询间隔。只在还没开过的时候轮询，开了就停。 */
    const POLL_MS = 15_000;

    function readFlag(storage, key) {
      try { return storage.getItem(key) === "1"; } catch (error) { return false; }
    }
    function writeFlag(storage, key, value) {
      try { storage.setItem(key, value ? "1" : "0"); } catch (error) { /* 隐私模式，忽略 */ }
    }
    function removeFlag(storage, key) {
      try { storage.removeItem(key); } catch (error) { /* 隐私模式，忽略 */ }
    }

    /**
     * v0.2 的"关掉就不再自动打开"标记迁移成 v0.3 的配置项。
     *
     * 旧标记是 localStorage 里的跨会话开关，新配置在 profile 的 cordis.patch.yml。
     * 写成功后删除旧标记；写失败（老 Host 没有该路由 / 设置服务不可用）就保留旧标记，
     * 自动打开继续按旧标记抑制 —— 降级，而不是把用户的拒绝弄丢。
     */
    function migrateAutoOpenOptout() {
      if (!readFlag(localStorage, OPTOUT_KEY)) return;
      if (typeof fetch !== "function") return;
      try {
        fetch("/pdev/plugin/config", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ patch: { autoOpen: false } }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            removeFlag(localStorage, OPTOUT_KEY);
            console.log("[dsh-parallel-dev] 旧的「不再自动打开」标记已迁移为配置 autoOpen=false");
          })
          .catch(function (error) {
            console.warn("[dsh-parallel-dev] autoOpen 迁移失败，保留旧标记:", messageOf(error));
          });
      } catch (error) {
        console.warn("[dsh-parallel-dev] autoOpen 迁移异常，保留旧标记:", messageOf(error));
      }
    }

    /**
     * 屏幕上当前是哪个会话。
     *
     * 自动打开必须先知道这个 —— 否则"有任务就开"会变成
     * "别人的会话有任务，却在你这里弹一个空看板"。
     */
    function mountedSession(ctx) {
      try {
        const m = ctx.sidebarRight && ctx.sidebarRight.mounted;
        const v = m && m.getSnapshot ? m.getSnapshot() : null;
        return v ?? null;
      } catch (error) {
        return null;
      }
    }

    /** 我的 tab 当前开着吗。`openTabs` 是 ObservableSnapshot：getSnapshot() + subscribe()。 */
    function boardTabOpen(ctx) {
      try {
        const source = ctx.sidebarRight && ctx.sidebarRight.openTabs;
        const list = source && source.getSnapshot ? source.getSnapshot() : null;
        if (!list) return false;
        const arr = Array.isArray(list) ? list : (list.tabs ?? []);
        return arr.some((tab) => tab && tab.kind === TAB_KIND);
      } catch (error) {
        return false;
      }
    }

    /**
     * 第一个团队任务出现时，自动把看板开起来 —— 只开一次。
     *
     * 为什么挑这个时机（而不是会话一开始就开）：绝大多数会话不搞并行开发，
     * 每次都弹一个空看板就是骚扰。任务真的出现了才开，那叫"正好需要"。
     *
     * 怎么退订：**v0.3 起由设置页的 autoOpen 配置决定**；v0.2 的 localStorage
     * 旧标记在启动时迁移成配置，迁移失败则继续沿用旧标记（见 migrateAutoOpenOptout）。
     *
     * 触发过一次就停止轮询 —— 不会反复弹。
     */
    function installAutoOpen(ctx) {
      if (readFlag(localStorage, OPTOUT_KEY)) return;
      if (readFlag(sessionStorage, FIRED_KEY)) return;

      let stopped = false;
      let timer = null;
      let unsubscribe = null;

      const stopPolling = () => {
        if (timer !== null) { clearInterval(timer); timer = null; }
      };

      const stop = () => {
        stopped = true;
        stopPolling();
        if (unsubscribe) { try { unsubscribe(); } catch (error) { /* 忽略 */ } }
        unsubscribe = null;
      };

      const fire = () => {
        if (stopped) return;
        stopPolling();          // 先停轮询，否则每 15 秒会再开一次
        try {
          ctx.sidebarRight.openTab(TAB_KIND);
        } catch (error) {
          console.warn("[dsh-parallel-dev] 自动打开看板失败:", error && error.message);
          stop();
          return;
        }
        writeFlag(sessionStorage, FIRED_KEY, true);
        console.log("[dsh-parallel-dev] 检测到团队任务，已自动打开看板");

        // 盯着：短时间内被关掉 = 用户不要，以后别再弹
        const openedAt = Date.now();
        let wasOpen = true;
        try {
          unsubscribe = ctx.sidebarRight.openTabs.subscribe(() => {
            const now = boardTabOpen(ctx);
            if (wasOpen && !now) {
              if (Date.now() - openedAt < DISMISS_WINDOW_MS) {
                writeFlag(localStorage, OPTOUT_KEY, true);
                console.log("[dsh-parallel-dev] 看板被关掉，以后不再自动打开（v0.3 会在下次启动时迁移为 autoOpen=false）");
              }
              stop();
            }
            wasOpen = now;
          });
        } catch (error) {
          // 订阅不上也不影响已经打开这件事，停止轮询即可
          stop();
        }
      };

      const tick = () => {
        if (stopped) return;
        // 注意：这里**不要**因为"我的 tab 在 openTabs 里"就提前停止。
        // openTabs 的语义是"跨已保存和已采纳会话的 tab 元数据"，它包含别的会话、
        // 甚至已保存布局里的旧记录 —— 实测因此误判成"已经开着"，一次都没开成。
        // 真正要防的是重复打开，那由 FIRED_KEY（本次会话只开一次）负责。
        //
        // 只看**屏幕上这个会话**：不知道是谁就先跳过，免得替别人的团队弹看板。
        const sid = mountedSession(ctx);
        if (!sid) return;
        const url = "/pdev/board/data?session=" + encodeURIComponent(String(sid));
        fetch(url, { headers: { accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (stopped || !d) return;
            // v0.3：配置明确关闭就不触发；字段缺失（老 Host）按 true 处理，向后兼容。
            if (d.prefs && d.prefs.autoOpen === false) return;
            // 只在"还有没做完的任务"时开。
            // 整个 DAG 都完成了就不打扰 —— 那时候看板没有正在发生的事，弹出来只是噪音。
            // unfinished 由服务端算好（含 pending / in_progress / review / needs_fix）；
            // 拿不到就退化成 total - completed —— 客户端能热更新而服务端要重启，
            // 这两半版本不一致是常态，不能让功能静默失效。
            const s = d.summary || {};
            const unfinished = s.unfinished ?? ((s.total || 0) - (s.completed || 0));
            if (unfinished > 0) fire();
          })
          .catch(() => { /* 端点不可用（没挂 webServer 之类）→ 静默跳过这一轮 */ });
      };

      tick();
      timer = setInterval(tick, POLL_MS);
      return stop;
    }

    // ─────────────────────────────────────────────────────────────
    // 设置页「并行开发配置」
    // ─────────────────────────────────────────────────────────────

    /** 设置页样式。只用 `--dsw-alias-*` 主题 token，明暗自动跟随；类名前缀 pdev-cfg-。 */
    const CSS_TEXT = `
.pdev-cfg-root{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.pdev-cfg-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.pdev-cfg-headerText{display:flex;flex-direction:column;gap:6px;min-width:0}
.pdev-cfg-title{margin:0;font-size:18px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pdev-cfg-subtitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.pdev-cfg-version{flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.pdev-cfg-card{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:18px}
.pdev-cfg-cardHead{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:4px}
.pdev-cfg-cardTitle{margin:0;font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}
.pdev-cfg-cardDesc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.pdev-cfg-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pdev-cfg-row:last-child{border-bottom:none}
.pdev-cfg-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}
.pdev-cfg-rowLabel{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.pdev-cfg-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.pdev-cfg-rowControl{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0;max-width:62%}
.pdev-cfg-rowValue{min-width:0;color:var(--dsw-alias-label-secondary);text-align:right;overflow-wrap:anywhere}
.pdev-cfg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px}
.pdev-cfg-pill{display:inline-flex;align-items:center;gap:4px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;font-weight:500;white-space:nowrap}
.pdev-cfg-pillOk{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.pdev-cfg-pillWarn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pdev-cfg-pillErr{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.pdev-cfg-pillMuted{color:var(--dsw-alias-label-tertiary)}
.pdev-cfg-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.pdev-cfg-badgeChanged{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.pdev-cfg-group{display:flex;flex-direction:column;gap:0}
.pdev-cfg-group + .pdev-cfg-group{border-top:1px solid var(--dsw-alias-border-l2);margin-top:6px;padding-top:6px}
.pdev-cfg-groupTitle{margin:8px 0 2px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.pdev-cfg-rows{display:flex;flex-direction:column;gap:0}
.pdev-cfg-checkRow{cursor:pointer}
.pdev-cfg-checkRow:disabled{cursor:default}
.pdev-cfg-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.pdev-cfg-switch[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill)}
.pdev-cfg-switch:disabled{opacity:.45;cursor:default}
.pdev-cfg-knob{position:absolute;top:2px;left:2px;display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .15s ease}
.pdev-cfg-switch[aria-checked="true"] .pdev-cfg-knob{transform:translateX(16px)}
.pdev-cfg-number{box-sizing:border-box;width:96px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 8px;font:inherit;font-size:13px;line-height:20px}
.pdev-cfg-number:disabled{opacity:.45;cursor:default}
.pdev-cfg-radioRow{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.pdev-cfg-check{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer}
.pdev-cfg-check input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.pdev-cfg-check input:disabled{cursor:default;opacity:.45}
.pdev-cfg-fieldError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding-top:2px}
.pdev-cfg-banner{box-sizing:border-box;border-radius:10px;padding:10px 12px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.pdev-cfg-bannerWarn{border-left:3px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary)}
.pdev-cfg-bannerError{border-left:3px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}
.pdev-cfg-bannerInfo{border-left:3px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.pdev-cfg-bannerSub{color:var(--dsw-alias-label-secondary);padding-top:4px}
.pdev-cfg-events{display:flex;flex-direction:column;gap:0}
.pdev-cfg-event{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.pdev-cfg-event:last-child{border-bottom:none}
.pdev-cfg-eventTime{flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
.pdev-cfg-eventLevel{flex:none;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pdev-cfg-eventLevelWarn{color:var(--dsw-alias-state-warn-primary)}
.pdev-cfg-eventLevelError{color:var(--dsw-alias-state-error-primary)}
.pdev-cfg-eventMsg{min-width:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.pdev-cfg-empty{color:var(--dsw-alias-label-tertiary);padding:10px 0;font-size:12px;line-height:18px}
.pdev-cfg-loading{display:flex;flex-direction:column;gap:12px;padding:6px 0}
.pdev-cfg-skel{height:48px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:12px}
.pdev-cfg-footer{display:flex;flex-direction:column;gap:10px;padding:2px 0 24px}
.pdev-cfg-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pdev-cfg-btn{appearance:none;font:inherit;font-size:13px;line-height:20px;border-radius:8px;padding:5px 14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.pdev-cfg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pdev-cfg-btn:disabled{opacity:.45;cursor:default}
.pdev-cfg-btnPrimary{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.pdev-cfg-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.pdev-cfg-btnConfirm{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.pdev-cfg-btnSmall{padding:3px 10px;font-size:12px;line-height:18px}
.pdev-cfg-footMeta{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:18px}
.pdev-cfg-live{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-height:18px;overflow-wrap:anywhere}
.pdev-cfg-liveOk{color:var(--dsw-alias-state-success-primary)}
.pdev-cfg-liveWarn{color:var(--dsw-alias-state-warn-primary)}
.pdev-cfg-liveError{color:var(--dsw-alias-state-error-primary)}
.pdev-cfg-revision{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.pdev-cfg-btn:focus-visible,.pdev-cfg-switch:focus-visible,.pdev-cfg-number:focus-visible,.pdev-cfg-check input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
@media (max-width:639px){
.pdev-cfg-header{flex-direction:column;align-items:flex-start}
.pdev-cfg-row{flex-direction:column;align-items:stretch;gap:8px}
.pdev-cfg-rowControl{justify-content:flex-start;max-width:none}
.pdev-cfg-rowValue{text-align:left}
.pdev-cfg-card{padding:14px}
}
`.trim();

    /**
     * 设置页主体。
     *
     * 数据流：GET /pdev/plugin/status → view.data；config.value 复制成 form；
     * 表单永远只提交相对 config.value 变化的字段，并带 config.revision。
     * 10s 轮询只在页面可见时发生；轮询不会覆盖用户未保存的改动。
     */
    function SettingsSection(props) {
      const client = (props && props.client) || clientInfo;

      // 页面数据：loading | ready | error
      const [view, setView] = React.useState({ phase: "loading", data: null, error: "" });

      // 配置：服务端已保存值 + profile 覆盖层 + 修订号 + 表单草稿
      const [cfg, setCfg] = React.useState({
        saved: null,
        defaults: CONFIG_DEFAULTS,
        user: {},
        revision: null,
        writable: true,
        readonlyReason: null,
        source: null,
        entryId: null,
        form: null,
      });

      // 保存状态：idle | saving | saved；notice 给 aria-live 区；confirmWeaken 是二次确认闸门
      const [saveState, setSaveState] = React.useState({
        phase: "idle",
        notice: null,
        fieldError: null,
        confirmWeaken: false,
      });

      const [eventsOpen, setEventsOpen] = React.useState(false);
      const [copyNotice, setCopyNotice] = React.useState("");

      const aliveRef = React.useRef(true);
      const requestIdRef = React.useRef(0);
      const abortRef = React.useRef(null);
      const saveAbortRef = React.useRef(null);
      const refreshTimerRef = React.useRef(null);
      const copyTimerRef = React.useRef(null);
      const loadRef = React.useRef(null);
      const viewRef = React.useRef(view);
      /** 复制兜底用的临时 textarea 挂在这里（组件自己的容器），不碰全局 DOM。 */
      const rootRef = React.useRef(null);

      React.useEffect(function () {
        viewRef.current = view;
      });

      // 卸载时中止所有请求与定时器
      React.useEffect(function () {
        return function () {
          aliveRef.current = false;
          if (abortRef.current) { try { abortRef.current.abort(); } catch (error) { /* 忽略 */ } }
          if (saveAbortRef.current) { try { saveAbortRef.current.abort(); } catch (error) { /* 忽略 */ } }
          if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
          if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
        };
      }, []);

      /** 把服务端 config view 应用到本地状态；forceForm 用于保存成功 / 409 刷新。 */
      function applyConfigView(raw, forceForm) {
        if (!isObject(raw)) return;
        const value = configValue(raw.value);
        const defaults = configValue(raw.defaults);
        const user = isObject(raw.user) ? raw.user : {};
        setCfg(function (prev) {
          const keepDraft = !forceForm && prev.form && formDirty(prev.form, prev.saved);
          return {
            saved: value,
            defaults: defaults,
            user: user,
            revision: typeof raw.revision === "number" ? raw.revision : null,
            writable: raw.writable !== false,
            readonlyReason: typeof raw.readonlyReason === "string" && raw.readonlyReason ? raw.readonlyReason : null,
            source: typeof raw.source === "string" ? raw.source : prev.source,
            entryId: typeof raw.entryId === "string" ? raw.entryId : prev.entryId,
            form: keepDraft ? prev.form : formFromValue(value),
          };
        });
        setView(function (prev) {
          if (!prev.data) return prev;
          return { phase: prev.phase, data: { ...prev.data, config: raw }, error: prev.error };
        });
      }

      /** status 响应落地：页面数据 + 配置；轮询时保留未保存草稿。 */
      function applyStatus(data) {
        setView({ phase: "ready", data: data, error: "" });
        if (isObject(data && data.config)) {
          applyConfigView(data.config, false);
        } else {
          // 兜底：新客户端 + 残缺响应时也不能白屏，只读展示默认值。
          applyConfigView({
            value: CONFIG_DEFAULTS,
            defaults: CONFIG_DEFAULTS,
            user: {},
            revision: null,
            writable: false,
            readonlyReason: "Host 没有返回配置信息",
            source: null,
            entryId: null,
          }, true);
        }
      }

      /**
       * 拉取插件状态。
       * @param {{silent?: boolean}} options silent=true 用于轮询：已有数据时不清空页面。
       */
      function load(options) {
        const opts = options || {};
        if (typeof fetch !== "function") {
          setView({ phase: "error", data: null, error: "当前浏览器不支持 fetch" });
          return;
        }
        const requestId = ++requestIdRef.current;
        if (abortRef.current) {
          try { abortRef.current.abort(); } catch (error) { /* 忽略 */ }
        }
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        abortRef.current = controller;
        if (!opts.silent) setView({ phase: "loading", data: null, error: "" });

        fetch("/pdev/plugin/status", {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller ? controller.signal : undefined,
        })
          .then(function (response) {
            return readJsonSafe(response).then(function (body) {
              if (!response.ok) {
                const detail = isObject(body) ? (body.message || body.error) : null;
                const error = new Error(detail || ("HTTP " + response.status));
                error.statusCode = response.status;
                throw error;
              }
              if (!isObject(body)) throw new Error("响应不是合法 JSON");
              return body;
            });
          })
          .then(function (data) {
            if (!aliveRef.current || requestId !== requestIdRef.current) return;
            applyStatus(data);
          })
          .catch(function (error) {
            if (!aliveRef.current || requestId !== requestIdRef.current) return;
            if (error && error.name === "AbortError") return;
            const message = messageOf(error);
            setView(function (prev) {
              // 已经拿到过数据时保留页面，只在顶部挂一条错误提示；否则整页错误面板。
              if (prev.data) return { phase: "ready", data: prev.data, error: message };
              return { phase: "error", data: null, error: message };
            });
          });
      }

      // 轮询与保存后的刷新都走 ref，保证拿到的是最新 render 的闭包。
      React.useEffect(function () {
        loadRef.current = load;
      });

      // 首次加载 + 10s 轮询 + 回前台立即刷新
      React.useEffect(function () {
        aliveRef.current = true;
        load({ silent: false });
        const timer = setInterval(function () {
          if (!aliveRef.current) return;
          if (document.visibilityState === "visible") loadRef.current({ silent: true });
        }, STATUS_POLL_MS);
        const onVisibilityChange = function () {
          if (!aliveRef.current) return;
          if (document.visibilityState === "visible") loadRef.current({ silent: true });
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return function () {
          aliveRef.current = false;
          clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisibilityChange);
        };
      }, []);

      // 保存成功后延迟静默刷新一次，让「最近插件事件」立刻出现 Host 记的那条
      function scheduleRefresh() {
        if (refreshTimerRef.current !== null) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(function () {
          refreshTimerRef.current = null;
          if (aliveRef.current) loadRef.current({ silent: true });
        }, 500);
      }

      /** 提交 patch。调用方保证 patch 非空、表单有效。 */
      function submitSave(patch) {
        setSaveState({ phase: "saving", notice: null, fieldError: null, confirmWeaken: false });
        if (saveAbortRef.current) {
          try { saveAbortRef.current.abort(); } catch (error) { /* 忽略 */ }
        }
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        saveAbortRef.current = controller;
        const expectedRevision = cfg.revision;

        fetch("/pdev/plugin/config", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ patch: patch, expectedRevision: expectedRevision }),
          signal: controller ? controller.signal : undefined,
        })
          .then(function (response) {
            return readJsonSafe(response).then(function (body) {
              return { response: response, body: body };
            });
          })
          .then(function (result) {
            if (!aliveRef.current) return;
            const response = result.response;
            const body = result.body;

            if (response.status === 200 && isObject(body)) {
              if (isObject(body.config)) applyConfigView(body.config, true);
              const nextRevision = isObject(body.config) && typeof body.config.revision === "number"
                ? body.config.revision
                : cfg.revision;
              setSaveState({
                phase: "saved",
                notice: { tone: "ok", text: format(TEXT.saved, { n: nextRevision === null || nextRevision === undefined ? "—" : nextRevision }) },
                fieldError: null,
                confirmWeaken: false,
              });
              // 契约 §6.7：把 autoOpen 保存为 true 时顺手清掉 v0.2 的旧拒绝标记。
              if (patch.autoOpen === true) removeFlag(localStorage, OPTOUT_KEY);
              scheduleRefresh();
              return;
            }

            if (response.status === 409) {
              if (isObject(body) && isObject(body.config)) applyConfigView(body.config, true);
              setSaveState({
                phase: "idle",
                notice: { tone: "warn", text: TEXT.conflict },
                fieldError: null,
                confirmWeaken: false,
              });
              return;
            }

            if (response.status === 400) {
              const field = isObject(body) && typeof body.field === "string" ? body.field : null;
              const fieldLabel = field && FIELD_META[field] ? FIELD_META[field].label : field;
              const serverMessage = isObject(body) && body.message ? String(body.message) : "保存请求被拒绝";
              const text = fieldLabel ? "字段「" + fieldLabel + "」：" + serverMessage : serverMessage;
              setSaveState({
                phase: "idle",
                notice: { tone: "error", text: text },
                fieldError: field ? { field: field, text: fieldLabel ? "字段「" + fieldLabel + "」：" + serverMessage : serverMessage } : null,
                confirmWeaken: false,
              });
              return;
            }

            if (response.status === 503) {
              const reason = cfg.readonlyReason
                || (isObject(body) && body.message ? String(body.message) : "设置服务不可用");
              setSaveState({
                phase: "idle",
                notice: { tone: "error", text: reason },
                fieldError: null,
                confirmWeaken: false,
              });
              return;
            }

            const detail = isObject(body) ? (body.message || body.error) : null;
            setSaveState({
              phase: "idle",
              notice: { tone: "error", text: "保存失败：" + (detail ? String(detail) : "HTTP " + response.status) },
              fieldError: null,
              confirmWeaken: false,
            });
          })
          .catch(function (error) {
            if (!aliveRef.current) return;
            if (error && error.name === "AbortError") return;
            setSaveState({
              phase: "idle",
              notice: { tone: "error", text: "保存失败：" + messageOf(error) },
              fieldError: null,
              confirmWeaken: false,
            });
          });
      }

      // ── 表单草稿派生值 ──

      const draftValue = cfg.form ? formToValue(cfg.form) : null;
      const dirtyKeys = draftValue && cfg.saved
        ? CONFIG_KEYS.filter(function (key) { return draftValue[key] !== cfg.saved[key]; })
        : [];
      const isDirty = dirtyKeys.length > 0;
      const numberInvalid = cfg.form ? !timelineValid(cfg.form.timelineMaxEntries) : false;
      const saving = saveState.phase === "saving";

      function setField(key, next) {
        setCfg(function (prev) {
          if (!prev.form) return prev;
          const form = {};
          for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
            const k = CONFIG_KEYS[i];
            form[k] = prev.form[k];
          }
          form[key] = next;
          return { ...prev, form: form };
        });
        // 改动之后必须重新点两次保存才能放宽门禁；成功提示也清掉。
        setSaveState(function (prev) {
          return {
            phase: prev.phase === "saved" ? "idle" : prev.phase,
            notice: prev.notice && prev.notice.tone === "ok" ? null : prev.notice,
            fieldError: null,
            confirmWeaken: false,
          };
        });
      }

      function resetToDefaults() {
        setCfg(function (prev) {
          if (!prev.defaults) return prev;
          return { ...prev, form: formFromValue(prev.defaults) };
        });
        setSaveState({ phase: "idle", notice: null, fieldError: null, confirmWeaken: false });
      }

      function handleSave() {
        if (!cfg.form || !cfg.writable || saving) return;
        if (numberInvalid) return;
        const draft = formToValue(cfg.form);
        const patch = {};
        let changed = 0;
        for (let i = 0; i < CONFIG_KEYS.length; i += 1) {
          const key = CONFIG_KEYS[i];
          if (draft[key] !== cfg.saved[key]) { patch[key] = draft[key]; changed += 1; }
        }
        if (changed === 0) return;

        // 二次确认：只要表单状态会放宽门禁，第一次点击只"上膛"。
        const weakening = weakenFields(cfg.form);
        if (weakening.length > 0 && !saveState.confirmWeaken) {
          setSaveState({ phase: "idle", notice: null, fieldError: null, confirmWeaken: true });
          return;
        }
        submitSave(patch);
      }

      // ── 复制诊断信息（契约 §6.8） ──

      function buildDiagnostics(data) {
        const plugin = isObject(data.plugin) ? data.plugin : {};
        const host = isObject(data.host) ? data.host : {};
        const paths = isObject(data.paths) ? data.paths : {};
        const services = host.services || {};
        const lines = [];
        lines.push("dsh-parallel-dev v" + CLIENT_VERSION);
        lines.push("服务端版本: " + str(plugin.version));
        lines.push("加载时间: " + fmtTime(plugin.loadedAt));
        lines.push("运行时长: " + fmtUptime(plugin.uptimeMs));
        lines.push("Node: " + str(plugin.nodeVersion) + "（要求 " + str(plugin.nodeEngine) + "）");
        lines.push("运行条件: " + SERVICES.map(function (service) {
          return service.key + "=" + (services[service.key] ? TEXT.present : TEXT.absent);
        }).join(" "));
        lines.push("安装目录: " + str(paths.packageDir));
        lines.push("Profile: " + str(paths.profileDir));
        lines.push("配置文件: " + str(paths.patchFile));
        lines.push("当前配置: " + JSON.stringify(cfg.saved || CONFIG_DEFAULTS));
        lines.push("最近插件事件:");
        const events = Array.isArray(data.events) ? data.events.slice(-10) : [];
        if (events.length === 0) lines.push("  (无)");
        events.forEach(function (event) {
          lines.push("  " + fmtTime(event && event.at) + " [" + str(event && event.level) + "] " + str(event && event.message));
        });
        return lines.join("\n");
      }

      /**
       * 老浏览器的复制兜底：临时 textarea + execCommand，用完移除。
       *
       * 挂在组件自己的根节点下（而不是 `document.body`），既满足契约 §6.8 的
       * "临时 textarea + execCommand"，又不给宿主加全局 DOM。fixed 定位让它
       * 不参与页面布局；`select()` 后浏览器仍能正常复制。
       */
      function legacyCopy(text) {
        const host = rootRef.current;
        if (!host) throw new Error("复制容器不可用");
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.left = "-1000px";
        area.style.opacity = "0";
        host.appendChild(area);
        let copied = false;
        try {
          area.select();
          copied = document.execCommand("copy");
        } finally {
          area.remove();
        }
        if (!copied) throw new Error("execCommand copy 失败");
      }

      function copyDiagnostics() {
        if (!viewRef.current.data) return;
        const text = buildDiagnostics(viewRef.current.data);
        const done = function (message) {
          if (!aliveRef.current) return;
          setCopyNotice(message);
          if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
          copyTimerRef.current = setTimeout(function () {
            copyTimerRef.current = null;
            if (aliveRef.current) setCopyNotice("");
          }, 3000);
        };
        const fallback = function () {
          try {
            legacyCopy(text);
            done("已复制诊断信息");
          } catch (error) {
            done("复制失败，请手动选择文本复制");
          }
        };
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            navigator.clipboard.writeText(text).then(function () { done("已复制诊断信息"); }, fallback);
          } else {
            fallback();
          }
        } catch (error) {
          fallback();
        }
      }

      // ── 渲染小部件 ──

      function pill(tone, text) {
        const toneClass = tone === "ok" ? " pdev-cfg-pillOk"
          : tone === "warn" ? " pdev-cfg-pillWarn"
            : tone === "err" ? " pdev-cfg-pillErr"
              : " pdev-cfg-pillMuted";
        return h("span", { className: "pdev-cfg-pill" + toneClass }, text);
      }

      function statusPill(status) {
        if (status === "injected") return pill("ok", TEXT.injected);
        if (status === "registered") return pill("ok", TEXT.registered);
        if (status === "disabled") return pill("muted", TEXT.disabled);
        if (status === "skipped") return pill("muted", TEXT.skipped);
        if (status === "failed") return pill("err", TEXT.failed);
        return pill("muted", status ? String(status) : "—");
      }

      function servicePill(available) {
        return available ? pill("ok", TEXT.present) : pill("err", TEXT.absent);
      }

      function card(key, titleText, children) {
        return h("section", { key: key, className: "pdev-cfg-card" }, [
          h("div", { key: "head", className: "pdev-cfg-cardHead" }, [
            h("h3", { key: "title", className: "pdev-cfg-cardTitle" }, titleText),
          ]),
        ].concat(children || []));
      }

      function infoRow(key, labelNode, valueNode, descText, statusNode) {
        return h("div", { key: key, className: "pdev-cfg-row" }, [
          h("div", { key: "text", className: "pdev-cfg-rowText" }, [
            h("div", { key: "label", className: "pdev-cfg-rowLabel" }, labelNode),
            descText ? h("div", { key: "desc", className: "pdev-cfg-rowDesc" }, descText) : null,
          ]),
          h("div", { key: "control", className: "pdev-cfg-rowControl" }, [
            valueNode ? h("span", { key: "value", className: "pdev-cfg-rowValue" }, valueNode) : null,
            statusNode || null,
          ]),
        ]);
      }

      function badgeOf(key) {
        const changed = cfg.user && Object.prototype.hasOwnProperty.call(cfg.user, key);
        return h("span", {
          className: "pdev-cfg-badge" + (changed ? " pdev-cfg-badgeChanged" : ""),
        }, changed ? "已改" : "默认");
      }

      function radioOption(fieldKey, value, labelText, checked, disabled) {
        return h("label", { key: value, className: "pdev-cfg-check" }, [
          h("input", {
            key: "input",
            type: "radio",
            name: "pdev-gate-mode",
            value: value,
            checked: checked,
            disabled: disabled,
            onChange: function () { setField(fieldKey, value); },
          }),
          h("span", { key: "text" }, labelText),
        ]);
      }

      function configField(field) {
        const key = field.key;
        const value = cfg.form[key];
        const disabled = !cfg.writable || saving;
        const fieldError = saveState.fieldError && saveState.fieldError.field === key
          ? saveState.fieldError.text
          : null;
        const invalidNumber = key === "timelineMaxEntries" && !timelineValid(value);

        let control;
        if (field.type === "switch") {
          control = h("button", {
            type: "button",
            role: "switch",
            "aria-checked": value === true ? "true" : "false",
            "aria-label": field.label,
            className: "pdev-cfg-switch",
            disabled: disabled,
            onClick: function () { setField(key, value !== true); },
          }, h("span", { className: "pdev-cfg-knob" }));
        } else if (field.type === "number") {
          control = h("input", {
            type: "number",
            min: 10,
            max: 500,
            step: 1,
            inputMode: "numeric",
            className: "pdev-cfg-number",
            value: value === null || value === undefined ? "" : String(value),
            "aria-label": field.label,
            "aria-invalid": invalidNumber ? "true" : "false",
            "aria-describedby": invalidNumber ? "pdev-cfg-timeline-error" : undefined,
            disabled: disabled,
            onChange: function (event) { setField(key, event.currentTarget.value); },
          });
        } else if (field.type === "radio") {
          control = h("div", { key: "radios", className: "pdev-cfg-radioRow", role: "radiogroup", "aria-label": field.label }, [
            radioOption(key, "enforce", "拦截", value === "enforce", disabled),
            radioOption(key, "advise", "仅提醒", value === "advise", disabled),
          ]);
        } else {
          // 整行就是 <label>（见下面 rowTag），这里只放原生 input，避免 label 套 label。
          control = h("input", {
            key: "check",
            type: "checkbox",
            checked: value === true,
            disabled: disabled,
            onChange: function (event) { setField(key, event.currentTarget.checked); },
          });
        }

        const hints = [];
        if (invalidNumber) {
          hints.push(h("div", { key: "number", id: "pdev-cfg-timeline-error", className: "pdev-cfg-fieldError", role: "alert" }, "请输入 10–500 的整数。"));
        }
        if (fieldError) {
          hints.push(h("div", { key: "server", className: "pdev-cfg-fieldError", role: "alert" }, fieldError));
        }

        // 复选框的整行就是 label，点文字也能勾选，且不出现重复可见文案。
        const rowTag = field.type === "checkbox" ? "label" : "div";
        return h(rowTag, {
          key: "field-" + key,
          className: "pdev-cfg-row" + (field.type === "checkbox" ? " pdev-cfg-checkRow" : ""),
        }, [
          h("div", { key: "text", className: "pdev-cfg-rowText" }, [
            h("div", { key: "label", className: "pdev-cfg-rowLabel" }, [field.label, badgeOf(key)]),
            h("div", { key: "desc", className: "pdev-cfg-rowDesc" }, field.desc),
            hints.length > 0 ? h("div", { key: "hints" }, hints) : null,
          ]),
          h("div", { key: "control", className: "pdev-cfg-rowControl" }, control),
        ]);
      }

      function headerBlock() {
        return h("header", { key: "header", className: "pdev-cfg-header" }, [
          h("div", { key: "text", className: "pdev-cfg-headerText" }, [
            h("h2", { key: "title", className: "pdev-cfg-title" }, TEXT.title),
            h("p", { key: "subtitle", className: "pdev-cfg-subtitle" }, TEXT.subtitle),
          ]),
          h("span", { key: "version", className: "pdev-cfg-version" }, "v" + ((client && client.version) || CLIENT_VERSION)),
        ]);
      }

      function bannerBlock(key, tone, content) {
        const toneClass = tone === "warn" ? " pdev-cfg-bannerWarn"
          : tone === "error" ? " pdev-cfg-bannerError"
            : " pdev-cfg-bannerInfo";
        return h("div", {
          key: key,
          className: "pdev-cfg-banner" + toneClass,
          role: tone === "error" ? "alert" : "status",
        }, content);
      }

      function statusCard(data) {
        const plugin = isObject(data.plugin) ? data.plugin : {};
        const host = isObject(data.host) ? data.host : {};
        const gateInstalled = host.gateInstalled === true;
        const children = [];
        if (plugin.description) {
          children.push(h("p", { key: "desc", className: "pdev-cfg-cardDesc" }, plugin.description));
        }
        children.push(infoRow("name", "包名", h("code", { className: "pdev-cfg-mono" }, str(plugin.name))));
        children.push(infoRow("version", "版本", "服务端 " + str(plugin.version) + " · 客户端 " + CLIENT_VERSION));
        children.push(infoRow("loaded", "加载时间", fmtTime(plugin.loadedAt)));
        children.push(infoRow("uptime", "运行时长", fmtUptime(plugin.uptimeMs)));
        children.push(infoRow("node", "Node 版本", str(plugin.nodeVersion) + "（要求 " + str(plugin.nodeEngine) + "）"));
        children.push(infoRow("gate", "验收门禁", null, gateInstalled ? null : "门禁工具没有安装，完成动作不会被拦截", servicePill(gateInstalled)));
        return card("status", TEXT.statusTitle, children);
      }

      function conditionsCard(data) {
        const host = isObject(data.host) ? data.host : {};
        const services = isObject(host.services) ? host.services : {};
        const rows = SERVICES.map(function (service) {
          const available = services[service.key] === true;
          return infoRow("service-" + service.key, service.label, null, service.impact, servicePill(available));
        });
        return card("conditions", TEXT.conditionsTitle, rows);
      }

      function pathsCard(data) {
        const plugin = isObject(data.plugin) ? data.plugin : {};
        const paths = isObject(data.paths) ? data.paths : {};
        const rows = [
          infoRow("packageDir", "安装目录", h("code", { className: "pdev-cfg-mono" }, str(paths.packageDir))),
          infoRow("profileDir", "Profile", h("code", { className: "pdev-cfg-mono" }, str(paths.profileDir))),
          infoRow("patchFile", "配置文件", h("code", { className: "pdev-cfg-mono" }, str(paths.patchFile))),
          infoRow("dataDir", "数据目录", h("code", { className: "pdev-cfg-mono" }, str(paths.dataDir))),
          infoRow("nodeVersion", "Node 版本", str(plugin.nodeVersion) + "（要求 " + str(plugin.nodeEngine) + "）"),
        ];
        return card("paths", TEXT.pathsTitle, rows);
      }

      function featuresCard(data) {
        const host = isObject(data.host) ? data.host : {};
        const policy = isObject(host.policy) ? host.policy : {};
        const board = isObject(host.board) ? host.board : {};
        const tools = Array.isArray(host.tools) ? host.tools : [];
        const children = [];
        if (tools.length === 0) {
          children.push(h("div", { key: "tools-empty", className: "pdev-cfg-empty" }, TEXT.absent));
        } else {
          tools.forEach(function (tool, index) {
            const item = isObject(tool) ? tool : {};
            children.push(infoRow(
              "tool-" + index,
              h("code", { className: "pdev-cfg-mono" }, str(item.name)),
              null,
              item.summary ? String(item.summary) : null,
            ));
          });
        }
        children.push(infoRow(
          "board",
          "看板路由",
          h("code", { className: "pdev-cfg-mono" }, str(board.path)),
          board.detail ? String(board.detail) : null,
          statusPill(board.status),
        ));
        const tabRegistered = client && client.tabRegistered === true;
        children.push(infoRow(
          "sidebar",
          "侧栏面板",
          "并行开发看板",
          "侧栏 tab kind：" + TAB_KIND,
          statusPill(tabRegistered ? "registered" : "failed"),
        ));
        children.push(infoRow(
          "policy",
          "提示词段",
          h("code", { className: "pdev-cfg-mono" }, str(policy.name)),
          "order " + str(policy.order) + (policy.detail ? " · " + String(policy.detail) : ""),
          statusPill(policy.status),
        ));
        return card("features", TEXT.featuresTitle, children);
      }

      function eventsCard(data) {
        const events = Array.isArray(data.events) ? data.events : [];
        const limit = eventsOpen ? EVENTS_MAX : EVENTS_DEFAULT;
        const visible = events.length > limit ? events.slice(events.length - limit) : events.slice();
        visible.reverse();

        const children = [];
        if (visible.length === 0) {
          children.push(h("div", { key: "empty", className: "pdev-cfg-empty" }, TEXT.emptyEvents));
        } else {
          children.push(h("div", { key: "list", className: "pdev-cfg-events" }, visible.map(function (event, index) {
            const item = isObject(event) ? event : {};
            const level = String(item.level || "info");
            const levelClass = "pdev-cfg-eventLevel" + (level === "warn" ? " pdev-cfg-eventLevelWarn" : level === "error" ? " pdev-cfg-eventLevelError" : "");
            return h("div", { key: "event-" + index, className: "pdev-cfg-event" }, [
              h("span", { key: "time", className: "pdev-cfg-eventTime" }, fmtTime(item.at)),
              h("span", { key: "level", className: levelClass }, level),
              h("span", { key: "message", className: "pdev-cfg-eventMsg" }, str(item.message)),
            ]);
          })));
        }
        if (events.length > EVENTS_DEFAULT) {
          children.push(h("div", { key: "more", className: "pdev-cfg-actions" }, h("button", {
            type: "button",
            className: "pdev-cfg-btn pdev-cfg-btnSmall",
            disabled: saving,
            onClick: function () { setEventsOpen(!eventsOpen); },
          }, eventsOpen ? TEXT.collapse : TEXT.expand)));
        }
        return card("events", TEXT.eventsTitle, children);
      }

      function configCard() {
        if (!cfg.form) {
          return card("config", TEXT.configTitle, [
            h("div", { key: "empty", className: "pdev-cfg-empty" }, TEXT.absent),
          ]);
        }
        const children = [];
        if (!cfg.writable) {
          children.push(bannerBlock("readonly", "warn", [
            h("div", { key: "copy" }, TEXT.readonlyBanner),
            cfg.readonlyReason ? h("div", { key: "reason", className: "pdev-cfg-bannerSub" }, "原因：" + cfg.readonlyReason) : null,
          ]));
        }
        CONFIG_GROUPS.forEach(function (group) {
          children.push(h("div", { key: "group-" + group.title, className: "pdev-cfg-group" }, [
            h("h4", { key: "title", className: "pdev-cfg-groupTitle" }, group.title),
            h("div", { key: "rows", className: "pdev-cfg-rows" }, group.fields.map(configField)),
          ]));
        });
        return card("config", TEXT.configTitle, children);
      }

      function footerBlock() {
        const data = view.data;
        const actions = [];
        if (cfg.writable) {
          const saveDisabled = saving || !cfg.form || !isDirty || numberInvalid;
          actions.push(h("button", {
            key: "save",
            type: "button",
            className: "pdev-cfg-btn " + (saveState.confirmWeaken ? "pdev-cfg-btnConfirm" : "pdev-cfg-btnPrimary"),
            disabled: saveDisabled,
            onClick: handleSave,
          }, saving ? TEXT.saving : (saveState.confirmWeaken ? TEXT.confirmWeaken : TEXT.save)));
        }
        actions.push(h("button", {
          key: "reset",
          type: "button",
          className: "pdev-cfg-btn",
          disabled: saving || !cfg.writable || !cfg.form,
          onClick: resetToDefaults,
        }, TEXT.reset));
        const notice = saveState.notice;
        const liveClass = notice
          ? " pdev-cfg-live" + (notice.tone === "ok" ? " pdev-cfg-liveOk" : notice.tone === "warn" ? " pdev-cfg-liveWarn" : " pdev-cfg-liveError")
          : " pdev-cfg-live";
        // 契约 §6.2 的顺序：8 底部操作（保存/恢复默认/保存状态/修订号），9 复制诊断信息。
        return h("div", { key: "footer", className: "pdev-cfg-footer" }, [
          h("div", { key: "actions", className: "pdev-cfg-actions" }, actions),
          h("div", { key: "meta", className: "pdev-cfg-footMeta" }, [
            h("div", { key: "live", className: liveClass.trim(), role: "status", "aria-live": "polite" }, notice ? notice.text : ""),
            h("div", { key: "revision", className: "pdev-cfg-revision" }, "修订号：" + (cfg.revision === null || cfg.revision === undefined ? "—" : cfg.revision)),
          ]),
          h("div", { key: "diagnostics", className: "pdev-cfg-actions" }, [
            h("button", {
              key: "copy",
              type: "button",
              className: "pdev-cfg-btn",
              disabled: saving || !data || !cfg.form,
              onClick: copyDiagnostics,
            }, TEXT.copyDiag),
            h("span", { key: "copy-live", className: "pdev-cfg-live", role: "status", "aria-live": "polite" }, copyNotice),
          ]),
        ]);
      }

      function errorPanel() {
        return card("error", TEXT.statusTitle, [
          bannerBlock("load-error", "error", format(TEXT.loadError, { message: view.error || "—" })),
          h("div", { key: "actions", className: "pdev-cfg-actions" }, [
            h("button", {
              key: "retry",
              type: "button",
              className: "pdev-cfg-btn",
              onClick: function () { load({ silent: false }); },
            }, TEXT.refresh),
          ]),
        ]);
      }

      function loadingPanel() {
        return card("loading", TEXT.statusTitle, [
          h("div", { key: "loading", className: "pdev-cfg-loading", role: "status", "aria-live": "polite", "aria-busy": "true" }, [
            h("div", { key: "text", className: "pdev-cfg-rowDesc" }, TEXT.loading),
            h("div", { key: "s1", className: "pdev-cfg-skel" }),
            h("div", { key: "s2", className: "pdev-cfg-skel" }),
          ]),
        ]);
      }

      // ── 页面组装 ──

      const styleNode = h("style", { key: "style" }, CSS_TEXT);
      const children = [styleNode, headerBlock()];

      if (view.phase === "loading" && !view.data) {
        children.push(loadingPanel());
      } else if (view.phase === "error" && !view.data) {
        children.push(errorPanel());
      } else {
        const data = view.data;
        if (view.error) {
          children.push(bannerBlock("stale", "error", format(TEXT.loadError, { message: view.error })));
        }
        children.push(statusCard(data));
        children.push(conditionsCard(data));
        children.push(pathsCard(data));
        children.push(featuresCard(data));
        children.push(eventsCard(data));
        children.push(configCard());
        if (saveState.confirmWeaken && cfg.form) {
          const weakening = weakenFields(cfg.form);
          if (weakening.length > 0) {
            children.push(bannerBlock("weaken", "warn", format(TEXT.weakenBanner, { fields: weakening.join("、") })));
          }
        }
        children.push(footerBlock());
      }

      return h("div", { ref: rootRef, className: "pdev-cfg-root" }, children);
    }

    // ─────────────────────────────────────────────────────────────
    // 注册
    // ─────────────────────────────────────────────────────────────

    /** 设置左栏「并行开发配置」整页（契约 §6.1）。 */
    function registerSettingsSection(ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "dsh-parallel-dev",
            order: 50,
            label: function () { return TEXT.nav; },
            inject: function () { return { ctx: ctx, client: clientInfo }; },
          }, SettingsSection);
        });
        console.log("[dsh-parallel-dev] settings section registered");
      } catch (error) {
        console.warn("[dsh-parallel-dev] settings section 注册失败:", error && error.message);
      }
    }

    function apply(ctx) {
      // 设置页不依赖侧栏服务；先注册，保证侧栏不可用时设置页仍可打开。
      registerSettingsSection(ctx);
      // v0.2 localStorage 旧标记 → v0.3 配置（失败保留旧标记，见函数注释）。
      migrateAutoOpenOptout();

      try {
        const tabs = ctx.sidebarRightTabs;
        if (!tabs || typeof tabs.register !== "function") {
          console.warn("[dsh-parallel-dev] sidebarRightTabs 服务不可用，侧栏面板不注册");
          return;
        }
        // 第一段：类型（是什么、叫什么、入口胶囊长什么样）
        ctx.effect(() => tabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: "extension",
          title: () => "并行开发",
          guide: [{
            id: "parallel-dev-board",
            order: 40,
            title: () => "并行开发看板",
            description: () => "依赖分层、关键路径、并发时间轴（拉宽或全屏看完整图）",
          }],
        }), "dsh-parallel-dev: tab type");

        // 第二段：正文与芯片标题，key 用定义的 id
        ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
          { name: "sidebar.right.pane.tab", key: TAB_ID, inject: (sessionId) => ({ sessionId }) },
          BoardPanel,
        ));
        ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register(
          { name: "sidebar.right.pane.tab.title", key: TAB_ID },
          BoardTitle,
        ));
        // 设置页的「侧栏面板」状态读这个字段（同一个 clientInfo 对象原地更新）。
        clientInfo.tabRegistered = true;
        console.log("[dsh-parallel-dev] sidebar tab registered (iframe host):", TAB_KIND);

        // 自动打开：注册成功之后才装，注册失败就没必要盯着了
        const stopAutoOpen = installAutoOpen(ctx);
        if (stopAutoOpen) ctx.effect(() => stopAutoOpen, "dsh-parallel-dev: auto-open watcher");
      } catch (error) {
        // 侧栏注册失败不该拖垮整个客户端插件树，但要吵出来
        console.error("[dsh-parallel-dev] 侧栏面板注册失败:", error && error.message);
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "sidebarRightTabs", "sidebarRight"];
    return module.exports;
  },
});
