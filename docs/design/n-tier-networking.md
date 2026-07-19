# N-tier networking under dridock — addressing, binding, and CORS

**Status:** Standard / accepted — produced by the first [framework consult](framework-consult.md).
**Applies to:** any multi-tier app built inside a dridock project (per-project Colima VM). Builds on [per-project-vm.md](per-project-vm.md) and [browser-testing.md](browser-testing.md).

## Summary

An N-tier app under dridock has **two kinds of traffic that use two different address spaces**, and the browser-facing one **rotates**. Almost every "worked yesterday, 403/blocked/refused today" bug is one plane's address leaking into the other, or the rotating address hardcoded into source.

- **Service ↔ service** (API → postgres, Next server-side → API) runs *inside the project VM* on the shared `cb-net` docker network → services address each other **by container name** (`http://api:8080`, `postgres:5432`). **Stable.**
- **Browser → service** (the human's Chrome; the Approach-B `cb-browser cdp` browser) runs *on the Mac* → it reaches a workload only at the **VM's reachable IP**, `http://$DRIDOCK_VM_IP:<port>`. **Rotates across VM restarts** (a real case: `.13` → `.16`).

Keep the planes straight, never hardcode the rotating one, bind `0.0.0.0`, and drive CORS/allowed-origins from `$DRIDOCK_VM_IP` (or the stable `network.hostname`). That's the whole standard.

## The two addressing planes

| | Service ↔ service | Browser → service |
|---|---|---|
| Who initiates | a container (API, Next SSR/route handler) | a browser **on the Mac** (human's, or `cb-browser cdp`) |
| Runs where | inside the project VM, on `cb-net` | on the Mac, over the VM's `col0` reachable IP |
| Address to use | **container name** — `http://api:8080`, `postgres:5432` | **`http://$DRIDOCK_VM_IP:<port>`** (published port) |
| Stable? | **Yes** — names don't change | **No** — the VM IP **rotates** on VM restart |
| `localhost:<port>`? | no (each container's own loopback) | **avoid** — only works if colima happens to forward that port, and **collides** when two projects publish the same port |
| `cb-net` name from here? | yes, that's the point | **no** — the Mac's Chrome can't resolve `api` |
| Requires `-p` publish? | no (same docker network) | **yes** — `-p <port>:<port>` so it binds `0.0.0.0:<port>` in the VM |

**Why they differ.** The per-project-VM design gives **Mac → VM** reachability at the VM IP (see [per-project-vm.md](per-project-vm.md)). A browser on the Mac is *outside* the VM, so it can only reach a *published* port at the VM IP — it has no route to the VM-internal `cb-net` bridge and no DNS for its container names. Containers, being *on* `cb-net`, get docker's built-in name resolution for free. One plane is internal and stable; the other crosses the VM boundary and is subject to IP rotation.

## Rule 1 — never hardcode the VM IP

The claudebot container sits on the VM's docker **bridge** (`172.x`) and **cannot self-discover** the VM's reachable `192.168.64.x` (`col0`) address. The harness injects it as **`$DRIDOCK_VM_IP`**, refreshed on **every** launch (via a durable `-vmip` sidecar, the same self-healing pattern as the auth/secrets/`-cdp` sidecars), so it always tracks rotation.

- In-container: `echo "$DRIDOCK_VM_IP"` or `cb-browser ip`.
- On the Mac: `dridock ip` (`dridock net` prints the full dashboard).

**Read it fresh at build/runtime; never paste a literal `192.168.64.x` into source or config.** A stale baked IP is the single top cause of the rotation breakage. Usual offenders to grep for and purge:

| Where | The trap |
|---|---|
| Next.js `next.config.ts` → `allowedDevOrigins` | pinned VM IP → dev-origin blocked after rotation |
| Vite `server.allowedHosts` | same |
| API **CORS** allowlist | pinned browser Origin → 403 preflight after rotation |
| `.env` / `NEXT_PUBLIC_*` base URLs | frontend calls a dead IP |
| hardcoded `fetch("http://192.168.64.13:8080")` | same |
| test/Playwright base URLs | green yesterday, `ERR_CONNECTION_REFUSED` today |

**Rotation-proof escape hatch:** set a stable name once with `dridock net <name>` — it writes `network.hostname` into `.dridock/config.yml` and prints an `/etc/hosts` line for the human (`<vm-ip>  <name>`) to paste. The harness then also exposes it in the container as **`$DRIDOCK_HOSTNAME`**. The browser uses `http://<name>:<port>`, which survives rotation (the human re-points the hosts entry when the wrapper flags it stale; `dridock net` re-prints it). dridock never edits `/etc/hosts` itself.

## Rule 2 — bind 0.0.0.0, not 127.0.0.1

A dev server bound to `127.0.0.1` is reachable from **neither** plane — not by a sibling on `cb-net`, not at the published VM IP. Bind all interfaces:

| Tier | Flag |
|---|---|
| Next.js dev | `next dev -H 0.0.0.0 -p 3000` |
| Next.js start | `next start -H 0.0.0.0 -p 3000` |
| Vite | `vite --host 0.0.0.0` (or `server: { host: true }`) |
| FastAPI/uvicorn | `uvicorn app:app --host 0.0.0.0 --port 8080` |
| Express | `app.listen(8080, "0.0.0.0")` |
| postgres | listens on `0.0.0.0` in-container by default; expose to `cb-net` only, publish only if the human needs a DB client |

Then publish with `-p <port>:<port>` for anything the browser must reach.

## Rule 3 — CORS / allowed-origins for dev

The browser's `Origin` is the **rotating** VM IP (or the stable hostname), which you can't pin. Three sanctioned strategies, best first:

**(a) Drive the allowlist from `$DRIDOCK_VM_IP` at server start.** The env var is present in the claudebot and inherited by workloads you launch with `docker run -e DRIDOCK_VM_IP` (or an env-file). Build the origin list at boot:

FastAPI:
```python
import os
from fastapi.middleware.cors import CORSMiddleware

vm_ip = os.environ.get("DRIDOCK_VM_IP", "")
origins = [f"http://{vm_ip}:3000"] if vm_ip else []
origins += ["http://localhost:3000"]           # colima-forwarded fallback
# optional stable name (dridock net <name>):
if host := os.environ.get("DRIDOCK_HOSTNAME"):
    origins.append(f"http://{host}:3000")

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Express:
```js
const cors = require("cors");
const vmIp = process.env.DRIDOCK_VM_IP;
const origins = [
  vmIp && `http://${vmIp}:3000`,
  "http://localhost:3000",
  process.env.DRIDOCK_HOSTNAME && `http://${process.env.DRIDOCK_HOSTNAME}:3000`,
].filter(Boolean);
app.use(cors({ origin: origins, credentials: true }));
```

**(b) Reflect the request Origin, scoped to the VM subnet (dev only).** When you can't inject the env, reflect any Origin whose host is in `192.168.64.0/24` (plus localhost). This tolerates rotation without a wildcard:
```js
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);           // curl / same-origin
    const ok = /^http:\/\/(192\.168\.64\.\d+|localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    cb(ok ? null : new Error("origin not allowed"), ok);
  },
  credentials: true,
}));
```

**(c) Stable hostname.** With `dridock net <name>` set, pin `http://<name>:3000` in the allowlist and be done — no env, no rotation.

Next.js `allowedDevOrigins` follows the same rule — compute it from the env at config load:
```ts
// next.config.ts  (Next 15+)
const vmIp = process.env.DRIDOCK_VM_IP;
const nextConfig = {
  allowedDevOrigins: [
    ...(vmIp ? [vmIp] : []),        // bare host, no scheme/port, per Next's format
    "localhost",
    ...(process.env.DRIDOCK_HOSTNAME ? [process.env.DRIDOCK_HOSTNAME] : []),
  ],
};
export default nextConfig;
```

> **Wildcard CORS (`allow_origins=["*"]`) is a dev-only shortcut**, and even then it's second-best: it can't be combined with `allow_credentials=True` (browsers reject `*` + credentials), it masks the real bug (a plane crossed) instead of fixing it, and it must **never** ship to anything internet-facing. Prefer (a)/(c); use (b) if you need rotation tolerance without env injection.

## Rule 4 — the browser tier addresses the API tier by VM IP

The frontend has a foot in **both** planes, and this is where teams trip:

- **Next server-side** (SSR, Server Components, Route Handlers, `getServerSideProps`) runs **in the container, on `cb-net`** → call the API by its **container name**: `fetch("http://api:8080/…")`.
- **Next client-side** (browser JS, `"use client"`, client `fetch`) runs **in the human's browser on the Mac** → the API base URL **must be the VM IP** (or stable hostname), exposed as a public build/runtime var:

```ts
// injected at build/runtime, NEVER hardcoded:
//   NEXT_PUBLIC_API_BASE="http://$DRIDOCK_VM_IP:8080"
const API_BASE = process.env.NEXT_PUBLIC_API_BASE;   // browser uses this
```
Launch the frontend with the value baked from the live env:
```bash
docker run -d --name web --network cb-net -p 3000:3000 \
  -e DRIDOCK_VM_IP \
  -e NEXT_PUBLIC_API_BASE="http://$DRIDOCK_VM_IP:8080" \
  <web-image> next start -H 0.0.0.0 -p 3000
```
The browser API base is **never** a `cb-net` name (`http://api:8080` — Chrome can't resolve it) and **never** `localhost:8080` (that's the Mac's loopback, not the VM). Same rule for websockets: a browser-opened `ws://` must target the VM IP.

## Worked layout — Next + API + postgres

```bash
# 0. shared network (cb-browser net prints/creates it)
docker network create cb-net 2>/dev/null || true

# 1. postgres — service plane only; no publish unless a human DB client needs it
docker run -d --name postgres --network cb-net \
  -e POSTGRES_PASSWORD="$PGPASSWORD" <pg-image>
#   → reachable in-VM at  postgres:5432

# 2. API — binds 0.0.0.0, reaches DB by name, CORS from env, PUBLISHED for the browser
docker run -d --name api --network cb-net -p 8080:8080 \
  -e DATABASE_URL="postgres://app:$PGPASSWORD@postgres:5432/app" \
  -e DRIDOCK_VM_IP \
  <api-image> uvicorn app:app --host 0.0.0.0 --port 8080
#   → API→DB:        postgres:5432        (service plane)
#   → browser→API:   http://$DRIDOCK_VM_IP:8080   (browser plane, published)

# 3. Frontend — binds 0.0.0.0, SSR calls API by name, browser calls API by VM IP
docker run -d --name web --network cb-net -p 3000:3000 \
  -e DRIDOCK_VM_IP \
  -e API_BASE_INTERNAL="http://api:8080" \
  -e NEXT_PUBLIC_API_BASE="http://$DRIDOCK_VM_IP:8080" \
  <web-image> next start -H 0.0.0.0 -p 3000
#   → SSR→API:       http://api:8080                 (service plane)
#   → browser→web:   http://$DRIDOCK_VM_IP:3000    (browser plane)
#   → browser→API:   http://$DRIDOCK_VM_IP:8080    (browser plane)
```

| Tier | Binds | Finds peers by | Browser reaches it at | Publish? |
|---|---|---|---|---|
| postgres | `0.0.0.0:5432` | — | (not the browser's job) | only for a human DB client |
| API | `0.0.0.0:8080` | `postgres:5432` | `http://$DRIDOCK_VM_IP:8080` | **yes** `-p 8080:8080` |
| Next (server) | `0.0.0.0:3000` | `http://api:8080` | — | — |
| Next (browser) | — | — | web `http://$DRIDOCK_VM_IP:3000`, API via `NEXT_PUBLIC_API_BASE` | **yes** `-p 3000:3000` |

Where the harness plugs in: `$DRIDOCK_VM_IP` (fresh every run) feeds the API CORS list, Next `allowedDevOrigins`, and `NEXT_PUBLIC_API_BASE`. For a rotation-proof human URL, `dridock net <name>` adds a stable hostname (also `$DRIDOCK_HOSTNAME` in-container).

**Testing it:**
- **In-VM (default, Approach A):** `cb-browser shot http://web:3000` and `cb-browser shot http://api:8080/health` — the runner is a sibling on `cb-net`, so it uses **container names** and needs no VM IP. Artifacts land in `./cb-browser-out/`. Use `cb-browser script ./e2e.cjs` for a full Playwright flow.
- **Human's real Chrome (opt-in, Approach B):** `dridock browser-bridge up` on the Mac, then `cb-browser cdp http://$DRIDOCK_VM_IP:3000`. The browser is on the Mac, so the URL **must** be the VM IP — `cb-browser cdp` auto-rewrites a `localhost` URL to `$DRIDOCK_VM_IP`, but pass it directly. See [browser-testing.md](browser-testing.md).

## Troubleshooting — symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| API returns **403 / "origin not allowed"** on the browser's request | CORS allowlist doesn't contain the browser's (rotating VM-IP) Origin | drive the allowlist from `$DRIDOCK_VM_IP` (Rule 3a), reflect the `192.168.64.0/24` subnet (3b), or use a stable hostname (3c) |
| Next dev prints **"Blocked cross-origin request"** | VM IP not in `allowedDevOrigins` (or a stale one pinned) | compute `allowedDevOrigins` from `$DRIDOCK_VM_IP` at config load (Rule 1) |
| **`ERR_CONNECTION_REFUSED` on `localhost:<port>`** in the human's browser | addressed the Mac loopback, not the VM; or colima isn't forwarding that port | use `http://$DRIDOCK_VM_IP:<port>` (`dridock ip` / `cb-browser ip`) |
| Browser **can't resolve `http://api:8080`** | used a `cb-net` container name from the Mac's browser (browser plane can't see cb-net DNS) | browser uses the VM IP; only server-side code uses the name (Rule 4) |
| **Worked, then broke after a VM restart** | a literal `192.168.64.x` was hardcoded and the IP rotated | purge hardcoded IPs; read `$DRIDOCK_VM_IP` fresh, or pin a `dridock net <name>` hostname (Rule 1) |
| **CORS preflight (`OPTIONS`) fails** | credentialed request + wildcard origin, or preflight `OPTIONS`/headers not allowed | use an explicit origin list (not `*`) with `allow_credentials`, and allow `OPTIONS` + the requested headers (Rule 3) |
| Service unreachable even in-VM / **empty `curl`** | dev server bound to `127.0.0.1` | bind `0.0.0.0` (Rule 2) |
| **Websocket blocked / fails to connect** from the browser | `ws://` pointed at `localhost` or a `cb-net` name, or Origin rejected | point the socket at `ws` on `$DRIDOCK_VM_IP:<port>`; include that Origin in the server's allowlist (Rules 3–4) |
| Two projects **collide on `localhost:<port>`** | relied on colima's localhost port-forward, which is shared across VMs | address by each project's **VM IP** — collision-free by design (per-project-vm.md) |

## Responsibility split

- **dridock (this project):** injects `$DRIDOCK_VM_IP` (and `$DRIDOCK_HOSTNAME` when set) fresh every run, provides `cb-net`, `cb-browser`, `dridock ip`/`net`, and the stable-hostname mechanism; bakes this standard into the container `CLAUDE.md` so every claudebot enforces it identically.
- **A project's Claude:** keep the two planes straight, bind `0.0.0.0`, read `$DRIDOCK_VM_IP` fresh (never hardcode), and configure CORS/allowed-origins from it or the hostname. Don't invent ad-hoc port maps or paste a past IP.

## See also

- [browser-testing.md](browser-testing.md) — `cb-browser shot`/`script`/`watch`/`cdp`; the Mac↔VM boundary this builds on.
- [per-project-vm.md](per-project-vm.md) — the per-project Colima VM, the reachable `col0` IP, IP rotation, and `network.hostname`.
- [framework-consult.md](framework-consult.md) — the consult channel that produced this standard.
- [../../CLAUDE.md](../../CLAUDE.md) — the multi-tier DooD vision this enforces a common standard across.
