import { test, expect, type Page, type CDPSession } from '@playwright/test';

/**
 * Issue #1883: on a phone, accepting an autocomplete suggestion re-inserted the
 * partial word and the preceding clause. A mobile keyboard edits text it has
 * already committed, and xterm.js's textarea handlers turned those replaces
 * into appends of a fragment or of the whole textarea.
 *
 * The keyboard is driven through Chromium's own IME pipeline (CDP), so the
 * textarea mutations, composition events and input events are the browser's,
 * landing on the real xterm.js inside the real Terminal component. Each edit
 * is preceded by keydown 229, as Chrome on Android sends it. The PTY is a fake
 * socket that applies DEL like a line editor (see fixture/terminal.tsx).
 */

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

interface Pty { frames: string[]; line: string; submitted: string[] }

class MobileKeyboard {
  constructor(private readonly page: Page, private readonly cdp: CDPSession) {}

  /**
   * Sends keydown 229, the IME operation and keyup back to back, as the
   * browser receives them from the keyboard.
   */
  private async imeOp(method: string, params: Record<string, unknown>): Promise<void> {
    const key = { windowsVirtualKeyCode: 229, key: 'Unidentified' };
    await Promise.all([
      this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key }),
      this.cdp.send(method as 'Input.insertText', params as { text: string }),
      this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }),
    ]);
    await this.page.waitForTimeout(20);
  }

  /** Letter by letter, the way a keyboard grows its composing text. */
  async compose(word: string): Promise<void> {
    for (let i = 1; i <= word.length; i++) {
      await this.imeOp('Input.imeSetComposition', { text: word.slice(0, i), selectionStart: i, selectionEnd: i });
    }
  }

  /** Commit the composition as `text`: a tapped suggestion, or the word as typed. */
  async commit(text: string): Promise<void> {
    await this.imeOp('Input.insertText', { text });
  }

  /** Text committed with no composition: a space or punctuation. */
  async insert(text: string): Promise<void> {
    await this.imeOp('Input.insertText', { text });
  }

  async words(...words: string[]): Promise<void> {
    for (const word of words) {
      await this.compose(word);
      await this.commit(word);
      await this.insert(' ');
    }
  }

  /** The keyboard puts a composing region over text it already committed and replaces it. */
  async recompose(start: number, end: number, text: string): Promise<void> {
    await this.imeOp('Input.imeSetComposition', {
      text, selectionStart: text.length, selectionEnd: text.length, replacementStart: start, replacementEnd: end,
    });
    await this.commit(text);
  }

  /**
   * The keyboard's backspace. Chrome on Android sends keydown 229 and deletes
   * through the IME; `execCommand('delete')` is the same deleteContentBackward
   * edit through the browser's own editing pipeline.
   */
  async backspace(): Promise<void> {
    const key = { windowsVirtualKeyCode: 229, key: 'Unidentified' };
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.page.evaluate(() => document.execCommand('delete'));
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await this.page.waitForTimeout(20);
  }

  /** The keyboard replaces the last `n` characters with no composition (autocorrect, smart punctuation). */
  async replaceTail(n: number, text: string): Promise<void> {
    await this.page.evaluate((count) => {
      const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
      ta.setSelectionRange(ta.value.length - count, ta.value.length);
    }, n);
    await this.imeOp('Input.insertText', { text });
  }
}

const pty = (page: Page): Promise<Pty> => page.evaluate(() => (window as unknown as { __pty: Pty }).__pty);
const textarea = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.value);

async function expectLine(page: Page, expected: string): Promise<void> {
  await expect.poll(async () => (await pty(page)).line).toBe(expected);
  expect(await textarea(page)).toBe(expected);
}

let keyboard: MobileKeyboard;
let imeErrors: string[];

test.beforeEach(async ({ page, hasTouch }) => {
  imeErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && msg.text().includes('[Terminal IME')) imeErrors.push(msg.text());
  });
  await page.goto('/playwright/fixture/terminal.html');
  const ta = page.locator('.xterm-helper-textarea');
  await ta.waitFor({ state: 'attached' });
  // The emulated device's pointer is what selects the touch path.
  expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(hasTouch);
  await ta.focus();
  // The Terminal buffers its first output for 500ms before going interactive.
  await page.waitForTimeout(800);
  keyboard = new MobileKeyboard(page, await page.context().newCDPSession(page));
});

test.afterEach(() => {
  // Ordinary typing never trips the desync alarm.
  expect(imeErrors).toEqual([]);
});

test('a suggestion tapped while the partial word is still composing replaces it', async ({ page }) => {
  await keyboard.words('under', 'normal');
  await keyboard.compose('ciecu');
  await keyboard.commit('circumstances');
  await keyboard.insert(' ');
  await expectLine(page, 'under normal circumstances ');
});

test('a suggestion for an already-committed word replaces it, no fragment left (sample 2)', async ({ page }) => {
  await keyboard.words('under', 'normal');
  await keyboard.compose('ciecu');
  await keyboard.commit('ciecu');
  const before = await textarea(page);
  await keyboard.recompose(before.length - 'ciecu'.length, before.length, 'circumstances');
  await keyboard.insert(' ');
  await expectLine(page, 'under normal circumstances ');
});

test('smart punctuation replaces the trailing space without resending the clause (sample 3)', async ({ page }) => {
  await keyboard.words('what', 'have', 'you', 'done', 'since', 'we', 'last', 'spoke');
  await keyboard.replaceTail(1, '. ');
  await expectLine(page, 'what have you done since we last spoke. ');
});

test('autocorrect of the last word outside a composition replaces it (sample 1)', async ({ page }) => {
  await keyboard.words('check');
  await keyboard.compose('afain');
  await keyboard.commit('afain');
  await keyboard.replaceTail('afain'.length, 'again');
  await keyboard.insert('. ');
  await expectLine(page, 'check again. ');
});

test('an iOS-style insertReplacementText reaches the PTY as a replace', async ({ page }) => {
  await keyboard.words('under', 'normal');
  await keyboard.compose('ciecu');
  await keyboard.commit('ciecu');
  // WebKit reports an accepted suggestion as insertReplacementText with no
  // composition; CDP cannot produce one, so it is dispatched the way the
  // browser would, after the textarea changes.
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!;
    ta.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertReplacementText', data: 'circumstances' }));
    ta.value = ta.value.replace(/ciecu$/, 'circumstances');
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'circumstances' }));
  });
  await expectLine(page, 'under normal circumstances');
});

test('Enter submits exactly what was typed, and the next line starts clean', async ({ page }) => {
  await keyboard.words('what', 'have', 'you', 'done', 'since', 'we', 'last', 'spoke');
  await keyboard.replaceTail(1, '. ');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await pty(page)).submitted).toEqual(['what have you done since we last spoke. ']);
  await keyboard.words('ok');
  await expectLine(page, 'ok ');
});

test('the keyboard\'s backspace deletes one character per press', async ({ page }) => {
  await keyboard.compose('helo');
  await keyboard.commit('helo');
  await keyboard.backspace();
  await keyboard.backspace();
  await keyboard.insert('llo');
  await expectLine(page, 'hello');
  expect((await pty(page)).frames).toEqual(['h', 'e', 'l', 'o', '\x7f', '\x7f', 'llo']);
});

test('dismissing the keyboard and typing again is not a desync', async ({ page }) => {
  await keyboard.words('hello');
  // xterm clears its textarea on blur, outside any input event.
  const ta = page.locator('.xterm-helper-textarea');
  await ta.blur();
  await ta.focus();
  await keyboard.words('world');
  await expect.poll(async () => (await pty(page)).line).toBe('hello world ');
  expect(await textarea(page)).toBe('world ');
});

test.describe('desktop (fine pointer)', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 800 } });

  test('IME input still goes through xterm, byte for byte as before', async ({ page }) => {
    await keyboard.words('under', 'normal');
    // xterm's composition handler sends each committed word whole; the touch
    // bridge would have sent it letter by letter.
    await expect.poll(async () => (await pty(page)).frames).toEqual(['under', ' ', 'normal', ' ']);
  });
});
