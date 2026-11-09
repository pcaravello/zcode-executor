// lib/cli/new.mjs —— new 子命令（外壳层）：参数校验 → 白名单 → worktree → 选模型 →
// 写登记簿。不建 zcode 会话（D13）：本地派单 id（x_ + 8 位十六进制），sessionId 留空，
// runner 首次投递时才 session/create。不 import 协议层。
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ExecutorError } from '../errors.mjs';
import { allowedRootFor, checkDirExists, loadConfig, resolveWhitelist } from '../config.mjs';
import { loadZcodeConfig, resolveModels } from '../models.mjs';
import { loadRegistry, saveSession } from '../registry.mjs';
import { thoughtLevelFor } from '../tiers.mjs';
import { parseFlags, sayConfigWarnings, worktreeStatus } from './common.mjs';

export async function run(argv) {
  const flags = parseFlags(argv, {
    value: ['--cwd', '--title', '--tier', '--thought', '--deny', '--provider'],
    boolean: ['--json'],
  });
  const { json, cwd: cwdArg, title, tier, thought, deny, provider } = flags;

  // ① 参数：--cwd 必给、绝对路径、存在且是目录；--tier 只能 fast|strong（不合法按 PRD 表退 2）
  if (cwdArg === undefined) throw new ExecutorError('missing --cwd. usage: new --cwd <absolute path> [--title title] [--tier fast|strong]', 1);
  if (!path.isAbsolute(cwdArg)) {
    throw new ExecutorError(`--cwd expects an absolute path, got: ${cwdArg}. Resolve it to an absolute path before passing it`, 1);
  }
  const dirExists = checkDirExists(cwdArg);
  if (!dirExists.ok) throw new ExecutorError(dirExists.reason, 1);
  if (tier !== undefined && !['fast', 'strong'].includes(tier)) {
    throw new ExecutorError(`--tier must be fast or strong, got: ${tier}`, 2);
  }

  const config = loadConfig();
  sayConfigWarnings('new', config);

  // ② 白名单：cwd 与每个 allowedRoot 都 realpath 后比前缀（macOS /tmp → /private/tmp 两种写法都能过，
  // 不存在的根跳过）；登记簿存解析后的路径（评审 T2.2b 第 1 条）
  const whitelist = resolveWhitelist(config.allowedRoots, path.resolve(cwdArg));
  const cwd = whitelist.cwd;
  if (!allowedRootFor(whitelist.roots, cwd)) {
    throw new ExecutorError(
      `cwd is not in the allowed roots: ${cwd}. Allowed roots: ${whitelist.roots.join(', ') || '(empty; configure allowedRoots in config.json first)'}`,
      2,
    );
  }

  // ③ worktree 检测：git-dir 与 git-common-dir 相同（或不是 git 仓库）只警告不拒
  // repoRoot 给闸门读项目文档用：读派发前的原仓库，不读执行端正在改的执行副本
  const { isWorktree, repoRoot } = worktreeStatus(cwd);
  if (!isWorktree) console.error('new: cwd is not a worktree, creating anyway');

  // ④ --provider 给错就拒（显式指定不静默回落，评审 T2.2b 第 6 条）
  if (provider !== undefined) {
    const { registry } = loadZcodeConfig();
    if (!registry.providers.some((p) => p.providerId === provider)) {
      throw new ExecutorError(
        `provider ${provider} is not in the provider table. Existing providers: ${registry.providers.map((p) => p.providerId).join(', ')}`,
        2,
      );
    }
  }
  // 3.12 起模型清单从 config.json 本地算，new 不握手（握手归 doctor）：这条命令不起任何子进程
  const resolved = await resolveModels({ config, providerId: provider, handshake: false });
  for (const w of resolved.warnings) console.error(`new: warning: ${w}`);
  let model = null;
  if (tier !== undefined) {
    model = resolved[tier];
    if (!model) throw new ExecutorError(`no available model in the ${tier} tier under ${resolved.provider.providerId}. Run models to check first`, 1);
  }
  if (!model) model = resolved.fast ?? resolved.strong;
  if (!model) throw new ExecutorError(`neither tier has an available model; cannot send. Run models to see the situation first`, 1);
  // 登记簿 tier 不落 null：从 assignTiers 的 tier 标记（resolveModels 已附在 available 上）查有效归档（T2.2b 第 9 条）
  const effectiveTier = tier ?? (resolved.available.find((m) => m.ref.modelId === model.ref.modelId)?.tier ?? null);

  // ⑤ 思考等级：默认 high，模型思考等级里没有就登记 null（runner 建会话时按模型默认档回落，
  //    lib/tiers.mjs 的 reasoningLevelFor）；显式给了不合法的由 thoughtLevelFor 抛 2
  const thoughtLevel = thoughtLevelFor(model, thought ?? 'high', { explicit: thought !== undefined });

  // ⑥ D13：new 不建 zcode 会话，只登记。本地派单 id = x_ + 8 位十六进制，sessionId 留空，
  // runner 首次投递时 session/create 并写回
  const toolDenylist = deny === undefined ? undefined : deny.split(/\s+/).filter(Boolean);
  const taken = loadRegistry(config.home).sessions; // 探路（T2.2b 第 10 条）：登记簿坏了提前退
  let localId = `x_${randomBytes(4).toString('hex')}`;
  while (taken[localId]) localId = `x_${randomBytes(4).toString('hex')}`; // id 已存在就重摇（T2.4d 第 9 条）
  const entry = {
    id: localId,
    sessionId: null,
    title: title ?? '',
    cwd,
    isWorktree,
    repoRoot,
    tier: effectiveTier,
    provider: resolved.provider.providerId,
    modelId: model.ref.modelId,
    thoughtLevel: thoughtLevel ?? null,
    toolDenylist: toolDenylist && toolDenylist.length > 0 ? toolDenylist : null,
    createdAt: new Date().toISOString(),
    lastOutcome: null,
  };
  saveSession(config.home, entry);

  // ⑦ 输出
  if (json) {
    console.log(JSON.stringify(entry));
    return;
  }
  console.log(`new: ${localId} ${entry.provider}/${entry.modelId} thought ${entry.thoughtLevel ?? 'default'} ${cwd}`);
}
