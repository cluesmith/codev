import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 81 } } as const

// Candidate 1. The test's own tool.call hook on Bash sits beneath the plugin and
// stands for the shell: it counts what reached it, so "denied" also means "never ran".

const DENIED = [
  'git add -A',
  'git add --all',
  'git add .',
  'git reset --hard',
  'git reset --hard HEAD~1',
  'git checkout -- .',
  'git clean -fd',
  'git stash',
  'git stash push -m wip',
  'git worktree remove .builders/x',
  'git branch -D builder/x',
  'gh pr merge 12 --squash',
]

const ALLOWED = ['git add path/to/file.ts', 'git status', 'git checkout -- path/to/file.ts', 'gh pr merge 12 --merge']

const HOLD_QUESTION = 'porch approve records a human gate. Did the human give the word for this gate?'

// The test environment's console, where it has one: the timings land in the run's output.
function report(text: string): void {
  const host = globalThis as { console?: { log: (line: string) => void } }
  host.console?.log(text)
}

function refusal(result: { deny?: string; text?: string; isError?: true }): string | undefined {
  if (result.deny !== undefined) {
    return result.deny
  }
  if (result.isError === true) {
    return result.text
  }

  return undefined
}

test('denies every irreversible act, and none of them reaches the shell', async ($, on) => {
  mock.store(on)
  const reached: string[] = []
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    reached.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  for (const command of DENIED) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(refusal(result), command).toContain('codev guard: ')
  }
  expect(reached).toEqual([])
})

test('lets ordinary commands through', async ($, on) => {
  mock.store(on)
  const reached: string[] = []
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    reached.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  for (const command of ALLOWED) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(refusal(result), command).toBeUndefined()
  }
  expect(reached).toEqual(ALLOWED)
})

for (const answer of ['Yes, relayed verbatim', 'No'] as const) {
  test(`porch approve is held behind the question, answered "${answer}"`, async ($, on) => {
    mock.store(on)
    const asked: string[] = []
    const reached: string[] = []
    on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
      const question = e.questions[0]?.question ?? ''
      asked.push(question)
      return { result: { questions: e.questions, answers: { [question]: answer } } }
    })
    on('tool.call', { tool: 'Bash' }, async ($, e) => {
      reached.push(e.command)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const result = await $.tool.call({ tool: 'Bash', command: 'porch approve 1782 spec-approval' })

    expect(asked).toEqual([HOLD_QUESTION])
    if (answer === 'No') {
      expect(refusal(result)).toContain('Gate not approved')
      expect(reached).toEqual([])
    } else {
      expect(refusal(result)).toBeUndefined()
      expect(reached).toEqual(['porch approve 1782 spec-approval'])
    }
  })
}

test('a dismissed hold (or -p, no one to ask) is denied, saying the human dismissed it', async ($, on) => {
  mock.store(on)
  const reached: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    throw new Error('dismissed')
  })
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    reached.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const result = await $.tool.call({ tool: 'Bash', command: 'porch approve 1782 pr' })

  expect(refusal(result)).toContain('The human dismissed the gate question')
  expect(refusal(result)).not.toContain('guard failed')
  expect(reached).toEqual([])
})

// A store whose every other write fails: the hook's own bookkeeping write fails,
// the .catch handler's (the next write) lands, so its time is still measured.
function flakyStore(on: On): Map<string, unknown> {
  const held = new Map<string, unknown>()
  let writes = 0
  on('store.get', async ($, e) => ({ value: held.get(e.key) }))
  on('store.set', async ($, e) => {
    writes += 1
    if (writes % 2 === 1) {
      throw new Error('store down')
    }
    held.set(e.key, e.value)
    return { value: undefined }
  })
  return held
}

test('fails closed: a fault inside the hook is answered by .catch with a deny, and the command never runs', async ($, on) => {
  flakyStore(on)
  const reached: string[] = []
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    reached.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  for (const command of ['git status', 'git stash', 'porch approve 1782 pr']) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(refusal(result), command).toContain('codev guard failed')
  }
  expect(reached).toEqual([])
})

test('the .catch handler cannot itself fail open: with every write failing it still denies', async ($, on) => {
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => {
    throw new Error('store down')
  })
  const reached: string[] = []
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    reached.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const result = await $.tool.call({ tool: 'Bash', command: 'git status' })

  expect(refusal(result)).toContain('codev guard failed')
  expect(reached).toEqual([])
})

test('own time of every guard path stays inside its budget', async ($, on) => {
  mock.store(on)
  let asks = 0
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const question = e.questions[0]?.question ?? ''
    asks += 1
    if (asks % 2 === 0) {
      throw new Error('dismissed')
    }
    return { result: { questions: e.questions, answers: { [question]: 'Yes, relayed verbatim' } } }
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  for (let i = 0; i < 20; i += 1) {
    await $.tool.call({ tool: 'Bash', command: DENIED[i % DENIED.length] ?? 'git stash' })
    await $.tool.call({ tool: 'Bash', command: ALLOWED[i % ALLOWED.length] ?? 'git status' })
    await $.tool.call({ tool: 'Bash', command: 'porch approve 1782 pr' })
  }

  expect(asks).toBe(20)
  const { text = '' } = await $.command.run({ command: 'codev-spike-timings', args: '', ...RUN })
  report(`guard timings (own ms):\n${text}`)
  for (const line of text.split('\n')) {
    const max = Number(/max=(\d+(?:\.\d+)?)ms/.exec(line)?.[1] ?? 'NaN')
    let limit = 10_000
    if (line.startsWith('tool.call:guard:catch')) {
      limit = 1_000
    }
    expect(max, line).toBeLessThan(limit)
  }
})

test('own time of the .catch handler stays inside its 1 s grace', async ($, on) => {
  const held = flakyStore(on)
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  for (let i = 0; i < 20; i += 1) {
    await $.tool.call({ tool: 'Bash', command: 'git status' })
  }

  const times = (held.get('timings') as Record<string, number[]> | undefined)?.['tool.call:guard:catch'] ?? []
  report(`guard .catch timings (own ms): n=${times.length} max=${Math.max(...times)}ms`)
  expect(times).toHaveLength(20)
  expect(Math.max(...times)).toBeLessThan(1_000)
})
