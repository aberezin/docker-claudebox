# Design: Browser testing from claudebox

**Status:** Draft / accepted direction — not yet implemented
**Applies to:** this fork (local-build, per-project Colima VMs). See
[per-project-vm.md](per-project-vm.md) for the VM model this builds on.

## Summary

The Claude running *inside* claudebox ("claudebot") frequently spins up web
workloads (an API server, a frontend) and then needs to **drive a browser against
them** to test. Two paths, and we implement both:

- **Approach A — self-contained browser in the project VM (DEFAULT).** claudebot
  runs its own Chromium (via Playwright/Puppeteer) inside its VM, pointed at the
  workload. Isolated, reproducible, no coupling to the human's machine.
- **Approach B — drive the human's real macOS Chrome via CDP (OPT-IN).** For when
  you specifically want claudebot driving *your* actual browser (your profile,
  your session, watching live). Privileged, off by default.

Default to A; enable B per project only when you mean it.

## The boundary that forces this design

The "Claude in Chrome" automation the **host** Claude Code uses (the browser
extension + native-messaging bridge) is a **host capability** — it talks to the
host Claude over native messaging, not the network. The Claude inside claudebox is
a **separate `claude` process in a container** and cannot reach that extension. So
"have claudebot use the Claude-in-Chrome tab" is not possible; claudebot must
drive a browser it can reach over a protocol (Playwright/CDP), not the extension.

Networking direction also matters. The per-project-VM design gives **Mac → VM**
reachability (workloads browsable at the VM IP). Approach A needs *no* new
networking (browser and workload are both inside the VM). Approach B needs the
**reverse — VM → Mac** — plus a bridge to Chrome's localhost-only debug port.

```
Approach A (default): everything inside the VM
   [ project VM ]  browser(container) ── http ──> workload(container)
                        └── artifacts (screenshots/traces) -> workspace -> your Mac

Approach A2 (watch live, still no host coupling)
   headful browser + noVNC in a container ──(Mac->VM, existing networking)──> you watch at http://<vm-ip>:7900

Approach B (opt-in): drive your real Chrome
   [ project VM ] claudebot ──CDP over col0──> [Mac] 192.168.64.1:9223
                                                 └─ python forwarder ─> 127.0.0.1:9222 -> debug Chrome
```

> **Status: implemented & verified (2026-07-05).** `claudebox browser-bridge up`
> launches the debug Chrome + a dependency-free Python TCP forwarder bound to the
> Colima gateway `192.168.64.1:9223`, and injects `CLAUDEBOX_HOST_CDP_URL` into the
> container. `cb-browser cdp <url>` then drives your Chrome. End-to-end proof: a
> container in a `--network-address` VM ran `connectOverCDP(192.168.64.1:9223)` and
> navigated the Mac's Chrome to example.com. See "What shipped" below.

## Approach A — self-contained browser in the VM (default)

claudebot runs a real Chromium *inside its project VM* and drives it with
Playwright (Node is already in the full image; `npx playwright install chromium`).
The workload is a sibling container on the same VM daemon, so reaching it is
trivial. Two flavors:

### A1 — headless + artifacts (the automated-test default)

- Put the workload and the browser runner on a **shared per-project docker
  network** so they address each other by container name
  (`http://cb_A_api:8080`) — no port juggling. (Falls back to the workload's
  published port on the VM.)
- Run Playwright **headless**; save **screenshots / traces / videos to the
  workspace**. Because the workspace round-trips through virtiofs, those artifacts
  land on your Mac **owned by you** (see the ownership note in per-project-vm.md),
  so you open them in Finder/your editor.
- **Where a `cb-browser script` writes:** its script is mounted **read-only at
  `/work`** (so a test run can't mutate your source); the one writable path is
  **`/out`** (= `./cb-browser-out`, also `$CB_OUT`), and the runner's cwd is `/out`.
  So `page.screenshot({path:'shot.png'})` just works; writing to `/work` or a
  workspace path fails with `EROFS` — write to `/out` rather than dropping the
  artifact. (`cb-browser shot` already writes `/out/{screenshot.png,page.json}`.)
- This is the standard way to automate web-app testing: reproducible, isolated, no
  host dependency, safe by default.

### A2 — headful + noVNC (watch it live, no host coupling)

Containers have no display, so "watch it happen" in A1 means screenshots. When you
want to *watch live* without touching your own Chrome, run a **headful browser
container that ships a VNC/noVNC server** (e.g. the Selenium/Playwright
`*-chrome` images expose noVNC on a port). Publish that port on the VM and it's
reachable at **`http://<vm-ip>:7900`** — this **reuses the Mac→VM networking we
already built**. You open noVNC in your own browser and watch claudebot drive a
real (headful) Chromium, with zero reverse-networking and zero access to your
personal Chrome.

**A2 covers most "I want to see it" needs** and is far cheaper/safer than B.

## Approach B — drive the human's real macOS Chrome via CDP (opt-in)

Use this only when you need claudebot in **your actual Chrome** — your logged-in
profile, your extensions, your session — or to hand a live tab back to you. The
mechanism is the **Chrome DevTools Protocol**, not the extension:

1. **Launch a debug Chrome on the Mac** with `--remote-debugging-port=9222`,
   `--remote-allow-origins=*` (Chrome ≥111 otherwise 403s the CDP WebSocket
   upgrade), and a **dedicated profile** — `--user-data-dir` defaults to a clearly
   named `<state>/claudebox/cdp/chrome-debug-profile` and is tunable via
   `CLAUDEBOX_CDP_PROFILE`. Never point it at your main profile — so B carries no
   ambient logins unless you opt each one in.
2. **Bridge the debug port to the VM.** CDP binds to `127.0.0.1:9222` only (by
   design — it's total control of the browser). A tiny **dependency-free Python TCP
   forwarder** on the Mac re-exposes it on the **Colima gateway address
   `192.168.64.1:9223`** — the interface the project VM reaches over `col0`, and
   which the Mac *can* bind (unlike the vz NAT address `192.168.5.2`). It is
   **colima-only, not on your LAN**. We use Python rather than `socat` so B has no
   install prerequisite; `socat` would work identically.
3. **Connect from the container.** claudebot uses Playwright
   `chromium.connectOverCDP("http://192.168.64.1:9223")` from a `--network host`
   container, which reaches `192.168.64.1` directly over the VM's `col0` interface.
   **Note: the URL must be an IP, not a hostname** — Chrome's CDP endpoint rejects
   requests whose `Host` header isn't an IP or `localhost`.

The fork provides the host-side helper `claudebox browser-bridge up`, which
launches the dedicated debug Chrome + the Python forwarder and writes the reachable
CDP URL to a per-project marker (`~/.config/claudebox/projects/<id>/.cdp-url`); the
wrapper injects it as `CLAUDEBOX_HOST_CDP_URL` on the next `docker run`. `down`
kills both and removes the marker. All userspace — **no sudo**. (One shared bridge —
single Chrome, fixed forwarder port — serves every project, so the profile is global,
not per-id.)

**Target-reachability caveat (esp. for websocket apps).** In Approach B the browser
runs *on the Mac*, so the `<url>` you pass to `cb-browser cdp` — and every websocket
the page opens — must be reachable **from the Mac**: the project VM's IP
(`http://<vm-ip>:<port>`) or `localhost:<port>`, **not** a `cb-net` container name
like `http://api:8080` (the Mac's Chrome can't resolve those). This is the inverse of
Approach A, whose runner lives *inside* the VM on `cb-net` and addresses workloads by
name. So for a workload only reachable in-VM (or whose websocket endpoint is in-VM),
use Approach A (`shot`/`script`/`watch`); reserve B for Mac-reachable targets.

### Security (why B is opt-in)

CDP is **full control of that Chrome instance**: read cookies/localStorage,
navigate anywhere, synthesize input, exfiltrate a logged-in session. Mitigations,
all required for B:

- **Dedicated Chrome profile**, not your main one (no ambient logins unless you
  choose).
- **Scoped bind** — the Python forwarder binds only `192.168.64.1` (the Colima
  gateway the project VM reaches), **never `0.0.0.0`**, so it is not exposed on your
  LAN; torn down after the session.
- **Off unless you start it** — the bridge exists only while `browser-bridge up` is
  running; there is nothing to leak when it's down. Running the command *is* the
  opt-in, and it prints an explicit control-handover warning.

## Config / CLI surface

- **A** is the default and needs no opt-in. Ship the convention as an
  always-skill and/or a small baked-in helper so every project's Claude tests the
  same way (shared project network, headless + artifacts, or the A2 noVNC runner).
- **B** needs no config flag to stay safe: the bridge only exists while you run
  `claudebox browser-bridge up` on the Mac, and the container only sees a CDP URL
  when the marker is present. Starting the bridge is the per-session opt-in.
  ```
  claudebox browser-bridge up      # launch debug Chrome + forwarder, write marker
  # ...restart the claudebox session so the container picks up CLAUDEBOX_HOST_CDP_URL...
  cb-browser cdp https://example.com   # (inside claudebot) drive your Chrome
  claudebox browser-bridge down    # kill both, remove marker
  ```
  Overridable via env: `CLAUDEBOX_CDP_BIND` (default `192.168.64.1`),
  `CLAUDEBOX_CDP_PORT` (`9223`), `CLAUDEBOX_CHROME` (Chrome binary path).

### What shipped (B)

- Host: `wrapper.sh` — `cb_bridge_up` / `cb_bridge_down` and the `browser-bridge
  up|down` subcommand; a per-project marker at
  `~/.config/claudebox/projects/<id>/.cdp-url`; the wrapper injects
  `CLAUDEBOX_HOST_CDP_URL` into the container when the marker exists.
- Container: `cb-browser cdp <url>` — `connectOverCDP($CLAUDEBOX_HOST_CDP_URL)` on a
  `--network host` container, navigates your Chrome, drops a screenshot in the
  workspace.
- Forwarder: a ~20-line embedded Python TCP relay (`192.168.64.1:9223 →
  127.0.0.1:9222`) — no `socat`/sudo dependency.

## Responsibility split

- **claudebox (this project):** define and enforce the standard so Project-A and
  Project-B test identically — the A convention (network + Playwright + artifact
  location, or the A2 noVNC image) and the B bridge (dedicated Chrome + scoped
  Python forwarder + CDP-URL injection + the security guardrails). The boundary and
  the bridge live here, not in each project.
- **A project's Claude:** use the provided convention/helper; don't hand-roll
  ad-hoc port exposures or point CDP at `0.0.0.0`.

## Why not just share the host's Claude-in-Chrome extension?

It's wired to the host Claude via native messaging (stdio), not a network MCP, so
the container can't connect to it. Exposing "drive Chrome" to the container means
a network-reachable control surface — which is exactly CDP (Approach B). Replicating
"Claude drives a browser" *inside* the container is Playwright/Puppeteer (Approach
A), not the extension.

## Phased implementation plan

1. **A1 convention** ✅ — `cb-browser shot`/`script`: a per-project shared docker
   network (`cb-net`) for workloads + the browser runner (official Playwright image,
   runtime `npm i playwright`), addresses workloads by container name, writes
   screenshots/`page.json` to the workspace.
2. **A2 runner** ✅ — `cb-browser watch`: a headful+noVNC browser container
   (`linuxserver/chromium`), published on the VM so it's watchable at
   `http://<vm-ip>:<port>` (reuses Mac→VM networking). Verified via VNC.
3. **B bridge** ✅ — `claudebox browser-bridge up|down`: launches dedicated debug
   Chrome (`--remote-debugging-port`, dedicated `--user-data-dir`) + a **Python TCP
   forwarder** bound to `192.168.64.1:9223` (Colima gateway, not `socat`, not
   `0.0.0.0`); injects `CLAUDEBOX_HOST_CDP_URL` into the container; tears down on
   `down`. `cb-browser cdp <url>` drives your Chrome. Verified end-to-end.
4. **B security** ✅ — dedicated profile, colima-only bind, opt-in = running the
   command, explicit control-handover warning.
5. **Tests** — A1/A2/B verified manually end-to-end on throwaway `--network-address`
   VMs. TODO: fold a B smoke test into the bash suite behind the opt-in.

## Open questions

- **A: bake Playwright + Chromium into the full image** (bigger image, instant) vs
  install on first use (slower first run, smaller image)? — still open; currently
  runtime `npm i` (fast, browsers pre-cached in the image).
- **A2: which noVNC image** and default port — resolved: `linuxserver/chromium`,
  default port `3010`, overridable.
- ~~**B: exact Mac-side bind target** / CDP-URL discovery~~ — resolved: bind
  `192.168.64.1:9223` (Colima gateway, reachable from a `--network host` container
  over `col0`); discovery via `CLAUDEBOX_HOST_CDP_URL` injected from a per-project
  marker file.
- ~~**B: dedicated vs real Chrome profile**~~ — resolved: **dedicated** profile
  (`--user-data-dir`), overridable via `CLAUDEBOX_CHROME`/env if you want your real
  one.

## See also

- [per-project-vm.md](per-project-vm.md) — the VM IP / `cb-net` networking browser tests rely on.
- [convenience-scripts.md](convenience-scripts.md) — `cb-browser` and the `cb-*` convention.
- [framework-bug-reporting.md](framework-bug-reporting.md) — report harness/browser-tool friction with `cb-report-bug`.
- [environment-variables.md](../environment-variables.md) — `CLAUDEBOX_CDP_*` and related knobs.
