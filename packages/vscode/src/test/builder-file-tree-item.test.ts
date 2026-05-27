import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  BUILDER_FILE_SCHEME,
  BuilderFileTreeItem,
  builderFileResourceUri,
} from '../views/builder-file-tree-item.js';
import { BuilderDiffCache, type BuilderFileChange } from '../views/builder-diff-cache.js';
import {
  planResources,
  type ChangeEntry,
  type ChangeStatus,
  type ResourcePlan,
} from '../commands/view-diff.js';

/**
 * Regression tests for #799: the changed-file rows under each builder in
 * the Builders view were rendering with grey filenames because VSCode's
 * built-in Git FileDecorationProvider was firing on the `file:` URIs
 * (which point into gitignored `.builders/<id>/…`) and tinting the label
 * with `gitDecoration.ignoredResourceForeground`, winning the color merge
 * over our `BuilderFileDecorationProvider`. The fix is to use a custom
 * scheme on `resourceUri` so the built-in Git decorator skips these rows.
 */

const WT = '/repo/.builders/0042';

function makeFileChange(path: string, status: ChangeStatus = 'M'): BuilderFileChange {
  const change: ChangeEntry = { status, oldPath: null, path };
  const [plan] = planResources([change], new Set<string>());
  return { change, plan: plan as ResourcePlan };
}

suite('builderFileResourceUri', () => {
  test('returns a non-file scheme so the built-in Git decorator skips it', () => {
    const uri = builderFileResourceUri(WT, 'src/a.ts');
    // The whole point of the fix — Git only decorates `file:` URIs.
    assert.notStrictEqual(uri.scheme, 'file');
    assert.strictEqual(uri.scheme, BUILDER_FILE_SCHEME);
  });

  test('preserves the worktree-relative fs path (so the file-type icon resolves by basename)', () => {
    const uri = builderFileResourceUri(WT, 'src/components/Foo.tsx');
    // basename drives the icon — it must come through unchanged.
    assert.ok(uri.path.endsWith('/src/components/Foo.tsx'), `path = ${uri.path}`);
  });
});

suite('BuilderFileTreeItem (#799)', () => {
  test('resourceUri uses the custom scheme, not file:', () => {
    const item = new BuilderFileTreeItem(
      '0042',
      WT,
      'main',
      { status: 'M', oldPath: null, path: 'src/a.ts' },
      planResources([{ status: 'M', oldPath: null, path: 'src/a.ts' }], new Set<string>())[0]!,
    );
    assert.ok(item.resourceUri, 'resourceUri must be set');
    assert.strictEqual(item.resourceUri!.scheme, BUILDER_FILE_SCHEME);
    assert.notStrictEqual(item.resourceUri!.scheme, 'file');
  });
});

suite('BuilderDiffCache decorations (#799)', () => {
  test('decorationFor returns the status for a URI built via the same helper', () => {
    const cache = new BuilderDiffCache();
    try {
      // Internal accessor — exercises the path the real getDiff flow takes.
      const change = makeFileChange('src/a.ts', 'A');
      const result = { baseRef: 'main', files: [change] };
      (cache as unknown as { syncDecorations: (id: string, wt: string, r: typeof result) => void })
        .syncDecorations('0042', WT, result);

      const uri = builderFileResourceUri(WT, 'src/a.ts');
      assert.strictEqual(cache.decorationFor(uri), 'A');
    } finally {
      cache.dispose();
    }
  });

  test('decorationFor returns undefined for a plain file: URI of the same path', () => {
    // If a stray `file:` URI for the same path slipped into the tree,
    // we wouldn't decorate it — that's by design under the new scheme.
    const cache = new BuilderDiffCache();
    try {
      const change = makeFileChange('src/a.ts', 'M');
      (cache as unknown as { syncDecorations: (id: string, wt: string, r: { baseRef: string; files: BuilderFileChange[] }) => void })
        .syncDecorations('0042', WT, { baseRef: 'main', files: [change] });

      const fileUri = vscode.Uri.file(`${WT}/src/a.ts`);
      assert.strictEqual(cache.decorationFor(fileUri), undefined);
    } finally {
      cache.dispose();
    }
  });

  test('onDidChangeDecorations fires URIs with the custom scheme (so VSCode re-queries tree rows)', async () => {
    const cache = new BuilderDiffCache();
    try {
      const fired: vscode.Uri[] = [];
      const sub = cache.onDidChangeDecorations(uris => fired.push(...uris));
      try {
        const change = makeFileChange('src/a.ts', 'A');
        (cache as unknown as { syncDecorations: (id: string, wt: string, r: { baseRef: string; files: BuilderFileChange[] }) => void })
          .syncDecorations('0042', WT, { baseRef: 'main', files: [change] });

        assert.strictEqual(fired.length, 1, `expected 1 URI fired, got ${fired.length}`);
        assert.strictEqual(fired[0]!.scheme, BUILDER_FILE_SCHEME);
      } finally {
        sub.dispose();
      }
    } finally {
      cache.dispose();
    }
  });
});
