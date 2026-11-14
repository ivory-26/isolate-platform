# Contributing to Isolate

Thanks for helping improve Isolate. Contributions are accepted under the
[MIT License](LICENSE).

## Project background

Isolate was built for a hackathon. Every file in this repository was written during the
event week starting **October 27, 2026**, in a fresh git history. A pre-event spike that
validated the stack lives in a separate private repository (`ivory-26/isolate`); none of
its code, history or scaffolding has been committed here.

The project was **not submitted to the hackathon on time**. Circumstances during the
event week meant the submission deadline was missed, and the repository was published
afterward as a complete record of the work. It is maintained on a best-effort basis. Do
not describe the project or a contribution as a submitted, placed or awarded hackathon
entry.

## Community expectations

- Be respectful and assume good faith. Harassment, discrimination and personal attacks
  are not welcome.
- Discuss ideas in issues before writing large changes, so two people do not build the
  same thing.
- Keep credentials out of issues, pull requests, logs, screenshots and test fixtures.
  Use synthetic values and redact logs.
- **Never report a security vulnerability in a public issue.** Follow
  [SECURITY.md](SECURITY.md) instead.

## Before you start

Read these in order; they define the contracts and the current state:

1. [`AGENTS.md`](AGENTS.md) — work protocol and provider-credit rules.
2. [`project/STATUS.md`](project/STATUS.md) — current wave, gates and known gaps.
3. [`project/TASKS.md`](project/TASKS.md) — task ownership and phase order.
4. [`ARCHITECTURE.md`](ARCHITECTURE.md) — control plane, tenancy and security boundaries.

For anything beyond a typo or a one-line fix, **open an issue first** and describe the
problem, the proposed change and the affected package or app.

## Development setup

### Prerequisites

- [Bun](https://bun.sh/) **1.4.4** (the version pinned in CI)
- Git
- A Neon PostgreSQL database **only** if you want the live-database integration tests;
  they skip automatically when `DATABASE_URL` is unset.

### Install and run

```bash
git clone https://github.com/ivory-26/isolate-platform.git
cd isolate-platform
bun install --frozen-lockfile

# Local configuration. Never commit .env or any .env.* file.
cp .env.example .env

bun run dev:web      # web control plane
bun run dev:worker   # durable task worker
```

### Providers are disabled by default

You do not need any provider API key to develop, test or build this project. Keep the
offline settings while working:

```bash
INFERENCE_PROVIDER=none
SANDBOX_PROVIDER=null
```

Baseten and Modal are credit-funded and shared. Do not request, add or use
`BASETEN_API_KEY`, `MODAL_TOKEN_ID` or `MODAL_TOKEN_SECRET` unless a maintainer
explicitly authorizes a single bounded acceptance run. No exploratory or benchmark
calls against paid providers. See [`AGENTS.md`](AGENTS.md) for the full policy.

## Useful commands

| Command | Purpose |
|---|---|
| `bun run check` | Biome lint and format check |
| `bunx biome check --write <paths>` | Format and fix a scoped change |
| `bun run typecheck` | TypeScript across all workspaces |
| `bun test` | All tests (live-DB suites skip without `DATABASE_URL`) |
| `bun test --no-env-file` | Tests with provider configuration ignored |
| `bun run validate` | `check` + `typecheck` + `test` |
| `bun run security:check` | Repository credential-boundary and migration scan |
| `bun run acceptance:offline` | Offline acceptance suite; requires zero provider credentials |

## Making a change

1. **Branch from `main`.** Use a descriptive name, e.g. `task/connector-retry-fix` or
   `docs/setup-clarification`.
2. **Stay scoped.** One logical change per pull request. Existing work is split by
   package and app; do not refactor unrelated code in the same PR.
3. **Respect ownership.** `package.json`, the root `bun.lock`, `scripts/`, `project/`
   and `.env*` files are coordinator-owned. Change them only when the linked issue says
   so.
4. **Write tests.** New behaviour needs a regression test; a bug fix needs a test that
   fails before the fix. Keep tests deterministic and offline: no live provider, vendor
   or network calls.
5. **Update the docs** when behaviour, setup, environment variables or limits change:
   `README.md`, `docs/`, `project/STATUS.md` and `project/TASKS.md` as applicable.
6. **Commit with a conventional prefix**: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
   or `chore:`. Keep the subject imperative and under ~72 characters.
7. **Rebase on `main`** before requesting review; do not merge `main` into your branch.

## Pull request checklist

Before opening a pull request, confirm:

- [ ] `bun run check` passes.
- [ ] `bun run typecheck` passes (or the full `bun run validate`).
- [ ] `bun test --no-env-file` passes twice with identical results.
- [ ] `bun run security:check` passes.
- [ ] `bun run acceptance:offline` passes with `INFERENCE_PROVIDER=none` and
      `SANDBOX_PROVIDER=null`.
- [ ] The change contains no secrets, `.env` files, real tokens or private keys.
- [ ] New behaviour has tests; new configuration is documented in `.env.example`.
- [ ] The pull request links its issue and describes the change and any trade-offs.
- [ ] UI changes include a screenshot or recording made with synthetic data.

CI runs Biome, typecheck, the web production build, the client secret sweep, the test
suite, offline acceptance and a **blocking** gitleaks scan. Never add provider keys to
CI or to repository secrets for a contribution.

## Code style

- TypeScript in strict mode; Bun workspaces with one package per directory.
- Biome formats with tabs and double quotes. Run `bunx biome check --write` on the files
  you touched.
- Validate untrusted input with Zod at boundaries; share contracts through
  `packages/shared` rather than duplicating types.
- Keep error codes, task states and event names in the shared contracts; do not invent
  local variants.
- Never log secrets, tokens, request bodies or provider responses. Use the shared
  redaction helpers and fixed error text.
- No `eval`, no dynamic workflow execution and no unbounded provider reads.

## Connectors and documentation

- Adding or changing a connector: read [`docs/connector-onboarding.md`](docs/connector-onboarding.md)
  and [`docs/connector-usage.md`](docs/connector-usage.md).
- Documented limits live in [`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md). Do not
  claim a capability is live or verified unless it has an offline test and, where
  relevant, an approved live acceptance record.
- Architecture decisions and rejected alternatives are recorded in
  [`project/DECISIONS.md`](project/DECISIONS.md). Update it when you change a contract.

## Reporting bugs and requesting features

Open a GitHub issue and include:

- what you expected and what happened;
- exact steps to reproduce, with the smallest example;
- the affected app or package and the commit you tested;
- relevant logs with secrets, tokens and customer data removed;
- for feature requests: the problem you are trying to solve, not only the proposed
  solution.

## Questions

Open an issue with the `question` label. For security matters, use
[SECURITY.md](SECURITY.md).
