// 本文件负责：start plan 投递（decisions D21）在 CLI 一侧的前置检查（startPlanSendPrecheck）：
// 凭据可解（lib/credentials.mjs 的 readStartPlanAuth）、内置 provider 文件里有
// account:<family>-start-plan 条目、会话的模型在该条目的模型表里。
// 不负责：命令行解析与打印（lib/cli/send.mjs）、runner 侧的授权推送与鉴权应答（lib/startplan-run.mjs）、
// 授权配置与 send 参数的形状（协议层 lib/startplan-provider.mjs）。
// 和谁打交道：lib/cli/send.mjs（调用方）、lib/credentials.mjs、lib/startplan-provider.mjs、
// lib/offpeak-send.mjs（复用 builtinPathFor 定位内置文件）。
//
// 安全边界（RULES §8，D21）：JWT 只进内存；本模块的错误文案与返回值都不带凭据值。
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { readStartPlanAuth } from './credentials.mjs';
import { startPlanModelIds, startPlanProviderId } from './startplan-provider.mjs';
import { builtinPathFor } from './offpeak-send.mjs';

/**
 * send --start-plan 的前置检查（D21）：凭据、内置条目、会话模型三项，任一不满足抛 ExecutorError(2)。
 * 通过返回 { family, providerId }（入队项与人读输出用）。env 可注入（测试），缺省 process.env。
 */
export function startPlanSendPrecheck({ entry, env = process.env }) {
  const auth = readStartPlanAuth({ env });
  if (auth.error) throw new ExecutorError(`start-plan send is unavailable: ${auth.error}`, 2);

  const builtinPath = builtinPathFor(env);
  let builtin;
  try {
    builtin = JSON.parse(readFileSync(builtinPath, 'utf8'));
  } catch (err) {
    throw new ExecutorError(`cannot read the builtin provider config file or it is not valid JSON: ${builtinPath}: ${err.message}. Make sure the ZCode App installation is complete`, 2);
  }
  const modelIds = startPlanModelIds(builtin, auth.family);
  if (!Array.isArray(modelIds)) {
    throw new ExecutorError(
      `the model list of the start-plan entry cannot be found in the builtin provider config file (${builtinPath}). The start plan API may have changed; upgrade the ZCode App and try again`,
      2,
    );
  }
  if (!modelIds.includes(entry.modelId)) {
    throw new ExecutorError(
      `the session's model ${entry.modelId} is not in the start-plan model list (${modelIds.join(', ')}). Open another session with new --tier that uses these models`,
      2,
    );
  }
  return { family: auth.family, providerId: startPlanProviderId(auth.family) };
}
