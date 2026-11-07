// lib/cli/approve.mjs —— approve 子命令（外壳层）：放行当前挂起的审批。
// 只写 answer.json（带 requestId），消费与回合推进在 runner。不 import 协议层。
import { ExecutorError } from '../errors.mjs';
import { loadConfig, writeJsonAtomic } from '../config.mjs';
import { hasAllowOnce } from '../pending.mjs';
import { parseFlags, requirePending, waitAnswerOutcome } from './common.mjs';

export async function run(argv) {
  const flags = parseFlags(argv, { boolean: ['--json'] });
  const id = flags.positional[0];
  const { json } = flags;
  if (id === undefined) throw new ExecutorError('missing session id. usage: approve <id> [--json]', 1);

  const config = loadConfig();
  const { pendingPath, answerPath, pending, pendingKind, entry } = requirePending(config, id);
  if (pendingKind !== 'permission') {
    throw new ExecutorError('the pending item is a question; use answer to respond (or deny to decline)', 2);
  }
  // RULES §8：放行的前提是 options 里有 allow 类（allow_once）选项；只有 allow_always 也不能放行。
  // 判定与 gate/pending 共用同一份 hasAllowOnce，三道防线一个标准（T2.9 第 10 条）
  if (!hasAllowOnce(pending)) {
    throw new ExecutorError('options has no allow_once, so it cannot be approved (there is no "always allow for this session"). You can deny instead', 2);
  }

  const requestId = pending.requestId;
  writeJsonAtomic(answerPath, { requestId, decision: 'allow' });
  const { applied, event } = await waitAnswerOutcome({ config, id, requestId, pendingPath });
  // approve 撞上 cancel：runner 按 deny 处理了，如实说被拒（评审 T2.5b 第 5 条）
  const denied = event?.type === 'executor.deny';

  if (json) {
    // id 本地 id、sessionId 登记簿里 zcode 的 sess_（可 null），与 list/status 一致（T2.6b 第 1 条）
    console.log(JSON.stringify({ id, sessionId: entry.sessionId ?? null, requestId, kind: 'approve', applied, pendingKind, eventType: event?.type ?? null }));
    return;
  }
  if (denied) console.log('approve: your approval was superseded by deny/cancel; the pending item was handled as denied');
  else if (applied) console.log('approve: approved, the turn continues');
  else console.log('approve: answer written, no event recorded by the runner yet');
}
