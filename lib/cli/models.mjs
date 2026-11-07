// lib/cli/models.mjs —— models 子命令（外壳层）：模型清单按 provider 分组排版。
// 不 import 协议层；模型清单走 lib/models 的 resolveModels，3.12 起从 config.json 本地算、不握手
// （握手归 doctor），所以这条命令不起任何子进程。
import { loadConfig } from '../config.mjs';
import { resolveModels } from '../models.mjs';
import { assignTiers } from '../tiers.mjs';
import { parseFlags, sayConfigWarnings } from './common.mjs';

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const config = loadConfig();
  sayConfigWarnings('models', config);
  const resolved = await resolveModels({ config, handshake: false });
  for (const w of resolved.warnings) console.error(`models: warning: ${w}`);
  if (resolved.available.length === 0) console.error('models: the provider selected in config.json has no models');

  // 按 providerId 分组，保持 config.json 里的出现顺序；等级分配只看本 provider 的条目（T2.1）
  const groups = [];
  for (const m of resolved.all) {
    const providerId = m?.ref?.providerId;
    let group = groups.find((g) => g.providerId === providerId);
    if (!group) groups.push((group = { providerId, models: [] }));
    group.models.push(m);
  }
  const providers = groups.map((g) => {
    const { all } = assignTiers(g.models, { tiers: config.tiers });
    return {
      providerId: g.providerId,
      selected: g.providerId === resolved.provider.providerId,
      models: all.map((m) => ({
        providerId: m.ref.providerId,
        modelId: m.ref.modelId,
        label: m.label ?? m.ref.modelId,
        thoughtLevels: (m.reasoning?.levels ?? []).map((l) => l?.value ?? l),
        disabledReason: m.disabledReason ?? null,
        tier: m.tier,
      })),
    };
  });

  if (json) {
    console.log(JSON.stringify({ selectedProvider: resolved.provider.providerId, providers }));
    return;
  }
  for (const p of providers) {
    console.log(`${p.providerId}${p.selected ? ' ✓' : ''}`);
    for (const m of p.models) {
      const bits = [
        m.tier ? `★${m.tier}` : '·',
        m.modelId,
        m.label === m.modelId ? null : m.label,
        m.thoughtLevels.length > 0 ? `thought levels: ${m.thoughtLevels.join('/')}` : null,
        m.disabledReason ? `disabled: ${m.disabledReason}` : null,
      ].filter(Boolean);
      console.log(`  ${bits.join('  ')}`);
    }
  }
}
