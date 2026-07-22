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
