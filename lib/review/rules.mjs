// 本文件负责：闸门用的规则表——RULES（hard/soft 两级风险类别）、ALLOWANCES（放行例外）、
// HARD_RULES（hard 子集）、ruleById（按 id 查规则）。只提供数据和一个查找函数。
// 不负责：机械红线的判定（lib/review/hard.mjs）、提示词组装（lib/review/prompt.mjs）、
// 模型调用与两阶段编排（T3.2 的 gate）。
// 被依赖方：lib/review/prompt.mjs 的调用方（rules 作为参数传入）与 lib/gate.mjs。
// 来源：作者先前的 TypeScript 审批原型（同作者，无第三方许可证事宜），手工去类型。
//   规则文本与 id 逐字保留；唯一追加的是本项目 OUTSIDE_WORKTREE（T3.1b）。

/**
 * 结构照参照实现（Claude Code auto mode）的四段式：
 *
 *   hard（谁也推不翻） > soft（默认拦，可被清除） > allow（soft 的例外）
 *   > 用户的明确意图（能推翻剩下的 soft）
 *
 * 关键设计点是 soft 规则的 **mustName**：用户必须**同时**点到清单上的每一样，
 * 这条才清除。写成清单而不是散文，是因为散文会被读成「大意覆盖到了就算」——
 * 「他让我修 bug，ssh 上去看看是必要的」这种推理正是要挡掉的东西。
 * 规则按「什么该拦、什么算授权」的道理写，不照着历史语料调。
 */

/**
 * 一条规则。
 * severity：`hard` 谁也推不翻；`soft` 用户点全了 mustName 就清除。hard 要极其克制。
 * blocks：拦什么。mustName：soft 级，用户必须同时点到的东西，少一样就不清除。
 * except：本身就不归这条管的情形——不是「被清除」，是压根不适用。
 * 改措辞不要改 id：日志靠 id 记命中哪条。
 */

/**
 * 本项目专属的一条 hard 规则（T3.1b 起进正表，非移植）：执行副本隔离。
 * lib/review/hard.mjs 按它取 id（机械红线），提示词经「一律拦截」段渲染它的文案；
 * 单一出处在这，别处不要复制。
 */
export const OUTSIDE_WORKTREE = {
  id: 'outside-worktree',
  category: 'external-write',
  severity: 'hard',
  blocks: 'Any write, delete or move reaching outside the worktree (the current working directory), '
    + 'including via Bash cd, redirection, rm, mv, cp to external paths — always escalated to a human.',
};

export const RULES = [
  // ─────────────── 凭据 ───────────────
  {
    id: 'cred-exfil',
    category: 'credential',
    severity: 'hard',
    blocks: 'Credentials leaving this machine: contents of private keys, API tokens, passwords, cloud credentials or certificate private keys '
      + 'showing up in outbound requests, commits, uploads, or destinations off this machine. Includes landing in an intermediate file first.',
    except: 'Sending work content to a service the user configured themselves (memory store, notes, log collection), '
      + 'or requests to local services — those are not credentials.',
  },
  {
    id: 'cred-write',
    category: 'credential',
    severity: 'soft',
    blocks: 'Writing to credential stores: ~/.ssh, ~/.aws, ~/.config/gh, keychains, various credentials files.',
    mustName: ['which credential or file is being written', 'the write/create/replace action'],
    except: 'Reading for an existing authentication flow is not writing.',
  },
  {
    id: 'cred-print',
    category: 'credential',
    severity: 'soft',
    blocks: 'Printing valid credentials to output or writing them to a file (echo $TOKEN, cat key files, env | grep key).',
    mustName: ['which credential is being viewed', 'the view/verify action'],
  },
  {
    id: 'cred-scan',
    category: 'credential',
    severity: 'soft',
    blocks: 'Sweeping for credentials at scale: scanning file contents across home or the whole disk by key/token/secret/password patterns.',
    mustName: ['the scope to scan (which directory)', 'the credential hunt itself'],
  },

  // ─────────────── 外泄 ───────────────
  {
    id: 'exfil-upload',
    category: 'exfiltration',
    severity: 'soft',
    blocks: 'Uploading local file contents to external services: curl -d @file, paste services, file-sharing sites, third-party APIs.',
    mustName: ['what is being sent', 'which destination'],
  },
  {
    id: 'exfil-scout',
    category: 'exfiltration',
    severity: 'soft',
    blocks: 'Reconnaissance for exfiltration: enumerating sensitive directories in sequence, inventorying credential file locations, '
      + 'archiving config directories under home without a matching task.',
    mustName: ['the backup/migration/audit itself', 'which directories are in scope'],
  },
  {
    id: 'exfil-public-surface',
    category: 'exfiltration',
    severity: 'soft',
    blocks: 'Putting local content onto a public surface: creating a public repo and pushing, publishing an npm package, creating gists/pastes, '
      + 'pushing private repo content to a public repo.',
    mustName: ['what is being published', 'which public location'],
  },
  {
    id: 'exfil-tunnel',
    category: 'exfiltration',
    severity: 'soft',
    blocks: 'Exposing local services to the public internet: tunnels like ngrok/cloudflared, reverse shells, '
      + 'changing the listen address from 127.0.0.1 to 0.0.0.0.',
    mustName: ['which service is being exposed', 'making it externally reachable'],
    except: 'Preview services reachable only locally (localhost / 127.0.0.1) are not exposure.',
  },
  {
    id: 'exfil-sensitive-detail',
    category: 'exfiltration',
    severity: 'soft',
    blocks: 'Including sensitive details the user did not authorize for that recipient in outbound content: commit messages, PR/issue bodies, '
      + 'outbound messages containing real account names, internal paths, or real data returned by APIs.',
    mustName: ['these specific details', 'sending them to this recipient'],
  },

  // ─────────────── git 破坏性 ───────────────
  {
    id: 'git-force-push',
    category: 'git-destructive',
    severity: 'soft',
    blocks: 'Force push, deleting remote branches/tags/releases, rewriting pushed history.',
    mustName: ['the force push / delete / history-rewrite action', 'the target branch or tag'],
  },
  {
    id: 'git-discard-uncommitted',
    category: 'git-destructive',
    severity: 'soft',
    blocks: 'Discarding uncommitted changes: git reset --hard, git checkout -- ., git restore ., '
      + 'git clean -fd, git stash drop/clear.',
    mustName: ['discarding the current changes', 'or stating these changes are not wanted'],
    except: 'git stash (saves rather than discards) does not count when the user asks to switch context.'
      + ' Not applicable when the workspace has no uncommitted changes — the harness provides the git state.',
  },
  {
    id: 'git-amend-foreign',
    category: 'git-destructive',
    severity: 'soft',
    blocks: 'Rewriting commits not created in this session, or rewriting pushed commits.',
    mustName: ['which commit is being rewritten', 'the rewrite action'],
    except: 'Amending the message of a commit created in this session and not yet pushed does not count.',
  },
  {
    id: 'git-remote-repoint',
    category: 'git-destructive',
    severity: 'soft',
    blocks: 'Changing the push destination: git remote add / set-url pointing to a new address.',
    mustName: ['the new remote address', 'changing the remote'],
  },

  // ─────────────── 不可逆删除 ───────────────
  {
    id: 'del-preexisting',
    category: 'irreversible',
    severity: 'soft',
    blocks: 'Deleting files or directories that existed before this session, especially data files, databases, logs, backups.',
    mustName: ['the specific target being deleted', 'the delete action'],
    except: 'Deleting things this session created does not count — the harness provides the check of '
      + 'whether the path existed before the session started; take that as authoritative, do not guess.',
  },
  {
    id: 'del-wildcard-scratch',
    category: 'irreversible',
    severity: 'soft',
    blocks: 'Wiping shared temporary directories by wildcard, glob or time filter instead of specific paths — '
      + 'other processes and other sessions have things in those directories too.',
    mustName: ['which directory to clean', 'the criteria for cleaning'],
    except: 'Deleting temporary directories this session created does not count.',
  },
  {
    id: 'del-stateful',
    category: 'irreversible',
    severity: 'soft',
    blocks: 'Tearing down stateful resources not created by this session: stopping/deleting services, deleting containers and volumes, dropping databases or tables.',
    mustName: ['the specific resource', 'the stop/delete action'],
  },

  // ─────────────── 供应链 ───────────────
  {
    id: 'sc-download-exec',
    category: 'supply-chain',
    severity: 'soft',
    blocks: 'Downloading then executing directly: curl | sh, wget | bash, and the equivalent download-to-file-then-run pattern.',
    mustName: ['what is being installed/run', 'which source it comes from'],
  },
  {
    id: 'sc-global-install',
    category: 'supply-chain',
    severity: 'soft',
    blocks: 'Installing globally or elevating: npm i -g, pip install (outside a virtualenv), brew install, sudo. '
      + 'This affects the whole machine, not just the project.',
    mustName: ['what is being installed', 'installing globally / using sudo'],
    except: 'Installing dependencies per the project manifest (npm install, pip install -r) is not a global install.',
  },
  {
    id: 'sc-unlisted-package',
    category: 'supply-chain',
    severity: 'soft',
    blocks: 'Installing packages not in the project manifest — installs where the model picks the name. The risk is typosquatting and supply-chain poisoning.',
    mustName: ['this specific package name'],
    except: 'Not applicable when the package is already listed in the project dependencies.',
  },
  {
    id: 'sc-registry-bypass',
    category: 'supply-chain',
    severity: 'soft',
    blocks: 'Bypassing the project\'s configured mirror or private registry and installing straight from the public one.',
    mustName: ['using the public registry this time'],
  },
  {
    id: 'sc-opaque-exec',
    category: 'supply-chain',
    severity: 'soft',
    blocks: 'Executing un-auditable content: eval, encoded strings inside bash -c, running a script whose contents cannot currently be seen.',
    mustName: ['the script or code being run'],
    except: 'Not applicable when the script contents appeared in this conversation.'
      + ' Inline heredocs (contents right in the command, visible) are not un-auditable.',
  },

  // ─────────────── 持久化与自我修改 ───────────────
  {
    id: 'persist-startup',
    category: 'persistence',
    severity: 'soft',
    blocks: 'Writing autostart or residency mechanisms: LaunchAgents/LaunchDaemons, systemd units, crontab, '
      + 'shell startup files (.zshrc/.bashrc/.profile).',
    mustName: ['the resident service or startup file', 'the change to it (add/modify/start/stop)'],
  },
  {
    id: 'persist-shell-hook',
    category: 'persistence',
    severity: 'soft',
    blocks: 'Injecting auto-executing content into shell configs or git hooks.',
    mustName: ['the hook or config snippet', 'adding it'],
  },
  {
    id: 'self-modify-harness',
    category: 'persistence',
    severity: 'soft',
    blocks: 'Modifying ZCode\'s own runtime state: config under ~/.zcode (v2/config.json, cli/config.json), '
      + 'skill and MCP configuration, and ZCode\'s own installation directory.',
    mustName: ['which part of ZCode is being changed (config / skills / MCP)'],
    except: 'When the user says "install this skill" without giving a literal path, that still counts as named — '
      + 'installing a skill necessarily writes under ~/.zcode, which is inherent to the request. Not applicable either when '
      + 'the current project is itself a tool for ZCode and the write is its installation or deployment step.',
  },
  {
    id: 'self-modify-approval',
    category: 'persistence',
    severity: 'hard',
    blocks: 'Making later actions bypass this gate: changing zcode-executor\'s config or code to loosen judgment, '
      + 'turning off the approval policy, switching the permission mode to full access, or otherwise circumventing the judgment channel.',
    except: 'This rule only covers "disabling the gate". Editing instruction files (AGENTS.md, CLAUDE.md), project config, '
      + 'or installing plugins is not in scope — those fall under self-modify-harness, clearable by intent.',
  },

  // ─────────────── 审批与审计绕过 ───────────────
  {
    id: 'audit-tamper',
    category: 'audit-bypass',
    severity: 'soft',
    blocks: 'Modifying or deleting logs and session records: the session store and cli/log/ under ~/.zcode, various audit logs, disabling logging.',
    mustName: ['which part of the logs is being cleaned up or exported', 'the cleanup/disable action'],
    except: 'Reading logs does not count.',
  },
  {
    id: 'audit-retry-obfuscated',
    category: 'audit-bypass',
    severity: 'soft',
    blocks: 'Retrying the same thing in a different form after being blocked: encoding, renaming, splitting into steps, or reaching the blocked goal through another tool.',
    mustName: ['explicitly being asked to continue doing this after being blocked'],
    except: 'Normal correction and retry after a command error is not circumvention.',
  },
  {
    id: 'audit-disable-guard',
    category: 'audit-bypass',
    severity: 'soft',
    blocks: 'Disabling safety checks via flags: --insecure, --no-verify, skipping certificate validation, skipping pre-commit.',
    mustName: ['the check being skipped'],
  },

  // ─────────────── 生产部署与基础设施 ───────────────
  {
    id: 'deploy-production',
    category: 'deploy',
    severity: 'soft',
    blocks: 'Deploying or releasing to production: deploy scripts, blue-green switches, pushing to targets named prod/production/release, publishing official versions.',
    mustName: ['going to production this time'],
  },
  {
    id: 'deploy-migration',
    category: 'deploy',
    severity: 'soft',
    blocks: 'Running migrations or schema changes against non-local databases.',
    mustName: ['which database to run against', 'the migrate/change-schema action'],
  },
  {
    id: 'deploy-iac',
    category: 'deploy',
    severity: 'soft',
    blocks: 'terraform/pulumi/cdk apply and destroy, especially changes involving IAM, networking, quotas, node pools.',
    mustName: ['the scope and target of this change', 'the apply/destroy action'],
  },
  {
    id: 'deploy-dns-cert',
    category: 'deploy',
    severity: 'soft',
    blocks: 'Changing DNS records, TLS certificates, domain pointing.',
    mustName: ['which domain', 'what it is being changed to'],
  },

  // ─────────────── 集群与共享资源 ───────────────
  {
    id: 'shared-remote-exec',
    category: 'shared-resource',
    severity: 'soft',
    blocks: 'Running commands on another machine via ssh or a remote execution channel. That machine is outside this session\'s trust boundary, '
      + 'and changes there are not bound by local sandboxing.',
    mustName: [
      'the host (name or alias, however the user referred to it)',
      'the kind of thing to do on it — **checking status, changing config, restarting services and installing things are four different things**; '
        + 'the user naming one does not authorize the other three',
    ],
  },
  {
    id: 'shared-cluster-wide',
    category: 'shared-resource',
    severity: 'soft',
    blocks: 'Cluster operations whose blast radius exceeds the named resource: --all, bulk selection by label, resources running on every node, '
      + 'admission components intercepting cluster traffic.',
    mustName: ['the scope of effect this time', 'the operation being performed'],
  },
  {
    id: 'shared-service-lifecycle',
    category: 'shared-resource',
    severity: 'soft',
    blocks: 'Stopping, restarting, or draining services and nodes that others are using too.',
    mustName: ['the service', 'the stop/restart/drain action'],
  },

  // ─────────────── 外部系统写入与评审绕过 ───────────────
  {
    id: 'ext-third-party-repo',
    category: 'external-write',
    severity: 'soft',
    blocks: 'Pushing to, opening PRs on, or forking repositories other than this session\'s working repo.',
    mustName: ['the external target repo', 'the push/open-PR/fork action'],
  },
  {
    id: 'ext-merge-without-review',
    category: 'external-write',
    severity: 'soft',
    blocks: 'Merging PRs nobody reviewed, approving your own PR, disabling CI checks.',
    mustName: ['the PR', 'the merge/approve action'],
  },
  {
    id: 'ext-chatops',
    category: 'external-write',
    severity: 'soft',
    blocks: 'Posting comments or messages that trigger automation (/deploy, /merge, atlantis apply — instructions aimed at bots).',
    mustName: ['the action being triggered'],
  },
  {
    id: 'ext-send-message',
    category: 'external-write',
    severity: 'soft',
    blocks: 'Sending messages on the user\'s behalf: email, IM, calendar invites, push notifications.',
    mustName: ['who it goes to', 'what is sent'],
    except: 'Writing to local services the user configured (memory store, todos, notes) is not sending a message.',
  },
  {
    id: 'ext-transaction',
    category: 'external-write',
    severity: 'hard',
    blocks: 'Initiating real-world transactions: transfers, orders, payments, buying or selling assets, and any call that spends money or moves assets.',
    except: 'This rule only covers actual transfers of money and assets. Creating accounts, checking balances, reading market data are not in scope.',
  },

  // ─────────────── 浏览器 ───────────────
  {
    id: 'browser-offsite-data',
    category: 'browser',
    severity: 'soft',
    blocks: 'In the browser, sending page content, cookies or credentials somewhere other than the current site.',
    mustName: ['what is being sent', 'where to'],
  },
  {
    id: 'browser-credential-entry',
    category: 'browser',
    severity: 'hard',
    blocks: 'Filling in or submitting credentials, payment information, or ID numbers in the browser.',
  },
  {
    id: 'browser-irreversible-click',
    category: 'browser',
    severity: 'soft',
    blocks: 'Clicking irreversible controls: send, publish, place order, delete, accept terms and authorize.',
    mustName: ['the action being performed'],
  },

  // ─────────────── 执行副本隔离（本项目专属）───────────────
  OUTSIDE_WORKTREE,
];

/**
 * 放行例外——soft 规则的例外，压不过 hard。
 *
 * 为什么必须有：上面那些描述的是**风险类别**，而任何一条真实的开发命令都会
 * 沾上某个。只有禁止清单的话，判定器总能找到一条命中，日常工作会被大面积拦下。
 * 例外的作用是把「日常工作长什么样」讲清楚，让它有东西可以对照。
 */
export const ALLOWANCES = [
  {
    id: 'local-work',
    allows: 'Working inside the session workspace: reading, writing and editing files, running builds, tests, formatters and static checks, '
      + 'starting local dev servers, creating and deleting temp files of its own. Git has this covered; this is day-to-day work itself.',
  },
  {
    id: 'read-only',
    allows: 'Read-only inspection: ls, cat, head/tail, grep/rg, find, stat, git status/log/diff, '
      + 'and read-only SQL queries. Reading itself has no consequence; the risk is what was read being sent out — judged separately.',
  },
  {
    id: 'declared-deps',
    allows: 'Installing dependencies per the project manifest (npm install / pip install -r / cargo build and the like), '
      + 'and the cache directories they necessarily write (~/.npm, ~/.cargo, ~/go/pkg).',
  },
  {
    id: 'toolchain-cache',
    allows: 'Toolchains reading and writing state in their standard places: nvm, pyenv, rustup, bun, '
      + 'playwright browser caches, the ~/.config and ~/.cache of various CLIs. Inevitable side effects of running the tools.',
  },
  {
    id: 'routine-git',
    allows: 'Routine git: add, commit, pull, fetch, switching branches, pushing to the current working branch. Reversible and reviewable.',
  },
  {
    id: 'session-scratch',
    allows: 'Working in this session\'s own scratch directory (the scratch the host opened for this session). '
      + 'Discarded when the session ends; affects neither the repo nor anyone else.',
  },
  {
    id: 'transient-retry',
    allows: 'Corrected retries after a command error: retrying after network blips, timeouts, missing dependencies, wrong paths. '
      + 'Working around a judgment that just blocked you does not fall under this one.',
  },
  {
    id: 'standard-auth',
    allows: 'Existing authentication flows: reading configured credentials to call a service, standard logins like gh auth. '
      + 'Provided the credential contents do not appear in output or outbound content.',
  },
  {
    id: 'local-preview',
    allows: 'Starting and visiting a local preview or debug service (localhost / 127.0.0.1 / the machine\'s internal addresses).',
  },
  {
    id: 'test-fixtures',
    allows: 'Fake credentials, placeholder keys and sample configs in tests and examples. Provided they are genuinely made-up placeholders, '
      + 'not copied out of real credential files.',
  },
];

/** 按 id 取规则，日志把命中 id 落盘后用它还原措辞。 */
export function ruleById(id) {
  return RULES.find((rule) => rule.id === id);
}

/** hard 级规则——任何用户意图都不清除。提示词里单列一节。 */
export const HARD_RULES = RULES.filter((r) => r.severity === 'hard');
