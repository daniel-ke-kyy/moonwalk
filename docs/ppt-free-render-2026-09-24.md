# Free Render deployment verification, 2026-09-24

Historical baseline: this report records the initial Bubblewrap probe. The later
Landlock worker passed the Linux regression suite; see `ppt-cloud-execution.md`.
The isolated test service subsequently received password-protected provider
configuration for real GPT acceptance. Production remains unchanged until that
acceptance passes. Statements below describe the original probe, not current
test-service configuration.

## Scope and status

The requested target is a free Render service with temporary PPT projects, no
computer-hosted production worker, no new page/file/concurrency limits, and the
complete native PPT-master workflow. This is **not yet production-ready**.
The production service has not been deployed or upgraded. No model credentials
or user materials were sent to the probe service.

## Actual cloud probe

Reused the existing free `moonwalk-ppt-render-verify` service, without changing its
plan or enabling auto-deploy. Probe code is on `codex/ppt-free-render-probe`,
commit `ab32a30fbd931a873f2f2ffb699530ffa70d767d`, in `ppt-render-verify/`.
It runs a non-root Python container and a fixed startup test, not arbitrary code
received over HTTP. The public endpoints expose only health and capability results.

- Deployment `dep-daqb9ch42hec739286r0` succeeded.
- User namespace: exit 0.
- Network namespace: exit 0.
- Mount namespace setup: permission denied while changing root propagation.
- Bubblewrap: `bwrap: Failed to make / slave: Permission denied`.
- Landlock ABI query: 4, errno 0. This proves API availability only, not that a
  complete safe worker or Chromium rendering works.

The initial CLI branch update returned unchanged service configuration; the first
deployment therefore built old main and failed. Subsequent deployments explicitly
selected the probe commit. Production main was never pushed or deployed.

## Implemented temporary storage groundwork

- `PPT_STORAGE_MODE=temporary` allocates a fresh private directory at each server
  start. Leave `PPT_DATA_ROOT` unset; conflicting settings fail closed.
- Graceful shutdown stops the controller before removing this temporary directory.
- Existing local persistent projects are untouched. Default persistent behavior
  remains available for local acceptance.
- API reports temporary mode and no guaranteed retention duration. The existing
  seven-day internal maximum cleanup deadline remains housekeeping, not a promise.
- UI warns about sleep/restart/deploy loss and immediate download. Keeping a tab
  open is not a durability or uninterrupted-execution guarantee.
- Missing/expired project requests stop polling, clear the stale active project,
  and display a recovery message instead of endlessly showing a loading state.
- Two confirmations, authoring, review and export code paths are unchanged.
- Production native-execution guards remain in force; temporary storage alone
  does not authorize unsandboxed execution.

## Verification

- 17 focused storage/material/model regression tests passed.
- Full regression: 92 tests, 91 passed, 0 failed, 1 opt-in live-model test skipped.
  Includes actual native intake, confirmations, isolated Chromium rendering and
  a model-free export of the previously accepted GPT five-slide sample.
- ESLint and production build passed; pre-existing large frontend chunk warning.
- Browser checked temporary warning and an invalid recovery link returning to the
  new-project form with the correct error, rather than indefinite polling.
- Impeccable targeted detector returned no findings.

## Remaining release gate

The Bubblewrap adapter cannot be used as tested. Next investigate a vetted Linux
worker using Landlock filesystem restrictions plus network/process isolation.
It must deny sibling-project and server credential reads, deny unauthorized writes
and external network access, terminate child processes on cancel, and still support
native Chromium rendering, notes, animations, review and exports. Only then run a
real GPT acceptance on the free Render test service and promote to production.
Do not remove guards, skip visual review, or assume a paid plan fixes kernel policy.
Free hosting quotas and API usage costs still apply independently.
