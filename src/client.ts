/**
 * Client（browser）半部 —— @local/dsh-plugin-deepseek-web
 *
 * 在 DSH 双半结构里，本文件是浏览器半部，负责：
 *  1. 在左侧「工作区」区头上方注册一个 "DS" 触发按钮（Activity Bar 图标）；
 *  2. 点击后在右侧栏打开一个 `deepseek-web` Tab，其面板 DOM 内动态创建
 *     Electron 隔离 <webview>，加载 https://chat.deepseek.com/；
 *  3. webview 走 DSH 桌面端私有桥 window.dshDesktop.browser 的租约协议
 *     （about:blank#<lease> + partition 双向校验），带 allowpopups；
 *  4. 登录持久化：保存/恢复 DeepSeek 自身的 userToken / __appKit_userInfo，
 *     实现「重启不掉登录态」（桌面端 partition 是进程级随机分区，无法用
 *     persist: 覆盖，token 恢复是唯一可靠途径）；
 *  5. 主题同步：通过 webview.executeJavaScript 把 DSH 明暗状态写入网页。
 *
 * 架构参照社区已验证实现：swj88620-commits/dsh-deepseek-web-dock 与
 * sbbbx/dsh-client-ui-webchat（MIT）。本实现是独立 TypeScript 重构。
 */

type ModuleRequire = (id: string) => any;

/** React 类型面 —— 只声明本文件用到的部分（createElement + hooks）。 */
interface ReactLike {
  createElement(type: any, props: any | null, ...children: any[]): any;
  useRef<T>(initialValue: T): { current: T };
  useState<S>(initialState: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void];
  useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<any>): void;
  useCallback<T extends (...args: any[]) => any>(callback: T, deps?: ReadonlyArray<any>): T;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const KIND = 'deepseek-web';
const TYPE_ID = '@local/dsh-plugin-deepseek-web/panel';
const START_URL = 'https://chat.deepseek.com/';
const WARMUP_URL = 'https://chat.deepseek.com/robots.txt';
const AUTH_KEY = 'dsh.deepseek-web.auth.v1';
const AUTH_POLL_MS = 5000;
const LEASE_NAME = 'dsh-plugin-deepseek-web';
const DOUBLE_CLICK_MS = 280;
const ESCAPE_MARKER = '[dsh-plugin-deepseek-web] escape';

let zh = true;
let rootCtx: DSHClientContext | null = null;

// ---------------------------------------------------------------------------
// 文案（中 / 英）
// ---------------------------------------------------------------------------
const COPY: Record<string, Record<string, string>> = {
  zh: {
    label: 'DeepSeek 网页版',
    tabTitle: 'DeepSeek 网页版',
    open: '单击打开 / 已打开时单击收起；双击全屏',
    needSession: '请先打开一个会话',
    unavailable: '右侧栏暂不可用',
    openFailed: '无法打开右侧栏',
    desktopOnly: '仅桌面版可用',
    connecting: '正在连接',
    loading: '加载中',
    offline: '连接失败',
    signedIn: '登录已保持',
    restoring: '正在恢复登录',
    loginOnce: '登录一次即可保持',
    restoreFailed: '保存的网页登录态恢复失败，请在页面中重新登录。',
    loadFailed: 'DeepSeek 网页版加载失败，请检查网络后重试。',
    crashed: '内嵌网页已停止，请重新加载。',
    guestFailed: '无法启动内嵌浏览器。',
    unsupportedBody: '内嵌 DeepSeek 网页版需要 DeepSeek Harness 桌面版的隔离 webview。请在桌面版中打开。',
    retry: '重试',
    reload: '重新加载',
    tag: '免费',
    firstHint: '首次使用请登录一次，之后会自动保持网页登录。',
  },
  en: {
    label: 'DeepSeek Web',
    tabTitle: 'DeepSeek Web',
    open: 'Click to open · Click again to close · Double-click for fullscreen',
    needSession: 'Open a session first',
    unavailable: 'Right sidebar unavailable',
    openFailed: 'Could not open the right sidebar',
    desktopOnly: 'Desktop only',
    connecting: 'Connecting',
    loading: 'Loading',
    offline: 'Not connected',
    signedIn: 'Signed in',
    restoring: 'Restoring sign-in',
    loginOnce: 'Sign in once',
    restoreFailed: 'The saved web sign-in could not be restored. Sign in on the page.',
    loadFailed: 'DeepSeek Web could not be loaded. Check the network and retry.',
    crashed: 'The embedded page stopped. Reload it.',
    guestFailed: 'Could not start the embedded browser.',
    unsupportedBody: 'DeepSeek Web needs the isolated webview of DeepSeek Harness Desktop. Open this from the desktop app.',
    retry: 'Retry',
    reload: 'Reload',
    tag: 'FREE',
    firstHint: 'Sign in once on first use; later launches restore the web login.',
  },
};

/** 文案取值：按当前语言取 key，缺英文回退中文，再缺返回 key 本身。 */
function t(key: string): string {
  return (zh ? COPY.zh : COPY.en)[key] || COPY.zh[key] || key;
}

// ---------------------------------------------------------------------------
// 图标（"DS" 单色 monogram）
// ---------------------------------------------------------------------------
const ICON_MARKUP = [
  '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">',
  '<defs><linearGradient id="dsh-dw-glyph" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse">',
  '<stop offset="0" stop-color="#3a7bff" /><stop offset="1" stop-color="#1746a8" />',
  '</linearGradient></defs>',
  '<rect x="4" y="4" width="56" height="56" rx="15" fill="url(#dsh-dw-glyph)" />',
  '<text x="32" y="41" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700"',
  ' fill="#ffffff" text-anchor="middle" dominant-baseline="middle">DS</text>',
  '</svg>',
].join('');

/** 生成 "DS" monogram 图标元素（纯内联 SVG，无外部资源）。 */
function BrandGlyph(React: ReactLike) {
  return React.createElement('span', {
    className: 'dsh-deepseek-glyph',
    'aria-hidden': true,
    dangerouslySetInnerHTML: { __html: ICON_MARKUP },
  });
}

// ---------------------------------------------------------------------------
// 主题镜像：DSH 明暗状态 -> 网页。DeepSeek 网页与 Harness 都识别
// data-ds-dark-theme 属性，因此不触碰网页自身的控件即可跟随主题。
// ---------------------------------------------------------------------------
const themeListeners = new Set<() => void>();

function hostIsDark(): boolean {
  try {
    if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return true;
    const scheme = getComputedStyle(document.body || document.documentElement).colorScheme || '';
    if (scheme.toLowerCase().includes('dark')) return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

function themePayload(): { dark: boolean; background: string } {
  let background = '';
  try {
    background = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim();
  } catch {
    background = '';
  }
  return { dark: hostIsDark(), background };
}

/** 序列化进 guest 的自包含函数：不能引用任何 Harness 全局。 */
function applyThemeInPage(payload: { dark: boolean; background: string }): boolean {
  const body = document.body;
  if (!body) return false;
  const dark = !!(payload && payload.dark);
  if (dark) body.setAttribute('data-ds-dark-theme', '');
  else body.removeAttribute('data-ds-dark-theme');
  document.documentElement.style.setProperty('color-scheme', dark ? 'dark' : 'light', 'important');
  const background = payload && payload.background;
  if (background) {
    document.documentElement.style.setProperty('background-color', background, 'important');
    body.style.setProperty('background-color', background, 'important');
  }
  (window as any).__dshDeepSeekDesiredDark = dark;
  if (!(window as any).__dshDeepSeekThemeGuard && body) {
    (window as any).__dshDeepSeekThemeGuard = true;
    try {
      new MutationObserver(() => {
        const wanted = (window as any).__dshDeepSeekDesiredDark;
        const current = document.body;
        if (!current || typeof wanted !== 'boolean') return;
        if (wanted && !current.hasAttribute('data-ds-dark-theme')) current.setAttribute('data-ds-dark-theme', '');
        if (!wanted && current.hasAttribute('data-ds-dark-theme')) current.removeAttribute('data-ds-dark-theme');
      }).observe(body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    } catch {
      /* 初始写入仍生效 */
    }
  }
  return true;
}

async function applyThemeToView(view: DSHWebviewElement | null): Promise<void> {
  if (!view || typeof view.executeJavaScript !== 'function') return;
  try {
    await view.executeJavaScript('(' + applyThemeInPage.toString() + ')(' + JSON.stringify(themePayload()) + ')', false);
  } catch {
    /* 导航中途会令 document 失效，忽略 */
  }
}

function notifyTheme(): void {
  for (const listener of Array.from(themeListeners)) {
    try {
      listener();
    } catch {
      /* 一个页面出错不能影响其他页面 */
    }
  }
}

// ---------------------------------------------------------------------------
// 登录态保存 / 恢复。
// DeepSeek 把登录信息放在版本化 wrapper 中：userToken / __appKit_userInfo。
// token 存逻辑值（纯字符串）；info 存原始 wrapper 文本（含 __version），
// 因为 info 是对象，需要保留版本号才能被 DeepSeek 正确解析。
// ---------------------------------------------------------------------------
interface SavedAuth {
  token: string;
  tokenVersion: string;
  info: string | null;
  infoVersion: string;
}

/** 从 DSH localStorage 读取已保存的登录态；损坏/过期时清除并返回 null。 */
function readSavedAuth(): SavedAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const token = typeof value.token === 'string' ? value.token.trim() : '';
    if (!token || token === 'null' || token.startsWith('{') || token.indexOf('"__version"') !== -1) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return {
      token,
      tokenVersion: value.tokenVersion ? String(value.tokenVersion) : '0',
      info: typeof value.info === 'string' && value.info.length < 32768 ? value.info : null,
      infoVersion: value.infoVersion ? String(value.infoVersion) : '0',
    };
  } catch {
    return null;
  }
}

/** 把登录态写入 DSH localStorage；info 限制 32KB 防止超大对象撑爆存储。 */
function writeSavedAuth(token: string, tokenVersion: unknown, info: string | null, infoVersion: unknown): void {
  try {
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({
        token,
        tokenVersion: String(tokenVersion || '0'),
        info: typeof info === 'string' && info.length < 32768 ? info : null,
        infoVersion: String(infoVersion || '0'),
        savedAt: Date.now(),
      }),
    );
  } catch {
    /* localStorage 可能不可用 */
  }
}

function clearSavedAuth(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 序列化进 guest：读取 DeepSeek 版本化 wrapper 里的逻辑值。 */
function readAuthInPage(): {
  token: string | null;
  tokenVersion: string;
  info: string | null;
  infoVersion: string;
} {
  const parse = (raw: string | null): { value: unknown; version: string } => {
    if (raw == null) return { value: null, version: '0' };
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.prototype.hasOwnProperty.call(parsed, 'value')
      ) {
        return {
          value: (parsed as { value?: unknown }).value,
          version: (parsed as { __version?: unknown }).__version == null ? '0' : String((parsed as { __version?: unknown }).__version),
        };
      }
    } catch {
      /* 旧版纯字符串格式 */
    }
    return { value: raw, version: '0' };
  };
  try {
    const token = parse(localStorage.getItem('userToken'));
    const info = parse(localStorage.getItem('__appKit_userInfo'));
    return {
      token: typeof token.value === 'string' ? token.value : null,
      tokenVersion: token.version,
      info: info.value == null ? null : localStorage.getItem('__appKit_userInfo'),
      infoVersion: info.version,
    };
  } catch {
    return { token: null, tokenVersion: '0', info: null, infoVersion: '0' };
  }
}

/** 序列化进 guest：在 DeepSeek 启动前把保存的登录态写回。 */
function restoreAuthInPage(payload: {
  token?: string | null;
  tokenVersion?: string;
  info?: string | null;
  infoVersion?: string;
}): boolean {
  const parse = (raw: string | null): { value: unknown; version: string } => {
    if (raw == null) return { value: null, version: '0' };
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.prototype.hasOwnProperty.call(parsed, 'value')
      ) {
        return {
          value: (parsed as { value?: unknown }).value,
          version: (parsed as { __version?: unknown }).__version == null ? '0' : String((parsed as { __version?: unknown }).__version),
        };
      }
    } catch {
      /* 旧版格式 */
    }
    return { value: raw, version: '0' };
  };
  const wrap = (value: unknown, version: unknown): string => JSON.stringify({ value, __version: String(version || '0') });
  try {
    const current = parse(localStorage.getItem('userToken'));
    if (payload && payload.token && (!current.value || current.value === 'null')) {
      localStorage.setItem('userToken', wrap(payload.token, payload.tokenVersion));
    }
    const currentInfo = parse(localStorage.getItem('__appKit_userInfo'));
    const infoEmpty =
      currentInfo.value == null || (typeof currentInfo.value === 'object' && (currentInfo.value as { id?: unknown }).id == null);
    if (payload && payload.info && infoEmpty) {
      localStorage.setItem('__appKit_userInfo', payload.info);
    }
    return true;
  } catch {
    return false;
  }
}

const READ_AUTH_SOURCE = '(' + readAuthInPage.toString() + ')()';
const restoreAuthSource = (payload: SavedAuth) =>
  '(' + restoreAuthInPage.toString() + ')(' + JSON.stringify(payload) + ')';

/** 序列化进 guest：写入 DeepSeek 的 "使用环境异常" 关闭偏好，等同点击提示 ×。 */
function dismissEnvWarningInPage(): string {
  try {
    const key = 'closeUnsafeEnvWarn';
    const value = JSON.stringify({ value: true, __version: '0' });
    if (localStorage.getItem(key) === value) return 'kept';
    localStorage.setItem(key, value);
    return 'changed';
  } catch {
    return 'error';
  }
}
const ENV_WARN_SOURCE = '(' + dismissEnvWarningInPage.toString() + ')()';

/** 序列化进 guest：webview 键盘事件不冒泡到宿主，Esc 通过 guest console 上报。 */
function installEscapeInPage(): boolean {
  if ((window as any).__dshDeepSeekEscapeInstalled) return true;
  (window as any).__dshDeepSeekEscapeInstalled = true;
  window.addEventListener(
    'keydown',
    function (event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.isComposing) return;
      try {
        // eslint-disable-next-line no-console
        console.info('[dsh-plugin-deepseek-web] escape');
      } catch {
        /* console 尽力而为 */
      }
    },
    true,
  );
  return true;
}
const ESCAPE_SOURCE = '(' + installEscapeInPage.toString() + ')()';

/** 顶栏状态文字：根据面板阶段 + 登录态决定显示哪条文案。 */
function statusText(phase: Phase, authState: AuthState): string {
  if (phase === 'starting') return t('connecting');
  if (phase === 'loading') return t('loading');
  if (phase === 'unsupported') return t('desktopOnly');
  if (phase === 'error') return t('offline');
  if (authState === 'saved') return t('signedIn');
  if (authState === 'restoring') return t('restoring');
  return t('loginOnce');
}

/** 顶栏状态指示灯颜色：ok=绿 / wait=蓝 / err=红。 */
function statusTone(phase: Phase, authState: AuthState): 'ok' | 'wait' | 'err' {
  if (phase === 'ready') return authState === 'saved' || authState === 'restoring' ? 'ok' : 'wait';
  if (phase === 'error' || phase === 'unsupported') return 'err';
  return 'wait';
}

type Phase = 'starting' | 'loading' | 'ready' | 'error' | 'unsupported';
type AuthState = 'checking' | 'saved' | 'restoring' | 'none';

// ---------------------------------------------------------------------------
// 样式（使用 DSH 侧栏主题变量）
// ---------------------------------------------------------------------------
const PANEL_CSS = `
.dsh-deepseek-trigger-host{flex:none;box-sizing:border-box;padding:3px 0 2px;min-width:0}
.dsh-deepseek-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;margin:0;padding:0 8px;border:.5px solid rgba(74,132,255,.38);border-radius:var(--dsw-radius-md,9px);background:linear-gradient(135deg,rgba(47,111,237,.18),rgba(47,111,237,.045)),var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));color:var(--dsw-alias-label-secondary,rgba(235,238,245,.78));font:inherit;font-size:12px;line-height:1;text-align:left;cursor:pointer;overflow:hidden;user-select:none;-webkit-user-select:none;transition:border-color 140ms ease,background-color 140ms ease,color 140ms ease}
.dsh-deepseek-trigger:hover:not(:disabled){border-color:rgba(94,150,255,.72);background:linear-gradient(135deg,rgba(47,111,237,.28),rgba(47,111,237,.08)),var(--dsw-alias-bg-layer-1,rgba(255,255,255,.05));color:var(--dsw-alias-label-primary,#f2f4f8)}
.dsh-deepseek-trigger:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4a84ff);outline-offset:-2px}
.dsh-deepseek-trigger:disabled{cursor:default;opacity:.58}
.dsh-deepseek-trigger[data-error="true"]{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-deepseek-trigger-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px}
.dsh-deepseek-trigger-glyph svg{width:18px;height:18px;display:block}
.dsh-deepseek-trigger-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:500;letter-spacing:.01em}
.dsh-deepseek-trigger-tag{flex:none;padding:2px 4px;border:.5px solid rgba(94,150,255,.42);border-radius:4px;color:rgba(120,172,255,.92);font-size:8px;font-weight:600;line-height:1;letter-spacing:.08em}
.dsh-deepseek-panel{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#17181b);color:var(--dsw-alias-label-primary,#f1f3f7);font-family:inherit}
.dsh-deepseek-panel *,.dsh-deepseek-panel *::before,.dsh-deepseek-panel *::after{box-sizing:border-box}
.dsh-deepseek-bar{flex:none;display:flex;align-items:center;gap:7px;height:36px;padding:0 8px 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.025))}
.dsh-deepseek-glyph{flex:none;display:inline-flex;width:15px;height:15px}
.dsh-deepseek-glyph svg{width:15px;height:15px;display:block}
.dsh-deepseek-name{flex:none;max-width:46%;overflow:hidden;color:var(--dsw-alias-label-primary,#f1f3f7);font-size:12px;font-weight:600;white-space:nowrap;text-overflow:ellipsis}
.dsh-deepseek-status{flex:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary,rgba(232,235,242,.68));font-size:11px;white-space:nowrap;text-overflow:ellipsis}
.dsh-deepseek-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#8a8f99)}
.dsh-deepseek-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary,#30a46c);box-shadow:0 0 0 2px rgba(48,164,108,.15)}
.dsh-deepseek-dot[data-tone="wait"]{background:var(--dsw-alias-state-business-primary,#4a84ff)}
.dsh-deepseek-dot[data-tone="err"]{background:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-deepseek-iconbutton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,rgba(232,235,242,.68));cursor:pointer}
.dsh-deepseek-iconbutton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#f1f3f7)}
.dsh-deepseek-iconbutton:disabled{opacity:.38;cursor:default}
.dsh-deepseek-iconbutton svg{width:14px;height:14px;display:block}
.dsh-deepseek-notice{flex:none;padding:5px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.045));color:var(--dsw-alias-label-secondary,rgba(232,235,242,.72));font-size:11px;line-height:1.45}
.dsh-deepseek-stage{position:relative;flex:1;min-height:0;background:var(--dsw-alias-bg-base,#17181b)}
.dsh-deepseek-mount{position:absolute;inset:0;display:flex;min-width:0;min-height:0}
.dsh-deepseek-webview{display:flex;width:100%;height:100%;min-width:0;min-height:0;background:var(--dsw-alias-bg-base,#17181b)}
.dsh-deepseek-cover{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:28px;background:var(--dsw-alias-bg-base,#17181b);color:var(--dsw-alias-label-secondary,rgba(232,235,242,.68));text-align:center}
.dsh-deepseek-cover strong{color:var(--dsw-alias-label-primary,#f1f3f7);font-size:13px;font-weight:600}
.dsh-deepseek-cover p{max-width:310px;margin:0;font-size:12px;line-height:1.6}
.dsh-deepseek-cover button{height:28px;margin-top:2px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:6px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));color:var(--dsw-alias-label-primary,#f1f3f7);font:inherit;font-size:12px;cursor:pointer}
.dsh-deepseek-cover button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.dsh-deepseek-spinner{width:17px;height:17px;border:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-top-color:var(--dsw-alias-brand-primary,#4a84ff);border-radius:50%;animation:dsh-deepseek-spin .8s linear infinite}
.dsh-deepseek-cover small{max-width:310px;color:var(--dsw-alias-label-tertiary,rgba(232,235,242,.46));font-size:11px;line-height:1.55}
@keyframes dsh-deepseek-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dsh-deepseek-trigger{transition:none}.dsh-deepseek-spinner{animation-duration:1.8s}}
`;

function svgIcon(React: ReactLike, paths: string[]): any {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      'aria-hidden': true,
      focusable: 'false',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    paths.map((d, index) => React.createElement('path', { key: index, d })),
  );
}

// ---------------------------------------------------------------------------
// 右侧栏 Tab 相关（读取/打开/关闭）
// ---------------------------------------------------------------------------
/** 获取右侧栏服务；未就绪返回 null。 */
function getSidebar(): any {
  return rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('sidebarRight') : null;
}

/** 列出当前会话里所有本插件注册的 Tab。 */
function deepSeekTabs(): any[] {
  const sidebar = getSidebar();
  if (!sidebar) return [];
  let sessionId: string | undefined;
  try {
    sessionId =
      sidebar.mounted && typeof sidebar.mounted.getSnapshot === 'function'
        ? (sidebar.mounted.getSnapshot() as string | undefined)
        : undefined;
  } catch {
    sessionId = undefined;
  }
  if (!sessionId) return [];
  const inventory = sidebar.openTabs;
  if (inventory && typeof inventory.getSnapshot === 'function') {
    try {
      const snapshot = inventory.getSnapshot();
      if (Array.isArray(snapshot)) {
        return snapshot.filter(
          (tab: any) => tab && tab.sessionId === sessionId && tab.kind === KIND && typeof tab.tabId === 'string',
        );
      }
    } catch {
      /* 回退到 active tab */
    }
  }
  return [];
}

/** 当前激活的 Tab 是否是本插件的；不是则返回 null。 */
function activeDeepSeekTab(): any {
  const sidebar = getSidebar();
  if (!sidebar || typeof sidebar.active !== 'function') return null;
  try {
    const active = sidebar.active();
    if (active && active.kind === KIND && typeof active.id === 'string' && active.id) return active;
  } catch {
    /* 无 adopted surface */
  }
  return null;
}

/** 判断 DeepSeek 面板是否已展开可见。 */
function isDeepSeekOpen(): boolean {
  const sidebar = getSidebar();
  if (!sidebar) return false;
  if (deepSeekTabs().length === 0 && activeDeepSeekTab() === null) return false;
  try {
    return typeof sidebar.isExpanded === 'function' ? sidebar.isExpanded() === true : true;
  } catch {
    return false;
  }
}

/** 在 DOM 中找到当前可见的右侧栏面板元素（跳过 aria-hidden 的）。 */
function currentPanelElement(): HTMLElement | null {
  const sidebar = getSidebar();
  let sessionId: string | undefined;
  try {
    sessionId =
      sidebar && sidebar.mounted && typeof sidebar.mounted.getSnapshot === 'function'
        ? (sidebar.mounted.getSnapshot() as string | undefined)
        : undefined;
  } catch {
    sessionId = undefined;
  }
  for (const panel of document.querySelectorAll('[data-sidebar-right-panel]')) {
    if (panel.closest('[aria-hidden="true"]')) continue;
    if (sessionId && panel.getAttribute('data-sidebar-right-session') !== sessionId) continue;
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0) continue;
    return panel as HTMLElement;
  }
  return null;
}

/** 关闭右侧栏面板：优先点 DSH 自带的 toggle 按钮，回退到 sidebar.toggleExpanded。 */
function closeDeepSeek(): boolean {
  cancelScheduledClick();
  lastTriggerClickAt = 0;
  pendingFullscreen = false;
  const sidebar = getSidebar();
  if (!sidebar) return false;
  try {
    if (typeof sidebar.isExpanded === 'function' && sidebar.isExpanded() !== true) return false;
  } catch {
    return false;
  }
  try {
    if (triggerButton) triggerButton.focus({ preventScroll: true });
  } catch {
    /* focus 尽力而为 */
  }
  const panel = currentPanelElement();
  const toggle = panel ? panel.querySelector<HTMLElement>('[data-sidebar-right-toggle]') : null;
  if (toggle && typeof toggle.click === 'function') {
    toggle.click();
    return true;
  }
  try {
    if (typeof sidebar.toggleExpanded === 'function') {
      sidebar.toggleExpanded();
      return true;
    }
  } catch {
    /* 忽略 */
  }
  return false;
}

function cancelScheduledClick(): void {
  if (!clickTimer) return;
  window.clearTimeout(clickTimer);
  clickTimer = 0;
  pendingClickWasOpen = false;
}

function scheduleSingleClick(wasOpen: boolean): void {
  cancelScheduledClick();
  pendingClickWasOpen = wasOpen;
  clickTimer = window.setTimeout(() => {
    clickTimer = 0;
    lastTriggerClickAt = 0;
    const close = pendingClickWasOpen;
    pendingClickWasOpen = false;
    if (close) closeDeepSeek();
    else openDeepSeek(false);
  }, DOUBLE_CLICK_MS);
}

function panelFullscreenState(): boolean | null {
  const panel = currentPanelElement();
  if (panel) return panel.getAttribute('data-sidebar-right-panel') === 'fullscreen';
  for (const candidate of document.querySelectorAll('[data-sidebar-right-panel="fullscreen"]')) {
    if (candidate.closest('[aria-hidden="true"]')) continue;
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth) return true;
  }
  return null;
}

function schedulePanelMode(wantFullscreen: boolean, attempt = 0): void {
  if (disposedTrigger) return;
  window.setTimeout(() => {
    applyPanelMode(wantFullscreen, attempt);
  }, 50);
}

function applyPanelMode(wantFullscreen: boolean, attempt = 0): void {
  if (disposedTrigger) return;
  const sidebar = getSidebar();
  if (!sidebar || typeof sidebar.isExpanded !== 'function' || sidebar.isExpanded() !== true) return;
  if (window.innerWidth < 768) return;
  const current = panelFullscreenState();
  if (current === null) {
    if (attempt < 12) schedulePanelMode(wantFullscreen, attempt + 1);
    return;
  }
  if (current === wantFullscreen) return;
  let target: unknown = null;
  try {
    target = typeof sidebar.commandTarget === 'function' ? sidebar.commandTarget(null) : null;
  } catch {
    target = null;
  }
  if (
    !target ||
    typeof sidebar.toggleFullscreen !== 'function' ||
    (typeof sidebar.isTargetCurrent === 'function' && sidebar.isTargetCurrent(target) !== true)
  ) {
    if (attempt < 12) schedulePanelMode(wantFullscreen, attempt + 1);
    return;
  }
  try {
    sidebar.toggleFullscreen(target);
  } catch {
    /* 忽略 */
  }
}

/**
 * 打开 DeepSeek 右侧栏 Tab。
 * 若当前没有打开任何会话，先尝试 startSession；openTab 失败时最多重试 20 次（200ms 间隔）。
 * wantFullscreen=true 时（双击触发）打开后自动切换全屏。
 */
function openDeepSeek(wantFullscreen = false): void {
  cancelScheduledClick();
  const sidebar = getSidebar();
  if (!sidebar || typeof sidebar.openTab !== 'function') {
    flashTrigger(t('unavailable'));
    return;
  }
  if (openingTimer) {
    if (wantFullscreen) pendingFullscreen = true;
    return;
  }
  let mounted: unknown = null;
  try {
    mounted = sidebar.mounted && typeof sidebar.mounted.getSnapshot === 'function' ? sidebar.mounted.getSnapshot() : null;
  } catch {
    mounted = null;
  }
  if (!mounted) {
    const workspace = typeof rootCtx?.get === 'function' ? rootCtx.get('uiWorkspace') : null;
    if (workspace && typeof workspace.startSession === 'function') {
      try {
        workspace.startSession();
      } catch {
        /* 下面的重试会报告失败 */
      }
    }
  }
  let attempts = 0;
  const attempt = (): void => {
    attempts += 1;
    try {
      sidebar.openTab(KIND);
      openingTimer = 0;
      const full = pendingFullscreen || wantFullscreen === true;
      pendingFullscreen = false;
      schedulePanelMode(full);
    } catch {
      if (attempts >= 20) {
        openingTimer = 0;
        flashTrigger(mounted ? t('openFailed') : t('needSession'));
        return;
      }
      openingTimer = window.setTimeout(attempt, 200);
    }
  };
  attempt();
}

// ---------------------------------------------------------------------------
// 左侧「工作区」触发按钮（DSH 没有暴露区头专用槽位，故以 DOM 插入）
// ---------------------------------------------------------------------------
const HEADER_LABELS = new Set([
  '工作区',
  '会话',
  'Workspaces',
  'Sessions',
  'Espaces de travail',
  'Séances',
  'Arbeitsbereiche',
  'Sitzungen',
  'Рабочие пространства',
  'Сессии',
  'Espacios de trabajo',
  'Sesiones',
  'Espaços de trabalho',
  'Sessões',
  'ワークスペース',
  'セッション',
]);

let triggerHost: HTMLDivElement | null = null;
let triggerButton: HTMLButtonElement | null = null;
let triggerLabel: HTMLElement | null = null;
let styleElement: HTMLStyleElement | null = null;
let domObserver: MutationObserver | null = null;
let resizeObserver: ResizeObserver | null = null;
let resizeParent: Element | null = null;
let ensureFrame = 0;
let disposedTrigger = false;
let openingTimer = 0;
let clickTimer = 0;
let pendingClickWasOpen = false;
let lastTriggerClickAt = 0;
let pendingFullscreen = false;

function flashTrigger(message: string): void {
  if (!triggerButton || !triggerLabel) return;
  triggerButton.dataset.error = 'true';
  triggerLabel.textContent = message;
  window.setTimeout(() => {
    if (!triggerButton || !triggerLabel) return;
    delete triggerButton.dataset.error;
    triggerLabel.textContent = t('label');
  }, 2600);
}

/** 在 DOM 中定位最左侧的侧边栏列容器（Activity Bar 区域），作为插入触发按钮的范围。 */
function findSidebarScope(): HTMLElement {
  let best: HTMLElement | null = null;
  let bestLeft = Infinity;
  let fallback: HTMLElement | null = null;
  for (const element of document.querySelectorAll('[class*="sidebarCol"]')) {
    if (fallback === null) fallback = element as HTMLElement;
    const rect = element.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 200) continue;
    if (rect.left < bestLeft) {
      best = element as HTMLElement;
      bestLeft = rect.left;
    }
  }
  return best || fallback || document.body;
}

function insideRightSidebar(element: Element | null): boolean {
  return !!(element && typeof element.closest === 'function' && element.closest('[data-sidebar-right-session]'));
}

/** 从左侧 tree 组件向上找 sectionHeader 节点（DSH 没有暴露区头槽位，只能 DOM 探测）。 */
function headerFromTree(scope: HTMLElement): HTMLElement | null {
  const trees = scope.querySelectorAll('[role="tree"]');
  for (const tree of trees) {
    if (insideRightSidebar(tree)) continue;
    const treeRect = tree.getBoundingClientRect();
    if (treeRect.left > window.innerWidth * 0.45) continue;
    let node: Element | null = tree.parentElement;
    for (let depth = 0; node && depth < 12; depth += 1) {
      for (const child of node.children) {
        if (child.className && String(child.className).includes('sectionHeader')) return child as HTMLElement;
      }
      if (node === scope) break;
      node = node.parentElement;
    }
  }
  return null;
}

/** 按已知区头文案（多语言）匹配 sectionHeader 元素。 */
function headerByLabel(scope: HTMLElement): HTMLElement | null {
  for (const header of scope.querySelectorAll('[class*="sectionHeader"]')) {
    if (insideRightSidebar(header)) continue;
    const rect = header.getBoundingClientRect();
    if (rect.left > window.innerWidth * 0.45) continue;
    const label = header.querySelector('[class*="sectionLabel"]');
    const value = String(label ? label.textContent : header.textContent).trim();
    if (HEADER_LABELS.has(value)) return header as HTMLElement;
  }
  return null;
}

/** 综合两种策略找到「工作区」区头：优先 tree 向上找，其次按文案匹配。 */
function findWorkspaceHeader(): HTMLElement | null {
  const scope = findSidebarScope();
  return headerFromTree(scope) || headerByLabel(scope);
}

function attachResize(parent: Element): void {
  if (resizeParent === parent && resizeObserver) return;
  if (resizeObserver) resizeObserver.disconnect();
  resizeParent = parent;
  resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => scheduleEnsure());
    resizeObserver.observe(parent);
  }
}

function ensureTrigger(): void {
  if (disposedTrigger || !triggerHost) return;
  const header = findWorkspaceHeader();
  if (!header || !header.parentElement) {
    if (triggerHost.isConnected) triggerHost.remove();
    return;
  }
  const parent = header.parentElement;
  attachResize(parent);
  if (parent.clientWidth < 140) {
    triggerHost.style.display = 'none';
    return;
  }
  triggerHost.style.display = '';
  if (triggerHost.parentElement !== parent || triggerHost.nextElementSibling !== header) {
    parent.insertBefore(triggerHost, header);
  }
}

function scheduleEnsure(): void {
  if (disposedTrigger || ensureFrame) return;
  ensureFrame = window.requestAnimationFrame(() => {
    ensureFrame = 0;
    ensureTrigger();
  });
}

function onDomMutations(records: MutationRecord[]): void {
  if (disposedTrigger || !triggerHost) return;
  if (!triggerHost.isConnected) {
    scheduleEnsure();
    return;
  }
  for (const record of records) {
    const nodes = Array.from(record.addedNodes).concat(Array.from(record.removedNodes));
    for (const node of nodes) {
      if (node === triggerHost) {
        scheduleEnsure();
        return;
      }
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      const className = String(el.className || '');
      if (className.includes('sectionHeader') || className.includes('sidebarCol')) {
        scheduleEnsure();
        return;
      }
      if (typeof el.querySelector === 'function' && el.querySelector('[class*="sectionHeader"], [class*="sidebarCol"]')) {
        scheduleEnsure();
        return;
      }
    }
  }
}

/** 构建左侧触发按钮 DOM；无桌面桥时禁用。单击切换面板，双击全屏。 */
function buildTrigger(): void {
  triggerHost = document.createElement('div');
  triggerHost.className = 'dsh-deepseek-trigger-host';
  triggerHost.dataset.dshDeepSeekHost = '';
  triggerButton = document.createElement('button');
  triggerButton.type = 'button';
  triggerButton.className = 'dsh-deepseek-trigger';
  triggerButton.setAttribute('aria-label', t('open'));
  triggerButton.title = t('open');
  triggerButton.innerHTML = [
    '<span class="dsh-deepseek-trigger-glyph" aria-hidden="true">',
    ICON_MARKUP,
    '</span>',
    '<span class="dsh-deepseek-trigger-label"></span>',
    '<span class="dsh-deepseek-trigger-tag">' + t('tag') + '</span>',
  ].join('');
  triggerLabel = triggerButton.querySelector<HTMLElement>('.dsh-deepseek-trigger-label');
  if (triggerLabel) triggerLabel.textContent = t('label');
  if (!(window.dshDesktop && window.dshDesktop.browser)) {
    triggerButton.disabled = true;
    triggerButton.title = t('desktopOnly');
    triggerButton.setAttribute('aria-label', t('desktopOnly'));
  } else {
    triggerButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      const isDouble = event.detail === 2 || (lastTriggerClickAt > 0 && now - lastTriggerClickAt <= DOUBLE_CLICK_MS);
      lastTriggerClickAt = now;
      if (isDouble) {
        lastTriggerClickAt = 0;
        cancelScheduledClick();
        openDeepSeek(true);
        return;
      }
      scheduleSingleClick(isDeepSeekOpen());
    });
  }
  triggerHost.appendChild(triggerButton);
}

// ---------------------------------------------------------------------------
// 面板组件（React）
// ---------------------------------------------------------------------------
/**
 * DeepSeek 右侧栏面板 React 组件。
 * 生命周期：申请 webview 租约 → 创建 <webview> 加载 about:blank#lease →
 * warmup robots.txt 后注入登录态 → 跳转到 START_URL → did-finish-load 后恢复 token + 主题。
 * 卸载时释放租约、清理所有定时器/观察者/webview 元素。
 */
function DeepSeekPanel(React: ReactLike, props: any): any {
  const h = React.createElement;
  const hostRef = React.useRef<HTMLElement | null>(null);
  const viewRef = React.useRef<DSHWebviewElement | null>(null);
  const aliveRef = React.useRef(true);
  const restoredRef = React.useRef(false);
  const emptyAuthRef = React.useRef(0);
  const [phase, setPhase] = React.useState<Phase>('starting');
  const [authState, setAuthState] = React.useState<AuthState>('checking');
  const [notice, setNotice] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    aliveRef.current = true;
    restoredRef.current = false;
    emptyAuthRef.current = 0;
    const host = hostRef.current;
    const bridge = window.dshDesktop && window.dshDesktop.browser;
    if (!host) return undefined;
    if (!bridge || typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') {
      setPhase('unsupported');
      return undefined;
    }
    let disposed = false;
    let view: DSHWebviewElement | null = null;
    let lease = '';
    let pageRequested = false;
    let poll = 0;
    let warmupTimer = 0;
    // ---- webview guest 视口尺寸同步（修复窄视口 / 横向裁切 BUG） ----
    // Electron <webview> 的 guest 不会随外层元素自动重测：面板展开动画期间
    // webview 先以小尺寸渲染 DeepSeek，之后 DOM 撑满但 guest 不重排，导致
    // 响应式布局错乱（汉堡键小黑方块、侧栏抽屉遮挡主内容、主内容左侧被裁切）。
    // 这里主动 setSize 推送真实像素尺寸 + 一像素抖动 + ResizeObserver 跟随。
    let sizeObserver: ResizeObserver | null = null;
    const sizeRetryFrames: number[] = [];
    const sizeRetryTimers: number[] = [];
    let appliedW = -1;
    let appliedH = -1;
    // Electron <webview> 的 guest 视口不随外层 CSS 自动重测。必须三件套：
    //   1) 给 webview 元素写死 px 宽高（确定盒子，不能用 100%）
    //   2) 调 Electron 标准 API view.setSize({normal:{w,h}}) 显式通知 guest
    //   3) 高度一像素抖动（h-1 → rAF → h）逼 Chromium 重排
    // 时机：dom-ready 后 did-finish-load 后，以及面板容器 ResizeObserver。
    const syncGuestSize = (): void => {
      if (disposed || !view) return;
      try {
        const stage = host.parentElement as HTMLElement | null;
        const rect = (stage || host).getBoundingClientRect();
        const w = Math.max(0, Math.round(rect.width));
        // 高度优先用 stage 自身 rect.height（语义正确）；但面板展开动画期间
        // DSH 会把 stage 算成内容高度（~250px），此时回退到 innerHeight - top。
        let h = Math.max(0, Math.round(rect.height));
        if (h < 300) h = Math.max(0, Math.round(window.innerHeight - rect.top));
        if (w < 20 || h < 20) return;
        // 给 mount 写死 px，webview 的 width:100%/height:100% 自然跟随。
        host.style.width = w + 'px';
        host.style.height = h + 'px';
        host.style.left = '0px';
        host.style.top = '0px';
        // 标准 Electron <webview> 没有 setSize（那是 BrowserView/BrowserWindow 的）。
        // 仅当 DSH 桌面端注入了该扩展时才使用；主要重排机制是 host 写 px + 一像素抖动。
        const anyView = view as any;
        if (typeof anyView.setSize === 'function') {
          try { anyView.setSize({ normal: { width: w, height: h } }); } catch { /* noop */ }
        }
        // 仅在尺寸真正变化时做一像素抖动逼 Chromium 重排；不回顶——保留用户滚动位置。
        if (appliedH !== h || appliedW !== w) {
          appliedW = w;
          appliedH = h;
          host.style.height = Math.max(1, h - 1) + 'px';
          requestAnimationFrame(() => {
            if (!disposed && view) host.style.height = h + 'px';
          });
        }
      } catch { /* noop */ }
    };
    const scheduleSizeSync = (): void => {
      for (let i = 0; i < 10; i += 1) {
        sizeRetryFrames.push(requestAnimationFrame(() => { if (!disposed) syncGuestSize(); }));
      }
      // did-finish-load 后 DeepSeek SPA 还会重排几次，再补几轮延迟同步
      for (const delay of [300, 800, 1500, 2500, 4000]) {
        sizeRetryTimers.push(window.setTimeout(() => { if (!disposed) syncGuestSize(); }, delay));
      }
    };

    const updateAuth = async (target: DSHWebviewElement | null): Promise<boolean | null> => {
      if (disposed || !aliveRef.current || !target || typeof target.executeJavaScript !== 'function') return null;
      try {
        const raw = await target.executeJavaScript(READ_AUTH_SOURCE, false);
        if (disposed || !aliveRef.current) return null;
        const token = raw && typeof raw.token === 'string' && raw.token !== '' && raw.token !== 'null' ? raw.token : '';
        if (token) {
          emptyAuthRef.current = 0;
          const saved = readSavedAuth();
          if (
            !saved ||
            saved.token !== token ||
            saved.tokenVersion !== String(raw.tokenVersion || '0') ||
            (saved.info || null) !== (raw.info || null)
          ) {
            writeSavedAuth(token, raw.tokenVersion || '0', raw.info || null, raw.infoVersion || '0');
          }
          setNotice('');
          setAuthState('saved');
          return true;
        }
        emptyAuthRef.current += 1;
        if (emptyAuthRef.current >= 3) {
          clearSavedAuth();
          setAuthState('none');
        }
        return false;
      } catch {
        return null;
      }
    };

    const afterLoad = async (): Promise<void> => {
      if (!view || disposed) return;
      await applyThemeToView(view);
      const saved = readSavedAuth();
      let current: { token?: string | null } | null = null;
      try {
        current = (await view.executeJavaScript(READ_AUTH_SOURCE, false)) as { token?: string | null } | null;
      } catch {
        current = null;
      }
      if (disposed) return;
      const hasToken = !!(
        current &&
        typeof current.token === 'string' &&
        current.token !== '' &&
        current.token !== 'null'
      );
      if (!restoredRef.current) {
        restoredRef.current = true;
        if (saved && saved.token && !hasToken) {
          setAuthState('restoring');
          emptyAuthRef.current = 0;
          let restored = false;
          try {
            restored = !!(await view.executeJavaScript(restoreAuthSource(saved), false));
          } catch {
            restored = false;
          }
          if (disposed) return;
          if (restored) {
            try {
              view.reload();
              return;
            } catch {
              setNotice(t('restoreFailed'));
              clearSavedAuth();
              setAuthState('none');
            }
          } else {
            setNotice(t('restoreFailed'));
            clearSavedAuth();
            setAuthState('none');
          }
          return;
        }
      }
      const signed = await updateAuth(view);
      if (disposed) return;
      if (signed === false) setAuthState('none');
    };

    const syncTheme = (): void => {
      if (!disposed && view) void applyThemeToView(view);
    };
    themeListeners.add(syncTheme);

    const fail = (message: string, error?: unknown): void => {
      if (disposed) return;
      if (error) console.warn('[dsh-plugin-deepseek-web] ' + message, error);
      setPhase('error');
      setNotice(t(message));
    };

    const load = async (): Promise<void> => {
      setPhase('starting');
      setNotice('');
      try {
        const reservation = await bridge.acquire(LEASE_NAME);
        if (disposed) {
          if (reservation && reservation.lease) void Promise.resolve(bridge.release(reservation.lease)).catch(() => {});
          return;
        }
        if (!reservation || !reservation.lease || !reservation.partition) {
          fail('guestFailed');
          return;
        }
        lease = reservation.lease;
        view = document.createElement('webview');
        view.className = 'dsh-deepseek-webview';
        view.setAttribute('name', lease);
        view.setAttribute('partition', reservation.partition);
        // allowpopups：支持网页内新窗口弹出（如 OAuth 登录）
        view.setAttribute('allowpopups', '');
        view.setAttribute('src', 'about:blank#' + lease);
        view.dataset.dshDeepSeek = 'webview';
        viewRef.current = view;

        let warmup = 0;
        let appStarted = false;
        const loadApp = (): void => {
          if (disposed || appStarted) return;
          appStarted = true;
          pageRequested = true;
          if (warmupTimer) {
            window.clearTimeout(warmupTimer);
            warmupTimer = 0;
          }
          setPhase('loading');
          setNotice('');
          try {
            const pending = view!.loadURL(START_URL);
            if (pending && typeof pending.catch === 'function') {
              pending.catch((error: any) => {
                if (disposed) return;
                if (error && error.code === 'ERR_ABORTED') return;
                fail('loadFailed', error);
              });
            }
          } catch (error) {
            fail('loadFailed', error);
          }
        };

        onWebViewEvent(view, 'dom-ready', () => {
          if (disposed) return;
          let url = '';
          try {
            url = String(view!.getURL() || '');
          } catch {
            url = '';
          }
          let parsed: URL | null = null;
          try {
            parsed = new URL(url);
          } catch {
            parsed = null;
          }
          if (warmup === 0) {
            warmup = 1;
            setPhase('loading');
            try {
              const pending = view!.loadURL(WARMUP_URL);
              if (pending && typeof pending.catch === 'function') {
                pending.catch((error: any) => {
                  if (disposed || appStarted) return;
                  if (error && error.code === 'ERR_ABORTED') return;
                  loadApp();
                });
              }
            } catch {
              loadApp();
              return;
            }
            warmupTimer = window.setTimeout(() => {
              if (!disposed && !appStarted) loadApp();
            }, 1800);
            return;
          }
          if (warmup === 1 && !appStarted) {
            if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'chat.deepseek.com') return;
            warmup = 2;
            let savedAuth: SavedAuth | null = null;
            try {
              savedAuth = readSavedAuth();
            } catch {
              savedAuth = null;
            }
            const warmupSource = savedAuth
              ? ENV_WARN_SOURCE + ';' + restoreAuthSource(savedAuth)
              : ENV_WARN_SOURCE;
            view!.executeJavaScript(warmupSource, false)
              .catch(() => {})
              .then(() => {
                if (!disposed && !appStarted) loadApp();
              });
          }
        });

        onWebViewEvent(view, 'did-finish-load', () => {
          if (disposed || !pageRequested || !appStarted) return;
          let url = '';
          try {
            url = String(view!.getURL() || '');
          } catch {
            url = '';
          }
          if (!/^https:\/\/chat\.deepseek\.com\//i.test(url)) return;
          if (/\/robots\.txt(?:[?#]|$)/i.test(url)) return;
          setPhase('ready');
          setNotice('');
          applyThemeToView(view);
          view!.executeJavaScript(ESCAPE_SOURCE, false).catch(() => {});
          void afterLoad();
          syncGuestSize();
        });

        onWebViewEvent(view, 'did-fail-load', (event: any) => {
          if (disposed) return;
          if (event && (event.errorCode === -3 || event.isMainFrame === false)) return;
          if (!appStarted) {
            loadApp();
            return;
          }
          setPhase('error');
          setNotice(t('loadFailed'));
        });

        onWebViewEvent(view, 'render-process-gone', () => {
          if (disposed) return;
          setPhase('error');
          setNotice(t('crashed'));
        });

        onWebViewEvent(view, 'console-message', (event: any, _level?: number, message?: string) => {
          const text = event && typeof event === 'object' && typeof event.message === 'string' ? event.message : message;
          if (text === ESCAPE_MARKER) closeDeepSeek();
        });

        host.replaceChildren(view);
        // 面板展开动画期间尺寸尚未稳定：立即同步一次 + 多帧重试，并监听容器后续尺寸变化
        // （拖拽面板分隔条、窗口缩放），每次都重新推尺寸给 guest。
        scheduleSizeSync();
        if (typeof ResizeObserver === 'function') {
          sizeObserver = new ResizeObserver(() => { if (!disposed) syncGuestSize(); });
          // mount 自身被写死了 px 尺寸，监听 mount 收不到 stage 缩放；
          // 必须监听 stage（mount 的父容器），面板拖拽/窗口缩放时 stage 才会变化。
          const sizeTarget = host.parentElement || host;
          try { sizeObserver.observe(sizeTarget); } catch { /* noop */ }
        }
        poll = window.setInterval(() => {
          if (!disposed && pageRequested && view) void updateAuth(view);
        }, AUTH_POLL_MS);
      } catch (error) {
        fail('guestFailed', error);
      }
    };
    void load();

    return () => {
      disposed = true;
      aliveRef.current = false;
      themeListeners.delete(syncTheme);
      if (poll) window.clearInterval(poll);
      if (warmupTimer) window.clearTimeout(warmupTimer);
      if (sizeObserver) { try { sizeObserver.disconnect(); } catch { /* noop */ } }
      for (const f of sizeRetryFrames) cancelAnimationFrame(f);
      for (const t of sizeRetryTimers) window.clearTimeout(t);
      const element = view;
      viewRef.current = null;
      if (element) {
        try {
          element.remove();
        } catch {
          /* 已脱离 */
        }
      }
      if (lease && bridge.release) void Promise.resolve(bridge.release(lease)).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const refresh = React.useCallback((): void => {
    if (phase === 'error') {
      setPhase('starting');
      setNotice('');
      setAttempt((value) => value + 1);
      return;
    }
    const view = viewRef.current;
    if (!view) return;
    setPhase('loading');
    setNotice('');
    let current = '';
    try {
      current = String(view.getURL ? view.getURL() : '');
    } catch {
      current = '';
    }
    try {
      const pending = /^https?:/i.test(current) ? view.reload() : view.loadURL(START_URL);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error: any) => {
          if (error && error.code === 'ERR_ABORTED') return;
          setPhase('error');
          setNotice(t('loadFailed'));
        });
      }
    } catch {
      setPhase('error');
      setNotice(t('loadFailed'));
    }
  }, [phase]);

  const phaseBusy = phase === 'starting' || phase === 'loading';
  const text = statusText(phase, authState);
  const tone = statusTone(phase, authState);

  return h(
    'div',
    { className: 'dsh-deepseek-panel', 'data-dsh-deepseek': 'panel' },
    h(
      'div',
      { className: 'dsh-deepseek-bar' },
      BrandGlyph(React),
      h('span', { className: 'dsh-deepseek-name' }, t('label')),
      h('span', { className: 'dsh-deepseek-dot', 'data-tone': tone, 'aria-hidden': true }),
      h(
        'span',
        { className: 'dsh-deepseek-status', title: text, role: 'status', 'aria-live': 'polite' },
        text,
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'dsh-deepseek-iconbutton',
          title: t('reload'),
          'aria-label': t('reload'),
          disabled: phase === 'starting' || phase === 'unsupported',
          onClick: refresh,
        },
        svgIcon(React, ['M20 11a8 8 0 1 0-2.3 6.7', 'M20 5v6h-6']),
      ),
    ),
    notice ? h('div', { className: 'dsh-deepseek-notice' }, notice) : null,
    h(
      'div',
      { className: 'dsh-deepseek-stage' },
      h('div', { className: 'dsh-deepseek-mount', ref: hostRef }),
      phaseBusy
        ? h(
            'div',
            { className: 'dsh-deepseek-cover' },
            h('span', { className: 'dsh-deepseek-spinner', 'aria-hidden': true }),
            h('strong', null, phase === 'starting' ? t('connecting') : t('loading')),
            h('small', null, t('firstHint')),
          )
        : null,
      phase === 'error'
        ? h(
            'div',
            { className: 'dsh-deepseek-cover' },
            h('strong', null, t('offline')),
            h('p', null, notice || t('loadFailed')),
            h('button', { type: 'button', onClick: refresh }, t('retry')),
          )
        : null,
      phase === 'unsupported'
        ? h(
            'div',
            { className: 'dsh-deepseek-cover' },
            BrandGlyph(React),
            h('strong', null, t('desktopOnly')),
            h('p', null, t('unsupportedBody')),
          )
        : null,
    ),
  );
}

/** webview 自定义事件不在 lib.dom 里，统一转 EventListener 绑定。 */
function onWebViewEvent(
  view: DSHWebviewElement,
  name: string,
  handler: (event: any, ...args: any[]) => void,
): void {
  view.addEventListener(name, handler as EventListener);
}

// ---------------------------------------------------------------------------
// 注册右侧栏 Tab
// ---------------------------------------------------------------------------
/** 向 DSH 注册右侧栏 Tab 类型 + 面板渲染槽位。 */
function registerSidebar(ctx: DSHClientContext, React: ReactLike): void {
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
    const tabs = scope.get('sidebarRightTabs');
    if (!tabs || typeof tabs.register !== 'function') return;
    scope.effect(
      () =>
        tabs.register({
          id: TYPE_ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('tabTitle'),
          keepMounted: true,
        }),
      'deepseek-web: tab type',
    );
    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register(
        { name: 'sidebar.right.pane.tab', key: TYPE_ID },
        (props: any) => DeepSeekPanel(React, props),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// Apply：装配插件。React 由加载器 factory 注入，因此以参数传入，避免顶层
// import/export（client bundle 必须是单文件纯脚本，交给 __ModuleLoader__）。
// ---------------------------------------------------------------------------
function createApply(React: ReactLike): (ctx: DSHClientContext) => void {
  return (ctx: DSHClientContext) => {
    rootCtx = ctx;
    let localeResolved = false;
    try {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : null;
      if (locale) {
        const snapshot = typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null;
        const active = snapshot && snapshot.active ? String(snapshot.active) : undefined;
        if (active) {
          zh = /^zh/i.test(active);
          localeResolved = true;
        }
      }
    } catch {
      /* 回退到文档语言 */
    }
    if (!localeResolved) {
      try {
        const language = String(document.documentElement.lang || navigator.language || '');
        if (language) zh = /^zh/i.test(language);
      } catch {
        zh = true;
      }
    }

    registerSidebar(ctx, React);

    // 主题桥：监听 DSH 主题切换，同步到已打开的 guest。
    ctx.effect(() => {
      const offTheme = typeof ctx.on === 'function' ? ctx.on('theme/change', notifyTheme) : undefined;
      let observer: MutationObserver | undefined;
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(notifyTheme);
        try {
          if (document.body) {
            observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] });
          }
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] });
        } catch {
          /* 事件桥仍可处理主题切换 */
        }
      }
      return () => {
        if (observer) observer.disconnect();
        if (typeof offTheme === 'function') offTheme();
      };
    }, 'deepseek-web: theme bridge');

    // 工作区触发按钮。
    ctx.effect(() => {
      disposedTrigger = false;
      styleElement = document.createElement('style');
      styleElement.id = 'dsh-plugin-deepseek-web-style';
      styleElement.textContent = PANEL_CSS;
      document.head.appendChild(styleElement);
      buildTrigger();
      scheduleEnsure();

      const onEscape = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
        const pendingClick = clickTimer !== 0;
        if (pendingClick) {
          cancelScheduledClick();
          lastTriggerClickAt = 0;
        }
        if (!isDeepSeekOpen()) {
          if (pendingClick) event.preventDefault();
          return;
        }
        const target = event.target as Element | null;
        if (
          target &&
          typeof target.closest === 'function' &&
          target.closest(
            'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]',
          )
        ) {
          return;
        }
        if (closeDeepSeek()) event.preventDefault();
      };
      document.addEventListener('keydown', onEscape);

      if (typeof MutationObserver === 'function') {
        domObserver = new MutationObserver(onDomMutations);
        try {
          domObserver.observe(document.body, { childList: true, subtree: true });
        } catch {
          /* 按钮首帧仍会挂载 */
        }
      }

      return () => {
        disposedTrigger = true;
        document.removeEventListener('keydown', onEscape);
        if (ensureFrame) {
          window.cancelAnimationFrame(ensureFrame);
          ensureFrame = 0;
        }
        if (openingTimer) {
          window.clearTimeout(openingTimer);
          openingTimer = 0;
        }
        if (clickTimer) {
          window.clearTimeout(clickTimer);
          clickTimer = 0;
        }
        pendingClickWasOpen = false;
        lastTriggerClickAt = 0;
        pendingFullscreen = false;
        if (domObserver) {
          domObserver.disconnect();
          domObserver = null;
        }
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
          resizeParent = null;
        }
        if (triggerHost) {
          triggerHost.remove();
          triggerHost = null;
        }
        triggerButton = null;
        triggerLabel = null;
        if (styleElement) {
          styleElement.remove();
          styleElement = null;
        }
        if (rootCtx === ctx) rootCtx = null;
      };
    }, 'deepseek-web: workspace trigger');
  };
}

// ---------------------------------------------------------------------------
// 模块加载器引导。id 必须与 package.json 的 name 一致。
// factory 由加载器注入 require：react 等来自 DSH 浏览器模块表，不打包。
// 注意：本文件不得出现顶层 import/export，编译产物必须是单文件纯脚本。
// ---------------------------------------------------------------------------
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-deepseek-web',
  factory(requireFn: ModuleRequire) {
    const React = requireFn('react') as ReactLike;
    return {
      inject: ['slots'],
      apply: createApply(React),
    };
  },
});
