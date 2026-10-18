import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ComponentError, ComponentErrorCode } from "./components";

/**
 * Safe extraction of a component artifact (W4, docs/runtime-contract.md). A component archive comes from a manifest whose hash
 * the catalog pins, but the hash only says the bytes are the ones the publisher meant: this module still refuses an archive that
 * would write outside its folder, so one bad build can not damage the machine (acceptance R2).
 *
 * Refused, with `E_ARCHIVE_UNSAFE` and the entry named: a path that is absolute, has a drive letter, a `..` segment, a control
 * character, a character or a name Windows can not hold (`CON`, `a:b`, a trailing dot or space); a link of any kind and any
 * device, pipe or other special file; two entries for one path, also when they differ only in case; a file used as a folder;
 * extraction into a folder that is not empty. Refused with `E_ARCHIVE_TOO_LARGE`: more entries than allowed, or more bytes than the
 * caller allows (counted while writing, so an archive that lies about its sizes, or a compression bomb, stops at the limit).
 * `E_ARCHIVE_CORRUPT`: a bad checksum, a truncated archive, a bad length. `E_ARCHIVE_UNSUPPORTED`: encryption, zip64, multi-disk,
 * an unknown compression method.
 *
 * It writes only below `dest` and never overwrites. On a refusal it leaves what it had written; the caller deletes the folder.
 * Supported: tar.gz (ustar, GNU long names, pax `path` and `size`) and zip (stored and deflate, no zip64).
 */

export type ExtractLimits = { maxBytes: number; maxEntries?: number };
export type ExtractResult =
  | { ok: true; files: number; directories: number; bytes: number; paths: string[] }
  | { ok: false; error: ComponentError };

const MAX_ENTRY_PATH = 200;
const DEFAULT_MAX_ENTRIES = 200_000;
const MAX_META = 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

class ArchiveError extends Error {
  constructor(readonly code: ComponentErrorCode, message: string, readonly entry?: string) {
    super(message);
  }
}
const unsafe = (entry: string, why: string) => new ArchiveError("E_ARCHIVE_UNSAFE", `entry ${JSON.stringify(entry)} ${why}`, entry);
const corrupt = (why: string) => new ArchiveError("E_ARCHIVE_CORRUPT", why);

/** The segments of a safe relative path, or an error. Empty list: the entry names the root itself (`./`). */
export function safeSegments(name: string): string[] {
  if (name.length === 0) throw unsafe(name, "has no name");
  if (name.length > MAX_ENTRY_PATH) throw unsafe(name.slice(0, 40) + "...", `is longer than ${MAX_ENTRY_PATH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw unsafe(name, "has a control character");
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) throw unsafe(name, "is an absolute path");
  const out: string[] = [];
  for (const s of name.split(/[\\/]/)) {
    if (s === "" || s === ".") continue;
    if (s === "..") throw unsafe(name, "climbs out of its folder with ..");
    if (/[<>:"|?*]/.test(s)) throw unsafe(name, `has a character a Windows name can not hold in ${JSON.stringify(s)}`);
    if (/[. ]$/.test(s)) throw unsafe(name, `has a name that ends in a dot or a space: ${JSON.stringify(s)}`);
    if (RESERVED.test(s)) throw unsafe(name, `uses the reserved Windows name ${JSON.stringify(s)}`);
    out.push(s);
  }
  return out;
}

/** What the extraction has made so far: the keys are lower case so that two paths that differ only in case collide. */
class Tree {
  private readonly seen = new Map<string, "file" | "dir">();
  entries = 0;
  bytes = 0;
  files = 0;
  directories = 0;
  readonly paths: string[] = [];
  constructor(readonly dest: string, readonly limits: Required<ExtractLimits>) {}

  private key(segments: string[]) {
    return segments.join("/").toLowerCase();
  }
  private target(segments: string[], shown: string) {
    const full = path.resolve(this.dest, ...segments);
    if (!full.startsWith(this.dest + path.sep)) throw unsafe(shown, "would be written outside the destination");
    return full;
  }
  private count(shown: string) {
    if (++this.entries > this.limits.maxEntries) throw new ArchiveError("E_ARCHIVE_TOO_LARGE", `the archive has more than ${this.limits.maxEntries} entries`, shown);
  }
  /** Makes (and records) every parent folder of `segments`; refuses a parent that an earlier entry made a file. */
  private parents(segments: string[], shown: string) {
    for (let i = 1; i < segments.length; i++) {
      const k = this.key(segments.slice(0, i));
      const kind = this.seen.get(k);
      if (kind === "file") throw unsafe(shown, "is below a path that is a file");
      if (kind === undefined) {
        this.seen.set(k, "dir");
        this.directories++;
      }
    }
  }
  addBytes(n: number, shown: string) {
    this.bytes += n;
    if (this.bytes > this.limits.maxBytes) throw new ArchiveError("E_ARCHIVE_TOO_LARGE", `the archive expands to more than the ${this.limits.maxBytes} bytes the manifest declares`, shown);
  }
  /** Declared size check before anything is written. */
  expect(n: number, shown: string) {
    if (this.bytes + n > this.limits.maxBytes) throw new ArchiveError("E_ARCHIVE_TOO_LARGE", `entry ${JSON.stringify(shown)} would take the archive over the ${this.limits.maxBytes} bytes the manifest declares`, shown);
  }
  directory(shown: string): void {
    const segments = safeSegments(shown);
    this.count(shown);
    if (segments.length === 0) return;
    this.parents(segments, shown);
    const k = this.key(segments);
    const kind = this.seen.get(k);
    if (kind === "file") throw unsafe(shown, "is a folder where an earlier entry is a file");
    if (kind === undefined) {
      this.seen.set(k, "dir");
      this.directories++;
    }
    fs.mkdirSync(this.target(segments, shown), { recursive: true });
  }
  /** Opens a new file for writing; the caller closes it. */
  file(shown: string): { fd: number; full: string } {
    const segments = safeSegments(shown);
    this.count(shown);
    if (segments.length === 0) throw unsafe(shown, "names the destination itself");
    this.parents(segments, shown);
    const k = this.key(segments);
    if (this.seen.has(k)) throw unsafe(shown, "is a second entry for a path already in the archive (or differs from one only in case)");
    this.seen.set(k, "file");
    this.files++;
    this.paths.push(segments.join("/"));
    const full = this.target(segments, shown);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    return { fd: fs.openSync(full, "wx", 0o644), full };
  }
}

function prepareDestination(dest: string): string {
  const abs = path.resolve(dest);
  if (fs.existsSync(abs)) {
    const st = fs.lstatSync(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new ArchiveError("E_ARCHIVE_UNSAFE", `the destination ${abs} is not a plain folder`);
    if (fs.readdirSync(abs).length > 0) throw new ArchiveError("E_ARCHIVE_UNSAFE", `the destination ${abs} is not empty`);
  } else fs.mkdirSync(abs, { recursive: true });
  return fs.realpathSync(abs);
}

function makeExecutable(full: string, mode: number) {
  if ((mode & 0o111) !== 0) {
    try { fs.chmodSync(full, 0o755); } catch { /* a file system without modes: the file still exists */ }
  }
}

// ---- tar ---------------------------------------------------------------------------------------------------------------

function cString(b: Buffer): string {
  const z = b.indexOf(0);
  return b.subarray(0, z < 0 ? b.length : z).toString("utf8");
}
function tarNumber(field: Buffer, what: string): number {
  if ((field[0]! & 0x80) !== 0) {
    // GNU base-256: big endian, the first byte without its top bit
    let v = BigInt(field[0]! & 0x7f);
    for (let i = 1; i < field.length; i++) v = (v << 8n) | BigInt(field[i]!);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt(`the ${what} in a tar header is too large`);
    return Number(v);
  }
  const t = cString(field).trim();
  if (t === "") return 0;
  if (!/^[0-7]+$/.test(t)) throw corrupt(`the ${what} in a tar header is not a number`);
  return parseInt(t, 8);
}
function paxRecords(b: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < b.length) {
    const sp = b.indexOf(0x20, i);
    if (sp < 0) throw corrupt("a pax header is malformed");
    const len = Number(b.subarray(i, sp).toString("utf8"));
    if (!Number.isInteger(len) || len < sp - i + 2 || i + len > b.length) throw corrupt("a pax header has a bad length");
    const rec = b.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq < 0) throw corrupt("a pax header record has no =");
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

class TarSink {
  private pending: Buffer = Buffer.alloc(0);
  private mode: "header" | "data" | "meta" | "skip" | "end" = "header";
  private remaining = 0;
  private pad = 0;
  private fd: number | null = null;
  private full = "";
  private cur: { name: string; exec: boolean; size: number } | null = null;
  private metaKind = "";
  private metaChunks: Buffer[] = [];
  private longName: string | undefined;
  private paxPath: string | undefined;
  private paxSize: number | undefined;
  private zeroBlocks = 0;
  constructor(private readonly tree: Tree) {}

  write(chunk: Buffer) {
    let b = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (this.mode === "end") { off = b.length; break; }
      if (this.mode === "header") {
        if (b.length - off < 512) break;
        this.header(b.subarray(off, off + 512));
        off += 512;
        continue;
      }
      const take = Math.min(this.remaining, b.length - off);
      if (this.remaining > 0 && take === 0) break;
      const piece = b.subarray(off, off + take);
      off += take;
      this.remaining -= take;
      if (this.mode === "data") {
        this.tree.addBytes(take, this.cur!.name);
        let w = 0;
        while (w < piece.length) w += fs.writeSync(this.fd!, piece, w, piece.length - w);
      } else if (this.mode === "meta") {
        this.metaChunks.push(Buffer.from(piece));
      }
      if (this.remaining === 0) this.bodyDone();
    }
    this.pending = Buffer.from(b.subarray(off));
  }

  private header(h: Buffer) {
    if (h.every((x) => x === 0)) {
      if (++this.zeroBlocks >= 2) this.mode = "end";
      return;
    }
    if (this.zeroBlocks > 0) throw corrupt("a tar archive has data after its first empty block");
    const stored = tarNumber(h.subarray(148, 156), "checksum");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (sum !== stored) throw corrupt("a tar header has a wrong checksum");
    let name = cString(h.subarray(0, 100));
    if (h.subarray(257, 262).toString("latin1") === "ustar") {
      const prefix = cString(h.subarray(345, 500));
      if (prefix) name = prefix + "/" + name;
    }
    let size = tarNumber(h.subarray(124, 136), "size");
    const mode = tarNumber(h.subarray(100, 108), "mode");
    const type = String.fromCharCode(h[156]!);
    if (this.longName !== undefined) name = this.longName;
    if (this.paxPath !== undefined) name = this.paxPath;
    if (this.paxSize !== undefined && (type === "0" || type === "\0" || type === "7")) size = this.paxSize;

    if (type === "L" || type === "x" || type === "g" || type === "K") {
      if (size > MAX_META) throw corrupt("a tar extension header is too large");
      this.metaKind = type;
      this.metaChunks = [];
      this.remaining = size;
      this.pad = (512 - (size % 512)) % 512;
      this.mode = "meta";
      if (size === 0) this.bodyDone();
      return;
    }
    this.longName = undefined;
    this.paxPath = undefined;
    this.paxSize = undefined;
    const slash = name.endsWith("/");
    if (type === "5" || ((type === "0" || type === "\0") && slash)) {
      this.tree.directory(name);
      this.remaining = size;
      this.pad = (512 - (size % 512)) % 512;
      this.mode = "skip";
      if (size === 0) this.bodyDone();
      return;
    }
    if (type === "0" || type === "\0") {
      this.tree.expect(size, name);
      const { fd, full } = this.tree.file(name);
      this.fd = fd;
      this.full = full;
      this.cur = { name, exec: (mode & 0o111) !== 0, size };
      this.remaining = size;
      this.pad = (512 - (size % 512)) % 512;
      this.mode = "data";
      if (size === 0) this.bodyDone();
      return;
    }
    if (type === "1" || type === "2") throw unsafe(name, "is a link; a component archive may not contain links");
    if (type === "3" || type === "4" || type === "6") throw unsafe(name, "is a device, a pipe or another special file");
    throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", `entry ${JSON.stringify(name)} has the tar type ${JSON.stringify(type)}, which is not supported`, name);
  }

  /** The body of the current entry has been read completely. */
  private bodyDone() {
    if (this.mode === "data") {
      fs.closeSync(this.fd!);
      this.fd = null;
      if (this.cur!.exec) makeExecutable(this.full, 0o755);
      this.cur = null;
    } else if (this.mode === "meta") {
      const body = Buffer.concat(this.metaChunks);
      if (this.metaKind === "L") this.longName = cString(body);
      else if (this.metaKind === "x") {
        const rec = paxRecords(body);
        if (rec.has("path")) this.paxPath = rec.get("path");
        if (rec.has("size")) {
          const n = Number(rec.get("size"));
          if (!Number.isSafeInteger(n) || n < 0) throw corrupt("a pax size is not a number");
          this.paxSize = n;
        }
      }
    }
    if (this.pad > 0) {
      this.mode = "skip";
      this.remaining = this.pad;
      this.pad = 0;
    } else this.mode = "header";
    if (this.mode === "skip" && this.remaining === 0) this.mode = "header";
  }

  /** Closes the file being written, after a failure. */
  abort() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* the file is incomplete anyway */ }
      this.fd = null;
    }
  }

  finish() {
    this.abort();
    if (this.mode !== "end") throw corrupt("the tar archive ends early (it has no closing empty blocks): it is incomplete");
  }
}

async function extractTar(file: string, gz: boolean, tree: Tree): Promise<void> {
  const sink = new TarSink(tree);
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      try { sink.write(chunk); cb(); } catch (e) { cb(e as Error); }
    }
  });
  try {
    if (gz) await pipeline(fs.createReadStream(file), zlib.createGunzip(), out);
    else await pipeline(fs.createReadStream(file), out);
  } catch (e) {
    sink.abort();
    if (e instanceof ArchiveError) throw e;
    if ((e as NodeJS.ErrnoException).code?.startsWith("Z_")) throw corrupt(`the archive can not be decompressed: ${(e as Error).message}`);
    throw e;
  }
  sink.finish();
}

// ---- zip ---------------------------------------------------------------------------------------------------------------

type ZipEntry = { name: string; method: number; crc: number; csize: number; usize: number; offset: number; mode: number | null; exec: boolean; dir: boolean };

function readAt(fd: number, position: number, length: number): Buffer {
  const b = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, b, got, length - got, position + got);
    if (n === 0) throw corrupt("the zip file ends early");
    got += n;
  }
  return b;
}

function zipDirectory(fd: number, size: number): ZipEntry[] {
  if (size < 22) throw corrupt("the file is too short to be a zip archive");
  const tail = readAt(fd, Math.max(0, size - 65557), Math.min(size, 65557));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) throw corrupt("the file is not a zip archive (no end-of-directory record)");
  const disk = tail.readUInt16LE(eocd + 4), cdDisk = tail.readUInt16LE(eocd + 6);
  const here = tail.readUInt16LE(eocd + 8), total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || here !== total) throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", "a zip archive in several parts is not supported");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", "zip64 archives are not supported");
  if (cdOffset + cdSize > size) throw corrupt("the zip directory lies outside the file");
  const cd = readAt(fd, cdOffset, cdSize);
  const out: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw corrupt("the zip directory is damaged");
    const madeBy = cd.readUInt16LE(p + 4), flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const ext = cd.readUInt32LE(p + 38), offset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw corrupt("a zip directory entry runs past the directory");
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if ((flags & 1) !== 0) throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", `entry ${JSON.stringify(name)} is encrypted`, name);
    if (method !== 0 && method !== 8) throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", `entry ${JSON.stringify(name)} uses compression method ${method}`, name);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", "zip64 entries are not supported", name);
    const unix = madeBy >> 8 === 3 ? ext >>> 16 : null;
    const kind = unix === null ? 0 : unix & 0o170000;
    if (kind === 0o120000) throw unsafe(name, "is a link; a component archive may not contain links");
    if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) throw unsafe(name, "is a device, a pipe or another special file");
    const dir = /[\\/]$/.test(name) || kind === 0o040000 || (ext & 0x10) !== 0;
    out.push({ name, method, crc, csize, usize, offset, mode: unix, exec: unix !== null && (unix & 0o111) !== 0, dir });
  }
  if (p !== cd.length) throw corrupt("the zip directory has bytes that belong to no entry");
  return out;
}

class CrcCounter extends Writable {
  crc = 0;
  count = 0;
  constructor(private readonly fd: number, private readonly entry: ZipEntry, private readonly tree: Tree) { super(); }
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    try {
      this.count += chunk.length;
      if (this.count > this.entry.usize) throw corrupt(`entry ${JSON.stringify(this.entry.name)} is longer than its directory says`);
      this.tree.addBytes(chunk.length, this.entry.name);
      this.crc = zlib.crc32(chunk, this.crc);
      let w = 0;
      while (w < chunk.length) w += fs.writeSync(this.fd, chunk, w, chunk.length - w);
      cb();
    } catch (e) { cb(e as Error); }
  }
}

async function extractZip(file: string, tree: Tree): Promise<void> {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const entries = zipDirectory(fd, size);
    const cdStart = (() => {
      const tail = readAt(fd, Math.max(0, size - 65557), Math.min(size, 65557));
      for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) return tail.readUInt32LE(i + 16);
      return size;
    })();
    let declared = 0;
    for (const e of entries) {
      declared += e.usize;
      if (declared > tree.limits.maxBytes) throw new ArchiveError("E_ARCHIVE_TOO_LARGE", `the zip archive declares more than the ${tree.limits.maxBytes} bytes the manifest allows`);
      if (entries.length > tree.limits.maxEntries) throw new ArchiveError("E_ARCHIVE_TOO_LARGE", `the archive has more than ${tree.limits.maxEntries} entries`);
    }
    for (const e of entries) {
      if (e.dir) {
        tree.directory(e.name);
        continue;
      }
      if (e.method === 0 && e.csize !== e.usize) throw corrupt(`entry ${JSON.stringify(e.name)} is stored but its two sizes differ`);
      const local = readAt(fd, e.offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw corrupt(`entry ${JSON.stringify(e.name)} has no local header where the directory says`);
      const nameLen = local.readUInt16LE(26), extraLen = local.readUInt16LE(28);
      const localName = readAt(fd, e.offset + 30, nameLen).toString("utf8");
      if (localName !== e.name) throw corrupt(`entry ${JSON.stringify(e.name)} has another name in its local header`);
      const start = e.offset + 30 + nameLen + extraLen;
      if (start + e.csize > cdStart) throw corrupt(`entry ${JSON.stringify(e.name)} runs into the zip directory`);
      tree.expect(e.usize, e.name);
      const { fd: out, full } = tree.file(e.name);
      let counter: CrcCounter | null = null;
      try {
        counter = new CrcCounter(out, e, tree);
        if (e.csize > 0) {
          const raw = fs.createReadStream(file, { start, end: start + e.csize - 1 });
          try {
            if (e.method === 8) await pipeline(raw, zlib.createInflateRaw(), counter);
            else await pipeline(raw, counter);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code?.startsWith("Z_")) throw corrupt(`entry ${JSON.stringify(e.name)} can not be decompressed: ${(err as Error).message}`);
            throw err;
          }
        } else if (e.usize !== 0) throw corrupt(`entry ${JSON.stringify(e.name)} has no data but a length`);
      } finally {
        fs.closeSync(out);
      }
      if (counter!.count !== e.usize) throw corrupt(`entry ${JSON.stringify(e.name)} is shorter than its directory says`);
      if (counter!.crc >>> 0 !== e.crc) throw corrupt(`entry ${JSON.stringify(e.name)} fails its checksum`);
      if (e.exec) makeExecutable(full, 0o755);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---- entry point -------------------------------------------------------------------------------------------------------

export const ARCHIVE_KINDS = ["tar.gz", "zip"] as const;

/** Extracts `file` (kind `tar.gz` or `zip`) into the new or empty folder `dest`, within `limits`. See the notes at the top. */
export async function extractArchive(file: string, kind: string, dest: string, limits: ExtractLimits): Promise<ExtractResult> {
  try {
    if (kind !== "tar.gz" && kind !== "zip") throw new ArchiveError("E_ARCHIVE_UNSUPPORTED", `the archive type ${JSON.stringify(kind)} is not supported (tar.gz and zip are)`);
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) throw new ArchiveError("E_ARCHIVE_TOO_LARGE", "no byte limit was given for the extraction");
    const root = prepareDestination(dest);
    const tree = new Tree(root, { maxBytes: limits.maxBytes, maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES });
    if (kind === "zip") await extractZip(file, tree);
    else await extractTar(file, true, tree);
    return { ok: true, files: tree.files, directories: tree.directories, bytes: tree.bytes, paths: tree.paths.sort() };
  } catch (e) {
    if (e instanceof ArchiveError) return { ok: false, error: { code: e.code, ...(e.entry ? { field: e.entry } : {}), message: e.message } };
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOSPC") return { ok: false, error: { code: "E_DISK_SPACE", message: "the disk is full while unpacking" } };
    return { ok: false, error: { code: "E_INSTALL_FAILED", message: `unpacking failed: ${err.message}` } };
  }
}
