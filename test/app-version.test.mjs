// fork F-4：lib/app-version.mjs（App 版本从 zcode.cjs 的位置推）与 spawn 给 app-server 设 ZCODE_APP_VERSION。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appVersionOf, asarPackageVersion } from '../lib/app-version.mjs';
import { AppServerClient } from '../lib/appserver.mjs';
import { startMock } from './helpers.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'zcx-appver-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** 最小的 asar：pickle 头 + JSON 头部 + 数据区（package.json 放在数据区偏移 `offset` 处）。 */
function writeAsar(file, pkgJson, { offset = 0, extraFile = null } = {}) {
  const pkg = Buffer.from(pkgJson, 'utf8');
  const files = { 'package.json': { size: pkg.length, offset: String(offset) } };
  if (extraFile) files['other.txt'] = { size: extraFile.length, offset: '0' };
  const json = Buffer.from(JSON.stringify({ files }), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const payloadSize = 4 + padded; // 字符串长度 + 对齐后的字符串
  const headerPickleSize = 4 + payloadSize;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerPickleSize, 4);
  head.writeUInt32LE(payloadSize, 8);
  head.writeUInt32LE(json.length, 12);
  const jsonPadded = Buffer.concat([json, Buffer.alloc(padded - json.length)]);
  const data = Buffer.concat([extraFile ?? Buffer.alloc(0), Buffer.alloc(Math.max(0, offset - (extraFile?.length ?? 0))), pkg]);
  writeFileSync(file, Buffer.concat([head, jsonPadded, data]));
}

test('asar：读出 package.json 的 version，包括不在数据区开头的', () => {
  const a = path.join(tmp, 'a.asar');
  writeAsar(a, JSON.stringify({ name: 'zcode', version: '4.0.0' }));
  assert.equal(asarPackageVersion(a), '4.0.0');
  const b = path.join(tmp, 'b.asar');
  writeAsar(b, JSON.stringify({ version: '4.1.0-beta.2' }), { offset: 7, extraFile: Buffer.from('1234567') });
  assert.equal(asarPackageVersion(b), '4.1.0-beta.2');
});

test('asar：坏文件、没有 package.json、version 不像版本号 → null', () => {
  const junk = path.join(tmp, 'junk.asar');
  writeFileSync(junk, 'not an asar at all');
  assert.equal(asarPackageVersion(junk), null);
  assert.equal(asarPackageVersion(path.join(tmp, 'missing.asar')), null);
  const weird = path.join(tmp, 'weird.asar');
  writeAsar(weird, JSON.stringify({ version: 'latest; rm -rf /' }));
  assert.equal(asarPackageVersion(weird), null);
});

test('appVersionOf：Linux/Windows 布局（resources/glm/zcode.cjs 旁的 resources/app.asar）', () => {
  const res = path.join(tmp, 'ZCode', 'resources');
  mkdirSync(path.join(res, 'glm'), { recursive: true });
  writeFileSync(path.join(res, 'glm', 'zcode.cjs'), '');
  writeAsar(path.join(res, 'app.asar'), JSON.stringify({ version: '4.0.0' }));
  assert.equal(appVersionOf(path.join(res, 'glm', 'zcode.cjs')), '4.0.0');
});

test('appVersionOf：macOS 布局（Info.plist）；什么都推不出来 → null', () => {
  const contents = path.join(tmp, 'ZCode.app', 'Contents');
  mkdirSync(path.join(contents, 'Resources', 'glm'), { recursive: true });
  writeFileSync(path.join(contents, 'Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key>\n<string>3.14.1</string></dict></plist>');
  assert.equal(appVersionOf(path.join(contents, 'Resources', 'glm', 'zcode.cjs')), '3.14.1');
  assert.equal(appVersionOf(path.join(tmp, 'nowhere', 'zcode.cjs')), null);
  assert.equal(appVersionOf(''), null);
});

async function reportedAppVersion({ appVersion, env: extraEnv = {} }) {
  const mock = await startMock({ appVersion, script: { reportEnvValues: ['ZCODE_APP_VERSION'] } });
  const lines = [];
  let client = null;
  try {
    client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: { ...mock.env, ...extraEnv }, onStderr: (l) => lines.push(l) });
    for (let i = 0; i < 50 && !lines.some((l) => l.includes('envvalue ZCODE_APP_VERSION=')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return lines.find((l) => l.includes('envvalue ZCODE_APP_VERSION='))?.split('=').pop();
  } finally {
    if (client) await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
}

test('spawn：推得出 App 版本就给 app-server 设 ZCODE_APP_VERSION（start plan 的模型请求要它）', async () => {
  assert.equal(await reportedAppVersion({ appVersion: '4.0.0' }), '4.0.0');
});

test('spawn：调用方已经给了 ZCODE_APP_VERSION 就不动；推不出来就不设', async () => {
  assert.equal(await reportedAppVersion({ appVersion: '4.0.0', env: { ZCODE_APP_VERSION: '9.9.9' } }), '9.9.9');
  assert.equal(await reportedAppVersion({}), '(unset)');
});
