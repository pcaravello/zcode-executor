// 本文件负责：把 package.json 的版本号同步到所有带版本号的地方——两份 README 的版本徽章、
// 各代理的插件清单（.claude-plugin、.codex-plugin、.github/plugin、.grok-plugin 的 plugin.json、
// gemini-extension.json、plugin.yaml）的 version 字段。
// 挂在 npm 的 version 生命周期脚本上：`npm version patch` 改完 package.json 之后、建提交之前跑，
// 改好的文件被同一个发版提交带走。`--check` 只报漂移不写文件，挂在 npm test 里给 CI 用。
// 每个标记都是必需的：找不到就非零退出，不默默通过——静默无操作正是这个脚本要防的事。
// 不负责：改版本号本身（那是 npm version 的事）、打 tag、发布。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const checkOnly = process.argv.includes('--check');

const targets = [
  ...['README.md', 'README.zh-CN.md'].flatMap((file) => [
    { file, label: 'version badge', pattern: /badge\/version-v\d+\.\d+\.\d+[^"'\s]*-/, replace: `badge/version-v${version}-` },
    { file, label: 'badge alt', pattern: /alt="v\d+\.\d+\.\d+[^"]*"/, replace: `alt="v${version}"` },
  ]),
  ...['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.github/plugin/plugin.json', '.grok-plugin/plugin.json', '.antigravity-plugin/plugin.json', 'gemini-extension.json'].map((file) => ({
    file, label: 'version field', pattern: /"version": "[^"]+"/, replace: `"version": "${version}"`,
  })),
  { file: 'plugin.yaml', label: 'version field', pattern: /^version: .+$/m, replace: `version: ${version}` },
];

const edits = new Map();
const missing = [];
const drifted = [];
for (const t of targets) {
  const before = edits.get(t.file) ?? readFileSync(join(root, t.file), 'utf8');
  if (!t.pattern.test(before)) { missing.push(`${t.file}: ${t.label} (${t.pattern})`); continue; }
  const after = before.replace(t.pattern, t.replace);
  if (after !== before) drifted.push(`${t.file}: ${t.label} -> ${t.replace}`);
  edits.set(t.file, after);
}

if (missing.length) {
  console.error(`sync-doc-version: marker not found; if the docs moved, this script must be updated:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
if (checkOnly) {
  if (!drifted.length) { console.log(`sync-doc-version: docs already at ${version}`); process.exit(0); }
  console.error(`sync-doc-version: doc versions lag behind package.json (${version}):\n  ${drifted.join('\n  ')}`);
  process.exit(1);
}
for (const [file, content] of edits) writeFileSync(join(root, file), content);
console.log(drifted.length ? `sync-doc-version: synced to ${version}\n  ${drifted.join('\n  ')}` : `sync-doc-version: docs already at ${version}`);
