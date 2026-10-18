/**
 * dsh-parallel-dev — 浏览器半边（原生侧栏面板）。
 *
 * 设计决定：**侧栏面板不自己画画，它承载 web 看板页。**
 *
 * 之前这里有一份独立的 React 紧凑图（约 105 行），和 web 页的紧凑模式（约 211 行）
 * 画的是同一个东西 —— 两套代码，改一次设计要改两处，还容易走偏。
 *
 * 现在改成 iframe 承载 `/pdev/board?embed=1`：
 *   - web 页本来就是响应式的：容器 <560px 渲染紧凑迷你图，≥560px 渲染完整依赖图，
 *     再宽还有时间轴。侧栏的分栏/全屏两档天然对上。
 *   - 侧栏拉宽时**自动获得完整依赖图与时间轴** —— 这是原来那版做不到的。
 *   - 渲染代码只剩一份，改一次两处都变。
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
    // 自动打开
    // ─────────────────────────────────────────────────────────────

    /** 本次浏览器会话是否已经自动开过（关掉页面就重置——下次会话再给一次机会）。 */
    const FIRED_KEY = "pdev-auto-open-fired";
    /** 用户关掉过我们的面板 → 别再自动开。这个要跨会话记住。 */
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
     * 怎么退订：**用户关掉就是不要，不需要给设置界面。**
     * 自动打开后 60 秒内被关掉 → 记一条持久标记，以后不再自动开。
     * 超过 60 秒才关，多半只是"看完了"，不算拒绝。
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
                console.log("[dsh-parallel-dev] 看板被关掉，以后不再自动打开（想恢复：清掉 localStorage 的 pdev-auto-open-off）");
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

    function apply(ctx) {
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
