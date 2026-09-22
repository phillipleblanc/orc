import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentPatch, prepareDiffs } from './render-model.mjs';

test('replacement excerpts preserve source and create a real Pierre diff', () => {
  const [entry] = prepareDiffs({ edits: [{ path: 'index.html', before: 'old\n', after: '<script>bad()</script>\n' }] });
  assert.equal(entry.excerpt, true);
  assert.equal(entry.fileDiff.name, 'index.html');
  assert.deepEqual(entry.fileDiff.additionLines, ['<script>bad()</script>\n']);
  assert.deepEqual(entry.fileDiff.deletionLines, ['old\n']);
  assert.equal(entry.fileDiff.hunks.length, 1);
});
test('agent patches keep disjoint edits separate and preserve add/delete meaning', () => {
  const patch = '*** Begin Patch\n*** Update File: old.rs\n*** Move to: new.rs\n@@\n context\n-old\n+new\n@@ second\n-before\n+after\n*** Add File: added.txt\n+new file\n*** Delete File: deleted.txt\n*** End Patch';
  const entries = parseAgentPatch(patch);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].newFile.name, 'new.rs');
  assert.equal(entries[0].oldFile.contents, 'context\nold\n');
  assert.equal(entries[1].oldFile.contents, 'before\n');
  assert.equal(entries[2].oldFile, null);
  assert.match(entries[3].notice, /previous contents are not included/);
  const diffs = prepareDiffs({ patch });
  assert.equal(diffs.length, 4);
  assert.equal(diffs[2].fileDiff.type, 'new');
});
test('unified patches retain source line numbers', () => {
  const [entry] = prepareDiffs({ patch: 'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -40 +40 @@\n-before\n+after\n' });
  assert.equal(entry.fileDiff.hunks[0].additionStart, 40);
  assert.equal(entry.fileDiff.hunks[0].deletionStart, 40);
});
test('insertions, deletions, and empty new files do not invent blank lines', () => {
  const patch = '*** Begin Patch\n*** Update File: insert.txt\n@@\n+inserted\n*** Update File: delete.txt\n@@\n-removed\n*** Add File: empty.txt\n*** End Patch';
  const entries = parseAgentPatch(patch);
  assert.equal(entries[0].oldFile.contents, '');
  assert.equal(entries[1].newFile.contents, '');
  assert.equal(entries[2].newFile.contents, '');
  const diffs = prepareDiffs({ patch });
  assert.deepEqual(diffs[0].fileDiff.deletionLines, []);
  assert.deepEqual(diffs[1].fileDiff.additionLines, []);
  assert.deepEqual(diffs[2].fileDiff.additionLines, []);
  assert.deepEqual(diffs.map(entry => entry.fileDiff.type), ['change', 'change', 'new']);
});
test('malformed patches fail without presenting a partial change as complete', () => {
  for (const patch of ['*** Begin Patch\n*** Update File: a',
    '*** Begin Patch\n*** Add File: a\nnot an added line\n*** End Patch',
    '*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\ninvalid\n*** End Patch',
    '*** Begin Patch\n*** Delete File: a\n*** Move to: b\n*** End Patch']) {
    assert.throws(() => parseAgentPatch(patch));
  }
});
