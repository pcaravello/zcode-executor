// 本文件负责：建在 start plan 条目上的会话的模型审批通道（fork，decisions F-3）——把 Complete 接口
// （lib/review/complete.mjs 的形状：async ({system, user}) => 模型回复文本）换成「在第二条 zcode 会话里跑一个回合」。
// 为什么要有它：模型审批原先走 workspace/generateText，账号型 provider 的鉴权材料由宿主应答反向请求给出；
// ZCode 4.0.0 上这条调用带上 start plan 的 JWT 会被服务端拒掉（「This client is not supported」，真机 2026-11-27，
// verified.md），而普通回合带同一把 JWT 照常通。于是审查也走回合：另起一个 app-server 子进程，在里面建一条
// 只用来审查的会话（同一个 start plan 条目、fast 档模型），每次审查发一个回合、取最终回复当审查结论。
// 不负责：审查的提示词与解析（lib/review/prompt.mjs、parse.mjs 不变）、闸门编排（lib/gate.mjs、lib/review/run.mjs）、
// 执行端会话本身（lib/run.mjs）。
// 代价：一个审查回合约 3.4 万输入 token 的 start plan 额度、约 7 秒（GLM-5.3-Flash，思考等级 low，真机 2026-11-27），
// 比 generateText 的几百 token 贵两个数量级；每次审查新开一条会话，审查提示不累积进上下文。
// 安全边界（RULES §8，D21）：JWT 只进内存、providerAuth 的 JSON-RPC 应答与 secrets 抹除名单；审查会话里的
// 审批请求一律拒、提问一律拒答——审查只该回答，不该动手；审查会话的事件落在临时目录，收场即删。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { AppServerClient } from './appserver.mjs';
import { attachSession } from './session.mjs';
import { readStartPlanAuth } from './credentials.mjs';
import { buildStartPlanSendParams, pushStartPlanAccountConfig, startPlanProviderId } from './startplan-provider.mjs';
import { builtinPathFor } from './offpeak-send.mjs';
import { builtinRevision } from './offpeak-provider.mjs';

/** 一个审查回合的上限：到点发 session/stop，这次审查按失败结算（闸门转人工）。 */
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** 审查会话里什么都不许做：审批请求一律拒，提问一律拒答。 */
const DENY_ALL = {
  permission: () => ({ decision: 'deny', reason: 'review session: no action is allowed here' }),
  question: () => ({ action: 'decline', reason: 'review session: nothing is answered here' }),
};

/**
 * 造一个「审查用回合通道」。第一次 complete() 才起 app-server 子进程（连接按 runner 的一生复用），之后每次
 * complete() 在这条连接里新建一条会话、发一个回合、关掉它。complete 的入参出参同 lib/review/complete.mjs
 * 的 Complete（maxTokens 收下不用：回合的输出上限由模型定）。dispose() 关连接、删临时目录，可重复调。
 * personalProviderFile：与执行端会话同一份个人 provider 文件（start plan 会话的那份是空表，没有密钥）。
 */
export function createStartPlanReview({
  family,
  modelId,
  reasoningLevel,
  personalProviderFile,
  timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const providerId = startPlanProviderId(family);
  let connection = null; // Promise<{ client, scratch, workspaceDir, jwt }>
  let tail = Promise.resolve(); // 串行化：一次只跑一个审查回合
  let disposed = false;

  async function connect() {
    const auth = readStartPlanAuth({ env });
    if (auth.error || !auth.jwt) {
      throw new ExecutorError(`cannot read the start-plan login for the review session: ${auth.error ?? 'credentials file has no JWT'}`, 1);
    }
    // 工作区用临时目录：审查会话不该在执行副本里留下任何东西，也不该看见执行端的文件
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'zcode-executor-review-'));
    const workspaceDir = path.join(scratch, 'workspace');
    mkdirSync(workspaceDir, { mode: 0o700 });
    const jwt = auth.jwt;
    const client = await AppServerClient.spawn({
      cwd: workspaceDir,
      personalProviderFile,
      env,
      secrets: [jwt],
      // 审查回合也是 start plan 回合：每次模型请求前来要运行时头，答 JWT（同 D21）
      providerAuth: (id) => (id === providerId ? jwt : undefined),
    });
    try {
      await pushStartPlanAccountConfig(client, {
        family,
        basedOnZCodeBuiltinRevision: builtinRevision(builtinPathFor(env)),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      await client.close({ timeoutMs: 5000 }).catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
      throw err;
    }
    return { client, scratch, workspaceDir, jwt };
  }

  async function runReview({ system, user }) {
    if (!connection) {
      connection = connect().catch((err) => {
        connection = null; // 起不来：下次审查再试，不让一次失败钉死整条连接
        throw err;
      });
    }
    const { client, scratch, workspaceDir, jwt } = await connection;
    const created = await client.request('session/create', {
      workspace: { workspacePath: workspaceDir, workspaceKey: workspaceDir },
      mode: 'build',
      persistence: 'immediate',
      titleGenerationEnabled: false,
      ...(reasoningLevel ? { thoughtLevel: reasoningLevel } : {}),
      model: { providerId, modelId, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) },
    }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const session = await attachSession({
      client,
      sessionId: created.session.sessionId,
      cwd: workspaceDir,
      eventsPath: path.join(scratch, 'events.jsonl'),
      resume: false,
      secrets: [jwt],
      handlers: DENY_ALL,
    });
    try {
      // system 与 user 并成一条消息：回合没有 system 角色，执行端自带的系统提示词在前，审查说明作为本轮指令
      const outcome = await session.send(`${system}\n\n---\n\n${user}`, {
        timeoutMs,
        // 同 start plan 投递的回合参数：逐回合选模型、只管这次执行、跳过记忆抽取
        extraParams: buildStartPlanSendParams({ family, modelId, reasoningLevel }),
      });
      if (outcome.outcome !== 'done') {
        if (outcome.outcome === 'exited') connection = null; // 子进程没了：下次审查重新拉连接
        throw new ExecutorError(`the review turn ended as ${outcome.outcome}${outcome.reason ? `: ${outcome.reason}` : ''}`, 1);
      }
      const text = outcome.lastMessageText ?? outcome.lastText ?? '';
      if (!text.trim()) throw new ExecutorError('the review turn finished without any reply text', 1);
      return text;
    } finally {
      // 只关这条审查会话，连接留给下一次审查。Session.close() 会连客户端一起关掉（它是给「一条连接一条会话」
      // 用的），第一次审查之后进程就没了，第二次审查建不出会话
      await client.request('session/close', { sessionId: created.session.sessionId }, { timeoutMs: REQUEST_TIMEOUT_MS }).catch(() => {});
    }
  }

  return {
    /** Complete 接口：给审查的 system 与 user，回模型回复的全文（解析归 lib/review/parse.mjs）。 */
    async complete({ system, user } = {}) {
      if (disposed) throw new ExecutorError('the review session is already closed', 1);
      const run = tail.then(() => runReview({ system, user }));
      tail = run.catch(() => {});
      return run;
    },
    /** runner 收场时调：等手上的审查跑完，关连接，删临时目录。 */
    async dispose() {
      disposed = true;
      await tail;
      if (!connection) return;
      const current = connection;
      connection = null;
      try {
        const { client, scratch } = await current;
        await client.close({ timeoutMs: 5000 }).catch(() => {});
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // 连接当初就没起来：connect 已经收拾过
      }
    },
  };
}
