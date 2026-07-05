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
   [ project VM ] claudebot ──CDP──> [Mac] socat bridge -> 127.0.0.1:9222 -> your Chrome
```

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

1. **Launch a debug Chrome on the Mac** with `--remote-debugging-port=9222` — and,
   for safety, a **dedicated profile** (`--user-data-dir=<temp>`) rather than your
   main one.
2. **Bridge the debug port to the VM.** CDP binds to `127.0.0.1:9222` only (by
   design — it's total control of the browser). A small **`socat` (or SSH) forward
   on the Mac** exposes it *only* on the Colima network interface the project VM
   can reach — never `0.0.0.0`:
   `socat TCP-LISTEN:9222,bind=<mac-colima-iface-ip>,reuseaddr,fork TCP:127.0.0.1:9222`
3. **Connect from the container.** claudebot uses Playwright/Puppeteer
   `chromium.connectOverCDP("http://<mac-reachable-addr>:9222")` and drives tabs.
   Under Colima the container reaches the Mac via `host.docker.internal` / the
   gateway (`gatewayAddress: 192.168.5.2` in the profile config).

The fork provides a host-side helper (e.g. `claudebox browser-bridge up`) that
launches the dedicated debug Chrome + the scoped `socat` tunnel and injects the
reachable CDP URL into the container (e.g. `CLAUDEBOX_HOST_CDP_URL`); `down` tears
it all down. All userspace — **no sudo**.

### Security (why B is opt-in)

CDP is **full control of that Chrome instance**: read cookies/localStorage,
navigate anywhere, synthesize input, exfiltrate a logged-in session. Mitigations,
all required for B:

- **Dedicated Chrome profile**, not your main one (no ambient logins unless you
  choose).
- **Scoped bind** — the `socat` listener binds only the specific Colima interface
  the project VM uses, never `0.0.0.0`; torn down after the session.
- **Off by default**, enabled per project via config, with an explicit warning.

## Config / CLI surface

- **A** is the default and needs no opt-in. Ship the convention as an
  always-skill and/or a small baked-in helper so every project's Claude tests the
  same way (shared project network, headless + artifacts, or the A2 noVNC runner).
- **B** is gated in `.claudebox/config.yml`:
  ```yaml
  browser:
    host_cdp: false        # opt in per project; drives your real Chrome via CDP
  ```
  and driven by a host command: `claudebox browser-bridge up|down`.

## Responsibility split

- **claudebox (this project):** define and enforce the standard so Project-A and
  Project-B test identically — the A convention (network + Playwright + artifact
  location, or the A2 noVNC image) and the B bridge (dedicated Chrome + scoped
  `socat` + CDP-URL injection + the security guardrails). The boundary and the
  bridge live here, not in each project.
- **A project's Claude:** use the provided convention/helper; don't hand-roll
  ad-hoc port exposures or point CDP at `0.0.0.0`.

## Why not just share the host's Claude-in-Chrome extension?

It's wired to the host Claude via native messaging (stdio), not a network MCP, so
the container can't connect to it. Exposing "drive Chrome" to the container means
a network-reachable control surface — which is exactly CDP (Approach B). Replicating
"Claude drives a browser" *inside* the container is Playwright/Puppeteer (Approach
A), not the extension.

## Phased implementation plan

1. **A1 convention** — a per-project shared docker network for workloads + the
   browser runner; an always-skill (or baked helper) documenting: install/run
   Playwright headless, address workloads by container name, write
   screenshots/traces to the workspace. Optionally bake Playwright+Chromium into
   the full image to avoid first-run install cost.
2. **A2 runner** — a standard headful+noVNC browser container recipe, published on
   the VM so it's watchable at `http://<vm-ip>:<port>` (reuses Mac→VM networking).
3. **B bridge** — `claudebox browser-bridge up|down`: launch dedicated debug
   Chrome (`--remote-debugging-port`, temp `--user-data-dir`) + scoped `socat`
   tunnel on the Mac's Colima interface; inject `CLAUDEBOX_HOST_CDP_URL` into the
   container; tear down on `down`.
4. **B gate + docs** — `.claudebox/config.yml → browser.host_cdp`, security
   warnings, and a note that this is the privileged path.
5. **Tests** — A1 end-to-end (spin a trivial server workload, drive it headless,
   assert on a screenshot/DOM); B smoke test behind the opt-in.

## Open questions

- **A: bake Playwright + Chromium into the full image** (bigger image, instant) vs
  install on first use (slower first run, smaller image)?
- **A2: which noVNC image** and default port; is one standard recipe enough or do
  projects need to choose the browser?
- **B: exact Mac-side bind target** — the Colima gateway IP vs a dedicated vmnet
  interface — and how claudebot discovers the CDP URL (env var vs a well-known
  file in the workspace).
- **B: dedicated vs real Chrome profile** — dedicated is safer; a real profile is
  more realistic (your logins/extensions). Default dedicated, allow override?
