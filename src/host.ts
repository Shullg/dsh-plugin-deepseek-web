/**
 * Host 半部 —— @local/dsh-plugin-deepseek-web
 *
 * 在 DSH 的双半结构里，Host 半部运行在 Node 侧，没有 DOM / <webview> 访问
 * 权限；浏览器半部（src/client.ts）才持有 UI、webview 生命周期与主题同步。
 * 因此 Host 半部的职责只是作为一个合法 Cordis bundle 存在，让 client 半部
 * 被发现并挂载。本插件不注册任何 Host 路由、不读取 Harness 凭证。
 *
 * 加载契约（需与实际 DSH 版本核对）：
 *  - Host loader 读取本模块的**命名导出** `apply`（而非 default 导出）。
 *    若某版本改为只认 `mod.default.apply`，本文件需同步改为
 *    `export default { apply }`，否则插件会静默不激活——空 apply 即使
 *    被调用也不产生副作用，问题不会以报错形式暴露。
 *  - 本文件被 package.json 的 main / manifest.yaml 的 entry.host 引用，
 *    删除会导致插件管理器拒绝加载该包。
 *  - apply 当前为同步空实现；若未来需要异步初始化，改为 async 并返回
 *    Promise<void>，Cordis loader 支持异步 apply。
 */
export function apply(_ctx: unknown): void {
  /* Host 半部有意为空实现：
     - 无 Host HTTP 路由
     - 无 Harness API Key / 账号凭证读取
     - 无 Node 侧服务
     webview 的创建、销毁、重载、登录持久化与主题同步都在 client 半部实现。
     _ctx 占位而非省略参数：保持与 Cordis apply(ctx) 约定对称，
     避免 loader 按函数 arity 判断是否传 ctx，并为未来扩展预留入口。 */
}
