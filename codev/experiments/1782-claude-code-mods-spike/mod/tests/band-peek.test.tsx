import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 81 } } as const

// Candidates 5 (band) and 13 (issue peek), on both drawing surfaces.

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 76,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
  viewport: { columns: 81, rows: 30 },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'issue-peek',
  props: {
    title: '#1672',
    isFocused: true,
    bodyColumns: 76,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
  viewport: { columns: 81, rows: 40 },
} as const

const TOWER_1672 = {
  title: 'Lane Card: per-lane status card',
  state: 'OPEN',
  url: 'https://github.com/cluesmith/codev/issues/1672',
  body: 'Every lane gets one card.',
  labels: [{ name: 'area/vscode' }],
  comments: [
    { author: { login: 'old' }, createdAt: '2026-09-01T00:00:00Z', body: 'oldest comment' },
    { author: { login: 'vscode' }, createdAt: '2026-10-04T00:00:00Z', body: 'newest comment' },
  ],
}

// The world beneath: the engine's own answers the plugin passes through, Tower's
// GET /api/issue, the local key file. `opened` records each pane the plugin asked for.
function tower(on: On, fetched: string[], opened: string[] = []): void {
  mock.store(on)
  on('session.measure', async ($, e) => ({ changed: e.changed }))
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('session.cwd', async () => ({ value: '/repo/codev' }))
  on('ui.open', async ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  mock.env(on, { HOME: '/home/spike' })
  on('fs.read', async ($, e) => {
    expect(e.path).toBe('/home/spike/.agent-farm/local-key')
    return { value: 'test-key\n' }
  })
  on('http.fetch', async ($, e) => {
    fetched.push(e.url)
    expect(e.init?.headers?.['codev-tower-key']).toBe('test-key')
    expect(new URL(e.url).searchParams.get('workspace')).toBe('/repo/codev')
    const number = new URL(e.url).searchParams.get('number')
    if (number === '1672') {
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(TOWER_1672) } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: '{"error":"not found"}' } }
  })
}

async function completeTurn($: Engine, answer: string): Promise<void> {
  await $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('the band shows context percent and the save mark after session.measure', async ($, on) => {
  const fetched: string[] = []
  tower(on, fetched)
  await $.session.measure({
    context: { tokens: 150_000, window: 200_000, percent: 75 },
    rateLimits: [],
    changed: ['context'],
  })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'codev-spike', surface, ...BAND })
    expect((await ui.find({ key: 'context' }))?.text).toBe('context 75% · save at 70%')
    expect((await ui.find({ type: 'Text', text: /context 75%/ }))?.props.color).toBe('yellow')
    await ui.unmount()
  }
})

test('a reply naming issues grows one chip per reference; pressing one opens the peek pane', async ($, on) => {
  const fetched: string[] = []
  const opened: string[] = []
  tower(on, fetched, opened)
  const clock = mock.clock(on, { now: 1_000_000 })

  await completeTurn($, 'The spec at #1672 carries the rulings. PR #1131 is unaffected; #1672 again.')
  await clock.advance(1)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'codev-spike', surface, ...BAND })
    const first = await band.find({ key: 'chip-1672' })
    const second = await band.find({ key: 'chip-1131' })
    expect(first?.props.hotkey).toBe('1')
    // 76 cells shared by 2 chips, less hotkey and gap: 33 cells, so the title is cut.
    expect(first?.text).toBe('#1672 Lane Card: per-lane status…')
    expect(second?.props.hotkey).toBe('2')
    expect(second?.text).toBe('PR #1131')

    await band.press({ key: 'chip-1672' })
    expect(opened.at(-1)).toBe('issue-peek')

    const pane = await $.ui.mount({ plugin: 'codev-spike', surface, ...PANE })
    expect((await pane.find({ key: 'title' }))?.text).toBe('#1672 Lane Card: per-lane status card')
    expect((await pane.find({ key: 'meta' }))?.text).toBe('open · area/vscode')
    expect((await pane.find({ key: 'body' }))?.text).toContain('Every lane gets one card.')
    expect((await pane.find({ key: 'comment-0' }))?.text).toContain('newest comment')
    await pane.unmount()
    await band.unmount()
  }

  // One Tower round trip for #1672 (prefetch), then the $.store cache; #1131 tried once.
  expect(fetched.filter(url => url.includes('number=1672'))).toHaveLength(1)
})

test('/issue N opens the same pane, and an unknown issue shows the error', async ($, on) => {
  const fetched: string[] = []
  tower(on, fetched)
  mock.clock(on, { now: 5_000 })

  const ok = await $.command.run({ command: 'issue', args: '#1672', ...RUN })
  expect(ok.text).toBe('Peeking at #1672.')
  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'codev-spike', surface, ...PANE })
    expect((await pane.find({ key: 'title' }))?.text).toContain('Lane Card')
    await pane.unmount()
  }

  await $.command.run({ command: 'issue', args: '99999', ...RUN })
  const pane = await $.ui.mount({ plugin: 'codev-spike', surface: 'terminal', ...PANE })
  expect((await pane.find({ key: 'error' }))?.text).toContain('404')
  await pane.unmount()

  const usage = await $.command.run({ command: 'issue', args: 'abc', ...RUN })
  expect(usage.text).toBe('Usage: /issue <number>')
})

test('a typed prompt naming an issue grows a chip too, and is passed on unchanged', async ($, on) => {
  const fetched: string[] = []
  tower(on, fetched)
  const clock = mock.clock(on, { now: 9_000 })
  const reached: string[] = []
  on('prompt.submit', async ($, e) => {
    reached.push(e.text)
    return { text: e.text }
  })

  await $.prompt.submit({ text: 'what is the state of #1672?', wait: false, origin: { kind: 'composer' } })
  await clock.advance(1)

  expect(reached).toEqual(['what is the state of #1672?'])
  const band = await $.ui.mount({ plugin: 'codev-spike', surface: 'terminal', ...BAND })
  expect((await band.find({ key: 'chip-1672' }))?.props.hotkey).toBe('1')
  await band.unmount()
})

// Not a behaviour: drives every non-guard hook 20 times and prints the engine's
// metering of each hook's own time (next and $ excluded), checked against 10 s.
test('own time of the band, peek and scrub hooks stays inside the 10 s budget', async ($, on) => {
  const fetched: string[] = []
  tower(on, fetched)
  const clock = mock.clock(on, { now: 20_000 })
  on('prompt.submit', async ($, e) => ({ text: e.text }))
  on('attribution.text', async ($, e) => ({ text: e.text }))

  for (let i = 0; i < 20; i += 1) {
    await $.session.measure({ context: { tokens: 1000 * i, window: 200_000, percent: i }, rateLimits: [], changed: ['context'] })
    await completeTurn($, `see #1672 and #${1700 + i}`)
    await $.prompt.submit({ text: `and #${1800 + i}?`, wait: false, origin: { kind: 'composer' } })
    await $.command.run({ command: 'issue', args: '1672', ...RUN })
    await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: x' })
    await clock.advance(1)
  }

  const { text = '' } = await $.command.run({ command: 'codev-spike-timings', args: '', ...RUN })
  const host = globalThis as { console?: { log: (line: string) => void } }
  host.console?.log(`band/peek/scrub timings (own ms):\n${text}`)
  for (const line of text.split('\n')) {
    const max = Number(/max=(\d+(?:\.\d+)?)ms/.exec(line)?.[1] ?? 'NaN')
    expect(max, line).toBeLessThan(10_000)
  }
})

test('chip titles are cut with an ellipsis to their share of the band, numbers kept whole', async ($, on) => {
  const fetched: string[] = []
  tower(on, fetched)
  const clock = mock.clock(on, { now: 40_000 })
  await $.session.measure({ context: { tokens: 12_000, window: 200_000, percent: 6 }, rateLimits: [], changed: ['context'] })
  await completeTurn($, 'See #1672 and #1761.')
  await clock.advance(1)

  // 1761 is unknown to the fake Tower: give it a long title through the cache.
  await $.command.run({ command: 'issue', args: '1672', ...RUN })
  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'codev-spike', surface, ...BAND, props: { ...BAND.props, bodyColumns: 60 } })
    const chip = await band.find({ key: 'chip-1672' })
    const label = String(chip?.props.label)
    // 60 cells, less the context line (24) and a gap, shared by 2 chips, less hotkey and gap: 12.
    expect(label.length).toBeLessThanOrEqual(12)
    expect(label.startsWith('#1672')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(String((await band.find({ key: 'chip-1761' }))?.props.label)).toBe('#1761')
    await band.unmount()
  }
})
