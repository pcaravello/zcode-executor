// lib/cli/doctor.mjs —— doctor 子命令（外壳层）：三步零 token 自检，只编排 lib 的调用与排版。
// ① zcode.cjs 找得到、旁边的内置 provider 文件找得到（3.12+ 的判据：`--version` 在 3.11 与 3.12 都打
//   0.16.5，区分不了，verified.md「3.12.2 直连探针实测」 2026-09-18）；② provider 两个来源各自的状态
//   （T6-C：账号型 credentials.json 与 legacy config.json 两行，再一行选中的 provider；只报 key 在不在，
//   不打内容——这也是「App 哪天不写 config.json 了」的断粮预警）；
//   ③ 真握手一次（create deferred + close）并报等级分配；④ 只看插件配置，报告新启动 runner
//   的模型审批/快筛选择，不请求 Jev；⑤ 闲时内部接口自检（SPEC-offpeak F，lib/offpeak-check.mjs）：
//   结论 changed 时退出码 1，其余三态不改变 ①–③ 的结论。`doctor --offpeak` 只跑 ⑤。
// 不 import 协议层；zcode 交互走 lib/models 的 zcodeInfo / resolveModels / loadZcodeConfig / pickProvider，
// 闲时自检走 lib/offpeak-check 的 runOffPeakCheck。
import { loadConfig } from '../config.mjs';
import { loadZcodeConfig, pickProvider, resolveModels, zcodeInfo } from '../models.mjs';
import { OFFPEAK_VERIFIED_APP, runOffPeakCheck } from '../offpeak-check.mjs';
import { parseFlags, sayConfigWarnings, slimModel } from './common.mjs';

const LAYER_NAMES = { credentials: 'credentials', builtin: 'builtin entry', server: 'server contract', chain: 'full chain' };

// ⑤ 的人读一行：四态各一种写法
function offPeakLine(r) {
  if (r.state === 'ok') return 'doctor ⑤ off-peak: ok';
  if (r.state === 'changed') {
    return `doctor ⑤ off-peak: changed (the app's internal interface changed) (${LAYER_NAMES[r.layer]}: expected ${r.expected}, actual ${r.actual}${r.logid ? `, logid ${r.logid}` : ''})`;
  }
  if (r.state === 'unavailable') return `doctor ⑤ off-peak: temporarily unavailable (${r.reason})`;
  return `doctor ⑤ off-peak: not applicable (${r.reason})`;
}

// ⑤ 闲时自检：跑、打版本提示与警告（stderr）、打结论行（say），返回 runOffPeakCheck 的结果。
// throwOnBadOrigin：--offpeak 时闲时服务地址配错直接报错；不带参数时归「暂时不可用」，不打断整份输出
async function offPeakStep(say, config, { throwOnBadOrigin }) {
  const r = await runOffPeakCheck({ config, throwOnBadOrigin });
  // 不适用时闲时路径本来就用不上，版本提示只是噪音
  if (r.state !== 'not-applicable' && r.appVersion !== OFFPEAK_VERIFIED_APP) {
    console.error(`doctor: the off-peak path has only been verified against App ${OFFPEAK_VERIFIED_APP} on a real machine (current: ${r.appVersion ?? 'unknown'})`);
  }
  if (r.state === 'unavailable') console.error('doctor: warning: the off-peak service or self-check is temporarily unavailable; run zcode-executor doctor --offpeak again later');
  say(offPeakLine(r));
  return r;
}

// --json 只加字段不删字段（RULES §5）：minVersion 保留，值改成说明性的——真正的门槛是内置文件在不在
const MIN_VERSION_NOTE = 'App ≥ 3.12.2';

// ② 账号型那一行的排版：未登录（credentials.json 不存在）/ 不可用（原因）/ 已登录（family + 两档 key 在不在）
function accountLine(account) {
  if (account.missing) return 'doctor ② account coding plan: not signed in (credentials.json does not exist)';
  if (!account.ok) return `doctor ② account coding plan: unavailable (${account.error})`;
  const planState = (name, present) => `${name} key ${present ? 'present' : 'missing'}`;
  return `doctor ② account coding plan: signed in (${account.family}, `
    + `${planState('individual', account.plans.includes('individual'))}, ${planState('team', account.plans.includes('team'))})`;
}

// ② legacy 那一行只报来源本身；apiKey 是选中 provider 的状态，口径归「选中」行（T6-C-fix 第 3 条）
function legacyLine(legacy) {
  if (!legacy.ok) return `doctor ② config.json: cannot be read (${legacy.error})`;
  return `doctor ② config.json: ${legacy.providerCount} available provider(s) (fallback source)`;
}

// ② 「选中」行：带上选中 provider 的 apiKey 在不在（T6-C-fix 第 3、7 条，与 --json 的 apiKeyPresent 同口径）
function pickedLine(picked, apiKeyPresent) {
  if (!picked) return 'doctor ② picked (none)';
  return `doctor ② picked ${picked.providerId} (apiKey ${apiKeyPresent ? 'present' : 'missing'})`;
}

export async function run(argv) {
  const { json, offpeak } = parseFlags(argv, { boolean: ['--json', '--offpeak'] });
  if (offpeak) {
    await runOffPeakOnly(json);
    return;
  }
  const out = {
    ok: true,
    zcode: { ok: false, path: null, version: null, minVersion: MIN_VERSION_NOTE, builtinConfigPath: null, error: null },
    config: { ok: false, path: null, providerCount: null, apiKeyPresent: false, sources: null, error: null },
    handshake: { ok: false, skipped: false, providerId: null, tiers: { fast: null, strong: null }, warnings: [], error: null },
    review: { enabled: null, fastScreen: null, jevConfigured: null, pipeline: null },
  };
  const say = (line) => {
    if (!json) console.log(line);
  };
  // 插件自己的配置坏了不该让 ①② 也报不出来：错误记到 ③（握手要靠它），前两步照常
  let config = null;
  let configError = null;
  try {
    config = loadConfig();
    sayConfigWarnings('doctor', config);
  } catch (err) {
    configError = err;
  }
  if (config !== null) {
    const enabled = config.review?.enabled !== false;
    const jevConfigured = config.review?.jev?.apiKey !== undefined;
    out.review = {
      enabled,
      fastScreen: enabled ? (jevConfigured ? 'jev' : 'zcode') : null,
      jevConfigured,
      pipeline: enabled ? [...(jevConfigured ? ['jev'] : []), 'zcode-fast', 'zcode-slow'] : [],
    };
  }

  // ① zcode 二进制、版本与内置 provider 文件
  try {
    const info = zcodeInfo();
    const ok = info.builtinConfigPath !== null;
    out.zcode = { ok, path: info.path, version: info.version, minVersion: MIN_VERSION_NOTE, builtinConfigPath: info.builtinConfigPath, error: info.builtinConfigError };
    say(`doctor ① zcode: version ${info.version}, builtin provider file ${info.builtinConfigPath ?? 'not found'} (${info.path})`);
    if (!ok) console.error(`doctor: ${info.builtinConfigError}`);
  } catch (err) {
    out.zcode.error = err.message;
    say('doctor ① zcode: unavailable');
    console.error(`doctor: ${err.message}`);
  }

  // ② provider 两个来源（只读）；路径解析收在 lib/models 的 loadZcodeConfig（T2.2b 第 11 条）。
  //    T6-C：账号型一行 + legacy 一行 + 选中一行；选中的 provider 按 ③ 同一套规则挑（D6），
  //    只报 key 在不在，不打内容（RULES §8）
  let configPath = null;
  try {
    const { configPath: resolved, registry } = loadZcodeConfig();
    configPath = resolved;
    // pickProvider 对空表抛错；空表这里照旧只报个数，让 ③ 去报「表是空的」
    const picked = registry.providers.length > 0 ? pickProvider(registry, { preferredProvider: config?.preferredProvider }) : null;
    out.config.ok = true;
    out.config.path = configPath;
    out.config.providerCount = registry.providers.length;
    out.config.apiKeyPresent = Boolean(picked?.apiKey?.value);
    out.config.sources = registry.sources;
    say(accountLine(registry.sources.account));
    say(legacyLine(registry.sources.legacy));
    say(pickedLine(picked, out.config.apiKeyPresent));
    if (picked && !out.config.apiKeyPresent) {
      console.error(`doctor: the picked provider ${picked.providerId} has no plaintext apiKey; handshake and sends will fail. Check that ZCode App is signed in with an account or API-key coding plan, or switch providers with preferredProvider`);
    }
  } catch (err) {
    out.config.error = err.message;
    // 两个来源都空时 readProviderRegistry 把 sources 挂在 details 上（T6-C），排版照旧分两行
    const sources = err?.details?.sources;
    out.config.sources = sources ?? null;
    if (sources) {
      say(accountLine(sources.account));
      say(legacyLine(sources.legacy));
      say(pickedLine(null, false));
    } else {
      say('doctor ② account coding plan: unavailable');
      say('doctor ② config.json: cannot be read');
      say(pickedLine(null, false));
    }
    console.error(`doctor: ${err.message}`); // 怎么办只在 stderr 一处（T2.1b 第 7 条）
  }

  // ③ 真握手并报等级分配；前两步有失败就跳过（spawn 无从谈起）
  if (out.zcode.ok && out.config.ok) {
    try {
      if (configError) throw configError;
      const resolved = await resolveModels({ config, configPath, handshake: true });
      for (const w of resolved.warnings) console.error(`doctor: warning: ${w}`);
      out.handshake.ok = true;
      out.handshake.providerId = resolved.provider.providerId;
      out.handshake.tiers = { fast: slimModel(resolved.fast), strong: slimModel(resolved.strong) };
      out.handshake.warnings = resolved.warnings;
      say(`doctor ③ handshake: picked ${resolved.provider.providerId}; fast=${resolved.fast?.ref.modelId ?? '(none)'}, strong=${resolved.strong?.ref.modelId ?? '(none)'}`);
    } catch (err) {
      out.handshake.error = err.message;
      say('doctor ③ handshake: failed');
      console.error(`doctor: ${err.message}`);
    }
  } else {
    out.handshake.skipped = true;
    say('doctor ③ handshake: skipped (earlier steps failed)');
  }

  if (configError === null) {
    if (!out.review.enabled) {
      say(`doctor ④ model review: off; Jev key ${out.review.jevConfigured ? 'configured but not used' : 'not configured'}`);
    } else {
      say(`doctor ④ model review: on, newly started runners will use ${out.review.jevConfigured ? 'Jev pre-screen → ' : ''}ZCode fast screen → slow review`);
    }
  } else {
    say('doctor ④ model review: configuration unavailable');
  }

  out.offpeak = await offPeakStep(say, config, { throwOnBadOrigin: false });

  // ⑤ 只有「接口变了」才让 doctor 不过；不适用、暂时不可用不改 ①–③ 的结论
  out.ok = Boolean(out.zcode.ok && out.config.ok && out.handshake.ok) && out.offpeak.state !== 'changed';
  if (json) console.log(JSON.stringify(out));
  if (!out.ok) process.exitCode = 1;
}

// doctor --offpeak：只跑 ⑤。插件配置坏了不拦着（它只影响普通 provider 的偏好），错误打一行照跑
async function runOffPeakOnly(json) {
  let config = null;
  try {
    config = loadConfig();
    sayConfigWarnings('doctor', config);
  } catch (err) {
    console.error(`doctor: ${err.message}`);
  }
  const result = await offPeakStep((line) => {
    if (!json) console.log(line);
  }, config, { throwOnBadOrigin: true });
  const ok = result.state !== 'changed';
  if (json) console.log(JSON.stringify({ ok, offpeak: result }));
  if (!ok) process.exitCode = 1;
}
