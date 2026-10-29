# Workflow compilation persistence (W3-D)

Migration `migrations/0002_workflow_compilation.sql` requires `0001`. It is
additive, rerunnable, PostgreSQL 13+ compatible, and compatible with the
coordinator's line-based migration runner. Repositories and tests never apply
migrations. The coordinator owns application and integration.

## Public API

Import contracts, row types, pure helpers and PostgreSQL implementations from
`@isolate/db`. Each PostgreSQL repository takes the existing `PgSql` client.
Inputs use camelCase; returned rows match the existing snake_case DB contract.

- `WorkflowVersionPin`: `{ organizationId, workflowDefinitionId, workflowVersion }`.
  The version must be a positive PostgreSQL integer (1 through 2147483647).
- `CompiledPlanRepository.save({ ...pin, plan })` returns
  `{ ok: true, plan: CompiledPlanRow }` or
  `{ ok: false, code: "NOT_FOUND" | "CONFLICT" }`.
  A missing version, foreign definition, or wrong tenant is `NOT_FOUND`.
  Even an identical duplicate save is `CONFLICT`; it never overwrites a plan.
- `get(orgId, definitionId, version)` returns a row or `null`.
- `list(orgId, definitionId)` returns full rows, version descending.
- `listVersions(orgId, definitionId)` returns `{ id, workflow_version, created_at }`
  summaries in the same order, without plan blobs.
- `WorkflowRejectionRepository.record({ ...pin, issues })` returns
  `{ ok: true, rejection: WorkflowRejectionRow }` or
  `{ ok: false, code: "NOT_FOUND" }`. Each call appends a distinct history row.
- `listLatest(orgId, definitionId, version, limit = 50)` returns that pin's
  rejection history ordered by `created_at DESC, id DESC`. Limits are 1–500.
- Invalid scope, version, payload, plan pin, or limit throws before SQL.
  Unexpected database errors propagate; they are not classified as conflicts.

`plan` follows the actual compiler's `CompiledWorkflow` contract:
`workflowId`, `versionPinned`, `planId`, `entryNodeIds`, `steps`, `edges`.
Its workflow ID and pinned version must equal the row's pin. Issues use the
compiler's `{ path, code, message }` shape (including future string codes).
The DB package owns a structural type, not a runtime compiler dependency;
test-only real compiler round trips and bidirectional type assignments guard
against drift. Graph/config/policy validation remains the compiler's job.
Both JSON columns normalize through `parseJsonbColumn` at the mapper boundary.
Lossy/non-JSON values are rejected consistently by PostgreSQL and fake inputs.
Compilation inputs are copied using own data-property descriptors before payload
validation; the exact detached snapshot is serialized for both repositories.
Accessors (including nonenumerable getters/setters), callable serialization
hooks, proxies, hidden data, sparse arrays and custom array properties are
rejected without invoking caller code. Detached objects/arrays have null
prototypes so serialization cannot consult inherited hooks. PostgreSQL-JSONB
incompatible NUL and unpaired UTF-16 surrogates are rejected in string values
and property keys; valid surrogate pairs and other Unicode are preserved.
These errors use static messages and never include source keys or values.
No additional ID character restrictions or Unicode normalization are introduced.

Composite foreign keys enforce definition ownership and authored-version
existence even when repositories are bypassed. Uniqueness is race-safe in
PostgreSQL. Immutability/append-only behavior is a **repository API guarantee**:
there are no update/delete methods, but this migration does not install
triggers, RLS, or revoke privileged direct SQL UPDATE/DELETE access. Authorization
must supply the trusted caller's organization; it is not implemented by these
repositories. Deleting parent versions/definitions requires removing their
compilation history explicitly because the foreign keys do not cascade.

## Authored version reader (W4-D)

`WorkflowVersionRepository` and `PostgresWorkflowVersionRepository` are exported
from `@isolate/db`. The PostgreSQL implementation takes the existing `PgSql`.

```ts
getAuthoredVersion(
  organizationId: OrganizationId,
  workflowDefinitionId: WorkflowDefinitionId,
  workflowVersion: number,
): Promise<WorkflowVersionRow | null>
```

The reader joins `workflow_versions` to `workflow_definitions`, matching the
organization, definition ID and exact authored version with bound parameters.
All SQL column references are qualified. Empty/whitespace IDs, invalid runtime
ID types and nonpositive/noninteger/out-of-range versions return `null` before
SQL (valid versions are 1 through 2147483647). Missing and foreign pins also
return `null`, without retrying or selecting the latest version. The existing
snake_case row shape and driver `Date` are preserved; `graph` and nullable
legacy `compiled` pass through `parseJsonbColumn`. This is a read of existing
authored data, not graph validation, recompilation or a compiled-plan lookup.
There are no writes or migrations. Unexpected SQL/JSON decoding errors propagate;
they are not treated as a missing pin. Callers remain responsible for authorization.

## Offline testing

`@isolate/db/testing` exports the existing task/approval/queue fakes plus
`InMemoryCompiledPlanRepository`, `InMemoryWorkflowRejectionRepository` and
`createInMemoryWorkflowCompilationRepositories({ versions?, now? })`.
The factory returns `{ compiledPlans, rejections }`. Seed `versions` with
existing authored `WorkflowVersionPin` values; an empty catalog fails closed.
Definitions cannot belong to multiple tenants. Catalog seeds and all returned
JSON/dates are detached copies, and factory calls never share mutable state.
The optional clock makes latest-first history tests deterministic.

Run scoped checks from the worktree with installed tools (no dependency install):

```sh
bun --no-env-file x --no-install biome check packages/db
bun --no-env-file node_modules/typescript/bin/tsc -p packages/db/tsconfig.json --noEmit
env -u DATABASE_URL bun --no-env-file test packages/db
```

Both live suites skip without `DATABASE_URL`. When explicitly enabled, the
workflow compilation live suite requires both migrations to exist, fails with
an actionable message otherwise, uses random fixture IDs, and performs only
DML against those fixtures. Live execution and migration application were not
part of the offline validation.
