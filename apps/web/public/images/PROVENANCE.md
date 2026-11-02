# Image provenance

These images are shipping marketing assets. They are screenshots of the actual
Isolate UI rendered with **synthetic** data, not live tenant data.

| File | Source | Capture |
|---|---|---|
| `dashboard-overview.png` | Temporary `/dashboard-preview` route rendering the real wave-23 Home composition: `PageHeader`, `SetupChecklist` (when setup is incomplete), the four-metric `MetricStrip`, `NeedsYouSection` with `ApprovalRows`, `RunningNowSection`, `HomeInboxPreview` and `HomeSourcesSection`, inside the app-shell chrome | 1600×1200 CSS px at device scale 1, 2026-11-02 |
| `dashboard-active-runs.png` | Clip of the `Running now` section (`RunningNowSection`) from the same preview, with 20px of page background around the section so the heading is not clipped | 817×330 CSS px at device scale 2 (1634×660 px) |
| `dashboard-approvals.png` | Clip of the `Needs you` section (`NeedsYouSection`, approvals group) from the same preview, with 20px of page background around the section | 526×330 CSS px at device scale 2 (1052×660 px) |

The preview route is public and renders from static synthetic data: no session,
database read or live provider call is involved. The app shell normally needs a
session for its organization and user menus, so the preview reproduces that
chrome faithfully with the real brand mark and navigation groups. The overview
capture uses a completed setup state so the operational Home is visible; the
same preview renders the real `SetupChecklist` at `?setup=incomplete`.

Synthetic identities and records: organization "Demo workspace", repository
"ivory-26/agent-bank", synthetic task ids, approvals, event deliveries, relays
and connector metadata. Running rows carry only the supported autonomy labels
A2 and A3; A0 records an event without creating a task, A1 investigate is
unsupported, and A4 production mutation is out of scope, so none of those labels
appears in Running now. No real user, repository secret, token, or provider
credential appears in these images. The preview route is removed after capture;
the images are illustrative product views with synthetic data. The landing page
treats them as decorative images (no visible alt text); this provenance file is
the disclosure of their synthetic source.

The dashboard shell in the screenshot reflects the product UI at capture time;
small styling refinements after capture do not change the represented features.
