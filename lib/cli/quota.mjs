// lib/cli/quota.mjs —— quota 子命令（外壳层，SPEC-offpeak G）：今天的闲时取号情况，零额度。
// 取数在 lib/offpeak-send.mjs 的 offPeakQuota，这里只排版一行与定退出码：changed → 1，其余 0
// （这是给派单方看的信息，额度用完不算错）。不起 app-server，不取号。
import { resolveHome } from '../config.mjs';
import { offPeakQuota } from '../offpeak-send.mjs';
import { formatLocalTime } from '../offpeak.mjs';
import { parseFlags } from './common.mjs';

const STATE_TEXT = { unavailable: 'temporarily unavailable', 'not-applicable': 'not applicable', changed: "changed (the app's internal interface changed)" };

function serverText(q) {
  if (q.state !== 'ok') return `${STATE_TEXT[q.state]} (${q.reason})`;
  if (q.canTakeNumber) return 'a ticket can be taken now';
  return q.nextTakeAt ? `today's quota is used up; you can take a ticket again after ${formatLocalTime(Date.parse(q.nextTakeAt))}` : 'cannot take a ticket now';
}

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const q = await offPeakQuota({ home: resolveHome(), warn: (line) => console.error(`quota: ${line}`) });
  if (json) console.log(JSON.stringify(q));
  else console.log(`quota: off-peak tickets taken by this tool today: ${q.usedToday} (about ${q.estimatedDailyLimit} per day; usage in the App is not counted); server: ${serverText(q)}`);
  if (q.state === 'changed') process.exitCode = 1;
}
