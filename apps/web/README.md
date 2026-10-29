# Web control plane (W3-U)

Fresh event-owned Bun / strict TypeScript / React / TanStack Start scaffold, not a legacy port.

## Routes and boundaries

- `/`: bounded task submission via a validated POST server function.
- `/runs`: newest 25 organization-scoped tasks and each task's latest workflow run,
  loaded through a GET server function and a per-router/per-request Query client.
- Identity is never taken from form fields, search parameters, cookies or caller headers.
  Strict submission/list schemas reject unknown caller tenant/actor fields.
- **Production access is intentionally disabled** until a trusted authentication,
  membership and authorization adapter replaces `resolveLocalScope`. No invented auth.
  Authorization resolves before storage initializes, even when a DB URL is configured.
- Local demo is NOT authentication: both `NODE_ENV=development` (or `test`) and
  `WEB_LOCAL_DEMO=true` are required, with no configured database. It exposes only one
  fixed synthetic organization/user/repository, and refuses a real database.
- Demo repository UUID: `10000000-0000-4000-8000-000000000003`.
  Fake data is process-local, disappears on restart, and is not consumed by a worker.

All repository clients, configuration and fakes are in explicitly server-only modules.
The browser imports RPC stubs, schemas and safe summaries, never DB/provider/execution code.
Start's default entry installs same-origin CSRF middleware for server-function requests;
no custom start entry overrides it. Personalized SSR/RPC responses are `private, no-store`.

## Persistence and idempotency

`createRepositoryStore` adapts the existing `TaskRepository` and `QueueRepository`
contracts. It verifies repository ownership before creating a task, validates ownership
and payload equality on dedupe hits, and enqueues a bounded `run_task` reference.
Reusing a request key with a changed repository/branch/budget returns `CONFLICT`.
The form retains the exact payload/key after ambiguous errors until explicitly reset.

`createPostgresStore` wraps task + queue writes in one `sql.begin` transaction.
The local fake path is not transactional: retrying the same key heals a partial fake
write. Driver exceptions are replaced with fixed safe errors, never serialized raw.

The shared DB contract has no org-scoped latest-task/list-run method, so the web-local
SQL adapter binds the org in both task and latest-run predicates before ordering/limit.
It projects safe IDs, branch, statuses and ISO dates only (no raw payloads, budgets,
creator, idempotency keys, paths, credentials or events). No migration was added.

The seeded DB package now exports `@isolate/db/testing`. Development task adapters
and offline fixtures use that public subpath; the relative-source fallback is removed.

## Commands

From the worktree root (use the absolute Bun executable on Windows if needed):

```sh
bun run --no-env-file --cwd apps/web dev
bun run --no-env-file --cwd apps/web build
bun run --no-env-file --cwd apps/web typecheck
bun test --no-env-file --cwd apps/web
bunx --no-env-file --no-install biome check apps/web
bun run --no-env-file --cwd apps/web check:client
bun run --no-env-file --cwd apps/web check:build
```

Vite uses `envDir: false`; commands disable Bun's automatic `.env` loading. Configure
local-demo flags in the launching process explicitly, never in a committed env file.
`check:build` invokes the built fetch entry without opening a listening socket, in a
child with only synthetic environment values. It verifies SSR, no-store headers and
production refusal despite spoofed identity headers, a demo flag and a fake DB URL.
`check:client` scans every `dist/client` file for secret-shaped values and DB/provider/
execution markers. Build first. These are targeted safeguards, not a full security audit.

Build artifacts: `dist/client` static assets and `dist/server/server.js` fetch entry.
A deployment must host the client assets and provide an adapter for the fetch entry.
No production hosting/authentication integration or live DB test is claimed here.

## Exact direct dependencies

| Package | Version |
| --- | --- |
| `@tanstack/react-start` | `1.169.4` |
| `@tanstack/react-router` | `1.170.46` |
| `@tanstack/react-query` | `5.105.0` |
| `@tanstack/react-router-ssr-query` | `1.167.3` |
| `react`, `react-dom` | `19.3.1` |
| `zod` | `4.6.7` |
| `vite` | `8.3.5` |
| `@vitejs/plugin-react` | `6.1.2` |
| `@types/react`, `@types/react-dom` | `19.3.0` |
| `@isolate/db`, `@isolate/shared`, `@isolate/workflow-schema` | `workspace:*` (`0.1.0`) |

Validated using Bun `1.4.4`, root TypeScript `6.0.3`, Biome `2.4.5` and bun-types `1.4.4`.
The original W3 install added the web graph to root `bun.lock` (+289 lines, no removals).
W4-C does not change that pre-existing lockfile delta or any seeded dependency/root file.
The new compiler workspace dependency is declared only in `apps/web/package.json`;
local relinking used `bun install --no-env-file --no-save --ignore-scripts --offline`.
Coordinator must regenerate the root lockfile before a frozen-lockfile integration install.

API verification used all three requested TanStack skills, Context7 and live official
[server function docs](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions).
Context7's `inputValidator` examples are stale for this resolved version: installed
`@tanstack/start-client-core@1.170.39` types and the live guide require `.validator`.
Router exports `getRouter`; Query SSR uses `setupRouterSsrQueryIntegration` without a
second provider/dehydration pass. Clear the caller query cache on future auth switches.

Offline tests cover valid/default-budget submission, validation, repository/tenant
isolation, safe list/error responses, latest-first limits, task/queue dedupe (including
parallel retries), changed-key-payload conflicts, failure/retry and transaction wiring.
The SQL fixture verifies bound statement/transaction contracts; it does not emulate
PostgreSQL rollback or replace a future live integration test.

## W4-C: unexposed server-only workflow compilation

`src/server/workflow-compilation.server.ts` exports:

```ts
declare function createWorkflowCompilationService(
  deps: WorkflowCompilationDependencies,
): {
  compileAndPersist(input: unknown): Promise<WorkflowCompilationResult>;
};
```

The only accepted request fields are `workflowDefinitionId` (UUID, normalized to
lowercase) and `workflowVersion` (integer `1..2147483647`, no coercion). Client graph,
tenant, actor, allowlist and policy fields are rejected. The service has no defaults,
RPC, route or runtime factory registration; production auth is **not integrated**.

All required dependencies are injected from trusted server code:

- `resolveScope(): Promise<CallerScope | null>` resolves UUID organization/user IDs.
- `authorizeMembership(scope): Promise<boolean>` must authorize active membership
  **and compilation permission**, not merely a caller-provided identity claim.
- `resolvePolicy(scope, pin): Promise<WorkflowCompilationPolicy | null>` supplies
  `toolAllowlist: readonly string[]` and `taskBudget: number`. Null denies access;
  thrown/malformed policy fails closed, before compilation repository initialization.
- `getRepositories(scope): Promise<WorkflowCompilationRepositories>` lazily supplies
  `authoredVersions`, `compiledPlans`, and `rejections` only after all those checks.

The local structural W4-D integration seam is exact and does not import its unfinished
concrete implementation:

```ts
interface AuthoredWorkflowVersionReader {
  getAuthoredVersion(
    organizationId: OrganizationId,
    definitionId: WorkflowDefinitionId,
    version: number,
  ): Promise<WorkflowVersionRow | null>
}
```

W4-D's `PostgresWorkflowVersionRepository` must implement that tenant-filtered lookup.
`WorkflowVersionRow` has no organization column; tenant isolation at this seam must
be enforced by the reader's org-scoped query. The service additionally refuses a
returned row with the wrong definition ID/version rather than following a different pin.

The graph remains `unknown` until a hook-free JSON snapshot and runtime structural
schema succeed. The existing compiler still performs its actual semantic/registry,
allowlist and loop-budget validation. No cast substitutes for the runtime guard.
Graph ID/version must exactly equal the canonical authored row pin; compiled output
must also match. The service never reads/writes `workflow_versions.compiled`.

Outcomes:

- `{ outcome: "compiled", pin, compiledPlanId }` only after `compiledPlans.save` succeeds.
- `{ outcome: "rejected", pin, rejectionId, issues }` only after `rejections.record`
  succeeds. Malformed graphs and graph-pin mismatches are saved as safe
  `MALFORMED_GRAPH` / `PIN_MISMATCH` rejections under the canonical authored pin.
- `{ outcome: "conflict", pin }` for an insert-only plan save conflict, including an
  identical repeated compile; no overwrite or rejection write is performed.
- `{ outcome: "error", error: { code, message } }` with fixed safe messages for
  `INVALID_INPUT`, `AUTH_REQUIRED`, `FORBIDDEN`, `POLICY_UNAVAILABLE`, `NOT_FOUND`,
  `STORAGE_FAILURE`, or unexpected `COMPILATION_FAILED`.

Unknown/foreign/mis-pinned authored rows and versions disappearing at persistence
return `NOT_FOUND`. Rejection record failures cannot be reported as successful
rejections. Rejected retries append history; successful plans remain immutable.

Legacy compiler messages can contain source IDs, tool names and arbitrary config-key
paths. The web boundary stores/returns only fixed messages, recognized issue codes,
whitelisted structural paths (at most 160 characters) and at most 100 issues. It
returns no graph, plan configs, raw compiler/driver exception, policy or credential.
The legacy compiler reports loop-budget denial as `INVALID_TYPE`; this code is preserved.

W4-C adds actual-compiler tests with the real W3 in-memory plan/rejection repositories:
exact pins, valid/dotted/malformed graphs, sanitization, scope/membership/tenant denial,
server-only policy, duplicate/conflict/parallel saves, persistence failures and delayed
rejection confirmation. No live DB or real auth-provider integration is claimed.

Remaining integration: supply the W4-D reader and real lazy Postgres repositories,
trusted session/membership/permission and policy resolvers, then separately review a
production-authenticated RPC/route. W4-F's unknown-input compiler API has not been
synced here; the legacy-safe guard remains until it is. No execution is enabled.

## File inventory

```text
apps/web/.gitignore
apps/web/README.md
apps/web/package.json
apps/web/scripts/check-client.ts
apps/web/scripts/smoke-build.ts
apps/web/src/features/tasks/contracts.ts
apps/web/src/features/tasks/queries.ts
apps/web/src/features/tasks/tasks.functions.ts
apps/web/src/routeTree.gen.ts
apps/web/src/router.tsx
apps/web/src/routes/__root.tsx
apps/web/src/routes/index.tsx
apps/web/src/routes/runs.tsx
apps/web/src/server/development-store.server.ts
apps/web/src/server/local-mode.server.ts
apps/web/src/server/local-mode.test.ts
apps/web/src/server/postgres-store.server.ts
apps/web/src/server/postgres-store.test.ts
apps/web/src/server/repository-store.server.ts
apps/web/src/server/runtime.server.ts
apps/web/src/server/task-service.server.ts
apps/web/src/server/task-service.test.ts
apps/web/src/server/test-fixtures.ts
apps/web/src/server/workflow-compilation.server.ts
apps/web/src/server/workflow-compilation-guard.server.ts
apps/web/src/server/workflow-compilation-fixtures.ts
apps/web/src/server/workflow-compilation.test.ts
apps/web/src/server/workflow-compilation-auth.test.ts
apps/web/src/server/workflow-compilation-failures.test.ts
apps/web/src/styles.css
apps/web/tsconfig.json
apps/web/vite.config.ts
```
