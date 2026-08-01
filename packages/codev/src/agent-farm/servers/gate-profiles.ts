/**
 * Render-gate classifier profiles (Spec 1313, Phase 2).
 *
 * A profile tells {@link classifyScreen} how to find and bound a given app's
 * composer. Profiles are per-app *data* by design (spike constraint 9): a TUI
 * layout change is a profile drift the smoke suite catches, never a silent
 * misdelivery — an unmatched marker classifies NOT clean.
 *
 * Measured apps have a profile: claude, codex (spike g2), and agy (Spec 1313
 * Phase 3 measurement — its own marker `> ` and a color-keyed placeholder rule,
 * because agy renders its idle hint in palette-8 gray, not SGR-dim). Everything
 * else — gemini, opencode, an unknown binary, or a launch we can't identify —
 * resolves to `null`, and the caller holds the message with reason `no-profile`.
 * This is the strict app-identity table the spike mandates (constraint 10): we
 * deliberately do NOT reuse `resolveHarness`, whose claude fallback would make an
 * agy terminal masquerade as claude and receive claude's (wrong) profile — a
 * correctness bug, since agy's screens classify by an entirely different rule.
 */

import { basename } from 'node:path';
import { detectHarnessFromCommand } from '../utils/harness.js';
import type { GateProfile } from './render-gate.js';

/**
 * Marker family shared by the measured TUIs: both render a `❯`/`›` prompt glyph
 * at the start of the composer input row. Kept in one place but referenced
 * per-profile so a future app whose marker diverges gets its own pattern without
 * disturbing the others.
 */
const COMPOSER_MARKER = /^[❯›]/;

/**
 * Lines that END the composer region — the rule line claude draws beneath its
 * input (`─────`) and the status line codex draws (model / reasoning / cwd, e.g.
 * `  gpt-5.6-sol   high: …   ~/repo`). Scanning stops at the first such line so
 * status chrome below the composer is never miscounted as user text. Both
 * patterns are carried by both profiles (harmless: a claude screen has no
 * `gpt|high:|~/` status line, a codex screen has no long rule line under input),
 * exactly as the validated spike classifier applied them.
 */
const REGION_END_PATTERNS = [/^[─━╌┄]{5,}/, /^\s{2,}(gpt|high:|~\/)/];

/** claude composer profile (marker ❯, dim placeholder — measured, spike g2). */
export const CLAUDE_PROFILE: GateProfile = {
  app: 'claude',
  markerPattern: COMPOSER_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
};

/** codex composer profile (marker ›, dim placeholder — measured, spike g2). */
export const CODEX_PROFILE: GateProfile = {
  app: 'codex',
  markerPattern: COMPOSER_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
};

/**
 * agy (Antigravity CLI 1.1.8) composer marker: a `> ` prompt glyph at the input
 * row start — a different glyph from claude/codex's `❯`/`›`, so its own pattern.
 * (Measured, Spec 1313 Phase 3; the marker cell renders palette-12 bright-blue.)
 */
const AGY_MARKER = /^> /;

/**
 * agy composer profile (Spec 1313 Phase 3 — net-new measurement). agy breaks the
 * dim-placeholder assumption: its idle mode-hint (`Accept-edits mode: …`) renders
 * at NORMAL intensity but in **palette-8 (gray)**, while user-typed text is
 * default-fg — so the placeholder signal is a foreground COLOR, not SGR-dim
 * (`placeholderFgPalette: 8`). Consequences, all measured: idle → clean (the
 * gray hint is ignored), draft → busy (default-fg text counted), and the
 * per-folder trust dialog → busy (its selected `> Yes, I trust this folder`
 * option is palette-12, counted) — so a blind Enter never confirms filesystem
 * trust. Region bounds reuse the shared rule-line/status patterns (agy brackets
 * its composer with `─────` rules, like claude).
 */
export const AGY_PROFILE: GateProfile = {
  app: 'agy',
  markerPattern: AGY_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
  placeholderFgPalette: 8,
};

/** Registry keyed by the harness name `detectHarnessFromCommand` returns. */
const PROFILES_BY_HARNESS: Record<string, GateProfile> = {
  claude: CLAUDE_PROFILE,
  codex: CODEX_PROFILE,
};

/**
 * The identity signals a caller extracts from a live session. A `PtySession`
 * satisfies this structurally via its `command` / `launchArgs` getters (the
 * Spec 1313 identity seam); tests pass a plain object.
 *
 * `label` is intentionally not used for matching: for a builder it is the
 * builder id (e.g. `spir-1313`), for an architect the architect name — neither
 * names the agent. The authoritative signal is the launch `command`.
 */
export interface AppIdentity {
  command: string;
  args?: string[];
  label?: string;
}

/**
 * Map a session's identity to its classifier profile, or `null` when the app is
 * unknown/unmeasured (→ caller holds with `no-profile`).
 *
 * Resolution is strict: the launch `command`'s basename must match a measured
 * agent. agy is matched directly (its binary is `agy`/`antigravity`), because the
 * shared {@link detectHarnessFromCommand} does not recognize it and we will not
 * extend that resolver — its claude fallback is exactly the misidentification the
 * gate must avoid (constraint 10). claude/codex resolve via that helper. Wrapped
 * launches — a builder run through `.builder-start.sh` whose `command` is the
 * shell, not the agent — resolve to `null` here; the delivery wiring (Phase 4)
 * supplies the resolved agent command for those (it already reads the launch
 * script to identify the harness, as `afx reset` does). Fail-safe by
 * construction: an unresolved identity is held and surfaced, never guessed.
 */
export function resolveProfile(identity: AppIdentity): GateProfile | null {
  const base = basename(identity.command).toLowerCase();
  if (base.includes('agy') || base.includes('antigravity')) return AGY_PROFILE;
  const harness = detectHarnessFromCommand(identity.command);
  if (harness && harness in PROFILES_BY_HARNESS) return PROFILES_BY_HARNESS[harness];
  return null;
}
