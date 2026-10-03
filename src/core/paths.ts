export type PathKind = "windows" | "wsl" | "posix" | "relative";
export type PathErrorCode = "E_PATH_INVALID" | "E_PATH_TRAVERSAL" | "E_PATH_UNMAPPABLE";
export type PathError = { code: PathErrorCode; field?: string; message: string };
export type PathResult<T> = { ok: true; value: T } | { ok: false; error: PathError };
export type MapOptions = { distro?: string; mntRoot?: string };

function ok<T>(value: T): PathResult<T> {
  return { ok: true, value };
}

function err<T = never>(code: PathErrorCode, message: string, field?: string): PathResult<T> {
  const error: PathError = { code, message };
  if (field !== undefined) {
    error.field = field;
  }
  return { ok: false, error };
}

type ParsedPath =
  | { kind: "drive"; drive: string; segments: string[]; normalized: string }
  | { kind: "unc"; server: string; share: string; segments: string[]; isWsl: boolean; normalized: string }
  | { kind: "posix"; segments: string[]; normalized: string }
  | { kind: "relative"; segments: string[]; normalized: string };

function validateMntRoot(mntRoot?: string): PathResult<string> {
  const root = mntRoot ?? "/mnt";
  if (root === "" || !root.startsWith("/") || root.endsWith("/") || root.includes("\0")) {
    return err("E_PATH_INVALID", "mntRoot must be an absolute POSIX path with no trailing slash");
  }
  return ok(root);
}

function parsePath(input: string): PathResult<ParsedPath> {
  if (typeof input !== "string" || input.length === 0) {
    return err("E_PATH_INVALID", "Path is empty");
  }
  if (input.includes("\0")) {
    return err("E_PATH_INVALID", "Path contains NUL character");
  }

  // Single leading backslash is invalid
  if (input.startsWith("\\") && !input.startsWith("\\\\")) {
    return err("E_PATH_INVALID", "Single leading backslash is invalid");
  }

  // Bare drive or drive-relative: C: or C:foo
  if (/^[A-Za-z]:(?:[^\\/]|$)/.test(input)) {
    return err("E_PATH_INVALID", "Bare drive or drive-relative path is invalid");
  }

  let effective = input;

  // Device and extended forms: \\?\... or \\.\...
  if (/^[\\/]{2}[?.][\\/]/.test(effective)) {
    const driveMatch = /^[\\/]{2}\?[\\/]([A-Za-z]:[\\/].*)$/.exec(effective);
    if (driveMatch && driveMatch[1] !== undefined) {
      effective = driveMatch[1];
    } else if (/^[\\/]{2}\?[\\/][A-Za-z]:(?:[^\\/]|$)/.test(effective)) {
      return err("E_PATH_INVALID", "Bare drive or drive-relative path is invalid");
    } else {
      const uncMatch = /^[\\/]{2}\?[\\/]UNC(?:[\\/](.*))?$/i.exec(effective);
      if (uncMatch) {
        const rest = uncMatch[1];
        if (!rest || rest === "") {
          return err("E_PATH_INVALID", "UNC path missing server and share");
        }
        effective = "\\\\" + rest;
      } else {
        return err("E_PATH_UNMAPPABLE", "Device paths are unmappable");
      }
    }
  }

  // Windows UNC: starts with \\
  if (effective.startsWith("\\\\")) {
    const parts = effective.slice(2).split(/[\\/]/).filter((s) => s !== "");
    if (parts.length < 2) {
      return err("E_PATH_INVALID", "UNC path missing share");
    }
    const server = parts[0]!;
    const share = parts[1]!;
    const rawSegments = parts.slice(2);

    const segments: string[] = [];
    for (const s of rawSegments) {
      if (s === ".") continue;
      if (s === "..") {
        if (segments.length === 0) {
          return err("E_PATH_TRAVERSAL", "Path escapes UNC share root");
        }
        segments.pop();
      } else {
        segments.push(s);
      }
    }

    const isWsl = server.toLowerCase() === "wsl$" || server.toLowerCase() === "wsl.localhost";
    const normServer = isWsl ? "wsl.localhost" : server;
    const normalized =
      segments.length === 0 ? `\\\\${normServer}\\${share}` : `\\\\${normServer}\\${share}\\${segments.join("\\")}`;

    return ok({ kind: "unc", server, share, segments, isWsl, normalized });
  }

  // Windows drive path: ^[A-Za-z]:[\\/]
  const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(effective);
  if (driveMatch && driveMatch[1] !== undefined && driveMatch[2] !== undefined) {
    const drive = driveMatch[1].toUpperCase();
    const raw = driveMatch[2].split(/[\\/]/);
    const segments: string[] = [];
    for (const s of raw) {
      if (s === "" || s === ".") continue;
      if (s === "..") {
        if (segments.length === 0) {
          return err("E_PATH_TRAVERSAL", "Path escapes drive root");
        }
        segments.pop();
      } else {
        segments.push(s);
      }
    }

    const normalized = segments.length === 0 ? `${drive}:\\` : `${drive}:\\${segments.join("\\")}`;
    return ok({ kind: "drive", drive, segments, normalized });
  }

  // POSIX path: starts with /
  if (effective.startsWith("/")) {
    const raw = effective.slice(1).split("/");
    const segments: string[] = [];
    for (const s of raw) {
      if (s === "" || s === ".") continue;
      if (s === "..") {
        if (segments.length === 0) {
          return err("E_PATH_TRAVERSAL", "Path escapes root");
        }
        segments.pop();
      } else {
        segments.push(s);
      }
    }

    const normalized = segments.length === 0 ? "/" : "/" + segments.join("/");
    return ok({ kind: "posix", segments, normalized });
  }

  // Relative path
  const raw = effective.split(/[\\/]/);
  const segments: string[] = [];
  for (const s of raw) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else {
        segments.push("..");
      }
    } else {
      segments.push(s);
    }
  }

  const normalized = segments.length === 0 ? "." : segments.join("/");
  return ok({ kind: "relative", segments, normalized });
}

export function classifyPath(
  input: string,
  opts?: { assumeWsl?: boolean }
): PathResult<{ kind: PathKind; normalized: string }> {
  const parsed = parsePath(input);
  if (!parsed.ok) return parsed;

  const p = parsed.value;
  switch (p.kind) {
    case "drive":
    case "unc":
      return ok({ kind: "windows", normalized: p.normalized });
    case "posix":
      return ok({ kind: opts?.assumeWsl ? "wsl" : "posix", normalized: p.normalized });
    case "relative":
      return ok({ kind: "relative", normalized: p.normalized });
  }
}

export function toWsl(input: string, opts?: MapOptions): PathResult<string> {
  const mntRootRes = validateMntRoot(opts?.mntRoot);
  if (!mntRootRes.ok) return mntRootRes;
  const mntRoot = mntRootRes.value;

  const parsed = parsePath(input);
  if (!parsed.ok) return parsed;

  const p = parsed.value;
  switch (p.kind) {
    case "drive": {
      const drive = p.drive.toLowerCase();
      if (p.segments.length === 0) {
        return ok(`${mntRoot}/${drive}`);
      }
      return ok(`${mntRoot}/${drive}/${p.segments.join("/")}`);
    }
    case "unc": {
      if (!p.isWsl) {
        return err("E_PATH_UNMAPPABLE", "UNC path has no WSL equivalent");
      }
      if (!opts?.distro) {
        return err("E_PATH_UNMAPPABLE", "Distro option required to map WSL-UNC path");
      }
      if (p.share.toLowerCase() !== opts.distro.toLowerCase()) {
        return err("E_PATH_UNMAPPABLE", `Distro in path (${p.share}) does not match target distro (${opts.distro})`);
      }
      if (p.segments.length === 0) {
        return ok("/");
      }
      return ok("/" + p.segments.join("/"));
    }
    case "posix": {
      return ok(p.normalized);
    }
    case "relative": {
      return err("E_PATH_INVALID", "Relative path cannot be mapped to WSL");
    }
  }
}

export function toWindows(input: string, opts?: MapOptions): PathResult<string> {
  const mntRootRes = validateMntRoot(opts?.mntRoot);
  if (!mntRootRes.ok) return mntRootRes;
  const mntRoot = mntRootRes.value;

  // In posix input, backslash inside a segment cannot be represented in Windows
  if (input.startsWith("/") && input.includes("\\")) {
    return err("E_PATH_INVALID", "POSIX path segment contains backslash");
  }

  const parsed = parsePath(input);
  if (!parsed.ok) return parsed;

  const p = parsed.value;
  switch (p.kind) {
    case "drive":
    case "unc": {
      return ok(p.normalized);
    }
    case "posix": {
      const mntSegments = mntRoot.slice(1).split("/");
      let isUnderMnt = false;
      let driveLetter = "";
      let remainingSegments: string[] = [];

      if (p.segments.length > mntSegments.length) {
        const matchesMnt = mntSegments.every((seg, idx) => seg === p.segments[idx]);
        if (matchesMnt) {
          const driveSeg = p.segments[mntSegments.length]!;
          if (/^[A-Za-z]$/.test(driveSeg)) {
            isUnderMnt = true;
            driveLetter = driveSeg.toUpperCase();
            remainingSegments = p.segments.slice(mntSegments.length + 1);
          }
        }
      }

      if (isUnderMnt) {
        if (remainingSegments.length === 0) {
          return ok(`${driveLetter}:\\`);
        }
        return ok(`${driveLetter}:\\${remainingSegments.join("\\")}`);
      }

      // Ordinary posix path inside WSL: maps to \\wsl.localhost\<distro>\...
      if (!opts?.distro) {
        return err("E_PATH_UNMAPPABLE", "Distro option required to map WSL path to Windows");
      }

      if (p.segments.length === 0) {
        return ok(`\\\\wsl.localhost\\${opts.distro}`);
      }
      return ok(`\\\\wsl.localhost\\${opts.distro}\\${p.segments.join("\\")}`);
    }
    case "relative": {
      return err("E_PATH_INVALID", "Relative path cannot be mapped to Windows");
    }
  }
}

export function isPortableRelative(p: string): PathResult<string> {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0") || p.length > 512) {
    return err("E_PATH_INVALID", "Invalid portable relative path");
  }

  const segments = p.split("/");
  if (segments.some((s) => s === "..")) {
    return err("E_PATH_TRAVERSAL", "Portable relative path must not contain traversal segment");
  }

  if (p.startsWith("/") || p.includes("\\") || p.includes(":") || segments.some((s) => s === "" || s === ".")) {
    return err("E_PATH_INVALID", "Portable relative path is malformed");
  }

  return ok(p);
}

export function toPortableRelative(p: string): PathResult<string> {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
    return err("E_PATH_INVALID", "Invalid relative path");
  }

  if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) {
    return err("E_PATH_INVALID", "Path has leading separator or drive prefix");
  }

  const converted = p.replace(/\\/g, "/");
  const rawSegments = converted.split("/");
  const segments: string[] = [];
  for (const s of rawSegments) {
    if (s === "" || s === ".") continue;
    segments.push(s);
  }

  if (segments.length === 0) {
    return err("E_PATH_INVALID", "Relative path resolved to empty");
  }

  const candidate = segments.join("/");
  return isPortableRelative(candidate);
}

export function resolveInside(root: string, rel: string, opts?: { caseInsensitive?: boolean }): PathResult<string> {
  if (typeof root !== "string" || root === "" || root.includes("\0")) {
    return err("E_PATH_INVALID", "Invalid root path");
  }
  if (typeof rel !== "string" || rel.includes("\0")) {
    return err("E_PATH_INVALID", "Invalid relative path");
  }

  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) {
    return err("E_PATH_TRAVERSAL", "rel must not be absolute or have a drive prefix");
  }

  const rootClass = classifyPath(root);
  if (!rootClass.ok || rootClass.value.kind === "relative") {
    return err("E_PATH_INVALID", "Root must be an absolute path");
  }

  const rootKind = rootClass.value.kind;
  const caseInsensitive = opts?.caseInsensitive ?? rootKind === "windows";

  let rootBase = "";
  let rootSegments: string[] = [];

  const norm = rootClass.value.normalized;
  if (norm.startsWith("\\\\") || norm.startsWith("//")) {
    const parts = norm.slice(2).split("\\");
    const server = parts[0]!;
    const share = parts[1]!;
    rootBase = `\\\\${server}\\${share}`;
    rootSegments = parts.slice(2);
  } else if (/^[A-Za-z]:[\\/]/.test(norm)) {
    rootBase = norm.slice(0, 2);
    const rest = norm.slice(3);
    rootSegments = rest === "" ? [] : rest.split("\\");
  } else {
    rootBase = "";
    rootSegments = norm === "/" ? [] : norm.slice(1).split("/");
  }

  const curSegments = [...rootSegments];
  const relSegments = rel.split(/[\\/]/);

  for (const s of relSegments) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (curSegments.length === 0) {
        return err("E_PATH_TRAVERSAL", "Path escapes root");
      }
      curSegments.pop();
    } else {
      curSegments.push(s);
    }
  }

  if (curSegments.length < rootSegments.length) {
    return err("E_PATH_TRAVERSAL", "Path escapes root");
  }

  for (let i = 0; i < rootSegments.length; i++) {
    const cur = curSegments[i]!;
    const expected = rootSegments[i]!;
    if (caseInsensitive) {
      if (cur.toLowerCase() !== expected.toLowerCase()) {
        return err("E_PATH_TRAVERSAL", "Path escapes root");
      }
    } else {
      if (cur !== expected) {
        return err("E_PATH_TRAVERSAL", "Path escapes root");
      }
    }
  }

  if (rootKind === "windows") {
    if (rootBase.startsWith("\\\\")) {
      if (curSegments.length === 0) {
        return ok(rootBase);
      }
      return ok(`${rootBase}\\${curSegments.join("\\")}`);
    } else {
      if (curSegments.length === 0) {
        return ok(`${rootBase}\\`);
      }
      return ok(`${rootBase}\\${curSegments.join("\\")}`);
    }
  } else {
    if (curSegments.length === 0) {
      return ok("/");
    }
    return ok("/" + curSegments.join("/"));
  }
}
