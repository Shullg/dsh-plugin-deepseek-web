/**
 * dsh-plugin-deepseek-web —— 静态校验（无第三方依赖）。
 * 检查 bundle 清单、client 模块加载器 id、patch 名称、必需文件与编译产物
 * 的模块形态，防止"编译通过但 DSH 加载失败"这类问题。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_NAME = '@local/dsh-plugin-deepseek-web';
const REQUIRED = ['package.json', 'manifest.yaml', 'cordis.patch.yml', 'icon.svg', 'src/host.ts', 'src/client.ts'];
const BUILT = ['lib/index.js', 'lib/client.js'];

let failed = false;
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function bad(msg) {
  failed = true;
  console.error('  ✗ ' + msg);
}
function read(p) {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

console.log('dsh-plugin-deepseek-web 静态校验');
console.log('  根目录:', ROOT);

// 1. 必需文件
console.log('· 必需文件');
for (const f of REQUIRED) {
  existsSync(join(ROOT, f)) ? ok(f) : bad('缺少 ' + f);
}

// 2. package.json 元数据一致性
console.log('· package.json');
const pkg = JSON.parse(read(join(ROOT, 'package.json')) || '{}');
pkg.name === PKG_NAME ? ok('name = ' + PKG_NAME) : bad('name 应为 ' + PKG_NAME + '，实际 ' + pkg.name);
if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) {
  existsSync(join(ROOT, pkg.dsh.bundle.patch)) ? ok('dsh.bundle.patch 指向存在: ' + pkg.dsh.bundle.patch) : bad('patch 文件缺失');
}
if (pkg.dsh && pkg.dsh.client) {
  pkg.dsh.client.platform === 'web' ? ok('dsh.client.platform = web') : bad('dsh.client.platform 应为 web');
}

// 3. cordis.patch.yml 名称一致
console.log('· cordis.patch.yml');
const patch = read(join(ROOT, 'cordis.patch.yml')) || '';
const patchNameOk = new RegExp(`name:\\s*['"]?${PKG_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?`).test(patch);
patchNameOk ? ok('insert name 与包名一致') : bad('patch 中缺少 name: ' + PKG_NAME);

// 4. 编译产物
console.log('· 编译产物');
for (const f of BUILT) {
  existsSync(join(ROOT, f)) ? ok(f) : bad('缺少 ' + f + '（请先运行 pnpm build）');
}
const client = read(join(ROOT, 'lib/client.js')) || '';
if (client) {
  client.includes("id: '@local/dsh-plugin-deepseek-web'")
    ? ok('client 模块加载器 id 一致')
    : bad('lib/client.js 中未找到模块加载器 id');
  // client 必须是单文件纯脚本：不得有顶层 import/export 包装
  const hasTopLevelModuleWrap = /(?:^|\n)\s*(?:import\s|export\s|Object\.defineProperty\(exports|__esModule)/.test(client);
  hasTopLevelModuleWrap ? bad('client 产物带顶层模块包装，浏览器加载器会失败') : ok('client 产物为纯脚本（无顶层 import/export）');
}

// 5. manifest.yaml 存在性已在必需文件检查中覆盖
console.log(failed ? '\n✗ 校验失败' : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
