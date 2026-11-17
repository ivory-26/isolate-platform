# Frontend audit — `apps/web`

**Implementation reconciliation (2026-11-17):** the findings below are the
historical 2026-11-14 audit, not a current bug list. Run detail, artifact download,
attempts, validation, trace links, retry descendants, table scopes, inbox severity
and delivery truncation were already merged. Wave 28 additionally implements
goal/repository search with matching counts, parallel authorized reads, active-run
polling, workflow/approval/artifact cap notices, progressive event/log rendering
and concurrent usage reads. Product expansions (membership writes, workflow
builder, task-title migration) remain outside this bug-fix wave. Live visual
checks and combined validation are recorded in `project/STATUS.md`.

The later browser finding that pairing defaulted to a stale registration is
fixed in `982b14c`: most-recent-heartbeat proposal, measured freshness hints,
manual selection preservation and a code-bound relay label. The new selector
has unit/SSR coverage; the prior 1440/390 px browser checks covered the runs
surfaces, not this later selector change.

**Date:** 2026-11-14
**Base commit:** `c58e8f8` (worktree `worktree-agent-a5acd98b69b7eb3ed`)
**Scope:** every route and feature under `apps/web/src`, with a deep dive on the run detail page.
**Method:** static source read of routes, route loaders, query options, feature components, server read models and the DB repositories they call. No browser session, no live provider call, no `.env*` read.

Every claim below cites `path:line` in this repository. Claims that need a running browser (measured latency, FPS, screen-reader output, 390 px overflow) are marked **unverified**.

> Note on the brief: the brief asks for `project/STATUS.md` wave 20–27 UI notes. The newest wave in this worktree is **wave 24** (`project/STATUS.md:3`, `:5`); there are no wave 25–27 notes. This audit covers waves 20–24.

---

## 0. The one-paragraph verdict

The app is structurally complete: every primary destination has a loader, explicit pending/empty/error states and role-aware actions, and the run detail page is the only page that pulls together task, trace, approvals, usage and artifacts. The two real problems are (1) **artifact payloads are unreachable from the product** — the run page tells the user to fetch an object-storage reference that no route serves — and (2) **run detail loads a full attempts table and throws it away**, while several already-loaded fields (connector timings, trace id link, validation outcome) are never rendered. Behind that sit three classes of systemic debt: sequential DB awaits on the hottest reads, 200-row non-virtualized event/log lists, and no refresh path for in-flight runs.

---

## 1. Ground-truth route inventory

Legend: **SF** = server function backed by `uiRead` + a server read model. All app routes sit under the `_app` layout, whose loader runs on every in-app navigation (`apps/web/src/routes/_app.tsx:57-80`).

| Route | File | Data load (entry → query → repo) | What actually renders | Gaps / dead ends | States | Perf suspicion |
|---|---|---|---|---|---|---|
| `/` | `apps/web/src/routes/index.tsx:5-24` | `authStateOptions()` then `LandingPage` | Hero, product shot, capabilities, lifecycle, trust, CTA (`apps/web/src/features/landing/landing-page.tsx:97-296`) | None found; all landing images exist under `apps/web/public/images` (verified by directory listing) | Static | `GradientASCII` rAF on landing (`landing-page.tsx` hero); offscreen parking **unverified** |
| `/login`, `/signup`, `/auth/callback` | `apps/web/src/routes/login.tsx`, `signup.tsx`, `auth.callback.tsx` | Auth screens | **Not audited in depth — unverified** | — | — | — |
| `/_app` layout | `apps/web/src/routes/_app.tsx:57-80` | `authStateOptions()` + `setupStateOptions()` on every navigation (`:71-73`) | Shell, sidebar, topbar, mobile sheet | Extra setup round trip after its 10 s stale window (`apps/web/src/features/onboarding/queries.ts`); only empty workspaces redirect (`_app.tsx:78`) | Shell-shaped `AppPending` (`_app.tsx:14-55`), alert on error | One extra read per navigation; remember it is cached for 10 s only |
| `/overview` | `apps/web/src/routes/_app.overview.tsx` | `readHomeSnapshot()` → 14 repo calls in one `Promise.all` (`apps/web/src/server/overview-read.server.ts:696-776`) | Metrics, Needs you, Running now, Inbox preview, Sources (`_app.overview.tsx:146-180`) | No auto-refresh; needs manual reload for live runs | Empty/skeleton per section | 14 parallel queries is the right shape; watch DB connection ceiling, not UI |
| `/runs` | `apps/web/src/routes/_app.runs.tsx` | `listRuns` → `readRunsList` (`features/runs/read-model.ts:514-577`) | Summary strip, filter bar, table, pagination (`:151-335`) | Free-text search matches only `id::text` and `branch` (`read-model.ts:139-140`, mirrored at `:152-158`) — searching a goal or repo name finds nothing | Refetch warning `:187-192`; empty states `:199-230`; page pending; loader error via parent | 4 sequential awaits (`read-model.ts:524,540,555,565`); no polling |
| `/runs/$taskId` | `apps/web/src/routes/_app.runs.$taskId.tsx` | `readRunDetail` → task + trace + runs + attempts + approvals + artifacts (`features/runs/read-model.ts:580-642`) | Deep dive in §2 | See §2: attempts dropped, no blob download, connector timing/trace unrendered | Pending `:75-91`, error `:93-107`, refetch banner `:297-302` | 6 sequential awaits here (`read-model.ts:592-628`) + 5 inside the trace repo (`packages/db/src/repositories/trace-read.ts:398-424`) = ~11 serial round trips |
| `/approvals` | `apps/web/src/routes/_app.approvals.tsx` | `readApprovalsSnapshot` → pending + decided (`server/approvals-read.server.ts:183-186`, `Promise.all`) | Pending / decided sections, detail sheet, decision dialogs | Viewer role gets a note, no actions (`_app.approvals.tsx:143-148`) — correct | Empty sections, error, pending | Client-side paging over at most 50 pending + 20 decided (`APPROVAL_LIMITS`, `features/approvals/contracts.ts:223-226`) — fine at this cap |
| `/inbox` | `apps/web/src/routes/_app.inbox.tsx` | `readInboxSnapshot` (`server/inbox-read.server.ts:131-144`); loader deps only `status` + `source` (`_app.inbox.tsx:27-30`) | Filter bar, delivery list, client paging | **Severity is filtered client-side only** over the loaded window (`_app.inbox.tsx:11,66-72`); caveat text at `:141-143`; empty test at `:110-111,143-149` can say “none” while matches exist server-side | Empty + caveat | Client paging is a rendering choice, not a read cost |
| `/integrations` | `apps/web/src/routes/_app.integrations.tsx` | Integrations read model | Tabs incl. Relays (`:114-162`) | — | Per-tab empty states | Relays poll 15 s/5 s (`features/integrations/components/relays-panel.tsx`) — intended |
| `/integrations/$connectorId` | `apps/web/src/routes/_app.integrations.$connectorId.tsx` | Connector read | Connected/deliveries/verification/trigger panels (`:176-208`) | **`DeliveriesPanel truncated={false}` is hardcoded** (`:199-202`) although the server returns a real `truncated` flag (`server/integrations-read.server.ts:389-402`) → silent truncation | Panels handle empty | — |
| `/repositories` | `apps/web/src/routes/_app.repositories.tsx` → `features/repositories/repositories-view.tsx` | Repositories read | Table, GitHub install/picker, manual registration, advanced (`:149-815`) | Metadata limitation is stated explicitly | Empty/error | — |
| `/submit` | `apps/web/src/routes/_app.submit.tsx` | `readSubmitOptions` (`server/overview-read.server.ts:678-695`) | Form, demo fallbacks, success/compile result | Demo links blocked in README-like list (`:455-472`) are intentionally inert | Success/compile states `:531-549` | — |
| `/usage` | `apps/web/src/routes/_app.usage.tsx` | `readUsageSnapshot` (`server/usage-read.server.ts`) | Metrics, charts, table (`features/usage/usage-view.tsx:83-334`) | Client paging (`_app.usage.tsx:58-63`) | Empty `_app.usage.tsx:100-111` | **3 sequential awaits** (`server/usage-read.server.ts:83-104`) |
| `/settings` | `apps/web/src/routes/_app.settings.tsx` | `readSettingsSnapshot` (`server/settings-read.server.ts:57-96`) | Members, execution policy, account | Membership invite/remove is explicitly not implemented (`:103`, `:159-164`) | Empty/disabled states | — |
| `/workflows` | `apps/web/src/routes/_app.workflows.tsx` | Workflows list read | Read-only table (`:14-73`) + “builder unavailable” note (`:126-133`) | **Orphan page: no navigation entry anywhere** (`components/shell/nav.ts:31-35` documents this; grep finds no `to="/workflows"`) | — | — |
| `/devices` | `apps/web/src/routes/_app.devices.tsx:8-13` | None — loader throws a redirect to `/integrations?tab=relays` | Nothing | None; old bookmarks resolve | — | — |
| `/onboarding` | `apps/web/src/routes/_app.onboarding.tsx` | Setup state read | Setup checklist (`features/onboarding/components/setup-checklist.tsx:19-62`) | Reachable from checklist (`:170`) and submit (`_app.submit.tsx:467`), not from nav — intended | — | — |
| `/organizations`, `/organizations/new` | `apps/web/src/routes/organizations/{route,index,new}.tsx` | Not audited in depth — **unverified** | — | — | — | — |
| `/api/*` | `apps/web/src/routes/api.*` | Server handlers only | No UI | `/api/traces/$taskId` exists (`api.traces.$taskId.tsx:12-18`) but **nothing in the UI links to it** | Fixed JSON errors | — |

---

## 2. Run detail deep dive — `apps/web/src/routes/_app.runs.$taskId.tsx` (871 lines)

Loader: `apps/web/src/routes/_app.runs.$taskId.tsx:64-73` (auth, then `runDetailOptions`). Server projection: `apps/web/src/features/runs/read-model.ts:580-642`, whose trace section reuses `packages/db/src/repositories/trace-read.ts`.

### 2.1 Item-by-item: exists in DB → in projection → rendered?

| Required item | DB row exists? | In read projection? | Rendered? | Evidence / gap |
|---|---|---|---|---|
| Short id + copy | `tasks.id` | yes | **yes** | `_app.runs.$taskId.tsx:180-188`, `:324` |
| Status (text + tone) | `tasks.status` | yes | **yes** | `:184`, `statusTone` `:109-128` |
| Repository / branch / default branch | `repositories` join | yes (`RunTaskIdentity`) | **yes** | `:189-201` |
| Goal | `tasks.goal` | yes | **yes** | `:311-359` |
| Acceptance criteria | `tasks.acceptance_criteria` | yes | **yes** | `:361-405` |
| File ownership | `tasks.file_ownership` | yes | **yes** | `:361-405` |
| Autonomy level | `tasks.autonomy_level` | yes | **yes** | provenance list `:690-737` |
| Incident source / fingerprint | `tasks` incident columns | yes | **yes** | `:690-737` |
| Retry origin (`retry_of`) + depth | `tasks.retry_of`, `retry_depth` | yes | **yes** | `:237-261` |
| **Retry children / attempts list** | **`task_attempts` rows** | **yes — `read-model.ts:613`, mapped at `:637`, cap 10** | **NO** | The route never reads `detail.attempts`; grep for `attempts` finds only the connector-call column (`:515,538`). Data loaded and discarded. |
| **Metric strip** | `task_attempts` + usage + events | yes | **yes** | `:263-295` |
| Execution map | events | yes | **yes** | `:409-415`; builder `features/runs/execution-map.ts` (explicit single-agent fallback) |
| Lifecycle | events | yes | **yes** | `:417-423` |
| Event log / timeline | `run_events` (200 cap) | yes | **yes** | `:425-431`; `features/runs/components/run-timeline.tsx:174-183` |
| **Truncation notice for the 200-event cap** | — | no `truncated` flag returned | **no** | Event list simply ends; no “more events exist” indicator |
| Tool invocations table | `tool_invocations` | yes | **yes** | `:433-495`; headers lack `scope="col"` (`:447-454`) |
| Connector calls | `connector_calls` | yes | **partial** | `:497-549` renders tool, connector id, status, error code, attempts, created at |
| **Connector timings (`claimed_at`, `completed_at`, `expires_at`) and `traceparent`** | **yes** | **yes — `RunConnectorCall` carries them (`features/runs/contracts.ts:292-303`)** | **NO** | No columns/rows for these fields in `:497-549` |
| Validation outcome | **no table**; `validation.finished` event data (`stage/status/exitCode/durationMs/outputBytes/truncated`) | event data only | **only inside raw event log** | No dedicated validation section; would parse `validation.finished` from events — no migration needed |
| Approvals + payload SHA + decide actions | `approvals` | yes | **yes** | `:553-628` |
| Usage | `usage_records` | yes | **yes** | `:630-636`, `UsageSection:739-809`; headers lack `scope="col"` (`:772-776`) |
| Artifacts (kind/type/bytes/ref/preview) | `artifacts` | yes | **yes** | `:638-644`, `ArtifactsSection:811-870` |
| **Artifact download / blob payload** | **row exists; blob in `blob-store.ts:176` (`PostgresBlobStore`)** | storage ref + `isBlob` | **NO** | Copy at `:861-864` tells the user to “retrieve the payload from object storage using the reference above”, but **no web route serves a blob** (grep of `apps/web/src/routes` finds none). Dead end. |
| **Diff summary (+/− lines, files changed)** | raw `diff` artifact only; no stat columns | raw preview | **no summary** | Would need server-side parsing/stats; DB row exists (artifact), stats do not |
| Workflow runs | `workflow_runs` | yes | **yes** | `:646-683` |
| PR link | `tasks` PR columns | yes | **yes** | `:216-229` |
| Rerun / retry | — | eligibility in view | **yes** | `:230-232`; `features/runs/components/retry-run-button.tsx` |
| **Trace deep link** | trace API exists (`routes/api.traces.$taskId.tsx:12-18`) | trace id returned | **plain text only** | `run-timeline.tsx:160-167` prints the id; no anchor to `/api/traces/{taskId}`. |
| Full log view | `log_bundle` artifact | preview only | **preview only** | `run-log-viewer.tsx:62-64` fixes `h-72`; no full-log route |

### 2.2 Run-detail gap list (short form)

1. **Attempts table loaded, never rendered** — `read-model.ts:613`; route has no `detail.attempts`.
2. **Artifact payload unreachable** — no blob route; copy at `_app.runs.$taskId.tsx:861-864` points at nonexistent retrieval.
3. **Connector timing/trace fields dropped** — `contracts.ts:292-303` vs `_app.runs.$taskId.tsx:497-549`.
4. **No validation-report section** — outcome lives only in event data.
5. **No trace link** — API exists, UI does not link it.
6. **No retry descendants** — only upward `retryOf` + depth; no query for children of a task.
7. **No truncation signaling** for events/artifacts/approvals caps.
8. **No parsed diff stats** — raw preview only.
9. **No full-log surface** — bounded artifact preview only.
10. **No task title** — `tasks` has no title column; not fixable in the UI.

---

## 3. Performance / lag

### 3.1 Confirmed sequential reads (server)

- **Run detail**: task → trace → workflow runs → attempts → approvals → artifacts, each awaited in turn (`apps/web/src/features/runs/read-model.ts:592-628`). The trace repo itself runs `taskExists` → events → tool invocations → usage → connector calls sequentially by design (`packages/db/src/repositories/trace-read.ts:398-424`, comment at `:404`). That is **~11 serial DB round trips** for one detail view.
- **Runs list**: summary → filtered count → list page → repositories, sequentially (`apps/web/src/features/runs/read-model.ts:524,540,555,565`).
- **Usage**: three sequential blocks (`apps/web/src/server/usage-read.server.ts:83-104`).
- Approvals and overview are already parallel (`approvals-read.server.ts:183-186`; `overview-read.server.ts:637-653,713-736`) and should be the template.

### 3.2 Rendering

- **Non-virtualized 200-row lists**: `RunTimeline` maps every event (`features/runs/components/run-timeline.tsx:174-183`) and `RunLogViewer` maps all events into a fixed-height scroll area (`run-log-viewer.tsx:62-88`). Real cost at 200 rows with `<details>` payloads — **measured cost unverified**, but the shape is O(events) DOM on every mount.
- **Execution map** is a recursive tree with no windowing (`features/runs/components/run-execution-map.tsx:89-143`), bounded by the event stream size.
- **Event summarization / log text** is recomputed on render (`run-timeline.tsx` via `summarizeEventData`, `features/runs/view.ts:306-318`; `run-log-viewer.tsx:34`). Cheap at 200 rows; no memoization found.
- **Charts are fine**: `packages/...` Dither Kit `use-frame-loop.ts:30-83` genuinely parks rAF when offscreen/hidden, so the wave-23 parking claim holds (verified in source). No `setInterval` in the app; `transition-all` not used.
- **No polling on `/runs`, `/runs/$id`, `/overview`, `/approvals`** — all query options use `staleTime: 10_000, retry: false` and no `refetchInterval` (`features/runs/queries.ts:20-34`; analogous options elsewhere). Consequence: an in-flight run never updates without a manual Refresh (`_app.runs.$taskId.tsx:206-215`) or window refocus. This is a UX latency bug, not a CPU one.

### 3.3 Navigation

- `setupStateOptions()` is awaited in the `_app` loader for every non-settings/non-org path (`routes/_app.tsx:71-73`). It is cached with a 10 s stale time (`features/onboarding/queries.ts`), so the cost recurs after 10 s of navigation rather than on literally every click — still a shell-level read that could be folded into the shell summary or skipped after onboarding is complete.

---

## 4. Accessibility and UX mishaps

| Finding | Evidence | Severity |
|---|---|---|
| Table headers missing `scope="col"` on four hand-rolled tables | run detail tool table `_app.runs.$taskId.tsx:447-454`; connector calls `:511-516`; usage `:772-776`; runs list `_app.runs.tsx:240-263` | P0/P1 (mechanical) |
| Inbox severity filter runs client-side over the loaded page while status/source are server-side | `_app.inbox.tsx:11,27-30,66-72`; caveat `:141-143` | P0 (can show false “no results”) |
| Deliveries truncation hidden | `_app.integrations.$connectorId.tsx:199-202` vs `server/integrations-read.server.ts:389-402` | P0 (silent data loss) |
| Artifact blob dead end | `_app.runs.$taskId.tsx:861-864`; no blob route; `packages/db/src/repositories/blob-store.ts:176` | P0 |
| Attempts loaded and dropped | `read-model.ts:613`; route renders none | P0 (missing content) |
| Live runs never refresh | `features/runs/queries.ts:20-34`; no `refetchInterval` | P1 |
| No truncation indicators for capped sections | caps in `features/runs/contracts.ts:12-31`; no `truncated` in `RunDetailView` | P1 |
| Table semantics are right where the shared component is used | `components/common/data-table.tsx:60,66` | — (good example to copy) |
| Status never color-only | `components/common/status-badge.tsx:34-71,97-111` (dot + text) | — (good) |
| Skip links and focus/reduced-motion rules exist | `components/shell/app-shell.tsx:48-53`; `features/landing/landing-page.tsx:97-102`; `styles.css:216-219,224-233` | — (good) |
| Touch targets for native selects rely on a global coarse-pointer rule | `apps/web/src/styles.css:208-215` overrides `h-8 text-xs` selects in `features/inbox/inbox-view.tsx:50-169` | Watch; verified rule exists, real 390 px behavior **unverified** |
| Async refresh warnings are not announced | `_app.runs.$taskId.tsx:297-302`, `_app.runs.tsx:187-192` — no `role="status"`/live region | P2 |
| Orphan page `/workflows` | `components/shell/nav.ts:31-35`; no link anywhere | P2 |
| Settings membership dead end | `_app.settings.tsx:103,159-164` (honest copy) | P2 |
| Command menu is navigation-only | `components/shell/command-menu.tsx:16-65` — no run/task search | P2 |
| Read-only viewer note on run detail | `_app.runs.$taskId.tsx:304-309` | — (good) |

---

## 5. Dead ends and missing content outside run detail

1. **Settings → Members**: invite/remove explicitly absent (`_app.settings.tsx:103,159-164`). Honest, but it is a dead end for an owner.
2. **Workflows**: page exists, builder note at `_app.workflows.tsx:126-133`, but no nav entry (`nav.ts:36-66`) and no cross-link — unreachable without typing the URL.
3. **Command menu**: `Ctrl/Cmd+K` opens navigation only (`command-menu.tsx:16-65`); users cannot jump to a run by id from the palette even though `/runs/$taskId` is the core page.
4. **Runs search**: the search box promises free text but the SQL matches only id and branch (`read-model.ts:139-140`); goal/repository searches silently return nothing.
5. **Trace**: a trace API exists but the UI never links to it (`run-timeline.tsx:160-167`).
6. **Blob artifacts**: no download route (see §2).
7. **Retry lineage**: only `retryOf` upward; no way to see later retries of the same failure.

---

## 6. Prioritized fix plan (P0 / P1 / P2) with disjoint file ownership

Ownership is by file so parallel agents never touch the same file. Each P0 item lists the exact files.

### P0 — correctness/dead ends

| ID | Fix | Files (owner) |
|---|---|---|
| P0-1 | **Render the attempts table** already returned by `readRunDetail` (id, number, status, started/finished, error summary). No server change. | `apps/web/src/routes/_app.runs.$taskId.tsx` (render), `apps/web/src/features/runs/components/run-attempts.tsx` (new) — **Agent A** |
| P0-2 | **Make artifacts retrievable**: authenticated, tenant-scoped blob route + link from the artifact row; keep inline refs working. | `apps/web/src/routes/api.artifacts.$artifactId.tsx` (new), `apps/web/src/server/artifacts-read.server.ts` (new), `packages/db/src/repositories/blob-store.ts` (read helper), `apps/web/src/features/runs/components/artifact-download-link.tsx` (new) — **Agent C**; Agent A imports the link component in `_app.runs.$taskId.tsx` |
| P0-3 | **`scope="col"` on every hand-rolled `<TableHead>`** (tool, connector, usage, runs list). | `apps/web/src/routes/_app.runs.$taskId.tsx` (447-454, 511-516, 772-776) — **Agent A**; `apps/web/src/routes/_app.runs.tsx` (240-263) — **Agent B** |
| P0-4 | **Inbox severity must filter server-side** (add to loader deps + SQL), or stop offering severity until it can. Remove the client-only false-empty. | `apps/web/src/routes/_app.inbox.tsx`, `apps/web/src/server/inbox-read.server.ts`, `apps/web/src/features/inbox/contracts.ts` — **Agent D** |
| P0-5 | **Pass the real `truncated` flag to deliveries** instead of `truncated={false}`. | `apps/web/src/routes/_app.integrations.$connectorId.tsx` — **Agent D** |

### P1 — missing information and latency

| ID | Fix | Files (owner) |
|---|---|---|
| P1-1 | Show connector timings (`claimedAt`, `completedAt`, `expiresAt`) and `traceparent` in the connector-call table. Data already returned (`contracts.ts:292-303`). | `apps/web/src/routes/_app.runs.$taskId.tsx` — **Agent A** |
| P1-2 | Link the trace id to `/api/traces/$taskId` (new tab, `rel="noreferrer"`). | `apps/web/src/features/runs/components/run-timeline.tsx` — **Agent A** |
| P1-3 | Add a **validation report** section derived from the `validation.finished` event (stage, status, exit code, duration, output bytes, truncated). No migration. | `apps/web/src/features/runs/components/run-validation.tsx` (new), `apps/web/src/routes/_app.runs.$taskId.tsx`, `apps/web/src/features/runs/view.ts` — **Agent A** |
| P1-4 | **Parallelize** `readRunDetail`'s independent sections and `readRunsList`'s four reads (keep the trace internal order if tenancy wants it, but the outer calls can be `Promise.all`). | `apps/web/src/features/runs/read-model.ts` — **Agent B** |
| P1-5 | **Search by goal/repository**: extend the list SQL and filtered count consistently (the two must stay in lockstep). | `apps/web/src/features/runs/read-model.ts` (Agent B must serialize with P1-4; same file) |
| P1-6 | **Refresh in-flight runs**: `refetchInterval` only while a run is active/awaiting approval; stop when terminal. | `apps/web/src/features/runs/queries.ts` — **Agent B** (queries file only); Agent A opts the detail page in and Agent B the list |
| P1-7 | **Truncation indicators** for events (200), artifacts (20), approvals (50), attempts (10): return boolean flags from the read model and render a “showing first N” line. | `apps/web/src/features/runs/contracts.ts`, `apps/web/src/features/runs/read-model.ts` — **Agent B**; render in `_app.runs.$taskId.tsx` — **Agent A** |
| P1-8 | Virtualize or progressively reveal the event timeline and log viewer. | `apps/web/src/features/runs/components/run-timeline.tsx`, `run-log-viewer.tsx` — **Agent A** |
| P1-9 | Parallelize the three usage reads. | `apps/web/src/server/usage-read.server.ts` — **Agent E** |

### P2 — polish and product gaps

| ID | Fix | Files |
|---|---|---|
| P2-1 | Link `/workflows` from the sidebar or delete the route; builder note stays. | `apps/web/src/components/shell/nav.ts` (+ maybe `_app.workflows.tsx`) |
| P2-2 | Add run/task search to the command palette. | `apps/web/src/components/shell/command-menu.tsx`, `features/runs/queries.ts` |
| P2-3 | Implement membership invite/remove or link to the org page that does. | `_app.settings.tsx`, `features/settings/*`, `routes/organizations/*` |
| P2-4 | Reverse retry lineage (children of a task). | new repo query in `packages/db/src/repositories/` + `features/runs/read-model.ts` |
| P2-5 | Announce refetch/background state with `role="status"`. | two route files |
| P2-6 | Parsed diff stats (+/−) if product wants them; needs server-side artifact parsing. | new `features/runs/diff-summary.ts` + route |
| P2-7 | Task title — requires a schema migration and submit-form change; product decision, not a UI bug. | `packages/db/migrations`, `_app.submit.tsx`, `read-model.ts` |

### Suggested parallel split (disjoint primary files)

- **Agent A — run detail UI**: `_app.runs.$taskId.tsx`, `features/runs/components/{run-attempts,run-validation,run-timeline,run-log-viewer}.tsx`, imports `artifact-download-link` and `run-reported-truncation` components.
- **Agent B — runs read layer + list**: `features/runs/{read-model,queries,contracts}.ts`, `routes/_app.runs.tsx`, tests.
- **Agent C — artifact retrieval**: `routes/api.artifacts.$artifactId.tsx`, `server/artifacts-read.server.ts`, `packages/db/src/repositories/blob-store.ts`, `features/runs/components/artifact-download-link.tsx`, tests.
- **Agent D — inbox + integrations**: `_app.inbox.tsx`, `server/inbox-read.server.ts`, `features/inbox/{contracts,queries}.ts`, `_app.integrations.$connectorId.tsx`, tests.
- **Agent E — usage read**: `server/usage-read.server.ts`, `features/usage/usage-view.tsx`, tests.

A owns the run-detail route; B owns the runs read model; C owns the blob path; D owns inbox/integrations; E owns usage. No file is owned by two agents.

---

## 7. Unverified (needs a browser or live data)

- Actual page latency, frame rate, and the real cost of the 200-row timeline (static shape only).
- Screen-reader behavior of the refetch banners and `<details>` event payloads.
- 390 px layout, safe areas, and keyboard traversal of the mobile sheet (`app-shell.tsx:77-86`).
- Login, signup, auth callback and the organization routes were not read in depth.
- Whether `_app.integrations.$connectorId` handles an unknown connector id gracefully (not exercised).
- Landing `GradientASCII` rAF parking when the hero scrolls out of view.
- Any deployment/proxy behavior around the trace API and future blob route.
