import { parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';

const file = (name, contents) => ({ name, contents });
const contents = lines => lines.length ? lines.join('\n') + '\n' : '';

// apply_patch hunks have no source line numbers. Keep each hunk as an
// explicitly labelled excerpt rather than inventing file positions or context.
export function parseAgentPatch(patch) {
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new Error('Incomplete patch');
  }
  const entries = [];
  let i = 0;
  while (i < lines.length) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[i++]);
    if (!match) throw new Error('Unsupported patch section');
    const [, operation, path] = match;
    let newPath = path;
    if (lines[i]?.startsWith('*** Move to: ')) {
      if (operation !== 'Update') throw new Error('Only updated files can be moved');
      newPath = lines[i++].slice(13);
    }
    const body = [];
    while (i < lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i])) body.push(lines[i++]);
    if (operation === 'Delete') {
      if (body.length) throw new Error('Unexpected deleted-file contents');
      entries.push({ name: path, notice: 'Delete file. Its previous contents are not included in this tool call.' });
    } else if (operation === 'Add') {
      if (body.some(line => !line.startsWith('+'))) throw new Error('Invalid added-file patch');
      entries.push({ oldFile: null, newFile: file(newPath, contents(body.map(line => line.slice(1)))) });
    } else {
      let before = [], after = [], changed = false;
      const flush = () => {
        if (changed) entries.push({ oldFile: file(path, contents(before)),
          newFile: file(newPath, contents(after)), excerpt: true });
        before = []; after = []; changed = false;
      };
      for (const line of body) {
        if (line === '@@' || line.startsWith('@@ ')) { flush(); continue; }
        if (line === '*** End of File') continue;
        if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)); }
        else if (line.startsWith('-')) { before.push(line.slice(1)); changed = true; }
        else if (line.startsWith('+')) { after.push(line.slice(1)); changed = true; }
        else throw new Error('Invalid edit hunk');
      }
      flush();
      if (!body.length && newPath !== path) entries.push({ name: path, notice: 'Rename to ' + newPath });
    }
  }
  if (!entries.length) throw new Error('No changes in patch');
  return entries;
}

export function prepareDiffs(payload) {
  let entries;
  if (typeof payload.patch === 'string') {
    entries = payload.patch.startsWith('*** Begin Patch') ? parseAgentPatch(payload.patch)
      : parsePatchFiles(payload.patch).flatMap(patch => patch.files.map(fileDiff => ({ fileDiff })));
  } else {
    entries = payload.edits.map(edit => ({ oldFile: file(edit.path, edit.before), newFile: file(edit.path, edit.after), excerpt: true }));
  }
  if (!entries.length) throw new Error('No changes to preview');
  return entries.map(entry => {
    if (entry.notice || entry.fileDiff) return entry;
    const fileDiff = parseDiffFromFile(entry.oldFile, entry.newFile);
    // An empty excerpt side means an insertion/removal, not a new/deleted file.
    if (entry.excerpt) fileDiff.type = entry.oldFile.name === entry.newFile.name ? 'change' : 'rename-changed';
    return { fileDiff, excerpt: entry.excerpt };
  });
}
