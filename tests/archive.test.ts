// @covers R-INSTALL-02
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractArchive, safeSegments } from "../src/core/archive";
import { makeTar, makeTarGz, makeZip, paxEntry, type TarEntry, type ZipEntry } from "./helpers/archives";

// Safe extraction (W4, acceptance R2): what an archive may write, and what it may never write.
let work: string;
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), "seed-archive-")); n = 0; });
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }); });

const BIG = 1 << 30;
function writeFile(name: string, data: Buffer) {
  const f = path.join(work, name);
  fs.writeFileSync(f, data);
  return f;
}
const tgz = (entries: TarEntry[], file = "a.tar.gz", maxBytes = BIG) => ({ file: writeFile(file, makeTarGz(entries)), kind: "tar.gz", maxBytes });
const zip = (entries: ZipEntry[], file = "a.zip", maxBytes = BIG) => ({ file: writeFile(file, makeZip(entries)), kind: "zip", maxBytes });
type Made = { file: string; kind: string; maxBytes: number };
let n = 0;
const extract = (a: Made, dest = path.join(work, n++ === 0 ? "out" : `out${n}`), limits: { maxEntries?: number } = {}) => extractArchive(a.file, a.kind, dest, { maxBytes: a.maxBytes, ...limits });
const makers: [string, (names: string[]) => Made][] = [
  ["tar.gz", (n) => tgz(n.map((name) => ({ name, data: "x" })))],
  ["zip", (n) => zip(n.map((name) => ({ name, data: "x" })))]
];
const refusal = async (a: Made, code: string, dest?: string) => {
  const r = await extract(a, dest);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r.ok ? null : r.error;
};
const treeOf = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(dir, p).split(path.sep).join("/")); if (e.isDirectory()) walk(p); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};

describe("a good archive is unpacked exactly", () => {
  const files: TarEntry[] = [
    { name: "bin/", type: "5", mode: 0o755 },
    { name: "bin/run", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
    { name: "lib/data.txt", data: "hello" },
    { name: "lib/empty.txt" },
    { name: "docs/deep/er/readme.md", data: Buffer.alloc(100_000, 7) }
  ];
  it("tar.gz: files, folders, an empty file, a 100 kB file, with the declared byte count", async () => {
    const r = await extract(tgz(files));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files).toBe(4);
    expect(r.bytes).toBe(18 + 5 + 100_000);
    expect(r.paths).toEqual(["bin/run", "docs/deep/er/readme.md", "lib/data.txt", "lib/empty.txt"]);
    expect(fs.readFileSync(path.join(work, "out", "bin", "run"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(fs.readFileSync(path.join(work, "out", "lib", "empty.txt")).length).toBe(0);
    expect(fs.readFileSync(path.join(work, "out", "docs/deep/er/readme.md")).equals(Buffer.alloc(100_000, 7))).toBe(true);
    expect(treeOf(path.join(work, "out"))).toEqual(["bin", "bin/run", "docs", "docs/deep", "docs/deep/er", "docs/deep/er/readme.md", "lib", "lib/data.txt", "lib/empty.txt"]);
  });
  it.skipIf(process.platform === "win32")("tar.gz: the executable bit survives, and nothing else gets more than 0644", async () => {
    await extract(tgz(files));
    expect(fs.statSync(path.join(work, "out", "bin", "run")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(work, "out", "lib", "data.txt")).mode & 0o111).toBe(0);
  });
  it("tar.gz: an archive written in whole 10240-byte records, with a ./ prefix on every name, is unpacked", async () => {
    const a = { file: writeFile("rec.tar.gz", zlib.gzipSync(makeTar([{ name: "./", type: "5" }, { name: "./x/y.txt", data: "yy" }], { recordPad: true }))), kind: "tar.gz", maxBytes: BIG };
    const r = await extract(a);
    expect(r.ok && r.paths).toEqual(["x/y.txt"]);
  });
  it("zip: stored and deflated entries, a folder entry, an empty file", async () => {
    const r = await extract(zip([{ name: "d/" }, { name: "d/a.txt", data: "deflated deflated deflated deflated" }, { name: "d/b.bin", data: Buffer.from([1, 2, 3]), method: 0 }, { name: "e.txt" }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paths).toEqual(["d/a.txt", "d/b.bin", "e.txt"]);
    expect(fs.readFileSync(path.join(work, "out", "d", "a.txt"), "utf8")).toBe("deflated deflated deflated deflated");
    expect([...fs.readFileSync(path.join(work, "out", "d", "b.bin"))]).toEqual([1, 2, 3]);
  });
  it.skipIf(process.platform === "win32")("zip: a unix executable bit is kept", async () => {
    await extract(zip([{ name: "run.sh", data: "x", unixMode: 0o100755 }, { name: "plain", data: "x", unixMode: 0o100644 }]));
    expect(fs.statSync(path.join(work, "out", "run.sh")).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(work, "out", "plain")).mode & 0o111).toBe(0);
  });
  it("a destination with spaces and non-ASCII letters in its path works (R1)", async () => {
    const dest = path.join(work, "my apps", "Éxample dir", "v 1.0");
    const r = await extract(tgz(files), dest);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(dest, "lib", "data.txt"))).toBe(true);
  });
  it("an existing empty folder is fine as a destination", async () => {
    const dest = path.join(work, "empty");
    fs.mkdirSync(dest);
    expect((await extract(tgz(files), dest)).ok).toBe(true);
  });
});

describe("long names", () => {
  const long = "d".repeat(60) + "/" + "e".repeat(60) + "/" + "f".repeat(60) + "/file.txt";
  it("through the ustar prefix field", async () => {
    const prefix = "d".repeat(60) + "/" + "e".repeat(60);
    const r = await extract(tgz([{ prefix, name: "file.txt", data: "p" }]));
    expect(r.ok && r.paths).toEqual([prefix + "/file.txt"]);
  });
  it("through a GNU long-name entry", async () => {
    const r = await extract(tgz([{ name: "././@LongLink", type: "L", data: long + "\0" }, { name: "short", data: "g" }]));
    expect(r.ok && r.paths).toEqual([long]);
  });
  it("through a pax path record", async () => {
    const r = await extract(tgz([paxEntry({ path: long }), { name: "short", data: "x" }]));
    expect(r.ok && r.paths).toEqual([long]);
  });
  it("a path longer than 200 characters is refused (tar long name and zip)", async () => {
    const huge = ("x".repeat(50) + "/").repeat(5) + "f.txt";
    await refusal(tgz([{ name: "././@LongLink", type: "L", data: huge + "\0" }, { name: "short", data: "x" }]), "E_ARCHIVE_UNSAFE");
    await refusal(zip([{ name: huge, data: "x" }]), "E_ARCHIVE_UNSAFE");
  });
  it("a pax path that climbs out is refused like any other", async () => {
    await refusal(tgz([paxEntry({ path: "../../outside.txt" }), { name: "short", data: "x" }]), "E_ARCHIVE_UNSAFE");
    expect(fs.existsSync(path.join(work, "..", "outside.txt"))).toBe(false);
  });
});

describe("a path that would leave the folder is refused, and nothing is written outside", () => {
  const BAD = ["../evil.txt", "a/../../evil.txt", "a/b/../../../evil.txt", "/etc/evil.txt", "\\evil.txt", "C:/evil.txt", "C:\\evil.txt", "c:evil.txt", "a\\..\\..\\evil.txt", "a/..", ".."];
  for (const [kind, make] of makers) {
    it.each(BAD)(`${kind}: %s`, async (name) => {
      const err = await refusal(make([name]), "E_ARCHIVE_UNSAFE");
      expect(err?.message).toContain("entry");
      expect(fs.existsSync(path.join(work, "evil.txt"))).toBe(false);
      expect(fs.existsSync(path.join(work, "..", "evil.txt"))).toBe(false);
    });
  }
  it("a refusal names the entry", async () => {
    const err = await refusal(tgz([{ name: "ok.txt", data: "x" }, { name: "sub/../../bad.txt", data: "x" }]), "E_ARCHIVE_UNSAFE");
    expect(err?.field).toBe("sub/../../bad.txt");
    expect(err?.message).toContain("bad.txt");
  });
});

describe("names that Windows can not hold are refused on every platform", () => {
  const BAD = ["con", "aux.txt", "NUL", "dir/COM1.dat", "lpt9", "a:b", "x<y", "x>y", "x|y", "x?y", "x*y", 'x"y', "trailing.", "trailing ", "dir./file", "tab\tname", "bell\u0007"];
  for (const [kind, make] of makers) {
    it.each(BAD)(`${kind}: %j`, async (name) => {
      await refusal(make([name]), "E_ARCHIVE_UNSAFE");
    });
  }
  it("the plain names around them are fine", () => {
    expect(safeSegments("console/command.txt")).toEqual(["console", "command.txt"]);
    expect(safeSegments("./a//b/./c")).toEqual(["a", "b", "c"]);
    expect(safeSegments("./")).toEqual([]);
    expect(safeSegments("a.b.c")).toEqual(["a.b.c"]);
  });
});

describe("links and special files are refused", () => {
  it.each([["a symlink", "2"], ["a hard link", "1"], ["a character device", "3"], ["a block device", "4"], ["a fifo", "6"]])("tar: %s", async (_n, type) => {
    const err = await refusal(tgz([{ name: "good.txt", data: "x" }, { name: "evil", type, linkname: "/etc/passwd" }]), "E_ARCHIVE_UNSAFE");
    expect(err?.field).toBe("evil");
  });
  it("tar: an unknown entry type is unsupported, not unsafe", async () => {
    await refusal(tgz([{ name: "odd", type: "Z" }]), "E_ARCHIVE_UNSUPPORTED");
  });
  it("zip: a symlink and a device", async () => {
    await refusal(zip([{ name: "link", data: "/etc/passwd", unixMode: 0o120777 }]), "E_ARCHIVE_UNSAFE");
    await refusal(zip([{ name: "dev", data: "", unixMode: 0o020666 }]), "E_ARCHIVE_UNSAFE");
  });
  it("a file written through a link is therefore impossible: nothing is created when the link comes first", async () => {
    await refusal(tgz([{ name: "ln", type: "2", linkname: work }, { name: "ln/pwned.txt", data: "x" }]), "E_ARCHIVE_UNSAFE");
    expect(fs.existsSync(path.join(work, "pwned.txt"))).toBe(false);
  });
});

describe("two entries for one path, and files used as folders", () => {
  for (const [kind, make] of makers) {
    it(`${kind}: the same name twice`, async () => { await refusal(make(["a.txt", "a.txt"]), "E_ARCHIVE_UNSAFE"); });
    it(`${kind}: names that differ only in case`, async () => { await refusal(make(["Lib/a.txt", "lib/A.TXT"]), "E_ARCHIVE_UNSAFE"); });
    it(`${kind}: a file, then something below it`, async () => { await refusal(make(["a", "a/b"]), "E_ARCHIVE_UNSAFE"); });
    it(`${kind}: a folder made by an earlier entry, then a file of that name`, async () => { await refusal(make(["a/b", "a"]), "E_ARCHIVE_UNSAFE"); });
  }
  it("a folder named twice is fine", async () => {
    const r = await extract(tgz([{ name: "d/", type: "5" }, { name: "d/", type: "5" }, { name: "d/x", data: "1" }]));
    expect(r.ok).toBe(true);
  });
  it("a file where an earlier entry made a folder is refused (tar folder type)", async () => {
    await refusal(tgz([{ name: "d", type: "5" }, { name: "d", data: "x" }]), "E_ARCHIVE_UNSAFE");
  });
});

describe("size and count limits are enforced while writing", () => {
  it("an archive that expands to more than the manifest declares is refused (tar.gz and zip)", async () => {
    const entries = [{ name: "a", data: Buffer.alloc(600) }, { name: "b", data: Buffer.alloc(600) }];
    await refusal(tgz(entries, "a.tar.gz", 1000), "E_ARCHIVE_TOO_LARGE");
    await refusal(zip(entries, "a.zip", 1000), "E_ARCHIVE_TOO_LARGE");
  });
  it("exactly the declared size is fine", async () => {
    const r = await extract(tgz([{ name: "a", data: Buffer.alloc(1000) }], "a.tar.gz", 1000));
    expect(r.ok).toBe(true);
  });
  it("a compression bomb stops at the limit and does not fill the disk", async () => {
    const bomb = Buffer.alloc(60 * 1024 * 1024);
    const t = tgz([{ name: "bomb", data: bomb }], "bomb.tar.gz", 1024 * 1024);
    expect(fs.statSync(t.file).size).toBeLessThan(200_000);
    await refusal(t, "E_ARCHIVE_TOO_LARGE");
    const written = fs.existsSync(path.join(work, "out", "bomb")) ? fs.statSync(path.join(work, "out", "bomb")).size : 0;
    expect(written).toBeLessThanOrEqual(1024 * 1024);
  });
  it("a zip bomb too", async () => {
    const z = zip([{ name: "bomb", data: Buffer.alloc(60 * 1024 * 1024) }], "bomb.zip", 1024 * 1024);
    await refusal(z, "E_ARCHIVE_TOO_LARGE");
    const written = fs.existsSync(path.join(work, "out", "bomb")) ? fs.statSync(path.join(work, "out", "bomb")).size : 0;
    expect(written).toBeLessThanOrEqual(1024 * 1024);
  });
  it("a zip that claims small sizes but holds more is corrupt, not trusted", async () => {
    await refusal(zip([{ name: "liar", data: Buffer.alloc(5000), claimSize: 10 }]), "E_ARCHIVE_CORRUPT");
  });
  it("too many entries", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, data: "x" }));
    expect((await extract(tgz(entries), path.join(work, "o1"), { maxEntries: 19 })).ok).toBe(false);
    expect((await extract(zip(entries), path.join(work, "o2"), { maxEntries: 19 })).ok).toBe(false);
    expect((await extract(tgz(entries), path.join(work, "o3"), { maxEntries: 20 })).ok).toBe(true);
  });
});

describe("a damaged archive is corrupt, not half trusted", () => {
  it("tar: a header that fails its checksum", async () => {
    await refusal({ file: writeFile("c.tar.gz", makeTarGz([{ name: "a", data: "1" }, { name: "b", data: "2" }], { corruptHeader: 1 })), kind: "tar.gz", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
  });
  it("tar: no closing empty blocks (a copy cut at an entry boundary)", async () => {
    await refusal({ file: writeFile("c.tar.gz", makeTarGz([{ name: "a", data: "1" }], { noEnd: true })), kind: "tar.gz", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
  });
  it("tar: cut in the middle of a file", async () => {
    await refusal({ file: writeFile("c.tar.gz", makeTarGz([{ name: "a", data: Buffer.alloc(5000, 1) }], { truncateTo: 2000 })), kind: "tar.gz", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
  });
  it("gzip: cut in the middle of the stream, and plain garbage", async () => {
    const whole = makeTarGz([{ name: "a", data: Buffer.alloc(50_000, 9).map((_, i) => (i * 7) & 255) }]);
    await refusal({ file: writeFile("c1.tar.gz", whole.subarray(0, whole.length - 40)), kind: "tar.gz", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
    await refusal({ file: writeFile("c2.tar.gz", Buffer.from("this is not a gzip file at all")), kind: "tar.gz", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
  });
  it("zip: a wrong checksum", async () => {
    await refusal(zip([{ name: "a", data: "hello", crc: 12345 }]), "E_ARCHIVE_CORRUPT");
  });
  it("zip: not a zip file; a file cut short", async () => {
    await refusal({ file: writeFile("n.zip", Buffer.from("PK nope")), kind: "zip", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
    const whole = makeZip([{ name: "a", data: "hello world".repeat(100) }]);
    await refusal({ file: writeFile("t.zip", whole.subarray(0, whole.length - 30)), kind: "zip", maxBytes: BIG }, "E_ARCHIVE_CORRUPT");
  });
  it("zip: a local header with another name than the directory (the confusion trick)", async () => {
    await refusal(zip([{ name: "good.txt", data: "x", localName: "../evil.txt" }]), "E_ARCHIVE_CORRUPT");
    expect(fs.existsSync(path.join(work, "evil.txt"))).toBe(false);
  });
  it("zip: stored entry whose two sizes differ", async () => {
    await refusal(zip([{ name: "a", data: "hello", method: 0, claimSize: 3 }]), "E_ARCHIVE_CORRUPT");
  });
  it("zip: the end-of-directory signature inside the comment is not taken for the real one", async () => {
    const real = makeZip([{ name: "a.txt", data: "ok" }], { comment: "PK\x05\x06 fake end of directory padding padding" });
    const r = await extract({ file: writeFile("cm.zip", real), kind: "zip", maxBytes: BIG });
    expect(r.ok && r.paths).toEqual(["a.txt"]);
  });
});

describe("what is not supported is said so", () => {
  it("an encrypted zip entry", async () => { await refusal(zip([{ name: "s", data: "x", flags: 1 }]), "E_ARCHIVE_UNSUPPORTED"); });
  it("a zip method other than stored and deflate", async () => { await refusal(zip([{ name: "s", data: "x", method: 12 as unknown as 8 }]), "E_ARCHIVE_UNSUPPORTED"); });
  it("an archive type that is not tar.gz or zip", async () => {
    await refusal({ file: writeFile("x.rar", Buffer.from("x")), kind: "rar", maxBytes: BIG }, "E_ARCHIVE_UNSUPPORTED");
  });
  it("no byte limit given", async () => {
    const r = await extractArchive(writeFile("a.tar.gz", makeTarGz([{ name: "a" }])), "tar.gz", path.join(work, "o"), { maxBytes: -1 });
    expect(r.ok).toBe(false);
  });
});

describe("the destination", () => {
  it("a folder that is not empty is refused and left alone", async () => {
    const dest = path.join(work, "full");
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, "mine.txt"), "keep");
    await refusal(tgz([{ name: "a", data: "x" }]), "E_ARCHIVE_UNSAFE", dest);
    expect(fs.readFileSync(path.join(dest, "mine.txt"), "utf8")).toBe("keep");
    expect(treeOf(dest)).toEqual(["mine.txt"]);
  });
  it("a file in place of the folder is refused", async () => {
    const dest = path.join(work, "afile");
    fs.writeFileSync(dest, "x");
    await refusal(tgz([{ name: "a", data: "x" }]), "E_ARCHIVE_UNSAFE", dest);
  });
  it("a missing archive file is a failure that says so, not a crash", async () => {
    const r = await extractArchive(path.join(work, "missing.tar.gz"), "tar.gz", path.join(work, "o"), { maxBytes: BIG });
    expect(r.ok).toBe(false);
  });
});
