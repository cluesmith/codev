# Testing Guide

Procedures for testing Codev changes locally before publishing or claiming a fix works.

## Local Testing (Without Publishing)

To test changes locally before publishing to npm:

```bash
# From packages/codev directory:
cd packages/codev

# Build and create tarball
npm run build
npm pack

# Stop Tower before reinstalling
af tower stop

# Install globally from tarball (wildcard avoids hardcoding version)
npm install -g ./cluesmith-codev-*.tgz

# Clean up tarball
rm ./cluesmith-codev-*.tgz

# Restart Tower with new code
af tower start
```

This installs the exact package that would be published, without touching the npm registry. Better than `npm link` which has symlink issues.

**Do NOT use `npm link`** - it breaks global installs and has weird dependency resolution issues.

## UI Testing with Playwright

**IMPORTANT**: When making changes to UI code (tower, dashboard, terminal), you MUST test using Playwright before claiming the fix works. Do NOT rely solely on curl/API tests - they don't catch UI-level bugs.

**Default to headless mode** for automated testing:

```javascript
const browser = await chromium.launch({ headless: true });
```

**Test the actual user flow**, not just the API:

```bash
# From packages/codev directory
node test-launch-ui.cjs
```

Example test pattern:
```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('http://localhost:4100');
  await page.fill('#project-path', '/path/to/project');
  await page.click('button:has-text("Launch")');

  // Wait and check for errors
  const errorToast = await page.$('.toast.error');
  if (errorToast) {
    console.error('ERROR:', await errorToast.textContent());
    process.exit(1);
  }

  // Take screenshot for verification
  await page.screenshot({ path: '/tmp/test-result.png' });
  await browser.close();
})();
```

**When to use headed mode**: Only for debugging when you need to see what's happening visually. Add `{ headless: false }` temporarily.

## Tower/Agent Farm Regression Prevention

**CRITICAL PRINCIPLE**: Never claim a fix works without actually testing it.

The Tower Single Daemon architecture (Spec 0090) has state management complexity that unit tests don't catch. Before claiming any Tower/Agent Farm change works:

1. **Build and install**: `npm run build && npm pack && npm install -g ./cluesmith-codev-*.tgz && rm ./cluesmith-codev-*.tgz`
2. **Restart Tower**: `af tower stop && af tower start`
3. **Test the actual scenario**: Use Playwright or manual testing to verify the specific bug/feature
4. **Verify multi-project scenarios**: If touching project management, test with 2+ projects

### Known Regression Patterns

| Pattern | Root Cause | How to Test |
|---------|------------|-------------|
| Second dashboard kills first | WebSocket cleanup on disconnect | Activate 2 projects, verify both stay active |
| Project shows inactive | projectTerminals Map not updated | Check `curl localhost:4100/api/projects` |
| Terminal shows blinking cursor only | Command parsing (string vs args) | Verify terminal shows actual output |
| File view broken | React route handling | Navigate to `/project/enc/` paths |

### State Split Awareness

The Tower has TWO sources of truth that can diverge:
- **SQLite (global.db)**: Persistent port allocations
- **In-memory (projectTerminals)**: Runtime terminal state

Changes to either must consider the other. See `codev/resources/arch.md` for details.
