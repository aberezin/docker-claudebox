import { test, expect, describe } from "bun:test";
import { InMemoryFileSystem } from "./InMemoryFileSystem.ts";

describe("InMemoryFileSystem — read paths", () => {
  test("readText returns seeded content", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/a/b.txt", "hello");
    expect(await fs.readText("/a/b.txt")).toBe("hello");
  });

  test("readText throws on missing file", async () => {
    const fs = new InMemoryFileSystem();
    await expect(fs.readText("/missing")).rejects.toThrow(/no such file/);
  });

  test("readTextOrUndefined returns undefined on missing", async () => {
    const fs = new InMemoryFileSystem();
    expect(await fs.readTextOrUndefined("/missing")).toBeUndefined();
  });

  test("exists true for seeded file", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/x", "");
    expect(await fs.exists("/x")).toBe(true);
  });

  test("exists true for seeded dir", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/some/dir");
    expect(await fs.exists("/some/dir")).toBe(true);
    expect(await fs.exists("/some")).toBe(true);   // parent auto-created
  });

  test("isDirectory distinguishes file vs dir", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/file.txt", "");
    fs.seedDir("/dir");
    expect(await fs.isDirectory("/file.txt")).toBe(false);
    expect(await fs.isDirectory("/dir")).toBe(true);
    expect(await fs.isDirectory("/missing")).toBe(false);
  });
});

describe("InMemoryFileSystem — write paths", () => {
  test("writeText round-trips + records", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeText("/a/b.txt", "hi", { mode: 0o600 });
    expect(await fs.readText("/a/b.txt")).toBe("hi");
    expect(fs.modeOf("/a/b.txt")).toBe(0o600);
    expect(fs.recordedWrites).toEqual([{ path: "/a/b.txt", content: "hi", mode: 0o600 }]);
  });

  test("writeText marks parent dirs as existing (mimics mkdir -p)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeText("/deep/nested/path/file", "");
    expect(await fs.isDirectory("/deep")).toBe(true);
    expect(await fs.isDirectory("/deep/nested")).toBe(true);
    expect(await fs.isDirectory("/deep/nested/path")).toBe(true);
  });
});

describe("InMemoryFileSystem — listDir", () => {
  test("returns immediate children only, sorted", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/proj/.dridock/config.yml", "");
    fs.seed("/proj/.dridock/secrets.env", "");
    fs.seed("/proj/README.md", "");
    fs.seedDir("/proj/src");
    expect(await fs.listDir("/proj")).toEqual([".dridock", "README.md", "src"]);
    expect(await fs.listDir("/proj/.dridock")).toEqual(["config.yml", "secrets.env"]);
  });

  test("throws on missing dir", async () => {
    const fs = new InMemoryFileSystem();
    await expect(fs.listDir("/missing")).rejects.toThrow(/no such directory/);
  });
});

describe("InMemoryFileSystem — mutating primitives (Phase 3)", () => {
  test("mkdirRecursive creates every ancestor", async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdirRecursive("/a/b/c/d");
    for (const p of ["/a", "/a/b", "/a/b/c", "/a/b/c/d"]) {
      expect(await fs.isDirectory(p)).toBe(true);
    }
  });

  test("move — file to a new path preserves content + mode", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/src/file", "content", { mode: 0o600 });
    await fs.move("/src/file", "/dst/file");
    expect(await fs.exists("/src/file")).toBe(false);
    expect(await fs.readText("/dst/file")).toBe("content");
    expect(fs.modeOf("/dst/file")).toBe(0o600);
  });

  test("move — refuses to overwrite existing destination (audit rule: never silent clobber)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/src/file", "new");
    fs.seed("/dst/file", "existing");
    await expect(fs.move("/src/file", "/dst/file")).rejects.toThrow(/refuse to overwrite/);
    expect(await fs.readText("/src/file")).toBe("new");
    expect(await fs.readText("/dst/file")).toBe("existing");
  });

  test("move — directory with descendants relocates the whole subtree", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/old/a", "1");
    fs.seed("/old/sub/b", "2");
    fs.seedDir("/old/empty");
    await fs.move("/old", "/new");
    expect(await fs.exists("/old")).toBe(false);
    expect(await fs.readText("/new/a")).toBe("1");
    expect(await fs.readText("/new/sub/b")).toBe("2");
    expect(await fs.isDirectory("/new/empty")).toBe(true);
  });

  test("move — refuses when destination dir exists", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/old/x", "1");
    fs.seedDir("/new");
    await expect(fs.move("/old", "/new")).rejects.toThrow(/refuse to overwrite/);
  });

  test("move — missing source throws", async () => {
    const fs = new InMemoryFileSystem();
    await expect(fs.move("/nope", "/anywhere")).rejects.toThrow(/no such source/);
  });

  test("removeFile — ENOENT-idempotent (matches `rm -f`)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.removeFile("/never-existed"); // must not throw
    fs.seed("/existing", "x");
    await fs.removeFile("/existing");
    expect(await fs.exists("/existing")).toBe(false);
  });

  test("rmDirIfEmpty — empty dir removed; non-empty is a silent no-op (matches `rmdir ... || true`)", async () => {
    const fs = new InMemoryFileSystem();
    fs.seedDir("/empty");
    await fs.rmDirIfEmpty("/empty");
    expect(await fs.exists("/empty")).toBe(false);
    fs.seed("/nonempty/x", "1");
    await fs.rmDirIfEmpty("/nonempty");   // no-op, no throw
    expect(await fs.exists("/nonempty")).toBe(true);
    expect(await fs.readText("/nonempty/x")).toBe("1"); // content untouched
    // ENOENT-idempotent
    await fs.rmDirIfEmpty("/never-existed");
  });

  test("chmod records the new mode; missing file throws", async () => {
    const fs = new InMemoryFileSystem();
    fs.seed("/f", "x");
    await fs.chmod("/f", 0o600);
    expect(fs.modeOf("/f")).toBe(0o600);
    await expect(fs.chmod("/nope", 0o600)).rejects.toThrow(/no such file/);
  });

  test("writeTextAtomic — same visible outcome as writeText (in-memory has no half-writes)", async () => {
    const fs = new InMemoryFileSystem();
    await fs.writeTextAtomic("/a/b.txt", "hello", { mode: 0o600 });
    expect(await fs.readText("/a/b.txt")).toBe("hello");
    expect(fs.modeOf("/a/b.txt")).toBe(0o600);
  });
});
