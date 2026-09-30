// Secret storage in the OS keychain. Values never travel in argv (visible to
// `ps`): on macOS the command goes to `security -i` over stdin, on Linux
// `secret-tool` reads the value from stdin, and on Windows PowerShell reads it
// from stdin and encrypts it with DPAPI (the per-user key Credential Manager
// itself relies on) into %LOCALAPPDATA%\hide\secrets\NAME.bin.
//
// macOS stores the value base64-encoded: `security find-generic-password -w`
// prints non-printable values (newlines, as in a PEM key) as hex and printable
// ones as-is, so a raw value could not be read back unambiguously.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { VAR_NAME } from './detect.mjs';

export const SERVICE = process.env.HIDE_SERVICE || 'hide';
if (!/^[A-Za-z0-9._-]+$/.test(SERVICE)) throw new Error(`hide: invalid HIDE_SERVICE "${SERVICE}"`);

function configDir() {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'hide');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'hide');
}

export function indexPath() {
  return join(configDir(), 'index.json');
}

function dpapiPath(name) {
  return join(configDir(), 'secrets', `${name}.bin`);
}

// Both scripts take their file path from an env var and the value over stdin
// (base64, so the console code page cannot mangle it); nothing secret or
// user-supplied is spliced into PowerShell code.
const DPAPI_PROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  "$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')",
  '[IO.File]::WriteAllBytes($env:HIDE_DPAPI_FILE, $e)',
].join('; ');
const DPAPI_UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  '$e = [IO.File]::ReadAllBytes($env:HIDE_DPAPI_FILE)',
  "$b = [Security.Cryptography.ProtectedData]::Unprotect($e, $null, 'CurrentUser')",
  '[Console]::Out.Write([Convert]::ToBase64String($b))',
].join('; ');

function powershell(script, file, input) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HIDE_DPAPI_FILE: file },
  });
}

// The index lists names and metadata only, never values, so the SessionStart
// hook can tell Claude what exists without touching the keychain.
export function readIndex() {
  try {
    return JSON.parse(readFileSync(indexPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeIndex(index) {
  const file = indexPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

function backend() {
  const forced = process.env.HIDE_BACKEND;
  if (['plaintext-file-for-tests', 'keychain', 'secret-service', 'dpapi'].includes(forced)) return forced;
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'linux') return 'secret-service';
  if (process.platform === 'win32') return 'dpapi';
  throw new Error(`hide: no secure store for platform ${process.platform}`);
}

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8' });
  if (r.error) throw new Error(`hide: cannot run ${cmd}: ${r.error.message}`);
  return r;
}

function checkName(name) {
  if (!VAR_NAME.test(name)) throw new Error(`hide: invalid variable name "${name}" (use A-Z, 0-9, _)`);
}

export function saveSecret(name, value, meta = {}) {
  checkName(name);
  const b = backend();
  if (b === 'keychain') {
    const b64 = Buffer.from(value, 'utf8').toString('base64');
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${name} -l "${SERVICE}: ${name}" -w ${b64}\n`;
    const r = run('security', ['-i'], cmd);
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`hide: keychain write failed: ${r.stderr.trim()}`);
  } else if (b === 'secret-service') {
    const r = run('secret-tool', ['store', `--label=${SERVICE}: ${name}`, 'service', SERVICE, 'account', name], value);
    if (r.status !== 0) throw new Error(`hide: secret-tool store failed: ${r.stderr.trim()}`);
  } else if (b === 'dpapi') {
    mkdirSync(dirname(dpapiPath(name)), { recursive: true });
    const r = powershell(DPAPI_PROTECT, dpapiPath(name), Buffer.from(value, 'utf8').toString('base64'));
    if (r.status !== 0) throw new Error(`hide: DPAPI write failed: ${(r.stderr || r.error?.message || '').trim()}`);
  } else {
    const all = fileStore();
    all[name] = value;
    mkdirSync(dirname(fileStorePath()), { recursive: true, mode: 0o700 });
    writeFileSync(fileStorePath(), JSON.stringify(all), { mode: 0o600 });
  }
  const index = readIndex();
  index[name] = { ...index[name], ...meta, updatedAt: new Date().toISOString() };
  index[name].createdAt ??= index[name].updatedAt;
  writeIndex(index);
}

export function loadSecret(name) {
  checkName(name);
  const b = backend();
  if (b === 'keychain') {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    if (r.status !== 0) return null;
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  }
  if (b === 'secret-service') {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
    return r.status === 0 ? r.stdout : null;
  }
  if (b === 'dpapi') {
    const r = powershell(DPAPI_UNPROTECT, dpapiPath(name));
    return r.status === 0 && r.stdout ? Buffer.from(r.stdout.trim(), 'base64').toString('utf8') : null;
  }
  return fileStore()[name] ?? null;
}

export function deleteSecret(name) {
  checkName(name);
  const b = backend();
  if (b === 'keychain') run('security', ['delete-generic-password', '-s', SERVICE, '-a', name]);
  else if (b === 'secret-service') run('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
  else if (b === 'dpapi') rmSync(dpapiPath(name), { force: true });
  else {
    const all = fileStore();
    delete all[name];
    writeFileSync(fileStorePath(), JSON.stringify(all), { mode: 0o600 });
  }
  const index = readIndex();
  const existed = name in index;
  delete index[name];
  writeIndex(index);
  return existed;
}

// HIDE_BACKEND=plaintext-file-for-tests keeps values in a plain JSON file next
// to the index. It exists only so the test suite can run without a keychain.
function fileStorePath() {
  return join(dirname(indexPath()), 'test-store.json');
}

function fileStore() {
  try {
    return JSON.parse(readFileSync(fileStorePath(), 'utf8'));
  } catch {
    return {};
  }
}
