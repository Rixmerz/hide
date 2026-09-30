// Opens a terminal pane next to the one running Claude Code and runs a
// command in it. On macOS and Linux the command is written to a launcher
// script inside a private temp dir, so no terminal's own quoting rules come
// into play; on Windows the argv goes straight to wt.exe / cmd's start.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function shQuote(s) {
  return `'${String(s).replaceAll("'", String.raw`'\''`)}'`;
}

function osascript(script) {
  return spawnSync('osascript', ['-e', script], { encoding: 'utf8' }).status === 0;
}

// Tried in order; each returns true when it opened the pane.
const OPENERS = [
  {
    name: 'tmux',
    when: (env) => env.TMUX,
    open: (launcher) => spawnSync('tmux', ['split-window', '-h', '-l', '45%', `/bin/sh ${launcher}`]).status === 0,
  },
  {
    name: 'wezterm',
    when: (env) => env.WEZTERM_PANE,
    open: (_launcher, env, argv) =>
      spawnSync('wezterm', ['cli', 'split-pane', '--right', '--pane-id', env.WEZTERM_PANE, '--', ...argv]).status === 0,
  },
  {
    name: 'iterm2',
    when: (env) => env.TERM_PROGRAM === 'iTerm.app' && process.platform === 'darwin',
    // ITERM_SESSION_ID is "w0t1p0:<uuid>"; splitting that exact session keeps
    // the pane next to Claude even when another iTerm window has focus.
    open: (launcher, env) => {
      const id = (env.ITERM_SESSION_ID || '').split(':').pop();
      const cmd = `/bin/sh ${launcher}`;
      const byId = `
        tell application "iTerm2"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if unique id of s is "${id}" then
                  tell s to split vertically with default profile command "${cmd}"
                  return
                end if
              end repeat
            end repeat
          end repeat
          error "session not found"
        end tell`;
      const current = `tell application "iTerm2" to tell current session of current window to split vertically with default profile command "${cmd}"`;
      return (/^[0-9A-F-]+$/i.test(id) && osascript(byId)) || osascript(current);
    },
  },
  {
    name: 'windows-terminal',
    when: (env) => process.platform === 'win32' && env.WT_SESSION,
    open: (_launcher, _env, argv) =>
      spawnSync('wt.exe', ['-w', '0', 'split-pane', '-V', '--size', '0.45', ...argv], { windowsHide: true }).status === 0,
  },
  {
    name: 'windows-console',
    when: () => process.platform === 'win32',
    // `start` opens a new console window; the empty "" is its title. cmd does
    // its own parsing, so the line is built verbatim instead of letting Node
    // backslash-escape the quotes.
    open: (_launcher, _env, argv) =>
      spawnSync('cmd.exe', [`/d /c start "" ${argv.map((a) => `"${a}"`).join(' ')}`], {
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).status === 0,
  },
  {
    name: 'terminal-app',
    when: () => process.platform === 'darwin',
    open: (launcher) =>
      osascript(`tell application "Terminal"
        activate
        do script "/bin/sh ${launcher}; exit"
      end tell`),
  },
  {
    name: 'linux-terminal',
    when: () => process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    // Some of these block until the window closes, so launch detached.
    open: (launcher) => {
      const bin = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].find(
        (b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0,
      );
      if (!bin) return false;
      const args = bin === 'gnome-terminal' ? ['--', '/bin/sh', launcher] : ['-e', `/bin/sh ${launcher}`];
      spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
      return true;
    },
  },
];

// `dir` must come from fs.mkdtemp: its path has no spaces or quotes, which
// the AppleScript strings above rely on.
export function openPane(dir, argv, env = process.env) {
  // Test hooks: `none` opens nothing, `external` pretends a pane opened so a
  // test can answer through the files itself.
  if (env.HIDE_PANE === 'none') return null;
  if (env.HIDE_PANE === 'external') return 'external';
  const launcher = join(dir, 'launch.sh');
  if (process.platform !== 'win32') writeFileSync(launcher, `exec ${argv.map(shQuote).join(' ')}\n`, { mode: 0o700 });
  for (const opener of OPENERS) {
    if (opener.when(env) && opener.open(launcher, env, argv)) return opener.name;
  }
  return null;
}
