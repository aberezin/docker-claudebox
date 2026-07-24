/**
 * A narrow subset of the `docker` CLI dridock actually shells out to when
 * running the claudebot. Split from `Docker.ts` (which only knows about
 * image labels) so unit tests can inject a fake without also mocking the
 * label surface. Real impl uses Bun.spawn.
 *
 * Kept small on purpose: `runInteractive`, `startAttached`, `stop`,
 * `psFilter`, `execDetached`. Every method aligns 1:1 with the `docker`
 * commands wrapper.sh assembles at container launch time (wrapper.sh
 * lines 2830-3050ish).
 */

/** Common shape for the two "spawn a container that inherits our TTY" paths. */
export interface RunArgs {
  readonly context: string;
  readonly containerName: string;
  readonly image: string;
  readonly mounts: readonly { host: string; container: string; ro?: boolean }[];
  readonly envFile?: string;
  /** Env pairs, listed on the command line as `-e KEY=VALUE`. */
  readonly env: readonly { readonly key: string; readonly value: string }[];
  readonly workdir?: string;
  readonly network?: string;
  /**
   * Three run shapes bash uses:
   *   - "interactive": `-it`, allocates a TTY. Foreground. USE ONLY when
   *     stdin is a real terminal — docker refuses `-i` on a non-TTY stdin
   *     with `cannot attach stdin to a TTY-enabled container`. Interactive
   *     claudebot only.
   *   - "attached":    neither `-it` nor `-d`. Foreground, stdout/stderr
   *     piped through, no TTY. THIS is what wrapper.sh:3288 uses for `-p`
   *     mode so scripts/CI/pipes work. Arfy #38 part 3 caught the port
   *     using "interactive" here — hard rc-1 failure in any non-TTY
   *     context.
   *   - "detached":    `-d`, returns immediately. Cron mode.
   */
  readonly mode: "interactive" | "attached" | "detached";
  /** Command + args to run inside the container. */
  readonly cmd: readonly string[];
  /** Extra `-p HOST:CONTAINER` port publishes. */
  readonly publishPorts: readonly string[];
  /**
   * Optional `--tmpfs MOUNT:OPTS` — the DRIDOCK_TMPFS_TMP opt-in for
   * RAM-backing /tmp so docker bloat can't ENOSPC-kill the Bash tool.
   * See docs/design/disk-management.md.
   */
  readonly tmpfs?: readonly string[];
  /**
   * Optional `--entrypoint <bin>` — overrides the image's ENTRYPOINT so
   * the container runs `<bin> <cmd...>` directly, bypassing entrypoint.sh.
   * Used by the `mcp` / `auth` project passthroughs (bash: wrapper.sh:3128)
   * — those need to run `claude <verb>` directly against the mounted
   * project state, not through the entrypoint's sidecar-reading dance.
   *
   * BEWARE: bypassing entrypoint.sh means HOME isn't set to
   * /home/claude and the user is root. Callers must set
   * `-e HOME=/home/claude -e CLAUDE_CONFIG_DIR=/home/claude/.claude`
   * explicitly (see #39 root cause). Without those, `claude mcp add`
   * writes to /root/.claude.json — outside the mount + ephemeral with
   * --rm.
   */
  readonly entrypoint?: string;
  /**
   * Optional `--rm` — remove the container automatically on exit. Used
   * with `entrypoint` for the throwaway passthroughs so nothing
   * accumulates on the docker daemon per invocation.
   */
  readonly removeAfter?: boolean;
}

export interface PsRow {
  readonly name: string;
  readonly status: string; // e.g. "Up 3 minutes", "Exited (0) 2 hours ago"
  readonly image: string;
}

export interface ContainerRuntime {
  /**
   * Spin up a container with a fresh docker run. Returns the exit code of
   * the process — bash uses this to propagate the container's rc back to
   * the user. For `-it`, the calling process's stdio is inherited.
   */
  runInteractive(args: RunArgs): Promise<number>;

  /** `docker start -ai` — reattach to an existing stopped container. */
  startAttached(context: string, containerName: string): Promise<number>;

  /** `docker start <name>` (NO `-a`) — resurrect an existing detached
   *  container (e.g. cron daemon) and return once it's up. Distinct from
   *  `startAttached` (interactive claudebot) because a detached container
   *  must not tie the calling shell to its stdio — matches bash's
   *  wrapper.sh:3105 `"${DOCKER[@]}" start "$cron_name"` (no `-ai`). */
  startBackground(context: string, containerName: string): Promise<number>;

  /** `docker stop <name>` — SIGTERM then SIGKILL. Ignores "not found". */
  stop(context: string, containerName: string): Promise<void>;

  /** `docker ps --filter name=^<name>$ --format '{{.Names}}\t{{.Status}}\t{{.Image}}'`. */
  psFilter(context: string, nameExact: string): Promise<PsRow | undefined>;

  /** Detached exec inside a running container. Returns rc; stdout+stderr streamed. */
  execDetached(context: string, containerName: string, cmd: readonly string[]): Promise<number>;
}

export class RealContainerRuntime implements ContainerRuntime {
  async runInteractive(args: RunArgs): Promise<number> {
    const argv = buildRunArgv(args);
    const proc = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  }

  async startAttached(context: string, containerName: string): Promise<number> {
    const proc = Bun.spawn(["docker", "--context", context, "start", "-ai", containerName], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  }

  async startBackground(context: string, containerName: string): Promise<number> {
    // `docker start <name>` (no `-a`) prints the container name and
    // returns as soon as the daemon accepts the start — the container
    // keeps running detached. Used by the cron dispatch to resurrect
    // an existing `_cron` container.
    const proc = Bun.spawn(["docker", "--context", context, "start", containerName], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  }

  async stop(context: string, containerName: string): Promise<void> {
    const proc = Bun.spawn(["docker", "--context", context, "stop", containerName], {
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited; // rc ignored — "not found" is fine
  }

  async psFilter(context: string, nameExact: string): Promise<PsRow | undefined> {
    const proc = Bun.spawn([
      "docker", "--context", context, "ps", "-a",
      "--filter", `name=^${nameExact}$`,
      "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}",
    ], { stdout: "pipe", stderr: "ignore" });
    const text = (await new Response(proc.stdout).text()).trim();
    if (text === "") return undefined;
    const [name, status, image] = text.split("\t");
    return { name: name ?? "", status: status ?? "", image: image ?? "" };
  }

  async execDetached(context: string, containerName: string, cmd: readonly string[]): Promise<number> {
    const proc = Bun.spawn(["docker", "--context", context, "exec", containerName, ...cmd], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  }
}

/** Build the `docker run ...` argv from RunArgs. Exposed so unit tests can
 *  assert the exact command line without spawning docker. */
export function buildRunArgv(args: RunArgs): string[] {
  const argv: string[] = ["docker", "--context", args.context, "run"];
  argv.push("--name", args.containerName);
  if (args.removeAfter === true) argv.push("--rm");
  switch (args.mode) {
    case "interactive": argv.push("-it"); break;
    case "detached":    argv.push("-d");  break;
    case "attached":    break; // no -i / -t / -d — foreground, no TTY. See RunArgs.mode comment.
  }
  if (args.entrypoint !== undefined) argv.push("--entrypoint", args.entrypoint);
  if (args.network !== undefined) argv.push("--network", args.network);
  if (args.workdir !== undefined) argv.push("-w", args.workdir);
  if (args.envFile !== undefined) argv.push("--env-file", args.envFile);
  for (const e of args.env) argv.push("-e", `${e.key}=${e.value}`);
  for (const m of args.mounts) {
    const spec = m.ro === true
      ? `${m.host}:${m.container}:ro`
      : `${m.host}:${m.container}`;
    argv.push("-v", spec);
  }
  for (const p of args.publishPorts) argv.push("-p", p);
  for (const t of args.tmpfs ?? []) argv.push("--tmpfs", t);
  argv.push(args.image);
  argv.push(...args.cmd);
  return argv;
}
