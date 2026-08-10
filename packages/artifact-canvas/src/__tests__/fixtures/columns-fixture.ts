/**
 * Fixture document for the horizontal-mode fragmentation regression tests (spec 1380, plan
 * phase 2). Exercises every protected block type plus fragmenting prose, with distinctive
 * first-line markers (`short-fence`, `tall-fence`, `WideTable`, `TallTable`, `LONGPROSE`) so
 * the Playwright spec can address blocks by content rather than brittle indices.
 *
 * The `<!-- REVIEW(@…): … -->` lines become marker cards through the stub adapters (same
 * parse as the e2e tests): a stack of five on one block, plus one card with an over-long
 * body (the tall-card cap case).
 */

const prose = (tag: string, sentences: number): string => {
  const s =
    'Gate review is a cross-referencing activity and a single-column viewport forces the ' +
    'reviewer to hold one side of every comparison in memory. ';
  return `${tag} ${s.repeat(sentences)}`.trim();
};

const fenceLines = (tag: string, n: number): string => {
  const lines: string[] = [`// ${tag}`];
  for (let i = 1; i < n; i++) {
    lines.push(`const ${tag.replace(/-/g, '_')}_${i} = compute(${i});`);
  }
  return lines.join('\n');
};

const tableRows = (tag: string, rows: number): string => {
  const out = [`| ${tag} | Probability | Impact |`, '| --- | --- | --- |'];
  for (let i = 0; i < rows; i++) {
    out.push(`| Risk row ${i} | Medium | High |`);
  }
  return out.join('\n');
};

export const COLUMNS_FIXTURE = `# Columns fixture

${prose('LONGPROSE', 40)}

## Protected blocks

${prose('Intro paragraph.', 2)}
<!-- REVIEW(@amr): First comment in the stack — must never split across a column boundary. -->
<!-- REVIEW(@claude): Second card. -->
<!-- REVIEW(@amr): Third card. -->
<!-- REVIEW(@claude): Fourth card. -->
<!-- REVIEW(@amr): Fifth card in the stack. -->

\`\`\`js
${fenceLines('short-fence', 8)}
\`\`\`

${prose('Between blocks.', 3)}

\`\`\`js
${fenceLines('tall-fence', 140)}
\`\`\`

${tableRows('WideTable', 6)}

${prose('More prose between the tables.', 4)}

${tableRows('TallTable', 90)}

## Tall card

${prose('Block with one over-long comment below.', 1)}
<!-- REVIEW(@amr): TALLCARD ${'A very long comment body that keeps going. '.repeat(120)}-->

## Media

![tall diagram](/fixture-diagram.svg)

> ${prose('A blockquote to fragment naturally.', 6)}

- list item one
- list item two with enough text that it wraps within the column measure comfortably
- list item three

${prose('Tail prose A.', 8)}

${prose('Tail prose B.', 8)}

${prose('Tail prose C.', 8)}
`;
