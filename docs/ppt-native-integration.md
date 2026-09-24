# PPT-master native integration

## Milestone 7: complete spec refinement and explicit reapproval (current)

Local-only. The unmodified native spec_review UI is mounted behind the project's
capability and a same-origin write check. Its native drafts persist across bridge
requests and restarts. Native annotations, direct-edit logs, conflict detection,
schema validation and acknowledgment receipts remain authoritative.

- Initial opt-in refine_spec now stops after complete design_spec.md / Gate 1,
  before writing or validating a lock or authoring pages.
- Existing idle projects expose full-spec review. Outstanding page annotations
  must be resolved first; they are not discarded by a redesign.
- Applying annotations uses the selected model, confines writes to the one spec,
  preserves direct edits and returns to review. It NEVER approves automatically.
- Explicit approval is bound to the exact spec SHA-256, rejects pending drafts,
  comments, unread edits and schema errors, and freezes editing. Later approvals
  are stored separately; the original result.json remains immutable.
- Native section/slide parsing determines regeneration scope. A slide-local change
  regenerates only its pages; global or structural changes regenerate the deck.
  The UI presents scope and count before approval. The approved count supersedes
  the original count for completion checks.
- Previous generation files are backed up outside the worker workspace. A durable
  reset marker prevents retries deleting newly generated output. Execution lock,
  notes, animation, validation, visual checkpoint and old exports are invalidated.
  Gate 2 derives a new lock, then the existing authoring/postprocess/review/export
  chain runs. Unresolved visual issues still block export.
- The full spec is immutable during authoring. Speaker-note and custom-animation
  choices propagate from approved native fields. Unsupported narration/split
  production is blocked. Image acquisition and template inheritance remain
  unavailable and must not be silently downgraded.

Validation: native bridge/proxy, persistent drafts, hold/conflict checks, immutable
receipts, exact-version confirmation, scoped backup/reset/retry, and first-refinement
approval boundaries are covered by specReview.test.js. A real DeepSeek run on an
isolated five-slide copy applied a slide-3 comment, passed native schema validation,
preserved all SVGs and the execution lock, and stopped for real approval. This
turn does not claim a new live-model full-deck regeneration/export run or GPT test.
Existing native export and visual-render regression tests remain enabled.

Opt-in live check: node --env-file=.env server/ppt/verifySpec.js with the same
PPT_MASTER_SKILL_ROOT, PPT_PYTHON and PPT_EXPORT_SAMPLE used by the native tests.
The verifier deletes its isolated copy and never approves a user's project.

Still required before production: isolated Linux/container worker, persistent
volume, quotas and cross-process job locking; none is implied by this local stage.

## Milestone 6: confirmed revisions and native element annotations (historical)

Local-only, enabled with the existing postprocessing runtime. Upstream PPT-master
files are unchanged. The original two planning confirmations are not reopened,
synthesized or silently replaced. No production deployment is included.

Two entry paths preserve the native distinction:

- Before the first accepted export, `review_needs_human` offers precise per-page
  correction requests. This is the native direct-request route, not early application
  of editor annotations.
- After an actual native export, the original editor supports selecting elements,
  staging/removing annotations and saving them. The bridge preserves the original
  in-memory annotation map between isolated requests and writes through the original
  `/api/save-all`. Direct editing is still disabled both in the UI and server routes.
  Saving annotations invalidates the prior downloadable artifact, but does not run AI.

Both paths collect a concrete list of instructions and require an actual click on
the website's revision confirmation. The server binds that list to the current
project fingerprint and rejects stale, cross-project and duplicate confirmations.
Pending confirmation and requests survive browser close/restart. Returning to edit
does not execute. Failed/paused revisions can be resumed or returned for adjustment.

```text
review_needs_human / complete / edits_pending
  -> awaiting_revision_confirmation
  -> preparing_revision
  -> native structural / notes / animation checks
  -> visual review (when enabled) -> native export
```

The selected model edits native `svg_output` pages; `svg_final` and individual notes
remain derived export artifacts. Allowed writes are only confirmed target pages,
`notes/total.md` and `animations.json`. An exact-once replacement tool supports local
edits without rewriting whole pages. Native SVG validation and tools still apply.
Design/spec/confirmation receipts and non-target slides cannot be changed. Requests
that change approved outline, count, image policy or design direction stop with an
explanation; a native full-spec re-planning surface is still pending.

Server-owned transactions back up targets, notes and animation state before edits.
Failure/cancellation/restart rolls back unfinished work. A committed transaction can
resume idempotently without reapplying the AI changes. Approved annotations are read
with the original checker, cleared after edits, and logged as `annotation_applied`
only on committed work. Confirmed new revision cycles reset the bounded visual-review
budget; simple retries do not. No manual visual-pass override exists.

Preview writes require the project capability, same-origin request, an idle eligible
stage and an allowlisted annotation route. Pending/running revisions are read-only.
Original learning assessments are not changed.

Live verification (2026-09-24): an isolated copy of the earlier five-slide sample was
revised using the configured DeepSeek endpoint. The missing page-3 completion criteria
became visible, notes and animation targets were updated, and all five pages passed
image review. One nonblocking visual advisory remained. Native PPTX export completed
with `passed-with-warnings`. All four untouched slides, design spec and execution lock
retained their original hashes. The real user project was not changed or auto-approved.
Earlier live attempts stopped safely on a missing page write and excessive tool
exploration; precise-write tooling and clearer output ownership were added. This does
not promise deterministic model behavior or identical PowerPoint rendering.

`server/ppt/verifyRevision.js` is an opt-in live-model verifier. It requires an existing
confirmed `PPT_EXPORT_SAMPLE`, `PPT_REVISION_PAGE` and `PPT_REVISION_INSTRUCTION`, makes
an isolated temporary copy, performs revision/review/export, then deletes the copy.
It never changes the source project. Normal automated tests do not call a paid model.

Remaining native branches include full-spec re-confirmation, direct editor controls,
new image acquisition, template inheritance, conditional chart verification, narration
and production container isolation. This is not full native execution parity yet.

Verification: 70 automated tests passed with real native intake, editor staging,
annotation parsing, isolated Chromium and original PPTX export enabled. Build/lint
passed. Browser checks covered revision proposal/return without execution, persisted
native annotations and desktop/mobile input and save controls. The native mobile shell
is adapted to scroll its annotation panel rather than clipping the save button.

## Milestone 5: image-grounded visual review and bounded repair (historical)

Local setup: run `npm run setup:ppt-visual` after planning setup, then enable
`PPT_NATIVE_VISUAL_REVIEW_ENABLED=true` with the earlier flags. Optional
`PPT_BROWSER_ROOT` defaults to `.ppt-runtime/browsers`. Python Playwright is pinned
to 1.58.0. Upstream files remain unchanged; no Render deployment is included.

The adapter starts the original live-preview app on a temporary loopback port
behind a random per-invocation URL, calls the original `visual_review.py` rendering
functions and lock, and closes the server/browser when done. PNG sizes come from
the native canvas records. Blank, oversized, incomplete or changed renders fail
closed. The renderer's macOS sandbox allows only that loopback port, browser
binaries and macOS graphics services; network access to external hosts and other
loopback ports remains denied. Tool processes receive no API keys. This is local
defense in depth, not the future production container boundary.

Before review, an image-only random challenge tests the selected endpoint/model.
No text-only fallback or provider switch is permitted. DeepSeek uses image_url
content; OpenAI uses Responses input_image with the existing configured endpoint
and reasoning effort. Schema/transport support is tested rather than inferred from
a model name. API reference inspected: https://developers.openai.com/api/docs/guides/images-vision/.
Both configured endpoints passed the challenge locally; only DeepSeek has been
tested on the actual five-slide review in this milestone.

The reviewer reads the entire original rubric, approved design and execution lock,
per-page outline, optional Style Review Focus, SVG and actual PNG. Native §IX page
headings/role fields bind page roles; missing §IX uses the documented content-page
compatibility default. Source prose and image text never expand tool permissions.
The host also requires item-by-item visible-content coverage of §IX Content.
Covered items must quote actual SVG text; notes and merely related topics do not
count. A malformed report gets one bounded correction request, not a bypass.
Ruled-out findings are separate from actual violations.

Local repairs are restricted to existing text/tspan/rect/circle position and
spacing attributes and font-size changes within 2 px (then checked against the
original role anchors). No copy, IDs, colors, font families, elements, columns or
chart structure can be altered. Other native repair types, including scrims and
missing-content recreation, are escalated rather than silently approximated.
Each page allows at most two repair rounds across retries. Every candidate is
backed up, checked by the original structural/notes/animation tools, rendered and
reviewed again. Newly introduced hard or soft issues trigger rollback. Interruption
restores unchecked candidates and retains consumed budgets. Snapshots also bind
icons, images, notes and motion; changed assets invalidate cached reports.

```text
preparing_postprocess -> preparing_visual_review
passed -> preparing_export -> complete
unresolved / outside repair permissions -> review_needs_human
model/rendering/validation failure -> failed (resume same stage)
cancel / restart -> paused (restore unchecked candidate, resume)
```

The host owns `.review/<page>.json`, per-round backups/screenshots, brand findings
and the aggregate summary. A current, complete passed report bound to source and
reviewer fingerprints is required for export/download when review is enabled.
There is no manual approval bypass. The website shows per-page findings and
suggested next actions; changing an approved plan still requires human agreement.
The native re-planning/editing UI for those changes belongs to the pending revision
integration, not an automatic content rewrite in this stage.

Live verification (2026-09-24): the original user-confirmed five-slide project
completed image review. Four pages passed; page 3 lacked the approved completion
criteria (an explicit next action and next update time). It remains
`review_needs_human`, with no downloadable final artifact and no unauthorized
content edits. Early review trials exposed contradictory non-findings and loose
content matching; protocol v3 adds explicit violation classification and grounded
coverage. Earlier protocol results are not accepted by the current export gate.
No automatic repair was needed on this final live run; bounded repair/re-render,
rollback, cancellation and strict edit permissions are exercised in tests, including
the real native edit and Chromium rendering adapters. This is not proof of perfect
AI judgment, PowerPoint animation playback or preview/export pixel identity.

Run all native tests (including isolated export and Chromium isolation checks):

```sh
PPT_MASTER_SKILL_ROOT="$PWD/.ppt-runtime/ppt-master/skills/ppt-master" \
PPT_PYTHON="$PWD/.ppt-runtime/venv/bin/python" \
PPT_BROWSER_ROOT="$PWD/.ppt-runtime/browsers" \
PPT_EXPORT_SAMPLE=/absolute/path/to/native/project \
node --test server/ppt/*.test.js server/materialWorkflow.test.js server/modelMigration.test.js
```

Still pending: stateful native annotations/revisions and re-confirmation for changed
plans, richer acquired-image/template branches, conditional chart verification,
narration and production isolation. Learning-material tests remain independent.

## Milestone 4: local notes, animations and native PPTX export (historical)

Enable `PPT_NATIVE_POSTPROCESS_ENABLED=true` alongside the planning and authoring
flags. This is still local macOS verification, not a Render release. No changes
were made to the independent learning-assessment pipeline or upstream PPT-master.

The postprocessing worker reads the actual receipt, native workflow, executor-note
and motion contracts, the design/lock, and all final SVGs. It writes grounded
`notes/total.md`, uses original animation inspection/validation, and may write the
native `animations.json`. A justified native no-op is allowed; an explicit request
must not be silently dropped. Fixed tool allowlists exclude premature export and
confirmation mutation. It retains progress in `postprocess-checkpoint.json`, with
80 model rounds per attempt and the same provider settings as SVG authoring.

```text
draft_ready -> preparing_postprocess
visual review requested -> awaiting_visual_review (preserved, NOT approved)
visual review disabled -> preparing_export -> complete
failure / cancellation -> failed / paused -> resume the interrupted stage
```

Automatic visual review/repair is NOT integrated yet. Requested review blocks
final export, even if someone writes a purported manual approval record. There is
no new manual-confirmation substitute and no bypass button. The website explains
this limitation before project creation and keeps read-only preview available.
The two original user confirmations remain unchanged and are never synthesized.

After prerequisites pass, the exporter runs the ORIGINAL commands serially:
`total_md_split.py` (if notes enabled), `finalize_svg.py`, then `svg_to_pptx.py`.
Pre-export note validation imports the upstream parser without splitting files
early. Export checks the upstream postflight schema, quality gate, ZIP and slide
count. Source fingerprints cover design, lock, SVGs, notes, icons, images and motion;
download also verifies artifact bytes and SHA. Derived per-page notes are excluded
from the source fingerprint. Explicit custom-animation disable passes `-a none`.
Requested narration audio stops export because that native branch is not connected.

`GET /projects/:id/download` requires the project's bearer capability, a completed
state, unchanged sources and a matching PPTX. It returns no-store attachment bytes,
never arbitrary paths. `nativePostprocess` exposes this partial capability;
`nativeExecution` remains false. The UI covers the new states, download errors,
collapsed motion records and preview on desktop/mobile.

Verification (2026-09-23): the actually user-confirmed five-slide DeepSeek sample
completed all five scripts and original motion configuration, with no SVG changes.
It remains `awaiting_visual_review`, as requested. A separate temporary COPY with
review disabled produced a 48,992-byte PPTX through the original exporter: five
slides, five Chinese speaker-note parts, and object-animation XML. Native postflight
passed with advisory warnings. This verifies packaging, not playback in Microsoft
PowerPoint or preview/export pixel equivalence. The source project was not approved
or marked complete by the test.

The final local run passed 41 tests with no skips (including the real export
sample), the frontend build and ESLint. Desktop and 390px mobile UI checks verified
the waiting state, motion-record disclosure, native preview navigation/reload and
no horizontal overflow. The existing homepage Three.js bundle-size advisory
remains unchanged. No live GPT postprocessing or PowerPoint playback was tested.

Optional real export regression (no model calls, isolated copy, deleted afterward):

```sh
PPT_MASTER_SKILL_ROOT="$PWD/.ppt-runtime/ppt-master/skills/ppt-master" \
PPT_PYTHON="$PWD/.ppt-runtime/venv/bin/python" \
PPT_EXPORT_SAMPLE=/absolute/path/to/a/completed/native/project \
node --test server/ppt/nativeExport.test.js
```

The sample must contain valid native planning/authoring artifacts, complete
speaker notes and a validated animation sidecar. An omitted sample skips this
optional test; it does not prove export availability. Remaining work: acquired
images and broader native material branches, conditional chart verification,
bounded visual review/repair, stateful native annotations/revisions, narration,
additional export formats and isolated persistent production workers.

## Milestone 3: local SVG authoring and read-only native preview (historical)

Opt in with `PPT_NATIVE_AUTHORING_ENABLED=true` in addition to the planning flags.
macOS only: original fixed native tools run under a deny-by-default sandbox-exec
profile. Docker/Render worker isolation remains unimplemented; production startup
still rejects the native feature. No deployment is included.

The independent provider-selected worker consumes the actual final receipt and its
server-owned digest. It reads the original PPT-master contracts, writes the native
I-X design spec and execution lock, prepares original icons, calibrates text,
authors SVG pages, and calls the original validator and final SVG quality checker.
The model cannot write receipts, quality reports, application files or other
projects; tool subprocesses receive no API credentials and cannot use the network.
Output/time limits and process-group cancellation bound each native invocation.
This is local defense in depth, not a production security certification.

Current supported authoring branch: free design with no acquired images and no
additional design-spec confirmation. Other confirmed branches stop with an explicit
reason; they are never silently converted into this branch. The complete pinned
upstream distribution is retained; its files are not edited.

```text
actual final submission (continuous) -> preparing_authoring -> draft_ready
split / previously confirmed -> planning_complete -> explicit start -> preparing_authoring
interruption -> paused -> resume persisted tool history and project files
```

`draft_ready` means only that authored pages passed native structural validation.
It does NOT mean visual approval or completed production. Notes, animations, chart
verification where applicable, visual review/repair, preview editing/annotations,
and native export remain subsequent integration work. Requested outcomes are
preserved rather than disabled. `nativeAuthoring` reports this partial capability;
`nativeExecution` remains false until the complete production route is connected.

The website embeds the original `svg_editor` live-mode page via a read-only Flask
bridge with project-scoped credentials. It does not run a replacement renderer or
expose a native listener. Mutation endpoints reject requests explicitly in this
milestone. Preview is available during authoring and after an interruption.

- `POST /projects/:id/preview-session`: obtain a scoped HttpOnly preview session.
- `/projects/:id/preview/`: original page/static assets and allowlisted read APIs.
- `POST /projects/:id/start`: also resumes authoring after final confirmation.

Model history is stored outside the writable workspace and replayed only at
completed tool-turn boundaries. Interrupted calls may incur repeat model charges.
The worker uses an 80-turn budget per attempt and 24,000 output tokens per authoring
response; planning keeps its existing budget. Capability checks fail closed.
DeepSeek authoring explicitly uses the same non-thinking request mode as the
existing learning-material service; the initial implicit-thinking trials exhausted
12,000/24,000-token responses before writing a spec. GPT continues to use the
configured reasoning effort (default medium). Neither provider silently falls back.

Automated coverage includes receipt tampering, path/symlink/hardlink protection,
SVG active-content rejection, duplicate start, cancellation, restart recovery,
private preview authorization, and real sandbox tests denying sibling reads,
receipt writes, network sockets and secret environment inheritance. Real native
tests require both runtime variables; skipped tests are not runtime verification.

Local live result (2026-09-23): the existing, actually user-confirmed five-page
DeepSeek sample reached `draft_ready`, including design spec, execution lock,
project-local Tabler icons, native preset geometry and five editable SVG pages.
Native final checker: zero blocking errors; three advisory style-normalization
warnings. Visual review is still `pending`, export readiness false. This verifies
one text-only branch, not all PPT-master capabilities or live GPT authoring.

## Milestone 2: local native planning (historical)

Implemented: homepage entry (only when native planning is enabled), independent
`/ppt` workspace, native PDF/DOCX/PPTX intake, selected-provider tool-calling planner,
two original confirmation pages and submissions, browser recovery links, pause,
phase-level retries, restart recovery and deletion of non-running projects.
Existing learning assessment logic is unchanged.

This is NOT complete PPT production. The second confirmation ends at
`planning_complete`. Authoring, image acquisition, visual review execution,
preview annotations/revisions and exports are still pending. The visual-review
checkbox only stores the requested future policy. `nativePlanning` is true when
configured; `nativeExecution` remains false. No deployment has been made.

### Runtime setup

Requires Git, Node 22+, Python 3.10+. Install the full pinned upstream distribution
and a separate Python environment, with all original attribution and assets:

```sh
PPT_BOOTSTRAP_PYTHON=/absolute/path/to/python3 npm run setup:ppt-planning
```

The installer prints `PPT_MASTER_SKILL_ROOT` and `PPT_PYTHON`; configure both along
with `PPT_PROJECTS_ENABLED=true` and `PPT_NATIVE_PLANNING_ENABLED=true` to run locally.
Runtime: `.ppt-runtime/`; project data: `.ppt-data/` or `PPT_DATA_ROOT`. Both default
directories are excluded from Git, Docker context and lint. Do not store runtime
in a temporary directory for ongoing projects: native receipts bind template roots.

The full skill is pinned to `481e057ecd9f5ff094c9c789b17b2d1331e278e8`. Startup checks
the revision, local modifications, attribution guard and intake dependencies.
PyMuPDF is AGPL-3.0 (commercial licensing also available); review obligations before
public deployment or redistribution. The installer pins direct Python dependencies,
not all transitive dependencies.

Native planning is deliberately rejected in production and binds only 127.0.0.1.
It is not a container sandbox. Public enablement still requires an isolated worker,
persistent volume, quotas, resource limits, upload throttling, abandoned-upload
cleanup and cross-process locks. Keep one API instance.

### Gates and security

```text
draft -> preparing_stage1 -> awaiting_stage1
actual native user submission -> preparing_stage2 -> awaiting_stage2
actual native final submission -> planning_complete
```

The backend calls the unmodified native Flask routes through a subprocess bridge,
rewriting only root-relative resource/API URLs. No public native-server port.
Native code validates and writes hashes and receipts; the model cannot submit
confirmation or write receipt files. The proxy allowlists routes, uses project-
scoped HttpOnly/SameSite=Strict session cookies and checks Origin on submission.
Native shutdown after final confirmation is acknowledged without killing the API.
Interrupted native submission is reconciled with website state on restart/retry.

Planning uses DeepSeek Chat Completions or OpenAI Responses with the configured
model/base URL/reasoning effort, without provider fallback. Tools read only the
original skill and current project and write only the active recommendation file.
No arbitrary shell or filesystem writes; no external research/images in this
milestone. Fixed native intake/template tools do not inherit website/API secrets.
Each stage has a 24-turn budget. Retrying an interrupted stage can incur another
model call; exactly-once billing is not promised. Waiting stages do not rerun AI.

Reads/polls do not renew the seven-day expiry. Uploads, real planning activity and
confirmations do. Active tasks must stop before deletion; startup pauses interrupted
tasks. Recovery credentials live in URL fragments, not query strings, and are
removed after import into browser storage. There is no global project-list API.

Additional authenticated routes relative to `/api/ppt`:

- `POST /projects/:id/start`: starts/retries planning, returns 202.
- `POST /projects/:id/cancel`: aborts current work and waits for it to exit.
- `POST /projects/:id/confirmation-session`: creates the private native UI session.
- `/projects/:id/native/`: original confirmation surface and allowlisted resources.

### Verification

```sh
PPT_MASTER_SKILL_ROOT="$PWD/.ppt-runtime/ppt-master/skills/ppt-master" \
PPT_PYTHON="$PWD/.ppt-runtime/venv/bin/python" \
node --test server/ppt/*.test.js server/materialWorkflow.test.js server/modelMigration.test.js
npm run build
npm run lint
```

Native integration tests use synthetic files and isolated projects, including real
native submission validation for both stages. They explicitly skip when runtime
variables are missing; a skipped test is not native-runtime validation. Provider
protocol tests are mocked. A separate real DeepSeek/browser project completed both
stages after actual browser submissions, then recovered as `planning_complete`
after a service restart. The agent did not submit either browser confirmation.
Live GPT planning has not been tested.

Next: isolated production worker and native slide authoring, followed by native
preview/revision, bounded visual repair and export. Changes to approved planning
must be reconfirmed. Preview/export fidelity investigation remains deferred.

## Milestone 1: independent project storage (historical)

Implemented: project creation, immutable model selection, private bearer recovery
token, persisted prompt and uploaded source files, restart recovery, manual draft
deletion, seven-day retention since creation or upload. Reads do not renew expiry.
State writes are atomic and mutations are serialized within one API process.
The project record is separate from `workspace/`, which will be the worker mount.

This is foundation work, not a working PPT generator. Native execution is explicitly
unavailable (HTTP 503). There is no fake progress, generated deck, confirmation
receipt, homepage entry, or public deployment in this milestone.

Local opt-in: set `PPT_PROJECTS_ENABLED=true`. Storage defaults to `.ppt-data/`.
In production `PPT_DATA_ROOT` is required and must be a mounted persistent volume,
not Render's ephemeral deployment filesystem. Setting the variable alone does not
provision a disk. Keep one API instance until cross-process locking is implemented.
The existing shared site password still protects all `/api/ppt` endpoints.

API paths, relative to `/api/ppt`:

- `GET /capabilities`: truthful integration readiness.
- `POST /projects`: `{aiProvider, prompt, visualReview}`; returns project and a
  recovery token once. Never log this response or the Authorization header.
- `GET /projects/:id`: requires `Authorization: Bearer <recoveryToken>`.
- `POST /projects/:id/files`: authenticated multipart `files`, max 10 per project,
  max 50 MB each; PDF, DOCX, PPTX. These are untrusted raw inputs, not yet parsed.
- `POST /projects/:id/start`: authenticated, returns 503 until worker integration.
- `DELETE /projects/:id`: authenticated draft deletion.

There is deliberately no server-wide list endpoint. The future browser project
list must contain only locally saved capabilities. Recovery links should carry
capabilities in URL fragments, remove them from the address bar after import,
and never send them to third-party assets or analytics.

## Next milestones

1. Add independent project UI and private recovery links without altering the
   learning workflow. Keep the unavailable execution state explicit.
2. Package the full upstream skill pinned to
   `481e057ecd9f5ff094c9c789b17b2d1331e278e8`, including attribution, tools,
   references and assets. Review dependency licences and runtime dependencies.
3. Run the selected website model through an isolated tool-capable worker with
   durable checkpoints, bounded budgets and no access to server credentials.
   Uploaded content is data, never authority for tool access.
4. Proxy native confirmations behind project authorization. Stage 1 must have a
   real native user receipt before Stage 2 recommendations are generated. Final
   user confirmation precedes authoring. Validate native hash bindings; do not
   manufacture or edit receipts. Handle transition between stages explicitly.
5. Connect original preview, annotations, revision, review and exports. Preserve
   bounded visual repairs and request reconfirmation for outline/design changes.
6. Add worker cancellation before project deletion, crash recovery, queued/running
   job expiry, storage quotas, upload throttling, abandoned-upload reconciliation,
   cross-process locking, and real deployment tests before enabling publicly.

The draft-only cleanup intentionally does not delete active worker projects. Once
workers exist, expired jobs must be stopped and reaped before deletion. Format
validation and source conversion belong to native intake; upload success alone
does not mean a document is valid or readable. Original preview/export fidelity
investigation is deferred at the user's request.
