// Sends the clean prompt back into the Claude Code session it was blocked in.
// A UserPromptSubmit hook cannot rewrite a prompt, only block it, so the
// clean copy is typed into Claude's input the way a paste would be, then
// submitted with Enter. It is sent as a bracketed paste so a multi-line
// prompt is not submitted at its first newline.
//
// Only terminals that can write into a specific existing pane support this:
// tmux, WezTerm and iTerm2. Everywhere else the clean prompt goes to the
// clipboard instead.

import { spawnSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ESC = '\x1b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

function itermSessionId(env) {
  const id = (env.ITERM_SESSION_ID || '').split(':').pop();
  return /^[0-9A-F-]+$/i.test(id) ? id : null;
}

// The target is captured in the hook, where the env still names Claude's own pane.
export function resendTarget(env = process.env) {
  if (env.HIDE_RESEND === '0') return null;
  if (env.TMUX && env.TMUX_PANE) return { via: 'tmux', pane: env.TMUX_PANE };
  if (env.WEZTERM_PANE) return { via: 'wezterm', pane: env.WEZTERM_PANE };
  if (env.TERM_PROGRAM === 'iTerm.app' && process.platform === 'darwin' && itermSessionId(env)) {
    return { via: 'iterm2', session: itermSessionId(env) };
  }
  return null;
}

function tmux(target, text) {
  const load = spawnSync('tmux', ['load-buffer', '-b', 'hide-resend', '-'], { input: text });
  if (load.status !== 0) return false;
  // -p pastes with bracketed-paste markers when the app asked for them.
  if (spawnSync('tmux', ['paste-buffer', '-p', '-d', '-b', 'hide-resend', '-t', target.pane]).status !== 0) return false;
  return true;
}

function tmuxEnter(target) {
  return spawnSync('tmux', ['send-keys', '-t', target.pane, 'Enter']).status === 0;
}

function wezterm(target, text) {
  return spawnSync('wezterm', ['cli', 'send-text', '--pane-id', target.pane], { input: text }).status === 0;
}

function weztermEnter(target) {
  return spawnSync('wezterm', ['cli', 'send-text', '--no-paste', '--pane-id', target.pane], { input: '\r' }).status === 0;
}

// The text reaches AppleScript through a file, never spliced into the script.
function iterm(target, text) {
  const dir = mkdtempSync(join(tmpdir(), 'hide-resend-'));
  const file = join(dir, 'prompt.txt');
  try {
    writeFileSync(file, PASTE_START + text + PASTE_END, { mode: 0o600 });
    const script = `
      set t to read (POSIX file "${file}") as «class utf8»
      tell application "iTerm2"
        repeat with w in windows
          repeat with tb in tabs of w
            repeat with s in sessions of tb
              if unique id of s is "${target.session}" then
                tell s to write text t newline no
                return
              end if
            end repeat
          end repeat
        end repeat
        error "session not found"
      end tell`;
    return spawnSync('osascript', ['-e', script]).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function itermEnter(target) {
  const script = `
    tell application "iTerm2"
      repeat with w in windows
        repeat with tb in tabs of w
          repeat with s in sessions of tb
            if unique id of s is "${target.session}" then
              tell s to write text (ASCII character 13) newline no
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell`;
  return spawnSync('osascript', ['-e', script]).status === 0;
}

const SENDERS = {
  tmux: [tmux, tmuxEnter],
  wezterm: [wezterm, weztermEnter],
  iterm2: [iterm, itermEnter],
};

// iTerm2 is given the markers itself; tmux and WezTerm add them.
export async function resend(target, text) {
  const [paste, enter] = SENDERS[target.via];
  if (!paste(target, text)) return false;
  await sleep(400); // let Claude Code finish reading the paste before Enter
  return enter(target);
}
