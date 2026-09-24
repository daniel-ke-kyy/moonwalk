# PPT Cloud Execution

## Browser and server boundaries

Windows, Linux and macOS clients use the same HTTPS website. Uploads, native
confirmations, full-spec review, preview, annotations, revisions and downloads
use same-origin HTTP endpoints. Clients do not install Python, PPT-master,
Chromium, Docker or a local agent. Backend OS checks select the server sandbox,
not a client capability or an OS-dependent product tier.

The intended browser baseline is current Chrome, Edge, Firefox and Safari.
Architecture compatibility is not a claim of physical-device testing on every
OS/browser pair. Native Office applications may render downloaded PPTX fonts
differently; the website's preview is rendered on the server.

## Linux isolation

- Build `server/ppt/linuxSandbox` against pinned Go-Landlock and Elastic seccomp
  libraries. The helper is compiled from source with module checksums.
- The website launches the helper with UID/GID 65534, without model credentials.
- Each invocation creates new user, PID and network namespaces. No privileged
  container, mount capability, host socket or paid worker is required.
- Landlock ABI 4 is mandatory, never best-effort. Only pinned runtime/system
  resources and the current workspace are readable. Network access has no routes
  outside its namespace; TCP is restricted to the renderer's one loopback port.
- The server owns protected inputs and confirmation directories. Sticky project
  roots permit native atomic staging without letting workers replace protected
  entries. The worker cannot read server-owned state or host process credentials.
- Capabilities are dropped. Seccomp blocks ptrace, process memory access,
  namespace transitions and selected privileged interfaces. Pathname UNIX socket
  creation is denied because Landlock ABI 4 alone cannot restrict it; socketpair
  remains available for local IPC.
- Workspace filesystem operations are serialized within a project, not globally.
  This prevents preview requests racing permission setup and native writes.
- The supervisor tears down namespace PID 1 on cancellation, including detached
  descendants. A private control pipe avoids host cross-UID signal restrictions
  and also detects web-process death. Tool output and existing tool timeouts
  remain bounded.
- Cloud startup runs actual allow/deny checks. Failed checks stop startup;
  execution never silently falls back to an unsandboxed process.

The web server itself still runs as container root so it can manage protected
project ownership and spawn the distinct worker identity. This is not a privileged
host container. The worker never receives the server identity or API keys.

## Deployment

Use the repository Dockerfile, with the native PPT-master revision pinned in
`server/ppt/nativeRevision.js`. In a verified Linux deployment enable:

```dotenv
PPT_PROJECTS_ENABLED=true
PPT_STORAGE_MODE=temporary
PPT_CLOUD_EXECUTION_ENABLED=true
PPT_NATIVE_PLANNING_ENABLED=true
PPT_NATIVE_AUTHORING_ENABLED=true
PPT_NATIVE_POSTPROCESS_ENABLED=true
PPT_NATIVE_VISUAL_REVIEW_ENABLED=true
```

Leave `PPT_DATA_ROOT` unset in temporary mode. Runtime paths are provided by the
image. Keep `NODE_ENV=production` and the existing site password/provider settings.
Do not publish provider keys in source, build arguments, logs or browser bundles.

Temporary projects are not durable. Sleep, restart or deployment can remove them.
Open tabs and status polling are not a durability guarantee. Download completed
results promptly. No new page/file/concurrency quota is introduced, but free
hosting still has finite memory, CPU and monthly usage; model API costs are separate.

## Release gate

The dedicated `cloudProbe.js` entry point is for the isolated test service only.
It runs no-model native regression and is not mounted by the production server.
Real GPT end-to-end acceptance must additionally cover actual browser submissions
at both native confirmation stages, visible preview, review, revision and PPTX
download. Never auto-confirm a user's real project or skip a failing review.

## Verification on 2026-09-24

Dedicated free Render service, commit `4f564ced0d97992d994cdbdf45437845f3686106`:
90 tests, 80 passed, zero failed, 10 skipped (live-model/fixture opt-ins).
Actual Linux checks include native PDF/DOCX/PPTX intake, two-stage confirmation,
preview annotations, Chromium nonblank rendering, credential/receipt isolation,
network denial and cancellation of detached descendants. Duration: 170 seconds.

Local macOS regression including live-poll coalescing: 95 tests, 92 passed, zero failed, 3 skipped (Linux-only
checks and opt-in live-model review). Isolated native export produced five
editable slides, five Chinese notes and animation XML. This local result is not
a substitute for cloud GPT end-to-end acceptance, which remains a release gate.
