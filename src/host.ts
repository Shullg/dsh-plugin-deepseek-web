/**
 * Host 半部 —— @local/dsh-plugin-deepseek-web
 *
 * 在 DSH 的双半结构里，Host 半部运行在 Node 侧，没有 DOM / <webview> 访问
 * 权限；浏览器半部（src/client.ts）才持有 UI、webview 生命周期与主题同步。
 * 因此 Host 半部的职责只是作为一个合法 Cordis bundle 存在，让 client 半部
 * 被发现并挂载。本插件不注册任何 Host 路由、不读取 Harness 凭证。
 */
export function apply(): void {
  /* Host 半部有意为空实现：
     - 无 Host HTTP 路由
     - 无 Harness API Key / 账号凭证读取
     - 无 Node 侧服务
     webview 的创建、销毁、重载、登录持久化与主题同步都在 client 半部实现。 */
}
