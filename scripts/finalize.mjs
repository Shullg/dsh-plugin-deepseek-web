/**
 * finalize —— 把 tsc 按源文件名输出的 lib/host.js 规整为 DSH 约定的入口
 * lib/index.js（host 半部 bundle 入口）。tsc 不会改名，这里用复制完成，
 * 保持 src/host.ts -> lib/index.js 的映射，与 package.json exports["."] 一致。
 */
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = join(ROOT, 'lib', 'host.js');
const index = join(ROOT, 'lib', 'index.js');

if (!existsSync(host)) {
  console.error('✗ lib/host.js 不存在，请先运行 tsc');
  process.exit(1);
}
copyFileSync(host, index);
console.log('✓ lib/index.js 已生成（host 半部入口）');
