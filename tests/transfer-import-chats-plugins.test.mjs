import assert from 'node:assert/strict'
import test from 'node:test'

import { createTransferImport } from '../tavern-plugin/lib/domain/transfer-import.js';

function manifestWith(parts) {
  return { spec: 'dsh-tavern.transfer', version: 1, name: 't', parts };
}

function baseImport(overrides = {}) {
  return createTransferImport(Object.assign({
    fileResources: { async list() { return [] }, async readText() { return undefined } },
    worldBooks: { async catalog() { return { standalone: [] } }, async import() { throw new Error('unused') } },
    presetLibrary: { async catalog() { return { presets: [] } }, async import() { throw new Error('unused') } },
    promptDocuments: { import() { throw new Error('unused') } },
    userPreferenceProfile: { async read() { return { profiles: [] } }, async manage() { throw new Error('unused') } },
    regexManager: { async read() { return { global: [] } } },
    readTavernSettings: () => ({ promptSets: { sets: [] } }),
    updateTavernSettings: async () => ({}),
    importCard: async () => ({}),
    importPreset: async () => ({}),
    backup: async () => ''
  }, overrides));
}

test('导入对话走 importOne，并记录新 chatId', async () => {
  const calls = [];
  const importer = baseImport({
    chats: {
      async importOne({ title, content }) { calls.push({ title, size: content.length }); return { chatId: 'chat-new', sessionId: 's-new', title } }
    }
  });
  const files = new Map([['parts/chats/game.dshsave', Buffer.from('save-bytes')]]);
  const result = await importer.apply({
    manifest: manifestWith([{ kind: 'chats', label: '对话与存档', items: [{ key: 'chat-old', title: '雨中列车', entry: 'parts/chats/game.dshsave', bytes: 10, sha256: '' }] }]),
    files
  });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ title: '雨中列车', size: 10 }]);
  assert.deepEqual(result.results[0].chatIds, ['chat-new']);
});

test('导入插件写入新文件夹；同名文件夹在预览里提示加序号', async () => {
  const calls = [];
  const importer = baseImport({
    plugins: {
      async list() { return [{ key: 'dsh-tavern-rewrite', title: '重写', bytes: 1 }] },
      async importOne({ key, title, content }) { calls.push({ key, title, size: content.length }); return { folder: key + ' (2)' } }
    }
  });
  const manifest = manifestWith([{ kind: 'plugins', label: '插件', items: [{ key: 'dsh-tavern-rewrite', title: '重写', entry: 'parts/plugins/dsh-tavern-rewrite.zip', bytes: 4, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 1);
  assert.match(preview.parts[0].items[0].reason, /会加序号/);

  const result = await importer.apply({ manifest, files: new Map([['parts/plugins/dsh-tavern-rewrite.zip', Buffer.from('zip!')]]) });
  assert.equal(result.results[0].added, 1);
  assert.deepEqual(calls, [{ key: 'dsh-tavern-rewrite', title: '重写', size: 4 }]);
});

test('对话不会判定为冲突：导入总是新建一局', async () => {
  const importer = baseImport({
    chats: { async importOne() { return { chatId: 'x' } } }
  });
  const manifest = manifestWith([{ kind: 'chats', label: '对话与存档', items: [{ key: 'chat-1', title: '作家 · 第 3 章', entry: 'parts/chats/a.dshsave', bytes: 1, sha256: '' }] }]);
  const preview = await importer.preview(manifest);
  assert.equal(preview.parts[0].conflicts, 0);
  assert.equal(preview.parts[0].items[0].conflict, false);
});
