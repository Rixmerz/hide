// In-app flow for Claude Code builds that load function hooks ("mods").
//
// A prompt holding a secret is dropped at `prompt.submit`, before it enters
// the session, so neither the model nor the transcript ever gets it. A pane
// inside Claude Code asks for a variable name, the value goes to the keychain
// (scripts/bridge.mjs), and the clean prompt, with `$NAME` in place of the
// value, is submitted again as the person's own words. No side terminal, no
// keystroke injection, no clipboard.
//
// Anything this module can't handle (a headless run, a prompt with images,
// a pane that can't be placed, a failing bridge) goes on to the classic
// UserPromptSubmit hook (scripts/hook.mjs), which still blocks it.
//
// Values never enter `$.state`: the pane draws masked previews only.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { VAR_NAME, detectSecrets, preview, replaceAll, toVarName } from '../lib/detect.mjs'
import type { HideAsk } from '../types'

type Secret = { value: string; kind: string; suggested: string }

const PANE = 'hide'
const ask = atom({ plugin: 'hide', key: 'ask' } as const, null)

async function bridge<T>($: EngineInterface, mode: string, input?: unknown): Promise<T> {
  const run = await $.process.run(['node', `${$.plugin.root}/scripts/bridge.mjs`, mode], {
    stdin: input === undefined ? undefined : JSON.stringify(input),
    timeoutMs: 20_000,
  })
  if (run.exitCode !== 0) throw new Error(run.stderr.trim() || `bridge ${mode} exited ${run.exitCode}`)
  return JSON.parse(run.stdout) as T
}

// The prompt being named and its secrets' values: module memory only, so a
// reload forgets them (the pane then offers only to close).
let pending: { text: string; secrets: Secret[] } | null = null
// What the person has typed in the name field since it was last drawn.
let typed = ''

function redacted(p: { text: string; secrets: Secret[] }) {
  return p.secrets.reduce((text, s) => replaceAll(text, s.value, '[hide:REDACTED]'), p.text)
}

async function finish($: EngineInterface, names: (string | null)[] | null) {
  const p = pending
  pending = null
  typed = ''
  if (p === null) {
    await update($, ask, () => null)
    await $.ui.close({ id: PANE })
    return
  }
  await update($, ask, a => (a ? { ...a, isSaving: true, error: undefined } : a))

  const stored = names ? p.secrets.flatMap((s, i) => (names[i] ? [{ name: names[i], value: s.value, kind: s.kind }] : [])) : []
  const skipped = names ? p.secrets.filter((_, i) => !names[i]).map(s => s.value) : []
  try {
    await bridge($, 'commit', { stored, skipped, redacted: names ? [] : p.secrets.map(s => s.value) })
  } catch (error) {
    await update($, ask, () => null)
    await $.ui.close({ id: PANE })
    await $.prompt.fill({ text: redacted(p) })
    $.ui.toast(`hide: could not store the secret (${(error as Error).message}). Your prompt is back in the input with it removed.`)
    return
  }

  await update($, ask, () => null)
  await $.ui.close({ id: PANE })

  if (names === null) {
    await $.prompt.fill({ text: redacted(p) })
    $.ui.toast('hide: nothing stored. Your prompt is back in the input with the secret removed.')
    return
  }
  const clean = stored.reduce((text, s) => replaceAll(text, s.value, `$${s.name}`), p.text)
  if (stored.length) $.ui.toast(`hide: stored ${stored.map(s => `$${s.name}`).join(', ')} in the keychain`)
  await $.prompt.submit({ text: clean, asUser: true })
}

async function choose($: EngineInterface, raw: string) {
  const a = await read($, ask)
  if (a === null || a.isSaving) return
  const candidate = a.candidates[a.names.length]
  if (candidate === undefined) return
  const name = raw.trim() ? toVarName(raw.trim()) : candidate.suggested
  let error: string | undefined
  if (!VAR_NAME.test(name)) error = 'Use letters, digits and _ only, not starting with a digit.'
  else if (a.names.includes(name)) error = `${name} is already used by another secret in this prompt.`
  if (error) return update($, ask, x => (x ? { ...x, error } : x))
  if (a.existing.includes(name) && a.confirm !== name) {
    return update($, ask, x => (x ? { ...x, confirm: name, error: undefined } : x))
  }
  return answer($, name)
}

async function answer($: EngineInterface, name: string | null) {
  typed = ''
  const a = await update($, ask, x => (x ? { ...x, names: [...x.names, name], confirm: undefined, error: undefined } : x))
  if (a && a.names.length === a.candidates.length) await finish($, a.names)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hide', description: 'List the secrets hide keeps in the keychain (names only)' })
    return next(e)
  })

  on('command.run', { command: 'hide' }, async $ => {
    const index = await bridge<Record<string, { kind?: string; updatedAt?: string }>>($, 'index')
    const names = Object.keys(index).sort((x, y) => x.localeCompare(y))
    if (names.length === 0) return { text: 'hide: no secrets stored. Paste one in a prompt and hide will offer to store it.' }
    const rows = names.map(n => `- \`$${n}\` ${index[n]?.kind ?? ''} ${(index[n]?.updatedAt ?? '').slice(0, 10)}`.trimEnd())
    return { text: `hide: ${names.length} secret${names.length === 1 ? '' : 's'} in the keychain\n${rows.join('\n')}` }
  })

  on('prompt.submit', async ($, e, next) => {
    // No one to ask in a headless run, and a dropped prompt can't be resent
    // with its images: the classic hook blocks those as before.
    if (e.origin?.kind === 'sdk' || e.attachments?.length) return next(e)
    const found = detectSecrets(e.text) as Secret[]
    if (found.length === 0) return next(e)

    let secrets: Secret[]
    let existing: string[]
    try {
      const allowed = await bridge<boolean[]>($, 'allowed', found.map(s => s.value))
      secrets = found.filter((_, i) => !allowed[i])
      if (secrets.length === 0) return next(e)
      existing = Object.keys(await bridge<Record<string, unknown>>($, 'index'))
    } catch {
      return next(e)
    }

    if (pending !== null) {
      return { drop: 'hide: this prompt holds a secret too. Finish naming the one in the hide pane first, then send it again. Claude has not seen it.' }
    }

    pending = { text: e.text, secrets }
    typed = ''
    const state: HideAsk = {
      candidates: secrets.map(s => ({ preview: preview(s.value), kind: s.kind, suggested: s.suggested })),
      names: [],
      existing,
    }
    await update($, ask, () => state)
    const opened = await $.ui.open({ id: PANE, title: 'hide', focus: true, closeOnEscape: true, holdToasts: true, rows: 10 })
    if (!opened.isPlaced) {
      pending = null
      await update($, ask, () => null)
      await $.ui.close({ id: PANE })
      return next(e)
    }
    const summary = state.candidates.map(c => `${c.kind} ${c.preview}`).join(', ')
    return { drop: `hide: held back a prompt holding a secret (${summary}). Claude has not seen it. Name it in the hide pane.` }
  })

  // Esc or the close mark: the person changed their mind. Nothing is stored
  // and the prompt comes back to the input without the secret.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && pending !== null) await finish($, null)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const a = await read($, ask)

    const c = a?.candidates[a.names.length]
    if (a === null || c === undefined || pending === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No secret is waiting to be named.</Text>
          <Button key="close" role="dismiss" onPress={() => finish($, null)}>Close</Button>
        </Box>
      )
    }
    if (a.isSaving) return <Text dimColor>Storing in the keychain…</Text>

    const i = a.names.length
    const step = a.candidates.length > 1 ? `[${i + 1}/${a.candidates.length}] ` : ''

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Secret held back.</Text>
          <Text dimColor> Claude has not seen this prompt.</Text>
        </Text>
        <Text>
          {step}
          <Text bold>{c.kind}</Text> {c.preview}
        </Text>
        {'Input' in els ? (
          <els.Input
            key="name"
            label="Variable name: "
            value={a.confirm ?? c.suggested}
            placeholder={c.suggested}
            submitLabel={a.confirm ? 'overwrite' : 'store'}
            autoFocus
            onInput={value => {
              typed = value
            }}
            onSubmit={value => choose($, value)}
          />
        ) : (
          <Text>
            Variable name: <Text bold>{c.suggested}</Text>
          </Text>
        )}
        {a.error ? <Text color="error">{a.error}</Text> : null}
        {a.confirm ? <Text color="warning">${a.confirm} already exists. Store again to overwrite it.</Text> : null}
        <Box flexDirection="row" gap={1}>
          <Button key="store" variant="primary" onPress={() => choose($, typed)}>
            {a.confirm ? 'Overwrite' : 'Store'}
          </Button>
          <Button key="skip" onPress={() => answer($, null)}>Not a secret</Button>
          <Button key="cancel" role="dismiss" onPress={() => finish($, null)}>Cancel</Button>
        </Box>
        <Text dimColor>The value goes to the OS keychain. Claude only gets its name.</Text>
      </Box>
    )
  })
}
