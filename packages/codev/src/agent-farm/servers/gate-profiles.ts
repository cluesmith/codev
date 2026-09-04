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
 *
 * Load-bearing since the Spec 1313 render-gate hardening: when NONE of these matches
 * below the marker, the gate now HOLDS (`no-region-end`) rather than scanning to the
 * screen bottom — so this list is the sole lower-bound signal, and it is FAIL-SAFE but
 * DRIFT-FRAGILE. The rule pattern requires the line to *start* with `─/━/╌/┄`; a claude
 * reversion to a rounded box (`╰────╯`, note `╰`/`└` are ignorable glyphs but NOT in
 * this class) or an indented rule would stop matching and hold every send to that app.
 * That is the safe direction (never a false-clean), and a sustained hold now escalates
 * to liveness telemetry (mailbox-delivery `recordStreak`), but broaden this list ONLY
 * from a real capture — a too-loose pattern that matches draft content is a false-clean.
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
 * agy (Antigravity CLI) composer marker: a `>` prompt glyph at the input row start — a
 * different glyph from claude/codex's `❯`/`›`, so its own pattern. The trailing separator
 * is `\s|$` rather than a literal space because agy's no-hint mode renders the empty
 * composer as a BARE `>`, which right-trims to `">"` (measured on 1.1.13, #1474) — the
 * old `/^> /` never matched it, so the gate held every message to an agy in that mode
 * forever.
 *
 * This text pattern is deliberately NOT the whole marker test. `> ` is ordinary output —
 * and, measured on real agy screens, it is also agy's own slash-menu selection cursor and
 * the per-turn transcript echo of each submitted message. The composer is identified by
 * this pattern PLUS the two anchors on {@link AGY_PROFILE} below; broaden or narrow the
 * three together, never this line alone.
 */
const AGY_MARKER = /^>(\s|$)/;

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
 *
 * The two marker ANCHORS (#1474) exist because `> ` alone does not identify agy's
 * composer. Measured on real agy 1.1.13 captures (`fixtures/gate/agy-*.txt`), a live
 * screen routinely carries OTHER `> ` rows, and last-match-wins picked them over the
 * composer:
 *   - the slash-menu selection cursor (`> /add-dir …`) — palette-12 like the composer,
 *     and rendered BELOW it, so it won the marker scan outright;
 *   - the transcript echo of every submitted turn (`> <the message you sent>`), palette-4,
 *     one per conversation turn;
 *   - the trust dialog's selected option — palette-12, with no composer on screen at all.
 * Hence `markerRequiresCursorRow: true` (only the live input row holds the cursor — menu
 * and dialog rows never do) and `markerFgPalette: 12` (the marker glyph's own color, which
 * separates the composer from the palette-4 transcript echo). Both were measured stable
 * across agy's modes, including the bare-`>` no-hint mode.
 *
 * Direction of failure, deliberately: an agy re-theme, or a cursor parked off the composer
 * (e.g. a single mid-repaint frame), yields NO marker ⇒ `no-composer-marker` ⇒ the message
 * is held and re-checked, never delivered onto a screen we failed to understand. A
 * sustained hold escalates through the mailbox-delivery liveness telemetry
 * (`recordStreak`) — the same drift path {@link REGION_END_PATTERNS} documents — so widen
 * these anchors ONLY from a real capture.
 */
export const AGY_PROFILE: GateProfile = {
  app: 'agy',
  markerPattern: AGY_MARKER,
  regionEndPatterns: REGION_END_PATTERNS,
  placeholderFgPalette: 8,
  markerRequiresCursorRow: true,
  markerFgPalette: 12,
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
 * script to identify the harness, as `afx refresh` does). Fail-safe by
 * construction: an unresolved identity is held and surfaced, never guessed.
 */
export function resolveProfile(identity: AppIdentity): GateProfile | null {
  const base = basename(identity.command).toLowerCase();
  if (base.includes('agy') || base.includes('antigravity')) return AGY_PROFILE;
  const harness = detectHarnessFromCommand(identity.command);
  if (harness && harness in PROFILES_BY_HARNESS) return PROFILES_BY_HARNESS[harness];
  return null;
}
