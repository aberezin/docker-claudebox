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
