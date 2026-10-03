import { expect, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

// Assembled from an obviously fake filler, as test/fixtures.mjs does, so no
// literal here looks like a real credential to a secret scanner.
const KEY = ['sk', 'proj', 'FAKE0fake1'.repeat(5)].join('-')
const PANE = {
  component: 'Pane',
  requestId: 'hide',
  props: {
    title: 'hide',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// A prompt as the person sends it with Enter.
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

// Stands in for scripts/bridge.mjs and records what reached it.
function fakeBridge(on: On, existing: string[] = []) {
  const calls: { mode: string; input: unknown }[] = []
  on('process.run', ($, e) => {
    const mode = e.argv[2] ?? ''
    const input = e.init?.stdin ? JSON.parse(e.init.stdin) : undefined
    calls.push({ mode, input })
    const out =
      mode === 'allowed' ? (input as unknown[]).map(() => false)
      : mode === 'index' ? Object.fromEntries(existing.map(n => [n, { kind: 'openai' }]))
      : { stored: [] }
    const result: ProcessRunResult = {
      exitCode: 0,
      stdout: JSON.stringify(out),
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    }
    return { value: result }
  })
  return calls
}

// Stands in for the surface: panes are placed, closes and fills recorded.
function surface(on: On, placed = true) {
  const seen = { opened: 0, closed: 0, filled: [] as string[] }
  on('ui.open', () => {
    seen.opened += 1
    return { value: placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'too narrow' } }
  })
  on('ui.close', () => {
    seen.closed += 1
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  return seen
}

// Records the prompts that reach the engine beneath the plugin.
function prompts(on: On) {
  const seen: string[] = []
  on('prompt.submit', ($, e) => {
    seen.push(e.text)
    return { text: e.text }
  })
  return seen
}

test('a prompt without secrets goes through untouched', async ($, on) => {
  const calls = fakeBridge(on)
  const seen = prompts(on)
  surface(on)
  await $.prompt.submit(typed('list the files here'))
  expect(seen).toEqual(['list the files here'])
  expect(calls).toHaveLength(0)
})

test('a secret is held back, named in the pane and the clean prompt sent', async ($, on) => {
  const calls = fakeBridge(on)
  const seen = prompts(on)
  surface(on)
  await $.prompt.submit(typed(`call the API with ${KEY} please`))
  expect(seen).toEqual([])

  const ui = await $.ui.mount({ plugin: 'hide', surface: 'terminal', ...PANE })
  expect((await ui.find({ type: 'Text', text: /openai/ }))?.text).toContain('sk-pro')
  expect(JSON.stringify(await ui.find({ key: 'name' }))).not.toContain(KEY)
  await ui.input({ key: 'name', text: 'my openai key' })
  await ui.unmount()

  const commit = calls.find(c => c.mode === 'commit')
  expect(commit?.input).toEqual({
    stored: [{ name: 'MY_OPENAI_KEY', value: KEY, kind: 'openai' }],
    skipped: [],
    redacted: [],
  })
  expect(seen).toEqual(['call the API with $MY_OPENAI_KEY please'])
})

test('an existing name asks for confirmation before it is overwritten', async ($, on) => {
  const calls = fakeBridge(on, ['OPENAI_API_KEY'])
  prompts(on)
  surface(on)
  await $.prompt.submit(typed(`key ${KEY}`))
  const ui = await $.ui.mount({ plugin: 'hide', surface: 'terminal', ...PANE })
  await ui.input({ key: 'name', text: '' })
  expect(await ui.find({ type: 'Text', text: /already exists/ })).toBeDefined()
  expect(calls.some(c => c.mode === 'commit')).toBe(false)
  await ui.input({ key: 'name', text: 'OPENAI_API_KEY' })
  expect(calls.some(c => c.mode === 'commit')).toBe(true)
  await ui.unmount()
})

test('"Not a secret" lets the prompt through as written', async ($, on) => {
  const calls = fakeBridge(on)
  const seen = prompts(on)
  surface(on)
  await $.prompt.submit(typed(`token ${KEY}`))
  const ui = await $.ui.mount({ plugin: 'hide', surface: 'desktop', ...PANE })
  await ui.press({ key: 'skip' })
  await ui.unmount()
  expect(calls.find(c => c.mode === 'commit')?.input).toEqual({ stored: [], skipped: [KEY], redacted: [] })
  expect(seen).toEqual([`token ${KEY}`])
})

test('Cancel stores nothing and sends nothing', async ($, on) => {
  const calls = fakeBridge(on)
  const seen = prompts(on)
  const ui$ = surface(on)
  await $.prompt.submit(typed(`token ${KEY}`))
  const ui = await $.ui.mount({ plugin: 'hide', surface: 'terminal', ...PANE })
  await ui.press({ key: 'cancel' })
  await ui.unmount()
  expect(calls.find(c => c.mode === 'commit')?.input).toEqual({ stored: [], skipped: [], redacted: [KEY] })
  expect(seen).toEqual([])
  expect(ui$.filled).toEqual(['token [hide:REDACTED]'])
})

test('with no pane to ask in, the prompt goes on to the classic hook', async ($, on) => {
  fakeBridge(on)
  const seen = prompts(on)
  surface(on, false)
  await $.prompt.submit(typed(`token ${KEY}`))
  expect(seen).toEqual([`token ${KEY}`])
})

test('where no field can be drawn, Store takes the suggested name', async ($, on) => {
  const calls = fakeBridge(on)
  const seen = prompts(on)
  surface(on)
  await $.prompt.submit(typed(`export OPENAI_KEY=${KEY}`))
  const ui = await $.ui.mount({ plugin: 'hide', surface: 'mobile', ...PANE })
  await ui.press({ key: 'store' })
  await ui.unmount()
  expect(calls.find(c => c.mode === 'commit')?.input).toEqual({
    stored: [{ name: 'OPENAI_KEY', value: KEY, kind: 'openai' }],
    skipped: [],
    redacted: [],
  })
  expect(seen).toEqual(['export OPENAI_KEY=$OPENAI_KEY'])
})
