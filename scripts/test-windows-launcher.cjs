// Exercise the actual batch launcher with isolated command stubs; no network or GUI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run({ installed = true, node = true, npm = true, installFails = false, startFails = false, input = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'SEED launcher spaces '));
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'Start SEED.cmd'), path.join(root, 'Start SEED.cmd'));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // A real executable is needed for where node.exe, but node's version check is real too.
    if (node) fs.copyFileSync(process.execPath, path.join(bin, 'node.exe'));
    if (npm) fs.writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\necho %*>>"%~dp0..\\calls.txt"\r\nif "%1"=="ci" exit /b ${installFails ? 1 : 0}\r\nexit /b ${startFails ? 1 : 0}\r\n`);
    if (installed) {
      fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
      for (const name of ['tsc', 'electron']) fs.writeFileSync(path.join(root, 'node_modules', '.bin', name + '.cmd'), '');
    }
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call "Start SEED.cmd"'], {
      cwd: root, windowsVerbatimArguments: true, input, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${bin};${process.env.SystemRoot}\\System32`, PATHEXT: '.COM;.EXE;.BAT;.CMD', NODE_OPTIONS: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.stderr, '');
    const calls = fs.existsSync(path.join(root, 'calls.txt')) ? fs.readFileSync(path.join(root, 'calls.txt'), 'utf8') : '';
    return { ...result, calls };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('Windows launcher', { skip: process.platform !== 'win32' }, async (t) => {
  await t.test('installed launch uses no installation command (offline path)', () => {
    const r = run(); assert.equal(r.status, 0); assert.equal(r.calls.trim(), 'start');
  });
  await t.test('first launch installs locked dev dependencies then starts', () => {
    const r = run({ installed: false, input: 'Y\r\n' }); assert.equal(r.status, 0);
    assert.match(r.calls, /^ci --include=dev --no-audit --no-fund\r?\nstart/m);
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
