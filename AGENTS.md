# Agent rules — isolate-platform

Read before working: [`project/STATUS.md`](project/STATUS.md), [`project/TASKS.md`](project/TASKS.md), [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Work protocol (non-negotiable)

- One owner per package per wave; one worktree and one `task/*` branch per agent.
- Root files (`package.json`, root `bun.lock`, `scripts/`, `project/`, `.env*`) are coordinator-only unless a task says otherwise.
- Commit on your branch before reporting; **never push**.
- Never read, print, copy, or commit `.env*` contents. Never put secrets in prompts, fixtures, logs, or client code.
- Gates before every report: scoped `biome check`, project `tsc --noEmit`, scoped `bun test` (×2 for determinism).
- Stop reports must include command evidence and the exact commit hash.

## Provider credits: Baseten + Modal (STRICT)

Baseten and Modal are credit-funded ($100 each) and shared. Treat every keyed call as spending the user's money. **Adding API keys is the last step of a wave** — after all code, tests, builds, and merges are complete and green without them.

### Rules

1. **No keys before code.** Implementation, unit/integration tests, fakes, builds, and full `bun run validate` must pass with providers disabled:
   `INFERENCE_PROVIDER=none`, `SANDBOX_PROVIDER=null`.
2. **Never request, use, or provision** `BASETEN_API_KEY`, `MODAL_TOKEN_ID`, or `MODAL_TOKEN_SECRET` unless the user explicitly authorizes the keyed acceptance phase in the current session. One authorization covers one bounded acceptance run — not ongoing experimentation.
3. **No exploratory, benchmark, load, retry-loop, or “try it and see” calls** against paid providers. Agents do not self-test on live APIs.
4. **Live calls only through the acceptance checklist:**
   - Baseten: exactly **one** chat completion, `max_tokens <= 16`, no tools, prompt `Reply with OK`.
   - Modal: exactly **one** sandbox, smallest allowed CPU/memory (target 512 MiB), `timeoutMs <= 60000`, one `echo`, terminate immediately.
   - Optional end-to-end (separate approval): `<= 2` agent turns, `<= 512` output tokens total, sandbox `<= 5` minutes.
5. **Caps are mandatory** for any keyed run: `MAX_TOKENS_PER_TASK`, `MAX_SANDBOX_SECONDS`, `MAX_COST_USD_PER_TASK`. Stop at the first cap; never increase a cap to make a test pass.
6. **Always destroy Modal sandboxes in `finally`.** After acceptance, verify zero sandboxes remain running.
7. **Record spend.** After each live run, read `usage_records` (tokens/cost) and report measured values. Never estimate silently or claim cost without evidence.
8. **Never parallelize live calls.** No retries after success; after a failure, report it and ask before retrying.
9. **Missing key means skip**, with a clear message. Never substitute a real provider call to make a test “pass”.
10. **CI never receives provider keys.** Live smokes are local, opt-in (`BASETEN_LIVE=1` / `MODAL_LIVE=1`), skipped by default.

### Definition of done for keyed work

Offline gates green ×2 · adapters and fakes tested · user-approved keys added last · minimal live acceptance executed once · spend recorded · sandboxes destroyed · docs updated.

## References

- Provider decisions and rejected alternatives: [`project/DECISIONS.md`](project/DECISIONS.md)
- Task ownership and phase order: [`project/TASKS.md`](project/TASKS.md)
- Security boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md) §11
