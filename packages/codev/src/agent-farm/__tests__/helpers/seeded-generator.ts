/**
 * A small seeded, deterministic generator for property tests (Spec 1967, plan phase 2).
 *
 * The architect ruled out a new dev dependency for property testing, so this is our own:
 * a fixed-seed PRNG (mulberry32, 32 bits of state) and string generators that draw code
 * points by class. A failing case is reproduced by its seed alone; a test prints the seed
 * with any counterexample.
 *
 * The classes are the kinds of text a remote statement or payload can carry into a frame:
 * printable ASCII and other letters, the controls Decision 7 removes or converts, the
 * invisible and bidirectional format characters, the line and paragraph separators,
 * characters outside the BMP, and lone surrogates (which no well-formed UTF-8 can carry,
 * but a JSON `\u` escape can).
 */

/** A named class of code points, as inclusive ranges. */
export type CodePointClass =
  | 'ascii-printable'
  | 'c0-control'
  | 'del-c1-control'
  | 'format'
  | 'separator'
  | 'bmp-letter'
  | 'astral'
  | 'lone-surrogate';

export const CODE_POINT_CLASSES: Readonly<Record<CodePointClass, ReadonlyArray<readonly [number, number]>>> = {
  /** U+0020 to U+007E. */
  'ascii-printable': [[0x20, 0x7e]],
  /** U+0000 to U+001F: tab, line feed, carriage return and escape among them. */
  'c0-control': [[0x00, 0x1f]],
  /** DEL and the C1 controls. */
  'del-c1-control': [[0x7f, 0x9f]],
  /** Invisible and bidirectional format characters, the byte-order mark among them. */
  format: [
    [0x00ad, 0x00ad],
    [0x061c, 0x061c],
    [0x180e, 0x180e],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ],
  /** The line and paragraph separators. */
  separator: [[0x2028, 0x2029]],
  /** Letters outside ASCII: Latin-1, Greek, Cyrillic, Arabic, CJK. */
  'bmp-letter': [
    [0x00c0, 0x00ff],
    [0x0391, 0x03c9],
    [0x0410, 0x044f],
    [0x0627, 0x064a],
    [0x4e00, 0x4fff],
  ],
  /** Outside the BMP: emoji and supplementary ideographs (each is a surrogate pair). */
  astral: [
    [0x1f300, 0x1f64f],
    [0x20000, 0x2a6df],
  ],
  /** U+D800 to U+DFFF, each emitted alone. */
  'lone-surrogate': [[0xd800, 0xdfff]],
};

export const ALL_CODE_POINT_CLASSES = Object.keys(CODE_POINT_CLASSES) as CodePointClass[];

export interface StringOptions {
  /** Length in code points (a lone surrogate counts as one). Default 0. */
  minLength?: number;
  /** Default 32. */
  maxLength?: number;
  /** The classes to draw from, each equally likely. Default every class. */
  classes?: readonly CodePointClass[];
}

export interface SeededGenerator {
  readonly seed: number;
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  bool(probabilityOfTrue?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** One code point of the class, uniformly over the class's code points. */
  codePoint(codePointClass: CodePointClass): number;
  /**
   * A string of code points drawn from the classes. A lone surrogate is never placed
   * where it would pair with its neighbour, so each one drawn stays lone.
   */
  string(options?: StringOptions): string;
}

/** mulberry32: a 32-bit generator, small and fast, good enough to explore inputs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

export function createSeededGenerator(seed: number): SeededGenerator {
  if (!Number.isInteger(seed)) throw new Error(`seeded generator: the seed must be an integer, got ${seed}`);
  const next = mulberry32(seed);

  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`seeded generator: bad range [${min}, ${max}]`);
    }
    return min + Math.floor(next() * (max - min + 1));
  };

  const codePoint = (codePointClass: CodePointClass): number => {
    const ranges = CODE_POINT_CLASSES[codePointClass];
    const size = ranges.reduce((total, [lo, hi]) => total + hi - lo + 1, 0);
    let index = int(0, size - 1);
    for (const [lo, hi] of ranges) {
      const span = hi - lo + 1;
      if (index < span) return lo + index;
      index -= span;
    }
    throw new Error('seeded generator: unreachable');
  };

  return {
    seed,
    next,
    int,
    bool: (probabilityOfTrue = 0.5) => next() < probabilityOfTrue,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('seeded generator: pick from an empty list');
      return items[int(0, items.length - 1)];
    },
    codePoint,
    string: (options: StringOptions = {}): string => {
      const classes = options.classes ?? ALL_CODE_POINT_CLASSES;
      const length = int(options.minLength ?? 0, options.maxLength ?? 32);
      let text = '';
      for (let i = 0; i < length; i++) {
        let cp = codePoint(classes[int(0, classes.length - 1)]);
        // A low surrogate straight after a high one would make a pair: draw a high one
        // instead, which stays lone whatever follows it (a pair starts with a high unit).
        const previous = text.charCodeAt(text.length - 1);
        if (isLowSurrogate(cp) && isHighSurrogate(previous)) cp -= 0x400;
        text += String.fromCodePoint(cp);
      }
      return text;
    },
  };
}
