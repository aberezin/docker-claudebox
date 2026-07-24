// Single source of truth for the TS wrapper's version. Kept in lockstep with
// the repo-root VERSION file and wrapper.sh's DRIDOCK_VERSION — the existing
// tests/test_cbvm.sh sync assertion covers wrapper.sh↔VERSION; a Phase-5
// script will extend that check to this file too. Until then: bump this by
// hand alongside VERSION and wrapper.sh on every release.
//
// (Bun supports `import versionText from "../../VERSION" with { type: "text" }`
// which would be nicer, but during the compiled-binary build the relative
// resolution differs and the shape is fussy. Sticking with an explicit
// constant until Phase 5 introduces a build script that inlines VERSION.)
export const DRIDOCK_TS_VERSION = "3.3.7";

/**
 * Minimum claude CLI version that recognizes `--remote-control` (aka
 * `--rc`). Older CLIs silently ignore unknown flags (exit 0), so a
 * `dridock start --remote-control` against a stale image starts a
 * normal session with RC dead + no signal. Ports wrapper.sh:27's
 * CB_CLAUDE_CLI_FLOOR — kept in one place so a floor bump touches
 * one line, not two (host wrapper + this).
 *
 * Read by StartCommand.checkRemoteControlFloor + rendered in
 * checkversion + info. (#17 was the incident that added this class of
 * guard.)
 */
export const CLAUDE_CLI_REMOTE_CONTROL_FLOOR = "2.1.206";
