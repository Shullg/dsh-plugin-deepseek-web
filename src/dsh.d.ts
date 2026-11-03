/**
 * Ambient 类型声明：DSH 客户端运行时与本插件实际用到的表面。
 *
 * 遵循社区约定（dsh-office-plugin）：只声明用到的一层字段，深层用 any 兜底，
 * 避免因上游内部实现频繁变动而破坏类型面。这里的声明只服务于本项目编译，
 * 不代表 DSH 官方 API 契约。
 */

declare global {
  interface Window {
    /** DSH 浏览器半部模块加载器（client bundle 引导）。 */
    __ModuleLoader__: {
      load(desc: {
        id: string;
        factory: (require: (id: string) => any) => any;
      }): void;
    };
    /** DSH 桌面端私有桥（仅桌面版存在；浏览器 Web GUI 不暴露）。 */
    dshDesktop?: {
      browser?: {
        /**
         * 申请一个隔离 guest 的租约。返回 { lease, partition }：
         *  - lease：一次性租约 id，webview 必须以 name=lease 且 src=about:blank#lease 启动
         *  - partition：桌面端按租约协议分配的隔离分区（进程级、重启即失效，不能用 persist: 覆盖）
         */
        acquire(lease: string): Promise<{ lease: string; partition: string } | null | undefined>;
        /** 释放租约并关闭 guest。 */
        release(lease: string): Promise<void> | void;
        /** 网页内新窗口弹出回调（可选）。 */
        onOpenRequested?(lease: string, handler: (args: unknown) => void): void;
      };
    };
  }

  /** Electron <webview> 自定义元素（不在 lib.dom 里，需自行声明）。 */
  interface DSHWebviewElement extends HTMLElement {
    loadURL(url: string): Promise<void> | void;
    reload(): Promise<void> | void;
    getURL(): string;
    executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
    canGoBack(): boolean;
    goBack(): void;
  }

  interface HTMLElementTagNameMap {
    webview: DSHWebviewElement;
  }

  /** DSH 客户端 Cordis 上下文表面（只声明调用到的部分）。 */
  interface DSHClientContext {
    inject(names: string[], factory: (scope: any) => void): unknown;
    get<T = any>(name: string): T;
    on(name: string, handler: (...args: any[]) => void): () => void;
    effect(effect: () => void | (() => void), name?: string): unknown;
    slots?: any;
  }
}

export {};
