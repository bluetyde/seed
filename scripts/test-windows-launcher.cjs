// Exercise the actual batch launcher with isolated command stubs; no network or GUI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// stamp: 'current' (installed from the present lockfile), 'stale' (lockfile changed since), 'none' (install never recorded)
function run({ installed = true, node = true, npm = true, installFails = false, noFolder = false, allowStderr = false, startFails = false, stamp = 'current', input = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'SEED launcher spaces '));
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'Start SEED.cmd'), path.join(root, 'Start SEED.cmd'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(__dirname, 'deps-stamp.cjs'), path.join(root, 'scripts', 'deps-stamp.cjs'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // A real executable is needed for where node.exe, but node's version check is real too.
    if (node) fs.copyFileSync(process.execPath, path.join(bin, 'node.exe'));
    // The npm stub records its calls; a successful "ci" creates node_modules like the real one.
    if (npm) fs.writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\necho %*>>"%~dp0..\\calls.txt"\r\nif "%1"=="ci" (\r\n  if ${installFails ? 1 : 0}==1 exit /b 1\r\n  ${noFolder ? '' : 'mkdir "%~dp0..\\node_modules\\.bin" 2>nul\r\n  type nul > "%~dp0..\\node_modules\\.bin\\tsc.cmd"\r\n  type nul > "%~dp0..\\node_modules\\.bin\\electron.cmd"\r\n'}  exit /b 0\r\n)\r\nexit /b ${startFails ? 1 : 0}\r\n`);
    if (installed) {
      fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
      for (const name of ['tsc', 'electron']) fs.writeFileSync(path.join(root, 'node_modules', '.bin', name + '.cmd'), '');
      if (stamp !== 'none') {
        const w = spawnSync(process.execPath, [path.join(root, 'scripts', 'deps-stamp.cjs'), 'write'], { encoding: 'utf8' });
        assert.equal(w.status, 0, w.stderr);
      }
      if (stamp === 'stale') fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    }
    const launch = (stdin) => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call "Start SEED.cmd"'], {
      cwd: root, windowsVerbatimArguments: true, input: stdin, encoding: 'utf8', timeout: 15000,
      // NoDefaultCurrentDirectoryInExePath (set on some machines) stops cmd from finding the launcher in the working folder.
      env: { ...process.env, PATH: `${bin};${process.env.SystemRoot}\\System32`, PATHEXT: '.COM;.EXE;.BAT;.CMD', NODE_OPTIONS: '', NoDefaultCurrentDirectoryInExePath: undefined },
    });
    const result = launch(input);
    assert.ifError(result.error);
    if (!allowStderr) assert.equal(result.stderr, '');
    const calls = fs.existsSync(path.join(root, 'calls.txt')) ? fs.readFileSync(path.join(root, 'calls.txt'), 'utf8') : '';
    const stampPath = path.join(root, 'node_modules', '.seed-deps-stamp');
    const stampOk = spawnSync(process.execPath, [path.join(root, 'scripts', 'deps-stamp.cjs'), 'check']).status === 0;
    // A second launch with no input shows whether the first one left a matching record.
    const again = result.status === 0 && fs.existsSync(stampPath) ? launch('') : null;
    return { ...result, calls, stampOk, again, callsAfter: fs.existsSync(path.join(root, 'calls.txt')) ? fs.readFileSync(path.join(root, 'calls.txt'), 'utf8') : '' };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('Windows launcher', { skip: process.platform !== 'win32' }, async (t) => {
  await t.test('installed launch with a current record uses no installation command (offline path)', () => {
    const r = run(); assert.equal(r.status, 0); assert.equal(r.calls.trim(), 'start'); assert.doesNotMatch(r.stdout, /dependency list changed/);
  });
  await t.test('first launch installs locked dev dependencies, records them, then starts; the next launch reuses them', () => {
    const r = run({ installed: false, input: 'Y\r\n' }); assert.equal(r.status, 0);
    assert.match(r.calls, /^ci --include=dev --no-audit --no-fund\r?\nstart/m);
    assert.equal(r.stampOk, true);
    assert.equal(r.again.status, 0); assert.equal(r.callsAfter.trim().split(/\r?\n/).filter((l) => l.startsWith('ci')).length, 1);
  });
  await t.test('a changed lockfile after an update asks to reinstall, installs, records and starts', () => {
    const r = run({ stamp: 'stale', input: 'Y\r\n' }); assert.equal(r.status, 0);
    assert.match(r.stdout, /dependency list changed/);
    assert.match(r.calls, /^ci --include=dev --no-audit --no-fund\r?\nstart/m);
    assert.equal(r.stampOk, true);
  });
  await t.test('an install that was never recorded (older install) asks once', () => {
    const r = run({ stamp: 'none', input: 'Y\r\n' }); assert.equal(r.status, 0);
    assert.match(r.stdout, /dependency list changed|was not recorded/);
    assert.match(r.calls, /^ci /m); assert.equal(r.stampOk, true);
  });
  await t.test('declining a changed-dependency reinstall never installs or launches', () => {
    const r = run({ stamp: 'stale', input: 'N\r\nx\r\n' }); assert.equal(r.status, 1); assert.equal(r.calls, ''); assert.match(r.stdout, /Setup cancelled/);
  });
  await t.test('a failed reinstall does not launch and does not record', () => {
    const r = run({ stamp: 'stale', installFails: true, input: 'Y\r\nx\r\n' }); assert.equal(r.status, 1); assert.doesNotMatch(r.calls, /start/); assert.match(r.stdout, /dependency setup failed/); assert.equal(r.stampOk, false);
  });
  await t.test('an install that leaves no record (the stamp cannot be written) does not launch', () => {
    const r = run({ installed: false, noFolder: true, allowStderr: true, input: 'Y\r\nx\r\n' }); assert.equal(r.status, 1); assert.match(r.calls, /^ci /m); assert.doesNotMatch(r.calls, /start/); assert.match(r.stdout, /dependency setup failed/); assert.match(r.stderr, /deps-stamp write failed/);
  });
  await t.test('declining setup never installs or launches', () => {
    const r = run({ installed: false, input: 'N\r\nx\r\n' }); assert.equal(r.status, 1); assert.equal(r.calls, ''); assert.match(r.stdout, /Setup cancelled/);
  });
  await t.test('failed installation does not launch and retains an error', () => {
    const r = run({ installed: false, installFails: true, input: 'Y\r\nx\r\n' }); assert.equal(r.status, 1); assert.doesNotMatch(r.calls, /start/); assert.match(r.stdout, /dependency setup failed/);
  });
  for (const missing of ['node', 'npm']) await t.test(`missing ${missing} gives prerequisites`, () => {
    const r = run({ [missing]: false, input: 'x\r\n' }); assert.equal(r.status, 1); assert.match(r.stdout, /requires Node.js 24/); assert.equal(r.calls, '');
  });
  await t.test('startup failure is visible and returns failure', () => {
    const r = run({ startFails: true, input: 'x\r\n' }); assert.equal(r.status, 1); assert.match(r.stdout, /could not start/); assert.match(r.stdout, /Press any key/i);
  });
});

// The stamp helper itself, on any platform.
test('deps-stamp helper', async (t) => {
  const make = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-stamp-'));
    fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'node_modules'));
    fs.copyFileSync(path.join(__dirname, 'deps-stamp.cjs'), path.join(root, 'scripts', 'deps-stamp.cjs'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"a":1}\n'); fs.writeFileSync(path.join(root, 'package-lock.json'), '{"b":2}\n');
    return { root, call: (verb) => spawnSync(process.execPath, [path.join(root, 'scripts', 'deps-stamp.cjs'), verb], { encoding: 'utf8' }) };
  };
  await t.test('no stamp is a mismatch; write then check matches; changing either file mismatches', () => {
    const { root, call } = make();
    try {
      assert.equal(call('check').status, 1);
      assert.equal(call('write').status, 0); assert.equal(call('check').status, 0);
      fs.writeFileSync(path.join(root, 'package-lock.json'), '{"b":3}\n'); assert.equal(call('check').status, 1);
      assert.equal(call('write').status, 0); assert.equal(call('check').status, 0);
      fs.writeFileSync(path.join(root, 'package.json'), '{"a":2}\n'); assert.equal(call('check').status, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  await t.test('write fails loudly without node_modules; a missing lockfile or unknown verb never reports a match', () => {
    const { root, call } = make();
    try {
      fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
      const w = call('write'); assert.equal(w.status, 1); assert.match(w.stderr, /failed/);
      fs.mkdirSync(path.join(root, 'node_modules')); assert.equal(call('write').status, 0);
      fs.rmSync(path.join(root, 'package-lock.json')); assert.equal(call('check').status, 1);
      assert.equal(call('bogus').status, 2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
