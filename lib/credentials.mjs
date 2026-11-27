// 本文件负责：读 ~/.zcode/v2/credentials.json 里账号型 coding plan 的平台 API key（T6-C，decisions D19）
// 与闲时投递要的 JWT（decisions D20）——凭据值的解密（decryptCredentialValue）、解密密钥的派生
// （deriveCredentialKey）、默认路径（defaultCredentialsPath）、「只读四个键」的读取规则（readCodingPlanKeys）
// 和闲时鉴权（readOffPeakAuth：四个键之外只多解 zcodejwttoken）、start plan 鉴权（readStartPlanAuth，
// decisions D21：只要 active_provider 与 zcodejwttoken）。
// 不负责：provider 表的构造与合并（lib/providers.mjs 调这里）、闲时服务器请求（lib/offpeak.mjs）、
// 个人 provider 文件的写入、任何写盘——credentials.json 只读不写，钥匙串与 credential-secret 文件也只读。
// 只依赖 node 内置模块（os 源在 macOS 上另走系统的 security 命令读钥匙串，不是依赖包）。
//
// 2026-09-21 对照 ZCode 源码（3.14.0，用户本机 3.12.2 核对过文件格式）：
// - credentials.json 是平面 JSON { "<键>": "<值>" }，值形如 enc:v1:<iv>.<tag>.<密文>（三段 base64url），
//   AES-256-GCM，iv 12 字节、authTag 16 字节；密钥 = sha256(secret)；
//   secret = ZCODE_CREDENTIAL_SECRET（trim 后非空才算）或 zcode-credential-fallback:<platform>:<homedir>:<username>。
//   不带 enc: 前缀的值按明文原样用（真机探针见 verified.md「凭据文件探针」2026-09-21）。
// - 读取范围是 D19 的四个键加 D20 的一个键（其它键是 App 的私有实现，一律不读不解）：
//   oauth:active_provider（解出 "zai" 或 "bigmodel"）、oauth:<family>:user_info（JSON，取 id；
//   zai 族 App 3.17.2 起存 rawProfile，id 在 user_id 字段，见下方兜底）、
//   个人版与团队版两把 account-provider:coding-plan:account:<family>-<plan>-coding-plan:account:<encodeURIComponent(id)>:api-key；
//   闲时投递另解 zcodejwttoken（同一套 AES-GCM，verified.md「闲时任务探针」2026-09-27）。
//
// 2026-11-19 对照 3.18.2 的 app.asar（issue #6，App 3.18 起凭据加密改版）：
// - 新格式 enc:v2:<源>:<密钥指纹>:<iv>.<tag>.<密文>：AES-256-GCM 与三段 base64url 不变，
//   指纹 = sha256(密钥) hex 的前 24 个字符，源是 os 或 env。
// - os 源：密钥是 32 字节随机数以 base64url 存系统钥匙串（service "ZCode Credential Encryption"，
//   account = sha256(凭据文件 resolve 后绝对路径) hex）。macOS 上靠 security 命令读；
//   Windows/Linux 上 App 走 @napi-rs/keyring（DPAPI / Secret Service），本插件没有等价物，报「不支持」。
// - env 源：密钥 = sha256(managed secret)，managed secret 取 ZCODE_CREDENTIAL_SECRET（原始值判存在：空白串
//   也算设了，原样派密钥，照 App 不 trim），或 ZCODE_CREDENTIAL_SECRET_FILE 指到的文件（照 App 不查权限位），
//   或凭据文件旁边的 credential-secret（32–4096 字节）。
// - v1 兜底：App 对 enc:v1 的候选密钥表第一把是解析出的 managed secret（同上一行的顺序），
//   其后是平台派生，依序试解，照抄。
// - 指纹对不上（系统里的密钥不是加密这份凭据的那把）照 App 归「存储不可用」，指引重登 App 而不是升级插件。
// - credential-source 钉源文件：内容为 "os\n" 才算钉到 os；钉了别的值时 App 连解密都拒绝，照抄（os 源）。
// - 其它 enc:<未知版本> 前缀不再按明文放行，直接报「格式不认得」——v0.6.2 之前会把 enc:v2 的密文
//   当明文比较，误报成「oauth:active_provider 不是 zai 或 bigmodel」（issue #6 的误报就是这么来的）。
//
// fork（pcaravello/zcode-executor）与上游的两处差异：
// - 面向人的 error 文案写英文（decisions D26）；上游按中文前缀「凭据解不开」区分「密钥不对」与
//   「格式不对」，这里改用常量 DECRYPT_FAILED_PREFIX，判定不看语言。
// - PATCH locale（StreamEmbedder，2026-11-03，commit 1ab62bb）：user_info 里既没有 id 也没有 user_id 时，
//   按凭据文件里 plan key 的键名反推账号 id（见 planKeysFrom）。只看键名，值仍然只经 read() 读。
// - Windows 上的 os 源密钥（decisions F-2）：上游只在 macOS 上读钥匙串；这里另加 Windows 凭据管理器的读法
//   （readWindowsOsKey，零依赖），Linux 仍报「不支持」。
//
// 安全边界（RULES §6、§8）：解出的 key 与 config.json 的 apiKey 同一待遇——只进临时个人 provider 文件
// （D14）与 secrets 抹除名单，不进日志、事件、异常 message 和任何面向人的输出；JWT 只进内存、secrets 抹除名单
// 与 JSON-RPC / HTTP 请求（D20）。error 文案只说哪个键出了什么问题，不带密文也不带解出来的值；
// managed secret 与钥匙串读到的密钥同样不进任何文案。
import { createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENC_V1_PREFIX = 'enc:v1:';
const ENC_V2_PREFIX = 'enc:v2:';
const ENC_PREFIX = 'enc:';

/** 只解这四个键；键名是 App 的私有实现，改了就读不到，读不到就明确报错（D19）。 */
const ACTIVE_PROVIDER_KEY = 'oauth:active_provider';
const userInfoKey = (family) => `oauth:${family}:user_info`;
const planApiKey = (family, plan, accountId) =>
  `account-provider:coding-plan:account:${family}-${plan}-coding-plan:account:${encodeURIComponent(accountId)}:api-key`;
/** D20 放开的唯一一个额外键：闲时服务器只认这个 JWT。 */
const JWT_KEY = 'zcodejwttoken';

/** App 3.18 起 enc:v2 os 源的钥匙串条目（service / account 计算方式照抄 createSystemCredentialCipher）。 */
const OS_KEYCHAIN_SERVICE = 'ZCode Credential Encryption';
/** credential-source 钉到 os 的合法内容（含换行）；钉了别的值时 App 拒解，照抄。 */
const CREDENTIAL_SOURCE_OS = 'os\n';
/** managed secret 的合法长度（App resolveManagedSecret 的上下界）。 */
const MANAGED_SECRET_MIN = 32;
const MANAGED_SECRET_MAX = 4096;
/** 读钥匙串的最长等待：security 弹系统授权框时人会去点，超时就当读不到。 */
const KEYCHAIN_TIMEOUT_MS = 120_000;
/** 「解不开」类错误（密钥不对）的 message 前缀：enc:v1 候选表挨个试时只吞这一类，格式不对的照抛。 */
const DECRYPT_FAILED_PREFIX = 'credential decryption failed';

/** 系统凭据存储不可用（钥匙串读不到、managed secret 文件不合规等）→ kind 归 unavailable。 */
function unavailableError(message) {
  const err = new Error(message);
  err.code = 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE';
  return err;
}

/**
 * 派生 enc:v1 的解密密钥候选表：sha256(secret)，每把 32 字节。
 * App 3.18 起按 [env 原样、env trim、平台派生] 依序试，照抄——旧实现只认 trim 后一把，
 * 个别环境（env 值带空格、App 用未 trim 串写入）会解不开。
 * platform/homedir/username 可注入（测试不依赖运行机器）。返回值只含第一把（候选[0]），
 * 保持旧调用方的单密钥语义；要候选表用 deriveCredentialKeyCandidates。
 */
export function deriveCredentialKey({
  env = process.env,
  platform = os.platform(),
  homedir = os.homedir(),
  username = os.userInfo().username,
} = {}) {
  return deriveCredentialKeyCandidates({ env, platform, homedir, username })[0];
}

/** enc:v1 的候选密钥表：[sha256(env 原样), sha256(env trim), sha256(平台派生)] 去重后。 */
function deriveCredentialKeyCandidates({
  env = process.env,
  platform = os.platform(),
  homedir = os.homedir(),
  username = os.userInfo().username,
} = {}) {
  const fallback = `zcode-credential-fallback:${platform}:${homedir}:${username}`;
  const raw = env.ZCODE_CREDENTIAL_SECRET;
  const secrets = [raw || fallback, raw?.trim() || fallback, fallback];
  return [...new Set(secrets)].map((s) => createHash('sha256').update(s, 'utf8').digest());
}

/**
 * openCredentials 里实际用的 enc:v1 候选表，照 App createLegacyCipher（3.18.2 对照）：
 * 第一把是解析出的 managed secret（env 原样 > ZCODE_CREDENTIAL_SECRET_FILE 文件 >
 * 凭据文件旁的 credential-secret），没有才轮到平台派生。managed secret 解析失败
 * （同设、文件不合规）照 App 连 enc:v1 也拒解，抛 unavailable。
 */
function deriveLegacyKeyCandidates({
  env = process.env,
  credentialsFile,
  platform = os.platform(),
  homedir = os.homedir(),
  username = os.userInfo().username,
} = {}) {
  const managed = resolveManagedSecret({ env, credentialsFile, platform });
  const fallback = `zcode-credential-fallback:${platform}:${homedir}:${username}`;
  const secrets = [managed ?? fallback, managed?.trim() || fallback, fallback];
  return [...new Set(secrets)].map((s) => createHash('sha256').update(s, 'utf8').digest());
}

/** 惰性求值一次：v1 候选表要 stat/读旁路文件，只在真解到 enc:v1 时才算。 */
function lazyKeys(fn) {
  let cache;
  return () => (cache ??= fn());
}

/** sha256(密钥) hex 的前 24 字符，就是 enc:v2 里写的密钥指纹。 */
function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

/** AES-256-GCM 解三段 base64url 的载荷（v1 去掉前缀后、v2 的第三段共用）。失败归两类：格式 / 解不开。 */
function gcmOpen(payload, key) {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) {
    throw new Error('encrypted credential has the wrong format: expected <iv>.<tag>.<ciphertext> as three base64url segments');
  }
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('encrypted credential has the wrong format: iv must be 12 bytes and authTag 16 bytes');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM 校验失败：密钥不匹配或密文被改动，细节（密文）不进 message
    throw new Error(`${DECRYPT_FAILED_PREFIX} (GCM verification failed): the decryption key does not match or the data was altered`);
  }
}

/** 凭据文件默认路径：<生效数据目录>/.zcode/v2/credentials.json。
 * 生效数据目录与 runtime 模型缓存共用同一套解析（review r3 Medium）：ZCODE_DATA_BASE_DIR
 * > env.HOME/USERPROFILE > 系统家目录——注入独立 env（如子进程只换 HOME=B）时，
 * 凭据和模型表都从同一份数据根取，不会一半在 B 一半在宿主家目录。 */
export function defaultCredentialsPath(env = process.env) {
  const read = (k) => (typeof env?.[k] === 'string' && env[k].trim()) ? env[k].trim() : undefined;
  const base = read('ZCODE_DATA_BASE_DIR') ?? read('HOME') ?? read('USERPROFILE') ?? os.homedir();
  return path.join(base, '.zcode', 'v2', 'credentials.json');
}

/** 与 credentials.json 同目录的 credential-source 钉源文件；不存在 → null；读失败抛 unavailable。 */
function readCredentialSourcePin(credentialsFile) {
  try {
    return readFileSync(path.join(path.dirname(credentialsFile), 'credential-source'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw unavailableError(`cannot read credential-source (${err.code || err.message})`);
  }
}

/**
 * enc:v2 env 源的 managed secret（App resolveManagedSecret）：
 * ZCODE_CREDENTIAL_SECRET（原始值判存在：空白串也算设了，原样派密钥，照 App 不 trim）>
 * ZCODE_CREDENTIAL_SECRET_FILE 指向的文件（照 App 不查权限位）> 凭据文件旁边的 credential-secret
 * （非 Windows 上组/他人不能有任何权限位）。两个来源同设、文件不是普通文件、旁路文件权限不合规、
 * 内容不在 32–4096 字节都归「存储不可用」。没有 → null。
 */
function resolveManagedSecret({ env, credentialsFile, platform = os.platform() }) {
  // App resolveManagedSecret 用原始值判存在（不 trim）：空白串也算设了，直接拿去派密钥
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) {
    throw unavailableError('ZCODE_CREDENTIAL_SECRET and ZCODE_CREDENTIAL_SECRET_FILE are both set: the App does not allow two managed secret sources at once; remove one');
  }
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const fileEnv = env.ZCODE_CREDENTIAL_SECRET_FILE?.trim();
  const file = fileEnv || path.join(path.dirname(credentialsFile), 'credential-secret');
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT' && !fileEnv) return null;
    throw unavailableError(`cannot read the managed secret file: ${fileEnv || 'credential-secret'} (${err.code || err.message})`);
  }
  // 权限位只查凭据旁的 credential-secret（照 App：显式 ZCODE_CREDENTIAL_SECRET_FILE 指的文件不查）
  if (!st.isFile() || (!fileEnv && platform !== 'win32' && (st.mode & 0o077) !== 0)) {
    throw unavailableError('the managed secret file is not valid: it must be a regular file with no permission bits for group or others (chmod 600)');
  }
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    throw unavailableError(`cannot read the managed secret file (${err.code || err.message})`);
  }
  const len = Buffer.byteLength(content, 'utf8');
  if (len < MANAGED_SECRET_MIN || len > MANAGED_SECRET_MAX) {
    throw unavailableError(`the managed secret file has an invalid length: expected ${MANAGED_SECRET_MIN}-${MANAGED_SECRET_MAX} bytes`);
  }
  return content;
}

/**
 * enc:v2 os 源的密钥：App 用 @napi-rs/keyring 存 32 字节随机数（base64url）在系统钥匙串，
 * service "ZCode Credential Encryption"，account = sha256(resolve 后的凭据文件路径) hex。
 * macOS 上用系统自带的 security 命令读；Windows 上见 readWindowsOsKey（fork）；其它平台没有等价物，明确报「不支持」。
 * 返回值是原始 32 字节密钥（不再过 sha256）。读不到、被拒绝、超时都归「存储不可用」。
 */
function readOsKeySync({ credentialsFile, osSecret, platform = os.platform(), osKeyReader, fresh = false } = {}) {
  if (typeof osSecret === 'function' || typeof osSecret === 'string') {
    const v = typeof osSecret === 'function' ? osSecret({ credentialsFile }) : osSecret;
    return decodeOsSecret(v);
  }
  const account = createHash('sha256').update(path.resolve(credentialsFile), 'utf8').digest('hex');
  if (platform === 'win32') {
    return readWindowsOsKey({ credentialsFile, account, fresh, reader: osKeyReader ?? runWindowsCredRead });
  }
  if (platform !== 'darwin') {
    throw unavailableError('the enc:v2 os-source key lives in the system credential store: this plugin can read it on macOS (security command) and Windows (Credential Manager); Linux has no equivalent implementation yet');
  }
  let out;
  try {
    out = execFileSync('security', ['find-generic-password', '-s', OS_KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err?.killed || err?.signal === 'SIGTERM' || /timed out/i.test(String(err?.message))) {
      throw unavailableError('timed out reading the system keychain: it may be waiting for the keychain authorization dialog; retry or unlock the keychain first');
    }
    throw unavailableError('cannot read the credential key from the system keychain: the first read shows an "allow access" dialog, choose "Always Allow"; if access was denied before, allow it again in Keychain Access');
  }
  return decodeOsSecret(out);
}

// ───────── Windows 的 os 源（fork，decisions F-2）─────────
// App 在 Windows 上经 @napi-rs/keyring 2.1.2（keyring-core 1.0.1 + windows-native-keyring-store 1.1.0）
// 把密钥写成 Windows 凭据管理器的通用凭据：target = `<account>.<service>`，blob 是密钥 base64url 串的 UTF-16LE。
// 2026-11-25 对照 crates.io 上该 crate 的源码，并在 ZCode App 4.0.0 / Windows 10 的本机凭据管理器核对（verified.md）。
// 零依赖的读法：起系统自带的 powershell.exe，P/Invoke advapi32 的 CredReadW。只读这一个条目；
// 密钥只经管道进内存，不落盘、不进日志。`__TARGET__` 由调用方替换（account 是十六进制，service 是常量）。
const WIN_CRED_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ZxeCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }
  public static class Native {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, int flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
    public static int Read(string target, out byte[] blob) {
      blob = null;
      IntPtr p = IntPtr.Zero;
      if (!CredRead(target, 1, 0, out p)) return Marshal.GetLastWin32Error();
      try {
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        int n = (int)c.CredentialBlobSize;
        byte[] bytes = new byte[n];
        Marshal.Copy(c.CredentialBlob, bytes, 0, n);
        blob = bytes;
        return 0;
      } finally { CredFree(p); }
    }
  }
}
'@
$blob = $null
$code = [ZxeCred.Native]::Read('__TARGET__', [ref]$blob)
if ($code -ne 0) { [System.Console]::Out.Write('ERR:' + $code); exit 0 }
[System.Console]::Out.Write([System.Text.Encoding]::Unicode.GetString($blob))
`;

/** Windows 上读系统凭据的最长等待（fork）：没有授权弹窗，只给 powershell 启动和编译留余量。 */
const WIN_CRED_TIMEOUT_MS = 30_000;
/** CredReadW 的 ERROR_NOT_FOUND：这个凭据文件在系统里还没有密钥条目。 */
const WIN_ERROR_NOT_FOUND = 1168;

/** Windows 的 os 源密钥按进程缓存（fork）：读一次要起一个 powershell（实测约 0.5 秒），同进程内复用。键是 resolve 后的凭据文件路径。 */
const winOsKeyCache = new Map();

function runWindowsCredRead(target) {
  // 用系统目录里的绝对路径，不走 PATH：读的是密钥，别让同名程序截胡
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let out;
  try {
    out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_CRED_SCRIPT.replace('__TARGET__', target), 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: WIN_CRED_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    if (err?.killed || err?.signal === 'SIGTERM' || /timed out/i.test(String(err?.message))) {
      throw unavailableError('timed out reading the credential key from Windows Credential Manager; retry');
    }
    throw unavailableError('cannot read the credential key from Windows Credential Manager: Windows PowerShell could not read it (it calls CredReadW); check that Windows PowerShell is available and not restricted by execution policy');
  }
  if (out.startsWith('ERR:')) {
    if (Number(out.slice(4).trim()) === WIN_ERROR_NOT_FOUND) return null;
    throw unavailableError('cannot read the credential key from Windows Credential Manager: CredReadW failed; check that this process runs as the Windows user that signed in to the ZCode App');
  }
  return out;
}

/**
 * Windows 的 os 源密钥（fork）。reader 可注入（测试用，osKeyReader）：给 target 名，返回密钥的 base64url 串；
 * 没有条目返回 null；读不了抛 Error，这里统一归「存储不可用」（已带该 code 的原样抛）。
 * fresh：丢开缓存重读（指纹对不上时用，见 decryptV2）。
 */
function readWindowsOsKey({ credentialsFile, account, fresh = false, reader }) {
  const cacheKey = path.resolve(credentialsFile);
  if (!fresh && winOsKeyCache.has(cacheKey)) return winOsKeyCache.get(cacheKey);
  let key;
  try {
    const secret = reader(`${account}.${OS_KEYCHAIN_SERVICE}`);
    if (secret === null) {
      throw unavailableError('there is no key entry for this credentials file in Windows Credential Manager; sign in to the ZCode App again so it recreates the key');
    }
    key = decodeOsSecret(secret);
  } catch (err) {
    if (err?.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE') throw err;
    throw unavailableError('cannot read the credential key from Windows Credential Manager');
  }
  winOsKeyCache.set(cacheKey, key);
  return key;
}

/** os 源密钥字符串 → 32 字节密钥；形状不对（非 43 字符 base64url / 非 32 字节）归「存储不可用」。 */
function decodeOsSecret(secret) {
  const trimmed = typeof secret === 'string' ? secret.trim() : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    throw unavailableError('the key in the system credential store has the wrong shape: expected 43 base64url characters (32 bytes)');
  }
  const key = Buffer.from(trimmed, 'base64url');
  if (key.length !== 32) {
    throw unavailableError('the key in the system credential store has the wrong length: expected 32 bytes after decoding');
  }
  return key;
}

/**
 * 解一个 enc:v2 值。格式：<源>:<密钥指纹>:<载荷>；源只认 os 与 env。
 * 解析按值自带的源走：env → sha256(managed secret)，os → 钥匙串原始密钥；
 * 指纹对不上 = 密钥不对，归解不开。ctx 由 openCredentials 注入（credentialsFile/env/osSecret/platform）。
 */
function decryptV2(body, ctx) {
  const parts = body.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('encrypted credential has the wrong format: enc:v2 must be enc:v2:<source>:<fingerprint>:<ciphertext>');
  }
  const [source, fingerprint, payload] = parts;
  if (source !== 'os' && source !== 'env') {
    throw new Error('encrypted credential has the wrong format: the enc:v2 key source must be os or env');
  }
  if (!/^[a-f0-9]{24}$/.test(fingerprint)) {
    throw new Error('encrypted credential has the wrong format: the enc:v2 key fingerprint must be 24 hex characters');
  }
  let key = source === 'os'
    ? readOsKeySync(ctx)
    : (() => {
        const secret = resolveManagedSecret(ctx);
        if (secret === null) {
          throw unavailableError('the managed secret for enc:v2:env: was not found: set ZCODE_CREDENTIAL_SECRET, or provide ZCODE_CREDENTIAL_SECRET_FILE or a credential-secret file next to the credentials file');
        }
        return createHash('sha256').update(secret, 'utf8').digest();
      })();
  if (keyFingerprint(key) !== fingerprint && source === 'os' && winOsKeyCache.size > 0) {
    // fork：Windows 的 os 源密钥按进程缓存；App 重登换了密钥后，缓存的那把会短暂对不上——先丢缓存重读一次
    key = readOsKeySync({ ...ctx, fresh: true });
  }
  if (keyFingerprint(key) !== fingerprint) {
    // 照 App：指纹对不上归「系统凭据存储不可用」——要重登 App 换回正确的密钥，升级插件修不了
    throw unavailableError('key fingerprint mismatch: the key in the system is not the one that encrypted these credentials (the key was changed or the App was reinstalled); try signing in to the ZCode App again');
  }
  return gcmOpen(payload, key);
}

/**
 * 解一个凭据值。keyOrCtx 兼容两种调用：直接给密钥（Buffer 或候选表，只解 enc:v1），
 * 或 openCredentials 注入的 { keys（数组或懒函数，v1 用）, credentialsFile, env, osSecret, platform }（v1/v2 都走这里）。
 * 明文（无 enc: 前缀）原样返回；enc:v1 → 候选表依序试；enc:v2 → 按源取密钥；
 * 其它 enc:<版本> 一律报「不认得」（不再当明文，issue #6 的误报根因）。
 */
export function decryptCredentialValue(value, keyOrCtx) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const ctx = Buffer.isBuffer(keyOrCtx) || Array.isArray(keyOrCtx)
    ? { keys: Array.isArray(keyOrCtx) ? keyOrCtx : [keyOrCtx] }
    : keyOrCtx;
  if (value.startsWith(ENC_V1_PREFIX)) {
    const payload = value.slice(ENC_V1_PREFIX.length);
    const keysRaw = ctx?.keys;
    const keys = typeof keysRaw === 'function' ? keysRaw() : keysRaw ?? [];
    // 格式错误只报一次；密钥挨个试，全挂才报解不开（照 App createLegacyCipher 的语义）
    let lastErr;
    for (const key of keys) {
      try {
        return gcmOpen(payload, key);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(DECRYPT_FAILED_PREFIX)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error(`${DECRYPT_FAILED_PREFIX}: no usable decryption key`);
  }
  if (value.startsWith(ENC_V2_PREFIX)) {
    if (!ctx?.credentialsFile) {
      throw new Error('enc:v2 needs the credentials file context to get the key: callers must go through readCodingPlanKeys / readOffPeakAuth / readStartPlanAuth');
    }
    return decryptV2(value.slice(ENC_V2_PREFIX.length), ctx);
  }
  throw new Error('encrypted credential format not recognized: the value has an enc: prefix but is not v1/v2; the credential format may be newer than this plugin, upgrade zcode-executor first');
}

/**
 * 打开凭据文件，返回按需解密的 read(键)。三态同 readCodingPlanKeys：文件不存在 → null；
 * 出问题 → { error, kind }；成功 → { read }。read 解不开时抛 Error（message 带键名、不带密文）。
 * 可注入：key（v1 单密钥）、osSecret（v2 os 源密钥字符串或 () => string，测试用）、platform、
 * osKeyReader（fork：Windows 上读系统凭据的函数，测试用）。
 */
function openCredentials({ credentialsPath, env = process.env, key, osSecret, platform, osKeyReader } = {}) {
  const file = credentialsPath ?? defaultCredentialsPath(env);
  let raw;
  // credential-source 钉了非 os 的值时 App 拒绝一切解密（pin 检查在共享的取密钥路径上），照抄
  let pin;
  try {
    pin = readCredentialSourcePin(file);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), kind: 'unavailable' };
  }
  if (pin !== null && pin !== CREDENTIAL_SOURCE_OS) {
    return { error: 'credential-source pins a key source other than os: the App refuses to decrypt any credential in that case, so this is reported as unavailable', kind: 'unavailable' };
  }
  const ctx = {
    credentialsFile: file,
    env,
    osSecret,
    platform,
    osKeyReader, // fork：Windows 上读系统凭据的注入点（测试用；缺省读真的凭据管理器）
    // v1 候选表懒算：真解到 enc:v1 才去解析 managed secret（stat/读文件），
    // 纯 v2:os 的凭据不该被旁边一个不合规的 credential-secret 拖垮（App 也是按值才走 legacy 分支）
    keys: key !== undefined
      ? [key]
      : lazyKeys(() => deriveLegacyKeyCandidates({ env, credentialsFile: file, platform: platform ?? os.platform() })),
  };
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // 权限一类的读失败不是 App 改了格式，归「暂时不可用」
    return { error: `cannot read credentials.json: ${err.message}`, kind: 'unavailable' };
  }
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    return { error: `credentials.json is not valid JSON: ${file}. The ZCode App may be rewriting it; try again shortly`, kind: 'changed' };
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { error: 'credentials.json has the wrong shape: expected a flat object of { "<key>": "<value>" }', kind: 'changed' };
  }
  const read = (k) => {
    if (!(k in values)) return undefined; // 键不存在不算错（那一档 key 就是没有）
    let v;
    try {
      v = decryptCredentialValue(values[k], ctx);
    } catch (err) {
      // 补上键名再抛：哪个键解不开说清楚，键名不是秘密，密文留在原地不进 message
      const e = new Error(`key ${k}: ${err instanceof Error ? err.message : String(err)}`);
      if (err?.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE') e.code = err.code;
      throw e;
    }
    // 解出来不是字符串当没有（T6-C-fix 第 5 条）：非字符串的 key 进 secrets 抹除名单会让
    // scrubValues 的按值替换静默失效，从源头就不收
    return typeof v === 'string' ? v : undefined;
  };
  // PATCH locale (StreamEmbedder, 2026-11-03): i nomi delle chiavi, per ricavare l'id
  // dell'account quando user_info non lo porta (ZCode 0.17). Solo nomi, nessun valore.
  return { read, keys: Object.keys(values) };
}

/** 从 read 里读四个键；解不开照样抛（调用方统一接住归 changed / unavailable）。 */
function planKeysFrom(read, keys = []) {
  const active = read(ACTIVE_PROVIDER_KEY);
  if (active === undefined) {
    return { error: `credentials.json has no ${ACTIVE_PROVIDER_KEY}: no account login in the ZCode App yet`, kind: 'not-applicable' };
  }
  if (active !== 'zai' && active !== 'bigmodel') {
    // 解出来的值一律不进面向人的文案（T6-C-fix 第 4 条）
    return { error: 'oauth:active_provider is not zai or bigmodel; the account-provider coding plan cannot be used', kind: 'changed' };
  }
  const family = active;
  const userInfoRaw = read(userInfoKey(family));
  if (userInfoRaw === undefined) {
    return { error: `credentials.json has no oauth:${family}:user_info; account info is incomplete. Try signing in to the ZCode App again`, kind: 'not-applicable' };
  }
  let userInfo;
  try {
    userInfo = JSON.parse(userInfoRaw);
  } catch {
    return { error: `oauth:${family}:user_info did not decrypt into valid JSON`, kind: 'changed' };
  }
  // App 3.17.2 起 zai 族写的 user_info 是 rawProfile（账号 id 字段叫 user_id），不再是规范化形状；
  // App 读回时只在 zai 族兜底映射 user_id → id（app.asar toOAuthUserProfileFromRawZaiUser 2026-11-16 对照，
  // issue #6）。bigmodel 族仍存规范化形状，顶层 id 照旧。
  const accountId = userInfo?.id
    ?? (family === 'zai' && typeof userInfo?.user_id === 'string' ? userInfo.user_id : undefined);
  if (accountId === undefined || accountId === null || accountId === '') {
    // PATCH locale (StreamEmbedder, 2026-11-03): ZCode 0.17 non mette piu' l'id in user_info.
    // Il nome della chiave di ogni piano lo contiene: si cerca la chiave di OGNI piano per nome
    // (individual e team possono avere id diversi). Un piano con piu' chiavi candidate si salta,
    // per non sceglierne una a caso. Solo nomi delle chiavi, nessun valore fuori da read().
    // 在上游的 user_id 兜底（issue #6）之后才轮到这里：两处兜底都保留，id → user_id（仅 zai）→ 键名。
    const plans = {};
    let firstId;
    for (const plan of ['individual', 'team']) {
      const re = new RegExp(`^account-provider:coding-plan:account:${family}-${plan}-coding-plan:account:(.+):api-key$`);
      const hits = keys.filter((k) => re.test(k));
      if (hits.length !== 1) continue;
      // 键名里的 id 是 encodeURIComponent 过的；转义写坏了（URIError）的键名不算候选，不让它冒成异常
      let id;
      try {
        id = decodeURIComponent(re.exec(hits[0])[1]);
      } catch {
        continue;
      }
      const v = read(hits[0]);
      if (!v) continue;
      plans[plan] = v;
      if (firstId === undefined) firstId = id;
    }
    if (firstId === undefined) {
      return { error: `oauth:${family}:user_info has no account id, so the key name for the account-provider coding plan cannot be assembled`, kind: 'not-applicable' };
    }
    return { family, accountId: firstId, plans };
  }
  const plans = {};
  for (const plan of ['individual', 'team']) {
    const v = read(planApiKey(family, plan, String(accountId)));
    if (v) plans[plan] = v;
  }
  return { family, accountId: String(accountId), plans };
}

/** read 抛的按 code 分档：系统存储不可用归 unavailable，其余（解不开、格式不对）归 changed。 */
function decryptFailure(err) {
  const kind = err?.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE' ? 'unavailable' : 'changed';
  return { error: err instanceof Error ? err.message : String(err), kind };
}

/**
 * 读账号型 coding plan 的四个键。返回三态：
 * - 文件不存在 → null（没在 App 里登录过，正常状态）；
 * - 出问题 → { error: '<中文原因>', kind }（不抛，让调用方记 warning / doctor 报「不可用」；
 *   kind 是 not-applicable / changed / unavailable，闲时自检按它分档）；
 * - 成功 → { family, accountId, plans: { individual?: string, team?: string } }，
 *   两把 key 都没有时 plans 是空对象；key 的值只出现在 plans 里。
 * credentialsPath / env / key / osSecret / platform 都可注入（测试用），env 缺省 process.env。
 */
export function readCodingPlanKeys(options = {}) {
  const creds = openCredentials(options);
  if (!creds || creds.error) return creds;
  try {
    return planKeysFrom(creds.read, creds.keys);
  } catch (err) {
    return decryptFailure(err);
  }
}

/**
 * 读 start plan 投递的鉴权（D21）：只要 oauth:active_provider（定族）与 zcodejwttoken（凭据）。
 * start plan 不用 coding plan key——宿主给 start-plan provider 的 requestAuth 只有 JWT
 * （App 宿主 createAccountProviderRequestAuthService.resolveCurrent 2026-09-29 对照），所以
 * user_info 与两把 plan key 缺席照样能读，readCodingPlanKeys 那套要求这里全不适用。
 * 成功 → { family, jwt }；失败 → { error, kind }，kind 同 readOffPeakAuth；文件不存在 → null。
 * 文案里永远没有 JWT 的值。参数同 readCodingPlanKeys。
 */
export function readStartPlanAuth(options = {}) {
  const creds = openCredentials(options);
  if (!creds) {
    return { error: 'ZCode credentials file not found: no account login in the ZCode App. Sign in with a Start Plan account in the App first', kind: 'not-applicable' };
  }
  if (creds.error) return creds;
  try {
    const family = creds.read(ACTIVE_PROVIDER_KEY);
    if (family === undefined) {
      return { error: `credentials.json has no ${ACTIVE_PROVIDER_KEY}: no account login in the ZCode App yet`, kind: 'not-applicable' };
    }
    if (family !== 'zai' && family !== 'bigmodel') {
      // 解出来的值一律不进面向人的文案
      return { error: 'oauth:active_provider is not zai or bigmodel; start-plan send cannot be used', kind: 'changed' };
    }
    const jwt = creds.read(JWT_KEY);
    if (!jwt) {
      return { error: `credentials file has no ${JWT_KEY}: no account login in the ZCode App. Try signing in to the App again`, kind: 'not-applicable' };
    }
    return { family, jwt };
  } catch (err) {
    return decryptFailure(err);
  }
}

/**
 * 读闲时投递的鉴权（D20）：四个键之外只多解 zcodejwttoken。
 * 成功 → { family, jwt, planKey }（planKey 是个人版 key）；
 * 失败 → { error: '<中文原因，说清怎么办>', kind }，kind 为 not-applicable（没登录、团队版、没 key）
 * 或 changed（解不开、格式不对，App 的凭据格式可能变了）或 unavailable（文件读不了、
 * 系统凭据存储不可用——v2 os 源的钥匙串读不到也走这档）。
 * 文案里永远没有 JWT 与 key 的值。参数同 readCodingPlanKeys。
 */
export function readOffPeakAuth(options = {}) {
  const creds = openCredentials(options);
  if (!creds) {
    return { error: 'ZCode credentials file not found: no account login in the ZCode App. Sign in with a Coding Plan account in the App first', kind: 'not-applicable' };
  }
  if (creds.error) return creds;
  try {
    const keys = planKeysFrom(creds.read, creds.keys);
    if (keys.error) return keys;
    if (!keys.plans.individual) {
      return keys.plans.team
        ? { error: 'only a team Coding Plan key was found: off-peak send does not support the team plan yet', kind: 'not-applicable' }
        : { error: 'credentials file has no Coding Plan key: off-peak send requires an individual Coding Plan subscription; sign in with the subscription account in the ZCode App', kind: 'not-applicable' };
    }
    const jwt = creds.read(JWT_KEY);
    if (!jwt) {
      return { error: `credentials file has no ${JWT_KEY}: no account login in the ZCode App. Try signing in to the App again`, kind: 'not-applicable' };
    }
    return { family: keys.family, jwt, planKey: keys.plans.individual };
  } catch (err) {
    return decryptFailure(err);
  }
}
