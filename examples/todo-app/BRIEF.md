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

## How to run it (CRITICAL — must be reachable from the Mac's browser)
You run inside a container with the Docker socket mounted (docker-out-of-docker)
against this project's Colima VM, which has a host-reachable IP.
- Package the app as a SELF-CONTAINED Docker image: a Dockerfile that COPYs the
  source in, installs deps, builds, and CMD-runs the server. Do NOT bind-mount the
  code with `-v` — the workspace path is NOT visible to the VM daemon, so a volume
  mount would fail. COPY the code into the image instead.
- Run it DETACHED and PUBLISHED so it outlives this session and is reachable:
      docker build -t todo-app .
      docker run -d --name todo-app --restart unless-stopped -p 3000:3000 todo-app
- Verify from inside your container:
      curl -s http://localhost:3000/api/todos     # -> JSON, e.g. []
      curl -s http://localhost:3000/ | head        # -> HTML
- LEAVE THE CONTAINER RUNNING. Do not stop or remove it.

## Rules
- Work FULLY AUTONOMOUSLY. Do not ask any questions. You have yolo
  (--dangerously-skip-permissions).
- When finished, update the "## Progress / handoff log" section of
  .claudebox/BRIEF.md with what you built, the container name (todo-app), the port
  (3000), and how to hit it. Then print a final line starting "DONE:" summarizing it.
