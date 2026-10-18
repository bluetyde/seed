import zlib from "node:zlib";

/** Builders for small tar and zip archives, including malicious and damaged ones, for the extraction and installer tests. */

export type TarEntry = {
  name: string;
  /** Default: a regular file. `5` folder, `2` symlink, `1` hard link, `3` char device, `6` fifo, `x` pax, `L` GNU long name. */
  type?: string;
  data?: Buffer | string;
  mode?: number;
  linkname?: string;
  /** Written in the ustar prefix field (the name field then holds `name`). */
  prefix?: string;
};

const octal = (n: number, width: number) => Buffer.from(n.toString(8).padStart(width - 1, "0") + "\0", "latin1");

function tarHeader(e: TarEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(e.name.slice(0, 100), 0, "utf8");
  octal(e.mode ?? 0o644, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(0, 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write(e.type ?? "0", 156, "latin1");
  if (e.linkname) h.write(e.linkname, 157, "utf8");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  if (e.prefix) h.write(e.prefix, 345, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return h;
}

function tarBlock(e: TarEntry): Buffer {
  const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(e, data.length), data, pad]);
}

/** A pax extended header record block (`{path: "..."}`), for use before the entry it applies to. */
export function paxEntry(fields: Record<string, string>): TarEntry {
  const recs = Object.entries(fields).map(([k, v]) => {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (String(len).length + body.length !== len) len = String(len).length + body.length;
    return `${len}${body}`;
  });
  return { name: "PaxHeader", type: "x", data: recs.join("") };
}

export type TarOptions = {
  /** Leave off the two closing empty blocks. */
  noEnd?: boolean;
  /** Add this many bytes of zero padding after the closing blocks (tar writes whole records). */
  recordPad?: boolean;
  /** Flip one byte of the header of entry i (to break its checksum). */
  corruptHeader?: number;
  /** Cut the archive to this many bytes. */
  truncateTo?: number;
};

export function makeTar(entries: TarEntry[], opts: TarOptions = {}): Buffer {
  const parts = entries.map((e, i) => {
    const b = tarBlock(e);
    if (opts.corruptHeader === i) b[10] = (b[10]! ^ 0x55) & 0xff;
    return b;
  });
  if (!opts.noEnd) parts.push(Buffer.alloc(1024));
  let all = Buffer.concat(parts);
  if (opts.recordPad && !opts.noEnd) all = Buffer.concat([all, Buffer.alloc((10240 - (all.length % 10240)) % 10240)]);
  return opts.truncateTo !== undefined ? all.subarray(0, opts.truncateTo) : all;
}

export const makeTarGz = (entries: TarEntry[], opts: TarOptions = {}) => zlib.gzipSync(makeTar(entries, opts));

export type ZipEntry = {
  name: string;
  data?: Buffer | string;
  /** 0 stored, 8 deflate (default). */
  method?: 0 | 8;
  /** Unix mode, with the file type bits (0o100644, 0o120777, ...). Written as made on Unix. */
  unixMode?: number;
  /** Written as the entry's CRC instead of the real one. */
  crc?: number;
  /** The name in the local header, when it should differ from the directory's. */
  localName?: string;
  /** General purpose flags (bit 0 = encrypted). */
  flags?: number;
  /** Claim this uncompressed size in the directory instead of the real one. */
  claimSize?: number;
};

export function makeZip(entries: ZipEntry[], opts: { comment?: string } = {}): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 && raw.length > 0 ? zlib.deflateRawSync(raw) : raw;
    const crc = e.crc ?? zlib.crc32(raw);
    const nameLocal = Buffer.from(e.localName ?? e.name, "utf8");
    const nameCentral = Buffer.from(e.name, "utf8");
    const usize = e.claimSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameLocal.length, 26);
    const entryBytes = Buffer.concat([local, nameLocal, body]);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.flags ?? 0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(usize, 24);
    cd.writeUInt16LE(nameCentral.length, 28);
    cd.writeUInt32LE(e.unixMode === undefined ? 0 : (e.unixMode << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameCentral]));
    out.push(entryBytes);
    offset += entryBytes.length;
  }
  const cdBytes = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...out, cdBytes, eocd, comment]);
}
