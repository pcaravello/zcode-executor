// scripts/real-review.mjs —— 真机核模型审批链路（T3.2，起 3.12.2 协议改按 D14）：写个人 provider
// 文件 → spawn（带 personalProviderFile、providerAuth）→ 用 createComplete + createReview 对一条
// 固定审批请求（Write 到 cwd 内的 hello.txt）跑一次审批，打印筛选后的结果、耗时与 usage。
// 三级链为可选 Jev 前筛 → ZCode 快筛 → 必要时慢判；当前 Write 正文省略会本地 skip Jev，
// 零 Jev HTTP 请求，不是 Jev HTTP 性能测量。不建会话、不投递。
// **会花额度**（TypeSafe 和/或 workspace/generateText）：RULES §9 要求跑前打印提示并要 --yes。
// 给 Claude 真机核 querySource（固定 'zcode-executor.review'）与 selection 传法是否被接受；
// 结论回写 docs/verified.md。
// 不负责：npm test（这条脚本不进测试）、会话的创建与挂起。
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from '../lib/config.mjs';
import { loadZcodeConfig, resolveReviewSelection } from '../lib/models.mjs';
import { EXECUTOR_PROVIDER_ID, pickProvider, writePersonalProviderFile } from '../lib/providers.mjs';
import { AppServerClient } from '../lib/appserver.mjs';
import { createComplete } from '../lib/review/complete.mjs';
import { createJevFastScreen } from '../lib/review/jev.mjs';
import { createProxyFetch } from '../lib/review/proxy-fetch.mjs';
import { createReview } from '../lib/review/run.mjs';

const note = (msg) => process.stderr.write(`real-review: ${msg}\n`);

note('this will spend quota: the three-stage chain makes at most 1 Jev logical call (retries included) and 0-2 ZCode workspace/generateText calls (fast screen first, slow review when needed); this script always uses a local-skip Write, so 0 Jev requests — it is not a Jev HTTP performance measurement');
if (!process.argv.includes('--yes')) {
  note('add --yes to confirm');
  process.exit(1);
}

const config = loadConfig();
if (config.review.enabled === false) {
  note('review.enabled:false; refusing to run model review; ZCode was not started and no paid request was made');
  process.exit(1);
}
const { configPath, registry } = loadZcodeConfig();
const provider = pickProvider(registry, { preferredProvider: config.preferredProvider });
// resolveReviewSelection 按 fast 档 + review.thought 选模型，直接给出 D14 的 selection 形状
// （{providerId: EXECUTOR_PROVIDER_ID, modelId, options?}），不用再自己转换
const { selection } = resolveReviewSelection({ registry, providerId: provider.providerId, config });
note(`zcode config ${configPath}, provider ${provider.providerId}, selection ${JSON.stringify(selection)}`);
note('querySource is fixed to zcode-executor.review; the thought level goes through selection.options.reasoningLevel (D14)');

const cwd = process.cwd();
const workspace = { workspacePath: cwd, workspaceKey: cwd };
const apiKey = provider.apiKey?.value;
const secrets = [apiKey].filter(Boolean);
// D14：不再推表，改写一份个人 provider 文件给 app-server 自己读；apiKey 只经这个临时文件和
// requestProviderRuntimeHeaders 的应答传出去，finally 里 dispose
const providerAuth = (providerId) => {
  note(`[reverse request] requestProviderRuntimeHeaders providerId=${providerId ?? '(missing providerId)'}`);
  return providerId === EXECUTOR_PROVIDER_ID ? apiKey : undefined;
};
// 写文件和 spawn 都在 try 里：spawn 拉不起来（内置文件找不到等）时 finally 照样删掉带密钥的临时文件
let personalFile = null;
let client = null;
try {
  personalFile = writePersonalProviderFile(provider);
  client = await AppServerClient.spawn({ cwd, secrets, personalProviderFile: personalFile.path, providerAuth });
  const raws = [];
  const complete = createComplete({ client, workspace, selection, onRaw: (raw) => raws.push(raw) });
  const jevApiKey = config.review?.jev?.apiKey;
  const jevProxy = config.review?.jev?.proxy;
  const jevModel = config.review?.jev?.model;
  const fastScreen = jevApiKey === undefined
    ? undefined
    : createJevFastScreen({
      apiKey: jevApiKey,
      knownSecrets: secrets,
      ...(jevModel === undefined ? {} : { model: jevModel }),
      ...(jevProxy === undefined ? {} : { fetchImpl: createProxyFetch(jevProxy) }),
    });
  const review = createReview(complete, { fastScreen });
  const action = {
    toolName: 'Write',
    args: { file_path: path.join(cwd, 'hello.txt'), content: 'hello' },
    workspaceRoot: cwd,
  };
  const ctx = {
    intent: [{ source: 'task', text: '任务单：在执行副本里新建 hello.txt，内容一行 hello。这是模型审批的试运行，只写这一个文件' }],
    priorActions: [],
    environment: config.environment,
    sensitive: config.sensitive,
    evidence: { facts: [] },
    projectDoc: undefined,
    home: process.env.HOME,
  };
  const started = Date.now();
  const result = await review(action, ctx);
  for (const [index, raw] of raws.entries()) {
    // 只打筛选后的调用指标，不打印完整模型原文或 Jev state，避免任务单和工具参数进入终端历史。
    const stageName = index === 0 ? 'fast screen' : 'slow review';
    note(`ZCode call ${index + 1} (${stageName}, maxOutputTokens=${raw.maxOutputTokens}, ${raw.durationMs}ms, usage ${JSON.stringify(raw.usage ?? null)})`);
  }
  process.stdout.write(
    `${JSON.stringify({
      decision: result.decision,
      stage: result.stage,
      reason: result.reason ?? null,
      ruleId: result.ruleId ?? null,
      fastScreen: fastScreen ? 'jev' : 'zcode',
      review: {
        reviewer: result.reviewer ?? null,
        reviewModel: result.reviewModel ?? null,
        reviewSchema: result.reviewSchema ?? null,
        probabilities: result.probabilities ?? null,
        usage: result.usage ?? null,
        requestId: result.requestId ?? null,
        durationMs: result.durationMs ?? null,
        fastReview: result.fastReview ?? null,
        preScreen: result.preScreen ?? null,
      },
      calls: raws.length,
      elapsedMs: Date.now() - started,
      selection,
      querySource: 'zcode-executor.review',
      calls_detail: raws.map((r) => ({ maxOutputTokens: r.maxOutputTokens, usage: r.usage ?? null, durationMs: r.durationMs })),
    })}\n`,
  );
} finally {
  try {
    await client?.close();
  } catch (err) {
    note(`close failed: ${err?.message ?? err}`);
  }
  // D14：个人 provider 文件用完即删
  personalFile?.dispose();
}
