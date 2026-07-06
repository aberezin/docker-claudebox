Build a minimal TODO web app and leave it RUNNING as a published container so the
human can test it from their Mac's Chrome.

## What to build
- Node.js + TypeScript, a single app server. NO external database — use an in-memory
  store (array/Map); data resets on restart, that's fine.
- A minimal but working web UI at `GET /` — an HTML page to add a todo, list todos,
  toggle done, and delete, using a tiny inline fetch() script. No framework needed.
- JSON API:
  - GET    /api/todos            -> list all
  - POST   /api/todos {title}    -> create
  - PATCH  /api/todos/:id {done} -> set done true/false
  - DELETE /api/todos/:id        -> delete
- Listen on 0.0.0.0:3000. Minimal deps (express is fine). Compile with tsc or run
  via tsx — your call. Keep it simple and working over elaborate.

## How to run it
- Run the app as a container named `todo-app` on port 3000, and LEAVE IT RUNNING so
  the human can reach it from their Mac's browser. Follow the "Orchestrating &
  exposing workloads" section of your CLAUDE.md for how to publish a workload
  reachably (self-contained image, published + detached). Do not stop or remove it.

## Rules
- Work FULLY AUTONOMOUSLY. Do not ask any questions. You have yolo
  (--dangerously-skip-permissions).
- When finished, update the "## Progress / handoff log" section of
  .claudebox/BRIEF.md with what you built, the container name (todo-app), the port
  (3000), and how to hit it. Then print a final line starting "DONE:" summarizing it.
