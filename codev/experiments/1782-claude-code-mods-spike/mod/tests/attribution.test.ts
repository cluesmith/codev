import { expect, mock, test } from 'claude-code/testing'

// Candidate 6: commit and PR attribution come back empty; the commit gate's own
// sentences (exemption, remedy) are left as the engine composed them.

test('commit and PR attribution are scrubbed at the source', async ($, on) => {
  mock.store(on)
  on('attribution.text', async ($, e) => ({ text: e.text }))

  const commit = await $.attribution.text({ kind: 'commit', text: 'Co-Authored-By: Claude <noreply@anthropic.com>' })
  const pr = await $.attribution.text({ kind: 'pr', text: 'Generated with Claude Code' })
  const remedy = await $.attribution.text({ kind: 'remedy', text: 'engine sentence' })

  expect(commit.text).toBe('')
  expect(pr.text).toBe('')
  expect(remedy.text).toBe('engine sentence')
})
