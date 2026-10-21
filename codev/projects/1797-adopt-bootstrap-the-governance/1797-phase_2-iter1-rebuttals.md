# phase_2 iter1 rebuttals

Gemini: APPROVE. Codex: REQUEST_CHANGES. Claude: REQUEST_CHANGES. All accepted.

## Codex
- Displacement could edit a curated `lessons-learned.md`: FIXED in the skill (step 5) and the prompt. A seeded lesson is displaced only when `lessons-learned.md` is eligible; when it is curated, all three seeded lessons stay and only the remaining slots are used.

## Claude
- The full-coverage map rule was missing from the skill: FIXED. Step 4 and the prompt now state that a cold doc with 12 or fewer sections must be mapped completely, and that a curated cold doc with more than 12 gets its 12 most decision-relevant sections.
- Rules block not closing the prompt: FIXED. It now follows `{{SKILL}}`.
- Literal map headings left to inference: FIXED. The skill and prompt spell out `## Map of arch.md (consult when…)` and `## Map of lessons-learned.md (consult when…)`.
- "has just adopted" misdescribed late adopters: FIXED (now "an existing codebase that uses Codev but whose governance docs are still the starter placeholders").
