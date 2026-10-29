# @isolate/sandbox

Server-only execution-plane contracts. `NullProvider` is the only production
adapter: `create` and every `execute` fail with `PROVIDER_UNAVAILABLE`; `destroy`
is an idempotent no-op. No local process, Git, shell, SDK, network or credential
fallback is reachable from the public barrel. No new dependencies are needed.

## Public API

Import from `@isolate/sandbox`; the root is the only exported subpath.

- `SandboxProvider`: `create(spec)`, `execute(handle, authorizedCommand, signal?)`,
  `destroy(handle)`. `SandboxSpec` declares workspace, lifetime, memory, CPU and
  egress. `SandboxHandle` identifies an isolated workspace, never a worker path.
- `NullProvider`, `SandboxError`, `SandboxErrorCode`.
- `commandPolicy(policy, request)` returns a branded, deeply frozen
  `AuthorizedCommand`. Allowlists use exact executable names and positional argv
  shapes: `literal`, `oneOf`, bounded `pattern`. No implicit trailing arguments,
  flags, commands or network permission. Prefer literal/oneOf; trusted patterns
  must be reviewed for linear-time matching. Policy configuration is trusted
  application code, never a grant that a model/repository/user may invent.
- Pure validators: `validateArgs`, `validateTimeout`, `validateOutputLimit`,
  `validateEgress`, `validateAbsolutePath`, `validateSandboxPath`.
- `executeCommand(provider, sandbox, policy, request, signal?)` validates before
  adapter dispatch and checks returned bounds. Post-hoc checks cannot enforce
  isolation/stream caps. Only a real provider can terminate execution; there is
  deliberately no misleading Promise.race timeout around an unsafe host command.
- `openRepo({ provider, sandbox, path, timeoutMs?, maxOutputBytes? }, signal?)`
  verifies the exact repository root via the adapter, returning `GitRepository`.
- `taskBranchName(taskId)` and `createBranch(repo, taskId, signal?)` use
  `task/<id>`. Supply globally unique task/attempt IDs matching
  `[a-z0-9][a-z0-9_-]{0,63}`. Duplicate names fail, never force-reset/reuse.
- `createWorktree(repo, taskId, absoluteSandboxPath, signal?)` creates a new task
  branch/worktree with **no checkout**, returning a `GitWorktree` capability.
  This is metadata-only; isolated file population is remaining provider work.
- `removeWorktree(repo, worktree, signal?)` accepts only a capability created by
  that repository, never arbitrary paths. No force deletion or branch deletion.
  Dirty/untracked files cause failure and leave the handle retryable. Git may
  consider a no-checkout worktree with tracked HEAD files dirty too; destroy the
  disposable sandbox rather than forcing deletion when removal is unsafe.

## Bounds and security boundary

Command ceilings are positive safe integers, at most 300,000ms / 1,048,576
combined stdout/stderr UTF-8 bytes. Egress defaults to deny even if the ceiling
permits hosts. Grants mean HTTPS:443 to exact lowercase public DNS names only:
no wildcards, IPs, local names, URL/port/userinfo, or implicit subdomains.
DNS/IP/redirect confinement still requires network enforcement by the provider.

Git always uses fixed argv through `SandboxProvider.execute`, denied egress,
disabled hooks/fsmonitor/attributes defaults/SSH/credential helpers/transports,
no recursive submodules, no maintenance/replace objects/pagers, and no checkout.
Default bounds: 10,000ms / 16,384 bytes; maximum: 30,000ms / 65,536 bytes per
operation. Git failures never echo repository-controlled stdout/stderr.

Paths are canonical absolute POSIX sandbox paths with component-boundary checks.
Windows paths, traversal, hidden/flag components and shell syntax are rejected.
Lexical validation is NOT filesystem confinement: providers must confine symlinks,
Git metadata and all command access. Worktrees are NOT isolation. Capabilities do
not replace tenant authorization. The coordinator must serialize writers to each
checkout/branch; independent tasks need separate writable sandboxes.

## Remaining hosted-provider work

Reject unsupported controls before provisioning/execution:

1. Disposable isolation, tenant/run-scoped handles, immutable provisioning
   ceilings and finite CPU/memory/lifetime bounds.
2. Shell-free argv execution with trusted image binaries, sanitized environment
   and Git config; no host mounts, inherited credentials or repo-controlled PATH.
3. Real deadline/cancellation enforcement that kills and reaps all descendants;
   bounded streaming combined stdout/stderr capture, not post-hoc truncation.
4. Default-denied network. Exact HTTPS:443 allowlists, DNS/redirect checks against
   private/loopback/link-local/metadata/non-public IPs, no proxy/tunnel escapes.
   Command egress must never exceed the sandbox's provisioning ceiling.
5. Idempotent cleanup on all outcomes, short-lived scoped credentials, sanitized
   provider errors and audit records, isolated checkout/population support.
6. Conformance tests in the actual sandbox: symlink escapes, process descendants,
   output floods, cancellation, DNS rebinding, tenant separation and cleanup.

Brands/result checks cannot make an unsafe adapter safe. Never execute untrusted
repositories or scripts on the worker/web host. No provider is connected here.

## Offline validation

From the worktree, using installed tools without env-file loading or installs:

```text
bun --no-env-file node_modules/@biomejs/biome/bin/biome check packages/sandbox
bun --no-env-file node_modules/typescript/bin/tsc -p packages/sandbox/tsconfig.json --noEmit
bun test --no-env-file ./packages/sandbox/src
```

Root typecheck discovery already lists sandbox. Workspace linking/lockfile
reconciliation, integration checks and deployment remain coordinator-only.

`src/git/trusted-fixture.test-support.ts` is test-only, unexported and unreachable
from the public barrel. It accepts no existing repository: each fixture owns a
fresh empty-template repository under `node:os.tmpdir()`, fabricated identity,
sanitized environment and fixed setup/inspection argv. Its adapter accepts only
the exact hardened helper forms for its own identity and confined paths. No shell,
transport, checkout, hook or filter execution. Finally blocks destroy fixtures,
even dirty worktrees. Planted hook/fsmonitor/filter sentinels stay unexecuted.
This runner is NOT a sandbox provider for real repositories.

The task suggested Bun Shell for fixtures, but installed Bun Shell lacks
kill/deadline/bounded-capture APIs. The fixture-only runner therefore uses
shell-free `spawnSync` with timeout, SIGKILL, fixed buffer caps and a combined
byte check. Production helpers use neither host runner. Tests use no network or
hosted credentials and never mutate the platform repository.
