import { test, expect, describe } from "bun:test";
import { AdoptionService } from "./AdoptionService.ts";
import { InMemoryDocker } from "../test/fakes/InMemoryDocker.ts";
import { InMemoryFileSystem } from "../test/fakes/InMemoryFileSystem.ts";
import { sameBindsOf } from "../infra/Docker.ts";

const CTX = "colima-cb-69adc719";
const ROOT = "/Users/a/dev/myproj";
const DATA = "/Users/a/.config/dridock/projects/69adc719/dot/.claude";
const IDENT = { name: "myproj", id: "69adc719" };
const LEGACY = "claude-_Users_a_dev_myproj";

function setup(): { svc: AdoptionService; docker: InMemoryDocker; fs: InMemoryFileSystem; run: () => ReturnType<AdoptionService["adopt"]> } {
  const docker = new InMemoryDocker();
  const fs = new InMemoryFileSystem();
  fs.seedDir(ROOT);
  fs.seedDir(DATA);
  const svc = new AdoptionService(docker, fs);
  return { svc, docker, fs, run: () => svc.adopt({ context: CTX, root: ROOT, ident: IDENT, dataDir: DATA, binName: "dridock" }) };
}

describe("AdoptionService — pre-6.0 containers (#123)", () => {
  test("nothing in the VM → ok, no changes", async () => {
    const { docker, run } = setup();
    expect(await run()).toEqual({ kind: "ok", notes: [] });
    expect(docker.removals).toEqual([]);
  });

  test("a STOPPED legacy container at this root is adopted by recreate: removed, named", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "exited", sameBinds: [ROOT] });
    const r = await run();
    expect(r.kind).toBe("ok");
    expect(docker.removals).toEqual([{ context: CTX, name: LEGACY }]);
    if (r.kind === "ok") expect(r.notes.join("")).toContain(`adopting ${LEGACY} → claude-myproj-69adc719`);
  });

  test("all three roles map to their own new names", async () => {
    const { docker, run } = setup();
    for (const suf of ["", "_prog", "_cron"]) {
      docker.seedContainerSummary(CTX, { name: `${LEGACY}${suf}`, state: "exited", sameBinds: [ROOT] });
    }
    const r = await run();
    expect(docker.removals.map((x) => x.name).sort()).toEqual([LEGACY, `${LEGACY}_cron`, `${LEGACY}_prog`]);
    if (r.kind === "ok") {
      const n = r.notes.join("");
      expect(n).toContain("→ claude-myproj-69adc719_prog");
      expect(n).toContain("→ claude-myproj-69adc719_cron");
    }
  });

  test("a RUNNING legacy container is never touched: deferred, this run keeps the legacy name", async () => {
    const { docker, fs, run } = setup();
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "running", sameBinds: [ROOT] });
    docker.seedContainerSummary(CTX, { name: `${LEGACY}_cron`, state: "exited", sameBinds: [ROOT] });
    fs.seed(`${DATA}/.${LEGACY}-secrets`, "GH_TOKEN=x\n");
    const r = await run();
    expect(r.kind).toBe("deferred");
    if (r.kind === "deferred") {
      expect(r.legacyBase).toBe(LEGACY);
      expect(r.notes.join("")).toContain("dridock down");
    }
    // Nothing removed, not even the stopped sibling, and the sidecars stay:
    // the running container still reads them.
    expect(docker.removals).toEqual([]);
    expect(await fs.exists(`${DATA}/.${LEGACY}-secrets`)).toBe(true);
  });

  test("legacy AND new name both present → hard error naming both", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "exited", sameBinds: [ROOT] });
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719", state: "exited", sameBinds: [ROOT] });
    const r = await run();
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.message).toContain(LEGACY);
      expect(r.message).toContain("claude-myproj-69adc719 already exists");
    }
    expect(docker.removals).toEqual([]);
  });

  test("legacy container from a path that NO LONGER EXISTS → a move: adopted", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-_Users_a_dev_oldname", state: "exited", sameBinds: ["/Users/a/dev/oldname"] });
    const r = await run();
    expect(r.kind).toBe("ok");
    expect(docker.removals.map((x) => x.name)).toEqual(["claude-_Users_a_dev_oldname"]);
  });

  test("legacy container from a path that STILL EXISTS → a copy sharing this id: refused", async () => {
    const { docker, fs, run } = setup();
    fs.seedDir("/Users/a/dev/myproj-copy");
    docker.seedContainerSummary(CTX, { name: "claude-_Users_a_dev_myproj-copy", state: "exited", sameBinds: ["/Users/a/dev/myproj-copy"] });
    const r = await run();
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.message).toContain("/Users/a/dev/myproj-copy");
      expect(r.message).toContain("COPY");
      expect(r.message).toContain("id: 69adc719");
    }
    expect(docker.removals).toEqual([]);
  });

  test("a pre-6.0 SUBDIRECTORY container is named and left alone, not called a copy", async () => {
    const { docker, fs, run } = setup();
    fs.seedDir(`${ROOT}/src`);
    docker.seedContainerSummary(CTX, { name: `${LEGACY}_src`, state: "exited", sameBinds: [`${ROOT}/src`] });
    const r = await run();
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.notes.join("")).toContain("started from a subdirectory");
    expect(docker.removals).toEqual([]);
  });
});

describe("AdoptionService — 6.0 containers that moved or were copied", () => {
  test("current name, workspace = root → ok, untouched", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719", state: "running", sameBinds: [ROOT] });
    expect(await run()).toEqual({ kind: "ok", notes: [] });
    expect(docker.removals).toEqual([]);
  });

  test("current name, stopped, old workspace gone → moved: recreated here", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719", state: "exited", sameBinds: ["/Users/a/dev/oldname"] });
    const r = await run();
    expect(r.kind).toBe("ok");
    expect(docker.removals.map((x) => x.name)).toEqual(["claude-myproj-69adc719"]);
    if (r.kind === "ok") expect(r.notes.join("")).toContain("project moved from /Users/a/dev/oldname");
  });

  test("current name, RUNNING, old workspace gone → refused, never killed", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719", state: "running", sameBinds: ["/Users/a/dev/oldname"] });
    const r = await run();
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.message).toContain("dridock down && dridock start");
    expect(docker.removals).toEqual([]);
  });

  test("current name, old workspace still exists → a copy: refused", async () => {
    const { docker, fs, run } = setup();
    fs.seedDir("/Users/a/dev/other");
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719", state: "exited", sameBinds: ["/Users/a/dev/other"] });
    expect((await run()).kind).toBe("refused");
  });
});

describe("AdoptionService — legacy sidecars (rule 5)", () => {
  test("after adoption, every pre-6.0 sidecar is removed and credential files are counted", async () => {
    const { docker, fs, run } = setup();
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "exited", sameBinds: [ROOT] });
    for (const f of [`.${LEGACY}-secrets`, `.${LEGACY}-auth`, `.${LEGACY}-env`, `.${LEGACY}_prog-args`, ".claude-_Users_a_dev_oldname-secrets"]) {
      fs.seed(`${DATA}/${f}`, "x\n");
    }
    fs.seed(`${DATA}/.claude-myproj-69adc719-secrets`, "keep\n");
    const r = await run();
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.notes.join("")).toContain("removed 5 stale sidecar file(s)");
    if (r.kind === "ok") expect(r.notes.join("")).toContain("3 of them holding credentials");
    expect(await fs.exists(`${DATA}/.${LEGACY}-secrets`)).toBe(false);
    expect(await fs.exists(`${DATA}/.claude-myproj-69adc719-secrets`)).toBe(true);
  });
});

describe("sameBindsOf", () => {
  test("every same-path bind, socket and non-binds excluded, order kept as given", () => {
    expect(sameBindsOf([
      { Type: "bind", Source: "/data", Destination: "/data" },
      { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" },
      { Type: "bind", Source: "/Users/a/.config/dridock/projects/x/dot", Destination: "/home/claude" },
      { Type: "bind", Source: "/Users/a/dev/myproj", Destination: "/Users/a/dev/myproj" },
      { Type: "volume", Source: "/var/lib/docker/volumes/v", Destination: "/var/lib/docker/volumes/v" },
    ])).toEqual(["/data", "/Users/a/dev/myproj"]);
  });
});

describe("AdoptionService — Arfy's review (#123), against what a real daemon returns", () => {
  test("MF1: an extra same-path mount listed FIRST doesn't make an unmoved project look copied", async () => {
    const { docker, fs, run } = setup();
    fs.seedDir("/data");
    // docker inspect returns mounts unordered; the extra one can come first.
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "exited", sameBinds: ["/data", ROOT] });
    const r = await run();
    expect(r.kind).toBe("ok");
    expect(docker.removals.map((x) => x.name)).toEqual([LEGACY]);   // adopted, as an unmoved project
  });

  test("MF1: a moved pre-6.0 container with an extra mount → can't tell, refused, NOTHING removed", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-_Users_a_dev_old", state: "exited", sameBinds: ["/data", "/Users/a/dev/old"] });
    const r = await run();
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") {
      expect(r.message).toContain("can't tell which directory");
      expect(r.message).toContain("/data, /Users/a/dev/old");
    }
    expect(docker.removals).toEqual([]);
  });

  test("MF1: the org.dridock.workspace label wins over any mount", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719", state: "exited", labelWorkspace: ROOT, labelId: "69adc719", sameBinds: ["/data", "/elsewhere"] });
    expect(await run()).toEqual({ kind: "ok", notes: [] });
  });

  test("MF1: a container labelled with another id is not this project's", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-_Users_a_dev_myproj", state: "exited", labelId: "deadbeef", sameBinds: [ROOT] });
    expect(await run()).toEqual({ kind: "ok", notes: [] });
    expect(docker.removals).toEqual([]);
  });

  test("MF2: a failed container listing → refused, and NO sidecar is deleted", async () => {
    const { docker, fs, run } = setup();
    docker.listFails = true;
    fs.seed(`${DATA}/.${LEGACY}-secrets`, "GH_TOKEN=x\n");
    fs.seed(`${DATA}/.${LEGACY}-auth`, "x\n");
    const r = await run();
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.message).toContain("couldn't list the containers");
    expect(await fs.exists(`${DATA}/.${LEGACY}-secrets`)).toBe(true);
    expect(await fs.exists(`${DATA}/.${LEGACY}-auth`)).toBe(true);
  });

  test("MF3: removal is non-force; if the daemon refuses (it started meanwhile) → refused, no sweep", async () => {
    const { docker, fs, run } = setup();
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "exited", sameBinds: [ROOT] });
    docker.rmRefuses.add(LEGACY);
    fs.seed(`${DATA}/.${LEGACY}-secrets`, "x\n");
    const r = await run();
    expect(r.kind).toBe("refused");
    if (r.kind === "refused") expect(r.message).toContain("may have started since");
    expect(docker.removals).toEqual([]);
    expect(await fs.exists(`${DATA}/.${LEGACY}-secrets`)).toBe(true);
  });

  test("SF4: a kept subdirectory container keeps its sidecars; the adopted one's are swept", async () => {
    const { docker, fs, run } = setup();
    fs.seedDir(`${ROOT}/src`);
    docker.seedContainerSummary(CTX, { name: LEGACY, state: "exited", sameBinds: [ROOT] });
    docker.seedContainerSummary(CTX, { name: `${LEGACY}_src`, state: "exited", sameBinds: [`${ROOT}/src`] });
    for (const n of [LEGACY, `${LEGACY}_src`]) {
      fs.seed(`${DATA}/.${n}-secrets`, "x\n");
      fs.seed(`${DATA}/.${n}-auth`, "x\n");
    }
    const r = await run();
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.notes.join("")).toContain("removed 2 stale sidecar file(s)");
    expect(await fs.exists(`${DATA}/.${LEGACY}_src-secrets`)).toBe(true);
    expect(await fs.exists(`${DATA}/.${LEGACY}-secrets`)).toBe(false);
  });

  test("SF5: deferral carries the RUNNING container's own base name", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: `${LEGACY}_cron`, state: "running", sameBinds: [ROOT] });
    const r = await run();
    expect(r.kind).toBe("deferred");
    if (r.kind === "deferred") expect(r.legacyBase).toBe(LEGACY);
  });
});

describe("AdoptionService — old labels and throwaways", () => {
  test("a container under an older name: label (same id) is adopted, not orphaned", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-oldlabel-69adc719_cron", state: "exited", sameBinds: [ROOT] });
    const r = await run();
    expect(docker.removals.map((x) => x.name)).toEqual(["claude-oldlabel-69adc719_cron"]);
    if (r.kind === "ok") expect(r.notes.join("")).toContain("name: changed");
  });

  test("a nameless claude-<id> container is adopted once a name is declared", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-69adc719", state: "exited", sameBinds: [ROOT] });
    await run();
    expect(docker.removals.map((x) => x.name)).toEqual(["claude-69adc719"]);
  });

  test("another id's container and auth/mcp throwaways are ignored", async () => {
    const { docker, run } = setup();
    docker.seedContainerSummary(CTX, { name: "claude-myproj-deadbeef", state: "exited", sameBinds: [ROOT] });
    docker.seedContainerSummary(CTX, { name: `${LEGACY}_auth_1731700000000`, state: "running", sameBinds: [ROOT] });
    docker.seedContainerSummary(CTX, { name: "claude-myproj-69adc719_mcp_1731700000000", state: "running", sameBinds: [ROOT] });
    expect(await run()).toEqual({ kind: "ok", notes: [] });
    expect(docker.removals).toEqual([]);
  });
});

describe("AdoptionService — old-label sidecars", () => {
  test("sidecars under an old label are removed too; the current ones and another id's stay", async () => {
    const { fs, run } = setup();
    fs.seed(`${DATA}/.claude-oldlabel-69adc719-secrets`, "x\n");
    fs.seed(`${DATA}/.claude-oldlabel-69adc719_prog-interactive-args`, "x\n");
    fs.seed(`${DATA}/.claude-myproj-69adc719-secrets`, "keep\n");
    fs.seed(`${DATA}/.claude-other-deadbeef-secrets`, "keep\n");
    const r = await run();
    if (r.kind === "ok") expect(r.notes.join("")).toContain("removed 2 stale sidecar file(s)");
    expect(await fs.exists(`${DATA}/.claude-oldlabel-69adc719-secrets`)).toBe(false);
    expect(await fs.exists(`${DATA}/.claude-myproj-69adc719-secrets`)).toBe(true);
    expect(await fs.exists(`${DATA}/.claude-other-deadbeef-secrets`)).toBe(true);
  });
});

test("a RUNNING legacy container whose old workspace is gone → refused, not attached, not killed", async () => {
  const { docker, run } = setup();
  docker.seedContainerSummary(CTX, { name: "claude-_Users_a_dev_oldname", state: "running", sameBinds: ["/Users/a/dev/oldname"] });
  const r = await run();
  expect(r.kind).toBe("refused");
  if (r.kind === "refused") expect(r.message).toContain("dridock down && dridock start");
  expect(docker.removals).toEqual([]);
});
