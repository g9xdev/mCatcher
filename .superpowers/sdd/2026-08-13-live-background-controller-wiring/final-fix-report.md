# Final live-slice fix report

## RED evidence

- `node --test media-catcher/tests/background-live-actions.test.js` initially reported 5 passed / 1 failed. The no-ID legacy-shaped direct Download action returned `ok: true` where the public contract required `false` (`background-live-actions.test.js:282`), proving the dispatcher entered the legacy direct path.
- After tightening the same public case to every no-ID managed kind, the focused action run again reported 5 passed / 1 failed. A no-ID live HLS ordinary Download action returned `ok: true` (`background-live-actions.test.js:294`), proving HLS/DASH also needed the shared managed-media guard. The separate `record-live` message path was not changed.
- Before the production change, the corrected real-module integration scenario passed while the causal action test remained RED: 6 passed / 1 failed.

## Files and commit

- `media-catcher/background.js`: reject no-ID `direct`, `hls`, and `dash` ordinary Download actions before all legacy saving.
- `media-catcher/tests/background-live-actions.test.js`: causal public regression coverage for visible failure and zero controller, native, Firefox/downloads, fetch/save, or job effects.
- `media-catcher/tests/background-live-integration.test.js`: real manifest-loaded background/controller/scheduler/assembler/native-sink public scenario, including opaque HLS media/variant identity, popup dispatch, sink completion, privacy sentinels, and capacity-two independent-provider admission.
- `.superpowers/sdd/2026-08-13-live-background-controller-wiring/final-fix-report.md`: this report.
- Commit subject: `fix: keep live downloads on the policy controller`.

## Verification

- `node --test media-catcher/tests/background-live-actions.test.js media-catcher/tests/background-live-integration.test.js` — 7 passed, 0 failed.
- `node --test media-catcher/tests/background-live-bootstrap.test.js media-catcher/tests/background-live-detection.test.js media-catcher/tests/background-adapters-hls-sink.test.js media-catcher/tests/background-firefox-handoff.test.js media-catcher/tests/popup-intent.test.js` — 56 passed, 0 failed.
- `node --test media-catcher/tests/*.test.js` — 666 passed, 0 failed.
- `node --check media-catcher/background.js` — exit 0.
- `node --check media-catcher/tests/background-live-actions.test.js` — exit 0.
- `node --check media-catcher/tests/background-live-integration.test.js` — exit 0.
- `git diff --check` — exit 0.

## Self-review

- Production scope is one dispatcher predicate: owned opaque rows still route to the real controller; every no-ID direct/HLS/DASH ordinary Download fails visibly; YouTube and all other message branches are unchanged.
- The live integration loads the real manifest modules and background ownership. It does not fake the controller, scheduler, assembler, Privacy, Router, FirefoxGuard, or FileSinkProtocol.
- Public JSON assertions cover media, jobs, broadcasts/messages, action responses, and history, and reject manifest/variant/segment URLs, cookies, Authorization, signed query values, assembled bytes, sink ID, attempt token, native path/handle, destination secret, and action proofs.
- The integration proves the first HLS job remains active while a differently keyed provider/media job is admitted at capacity two.
- Independent read-only final review reported no findings.

## Concerns

None.
