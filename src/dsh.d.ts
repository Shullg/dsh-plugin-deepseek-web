/**
 * Ambient 类型声明：DSH 客户端运行时与本插件实际用到的表面。
 *
 * 遵循社区约定（dsh-office-plugin）：只声明用到的一层字段，深层用 any 兜底，
 * 避免因上游内部实现频繁变动而破坏类型面。这里的声明只服务于本项目编译，
 * 不代表 DSH 官方 API 契约。
 */

declare global {
  interface Window {
    /**
     * DSH 浏览器半部模块加载器（client bundle 引导）。
     * 可选：旧版 DSH 或测试环境可能不存在，client.ts 顶层调用前已判空。
     */
    __ModuleLoader__?: {
      load(desc: {
        id: string;
        factory: (require: (id: string) => any) => {
          inject?: string[];
          apply: (ctx: DSHClientContext) => void;
        };
      }): void;
    };
    /** DSH 桌面端私有桥（仅桌面版存在；浏览器 Web GUI 不暴露）。 */
    dshDesktop?: {
      browser?: {
        /**
         * 申请一个隔离 guest 的租约。
         * @param name 请求名（如 'dsh-plugin-deepseek-web'）
         * @returns lease 是桌面端分配的实际租约 id（与请求名不同）；
         *          webview 必须以 name=<返回的 lease> 且 src=about:blank#<lease> 启动；
         *          partition 是桌面端分配的隔离分区（进程级、重启即失效，不能用 persist: 覆盖）
         */
        acquire(name: string): Promise<{ lease: string; partition: string } | null | undefined>;
        /** 释放租约并关闭 guest。 */
        release(lease: string): Promise<void> | void;
        /** 网页内新窗口弹出回调（可选，OAuth 等场景）。 */
        onOpenRequested?(lease: string, handler: (args: unknown) => void): void;
      };
    };
  }

  /** Electron <webview> 自定义元素（不在 lib.dom 里，需自行声明）。 */
  interface DSHWebviewElement extends HTMLElement {
    loadURL(url: string): Promise<void> | void;
    reload(): Promise<void> | void;
    stop(): void;
    getURL(): string;
    /** 泛型化：调用方可指定 guest 返回值形状，避免 any 扩散。 */
    executeJavaScript<T = any>(code: string, userGesture?: boolean): Promise<T>;
    /** 向 guest 注入 CSS（主题注入比 executeJavaScript 更稳）。 */
    insertCSS(css: string): Promise<string>;
    canGoBack(): boolean;
    goBack(): void;
  }

  interface HTMLElementTagNameMap {
    webview: DSHWebviewElement;
  }

  /**
   * scope.slots 的最小接口，只声明 client.ts 用到的两个方法。
   * 具体签名以 DSH 当前版本的 slots 插件 API 为准。
   */
  interface DSHClientSlots {
    inject(name: string, factory: () => unknown): unknown;
    register(options: { name: string; key: string }, component: (props: any) => any): unknown;
  }

  /** DSH 客户端 Cordis 上下文表面（只声明调用到的部分）。 */
  interface DSHClientContext {
    /** factory 的 scope 与根 ctx 同型，让 scope.get/effect/slots 获得类型。 */
    inject(names: string[], factory: (scope: DSHClientContext) => void): unknown;
    get<T = any>(name: string): T;
    on(name: string, handler: (...args: any[]) => void): () => void;
    effect(effect: () => void | (() => void), name?: string): unknown;
    /** 只能在 inject 回调的 scope 上可靠使用；顶层 apply 可能未就绪。 */
    slots?: DSHClientSlots;
  }
}

export {};
