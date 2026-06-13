/**
 * A representative Codev review artifact (markdown) used by the end-to-end test and the
 * `examples/` dev page. It exercises the renderer's block variety (headings, paragraph, list,
 * fenced code) so the smoke surface looks like a real spec/review, and it already carries one
 * positional `<!-- REVIEW(...) -->` marker so the "existing markers render" path is covered
 * without any host write.
 *
 * Text is the source of truth (spec D3 / #857): the marker on the line below "## Summary"
 * annotates the heading block ABOVE it.
 */
export const SAMPLE_ARTIFACT = `# Spec 42 — Example Feature

## Summary
<!-- REVIEW(@reviewer): is this scoped to v1 only? -->
This document describes an example feature so the canvas has realistic content to render.

## Requirements

- Render markdown safely.
- Surface review markers inline.
- Emit comment intent to the host.

\`\`\`ts
export function example(): number {
  return 42;
}
\`\`\`
`;
