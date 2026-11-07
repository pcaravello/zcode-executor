// lib/cli/cancel.mjs —— cancel 子命令（外壳层）：写 stop/cancel 标记、答掉挂起、清空队列。
// 只操作文件与信号约定，不碰协议连接（连接在 runner 手里，runner 见 cancel 发 session/stop）。
// 闲时投递：runner 活着时由 runner 结算号；runner 已不在时这里经 lib/offpeak-send 的 cancelLeftover 结算（SPEC-offpeak D）。
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ExecutorError } from '../errors.mjs';
import { loadConfig, writeJsonAtomic } from '../config.mjs';
import { ensureRunsDir, livePidOf, readJsonOrNull, removeFileIfExists } from '../runs.mjs';
import { cancelLeftover } from '../offpeak-send.mjs';
import { getSession } from '../registry.mjs';
import { parseFlags, readPendingChecked } from './common.mjs';

export async function run(argv) {
  const flags = parseFlags(argv, { boolean: [] });
  const id = flags.positional[0];
  if (id === undefined) throw new ExecutorError('missing session id. usage: cancel <id>', 1);
  const config = loadConfig();
  getSession(config.home, id); // 不在登记簿 → 抛 2

  const dir = ensureRunsDir(config.home, id);
  writeJsonAtomic(path.join(dir, 'stop'), { at: new Date().toISOString() });
  writeJsonAtomic(path.join(dir, 'cancel'), { at: new Date().toISOString() });

  const pendingPath = path.join(dir, 'pending.json');
  const answerPath = path.join(dir, 'answer.json');
  const pending = readPendingChecked(pendingPath); // 容错读，坏 JSON 报中文（T2.4c 第 1 条、T2.6b 第 9 条）
  if (pending) {
    // 审批替人答 deny（带 requestId，runner 才认）；提问不写 {values:[]}——那过不了应答校验，
    // runner 见到 cancel 文件会替它 decline
    if (pending.kind === 'permission') {
      writeJsonAtomic(answerPath, { decision: 'deny', requestId: pending.requestId });
    }
  }

  // 清空队列；清掉的项留着，runner 不在时要看里面有没有闲时投递。容错删除：runner 可能同时在出队
  const queueDir = path.join(dir, 'queue');
  const droppedItems = [];
  if (existsSync(queueDir)) {
    for (const f of readdirSync(queueDir).filter((f) => f.endsWith('.json'))) {
      droppedItems.push(readJsonOrNull(path.join(queueDir, f)));
      removeFileIfExists(path.join(queueDir, f));
    }
  }
  const dropped = droppedItems.length;

  const pid = livePidOf(config.home, id);
  if (pid) {
    console.log(`cancel: runner (pid ${pid}) notified to stop the current turn and exit; queue cleared of ${dropped} item(s)${pending ? '; pending answered with deny' : ''}`);
  } else {
    // runner 不在了：没有人会消费挂起与答案文件，直接清理干净，别留下陈年挂起
    for (const f of [pendingPath, answerPath]) {
      try {
        unlinkSync(f);
      } catch {
        // 本来就没有
      }
    }
    // 闲时投递没收尾（回合 exited 后、runner 崩了）：没人会结算号了，这里结算（SPEC-offpeak D）
    const leftover = await cancelLeftover({ home: config.home, sessionId: id, dropped: droppedItems });
    const note = leftover
      ? `; off-peak send ${leftover.op.offPeakId} settled (ticket ${leftover.op.ticketId} ${leftover.settled ? 'settled' : 'settle failed, recorded in offpeak.json unsettledTickets'})`
      : '';
    console.log(`cancel: runner is already gone, pending and queue (${dropped} item(s)) cleaned up${note}`);
  }
}
