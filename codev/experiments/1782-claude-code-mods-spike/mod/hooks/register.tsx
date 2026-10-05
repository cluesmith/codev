// EXPERIMENT #1782 spike mod: four #1761 candidates in one hooks module.
//   1. Fail-closed guard on Bash (candidate 1)
//   2. Attribution scrub (candidate 6)
//   3. Context band (the band half of candidate 5)
//   4. Issue peek: band chips, a user-opened pane, /issue N (candidate 13)
// Plus one throwaway probe: /arch-init <name> submitted on /clear (live question 3).
//
// Never installed, never named in CLAUDE_CODE_PLUGIN_DIRS: it loads only when a
// person starts `claude --plugin-dir <this folder>` (see ../notes.md, Handoff).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextFill, IssueCard, IssueRef, Peek } from '../types'

// ---------------------------------------------------------------------------
// State the drawings read
// ---------------------------------------------------------------------------

const context = atom({ plugin: 'codev-spike', key: 'context' } as const, null)
const refs = atom({ plugin: 'codev-spike', key: 'refs' } as const, [])
const titles = atom({ plugin: 'codev-spike', key: 'titles' } as const, {})
const peek = atom({ plugin: 'codev-spike', key: 'peek' } as const, null)

const PANE = 'issue-peek'

// The /arch-save point the band marks. arch-save names no number; this is the
// figure the #1761 review's band mock used, a spike assumption only.
const SAVE_AT_PERCENT = 70

// ---------------------------------------------------------------------------
// Candidate 1: the guard. The worked example's list, plus ONE entry for
// `git checkout -- .` (vscode architect ruling A, 2026-10-05; the one deviation).
// ---------------------------------------------------------------------------

const FORBIDDEN = [
  { re: /\bgit\s+add\s+(-A|--all|\.)(\s|$)/, why: 'Stage files by path. Never git add -A, --all or .' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-fd|stash)\b/, why: 'Destroys uncommitted work. Ask the human first.' },
  { re: /\bgit\s+checkout\s+--\s+\.(\s|$)/, why: 'Destroys uncommitted work. Ask the human first.' },
  { re: /\bgit\s+worktree\s+remove\b|\bgit\s+branch\s+-D\s+builder\//, why: 'Builder worktrees are afx-managed. Use afx spawn --resume.' },
  { re: /\bgh\s+pr\s+merge\b.*--squash/, why: 'Merge with --merge. Squashing destroys the commit history.' },
]

const HOLD_QUESTION = 'porch approve records a human gate. Did the human give the word for this gate?'
const HOLD_YES = 'Yes, relayed verbatim'
const HOLD_DISMISSED =
  'The human dismissed the gate question, so porch approve was not run. Not approved: wait for the human to give the word; never retry to get the question again.'

// ---------------------------------------------------------------------------
// Measurement: a hook's own time, as the engine meters it (next and $ calls
// excluded), kept in $.store so /codev-spike-timings can print it.
// ---------------------------------------------------------------------------

type Budget = { readonly ms: number; readonly remainingMs: number }

function ownMs(budget: Budget): number {
  return budget.ms - budget.remainingMs
}

async function record($: EngineInterface, hook: string, ms: number): Promise<void> {
  const stored = (await $.store.get('timings')) as Record<string, number[]> | undefined
  const all = stored ?? {}
  const list = all[hook] ?? []
  list.push(ms)
  all[hook] = list.slice(-50)
  await $.store.set('timings', all)
}

// ---------------------------------------------------------------------------
// Candidate 13: issue lookup through Tower's forge getIssue path
// (GET /api/issue, the one #1412's terminal-link click uses).
// ---------------------------------------------------------------------------

const TOWER = 'http://localhost:4100'
const CACHE_MS = 10 * 60 * 1000
const REF_RE = /(PR\s+)?#(\d{2,6})\b/g

export function findRefs(text: string): IssueRef[] {
  const seen = new Set<string>()
  const found: IssueRef[] = []
  for (const match of text.matchAll(REF_RE)) {
    const number = match[2] ?? ''
    if (number === '' || seen.has(number)) {
      continue
    }
    seen.add(number)
    found.push({ number, isPR: match[1] !== undefined })
  }

  return found.slice(0, 9)
}

type TowerIssue = {
  title?: string
  state?: string
  url?: string
  body?: string
  labels?: { name?: string }[]
  comments?: { author?: { login?: string }; createdAt?: string; body?: string }[]
}

function toCard(number: string, raw: TowerIssue): IssueCard {
  const comments = (raw.comments ?? []).slice(-3).reverse()

  return {
    number,
    title: raw.title ?? '',
    state: raw.state ?? '',
    url: raw.url ?? '',
    labels: (raw.labels ?? []).map(label => label.name ?? '').filter(name => name !== ''),
    body: raw.body ?? '',
    comments: comments.map(c => ({
      author: c.author?.login ?? '?',
      createdAt: c.createdAt ?? '',
      body: c.body ?? '',
    })),
  }
}

async function towerIssue($: EngineInterface, number: string): Promise<IssueCard> {
  const home = await $.env.get('HOME')
  const key = (await $.fs.read(`${home ?? ''}/.agent-farm/local-key`)).trim()
  const workspace = await $.session.cwd()
  const query = `number=${encodeURIComponent(number)}&workspace=${encodeURIComponent(workspace)}`
  const response = await $.http.fetch(`${TOWER}/api/issue?${query}`, {
    headers: { 'codev-tower-key': key },
  })
  if (!response.ok) {
    throw new Error(`Tower answered ${response.status} for #${number}`)
  }

  return toCard(number, JSON.parse(response.text) as TowerIssue)
}

async function getIssue($: EngineInterface, number: string): Promise<IssueCard> {
  const cached = (await $.store.get(`issue:${number}`)) as { at: number; card: IssueCard } | undefined
  const now = await $.clock.now()
  if (cached !== undefined && now - cached.at < CACHE_MS) {
    return cached.card
  }
  const card = await towerIssue($, number)
  await $.store.set(`issue:${number}`, { at: now, card })

  return card
}

async function prefetchTitles($: EngineInterface, list: IssueRef[]): Promise<void> {
  for (const ref of list) {
    try {
      const card = await getIssue($, ref.number)
      await update($, titles, all => ({ ...all, [ref.number]: card.title }))
    } catch {
      // A title is a nicety: the chip shows the bare number.
    }
  }
}

async function openPeek($: EngineInterface, number: string): Promise<void> {
  const loading: Peek = { number }
  await update($, peek, () => loading)
  await $.ui.open({ id: PANE, title: `#${number}`, focus: true, closeOnEscape: true })
  try {
    const card = await getIssue($, number)
    await update($, peek, () => ({ number, card }))
  } catch (error) {
    let message = String(error)
    if (error instanceof Error) {
      message = error.message
    }
    await update($, peek, () => ({ number, error: message }))
  }
}

async function showRefs($: EngineInterface, text: string): Promise<void> {
  const found = findRefs(text)
  if (found.length === 0) {
    return
  }
  await update($, refs, () => found)
  $.clock.after(0, () => {
    prefetchTitles($, found)
  })
}

export function summarize(all: Record<string, number[]>): string {
  const lines = Object.entries(all).map(([hook, list]) => {
    const sorted = [...list].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const max = sorted[sorted.length - 1] ?? 0
    return `${hook}: n=${sorted.length} median=${median}ms max=${max}ms`
  })
  if (lines.length === 0) {
    return 'No timings recorded yet.'
  }

  return lines.join('\n')
}

export function ellipsize(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  if (max <= 1) {
    return '…'
  }

  return `${text.slice(0, max - 1).trimEnd()}…`
}

// One chip's label, fitted to `max` cells: the number always whole, the title
// cut with an ellipsis (live Q2: a title ran hard into the tab's edge).
export function chipLabel(ref: IssueRef, title: string | undefined, max: number): string {
  let label = `#${ref.number}`
  if (ref.isPR) {
    label = `PR ${label}`
  }
  const room = max - label.length - 1
  if (title !== undefined && title !== '' && room >= 2) {
    label = `${label} ${ellipsize(title, room)}`
  }

  return label
}

const CHIP_GAP = 2
const HOTKEY_CELLS = 3 // "1: " a plain Button draws before its label

// Cells each chip's label may take: the band's body less the context line,
// shared evenly, less each chip's hotkey and the gap after it.
export function chipRoom(bodyColumns: number, contextCells: number, chips: number): number {
  let free = bodyColumns
  if (contextCells > 0) {
    free -= contextCells + CHIP_GAP
  }
  const share = Math.floor(free / Math.max(1, chips)) - HOTKEY_CELLS - CHIP_GAP

  return Math.max(6, share)
}

function contextLine(fill: ContextFill): string {
  let percent = '…'
  if (fill.percent !== undefined) {
    percent = `${fill.percent}%`
  }

  return `context ${percent} · save at ${SAVE_AT_PERCENT}%`
}

function metaLine(card: IssueCard): string {
  const state = card.state.toLowerCase()
  if (card.labels.length === 0) {
    return state
  }

  return `${state} · ${card.labels.join(', ')}`
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }

  return `${text.slice(0, max)}\n\n…`
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  // --- 1. Guard ------------------------------------------------------------

  // Bookkeeping (record) runs BEFORE the command does, so a fault in it fails
  // closed through .catch and never denies a command that already ran.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const hit = FORBIDDEN.find(f => f.re.test(e.command))
    if (hit) {
      await record($, 'tool.call:guard:deny', ownMs(next.budget))
      return { deny: 'codev guard: ' + hit.why }
    }
    if (/\bporch\s+approve\b/.test(e.command)) {
      let answer: string
      try {
        answer = await $.ui.ask(HOLD_QUESTION, [HOLD_YES, 'No'])
      } catch {
        // $.ui.ask rejects when the person dismisses the question, or when no one
        // can be asked (-p). Say so, rather than letting it read as a guard fault.
        await record($, 'tool.call:guard:hold-dismissed', ownMs(next.budget))
        return { deny: HOLD_DISMISSED }
      }
      if (answer !== HOLD_YES) {
        await record($, 'tool.call:guard:hold-refused', ownMs(next.budget))
        return { deny: 'Gate not approved. Wait for the human; never infer approval from silence.' }
      }
      await record($, 'tool.call:guard:hold-approved', ownMs(next.budget))
      return next(e)
    }
    await record($, 'tool.call:guard:pass', ownMs(next.budget))

    return next(e)
  }).catch(async ($, e, next) => {
    // A .catch that throws leaves the hook absent and the command RUNS, so
    // nothing here may throw: the measurement is best effort.
    try {
      await record($, 'tool.call:guard:catch', ownMs(next.budget))
    } catch {
      // fall through to the deny
    }
    return { deny: 'codev guard failed, so this command was not run.' }
  })

  // --- 2. Attribution scrub ------------------------------------------------

  on('attribution.text', async ($, e, next) => {
    if (e.kind === 'commit' || e.kind === 'pr') {
      await record($, 'attribution.text', ownMs(next.budget))
      return { text: '' }
    }

    return next(e)
  })

  // --- 3. Context band data --------------------------------------------------

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const fill: ContextFill = {
        percent: e.context.percent,
        tokens: e.context.tokens,
        window: e.context.window,
      }
      await update($, context, () => fill)
    }
    await record($, 'session.measure', ownMs(next.budget))

    return next(e)
  })

  // --- 4. Issue peek ---------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'issue',
      description: 'Peek at an issue in a pane (codev spike)',
      argumentHint: '<number>',
      immediate: true,
    })
    await $.command.register({
      name: 'codev-spike-fetch',
      description: "Measure Tower's issue round trip (codev spike)",
      argumentHint: '<number>',
    })
    await $.command.register({
      name: 'codev-spike-timings',
      description: "Print the codev spike hooks' measured own time",
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await showRefs($, e.answer)
    await record($, 'turn.complete', ownMs(next.budget))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await showRefs($, e.text)
    await record($, 'prompt.submit', ownMs(next.budget))

    return next(e)
  })

  on('command.run', { command: 'issue' }, async ($, e, next) => {
    const number = e.args.trim().replace(/^#/, '')
    if (!/^\d{1,6}$/.test(number)) {
      return { text: 'Usage: /issue <number>' }
    }
    const spent = ownMs(next.budget)
    await openPeek($, number)
    await record($, 'command.run:issue', spent)

    return { text: `Peeking at #${number}.` }
  })

  // Measurement only: Tower's issue round trip, wall clock, uncached then cached.
  on('command.run', { command: 'codev-spike-fetch' }, async ($, e, next) => {
    const number = e.args.trim().replace(/^#/, '')
    const lines: string[] = []
    for (let i = 0; i < 3; i += 1) {
      const start = await $.clock.now()
      await towerIssue($, number)
      lines.push(`uncached (Tower GET /api/issue) #${number}: ${(await $.clock.now()) - start}ms`)
    }
    await $.store.delete(`issue:${number}`)
    for (let i = 0; i < 3; i += 1) {
      const start = await $.clock.now()
      await getIssue($, number)
      let label = 'cached ($.store)'
      if (i === 0) {
        label = 'first getIssue (fills $.store)'
      }
      lines.push(`${label} #${number}: ${(await $.clock.now()) - start}ms`)
    }
    lines.push(`hook own time: ${ownMs(next.budget)}ms of ${next.budget.ms}ms`)

    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'codev-spike-timings' }, async $ => {
    const stored = (await $.store.get('timings')) as Record<string, number[]> | undefined

    return { text: summarize(stored ?? {}) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const fill = await read($, context)
    const list = await read($, refs)
    const known = await read($, titles)
    if (e.props.hasSurvey || (fill === null && list.length === 0)) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    let contextCells = 0
    if (fill !== null) {
      contextCells = contextLine(fill).length
    }
    const room = chipRoom(e.props.bodyColumns, contextCells, list.length)
    const isOver = fill?.percent !== undefined && fill.percent >= SAVE_AT_PERCENT
    let contextColor = 'green'
    if (isOver) {
      contextColor = 'yellow'
    }

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={CHIP_GAP}>
        {fill !== null && (
          <Box key="context"><Text color={contextColor}>
            {contextLine(fill)}
          </Text></Box>
        )}
        {list.map((ref, index) => (
          <Button
            key={`chip-${ref.number}`}
            plain
            hotkey={String(index + 1)}
            label={chipLabel(ref, known[ref.number], room)}
            onPress={() => openPeek($, ref.number)}
          />
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const shown = await read($, peek)
    if (shown === null) {
      return <Text dimColor>No issue selected.</Text>
    }
    if (shown.error !== undefined) {
      return <Box key="error"><Text color="red">#{shown.number}: {shown.error}</Text></Box>
    }
    const card = shown.card
    if (card === undefined) {
      return <Box key="loading"><Text dimColor>Loading #{shown.number}…</Text></Box>
    }

    return (
      <Box flexDirection="column">
        <Box key="title"><Text bold>#{card.number} {card.title}</Text></Box>
        <Box key="meta"><Text dimColor>{metaLine(card)}</Text></Box>
        <Box key="body"><Markdown text={clip(card.body, 6000) || '_No description._'} /></Box>
        {card.comments.map((comment, index) => (
          <Box key={`comment-${index}`} flexDirection="column">
            <Text dimColor>── {comment.author} · {comment.createdAt.slice(0, 10)}</Text>
            <Markdown text={clip(comment.body, 1200)} />
          </Box>
        ))}
        <Box flexDirection="row" columnGap={2}>
          <Button key="copy" plain hotkey="c" label="copy URL" onPress={press => $.ui.copy({ text: card.url, surface: press.surface })} />
          <Text dimColor>Esc closes</Text>
        </Box>
      </Box>
    )
  })

  // --- Probe: does a mod-submitted /arch-init <name> expand? (live question 3)
  // Active only when the person sets CODEV_SPIKE_ARCH_INIT_NAME for the run.

  on('classic.SessionStart', { source: 'clear' }, async ($, e, next) => {
    const name = await $.env.get('CODEV_SPIKE_ARCH_INIT_NAME')
    if (name !== undefined && /^[a-z0-9-]+$/.test(name)) {
      // $.prompt.submit refuses text beginning with / (host check); a slash
      // command, skills included, runs through $.command.run instead.
      $.command.run({ command: 'arch-init', args: name }).catch(error => {
        $.ui.log(`arch-init probe: command.run rejected: ${String(error)}`)
      })
    }

    return next(e)
  })
}
