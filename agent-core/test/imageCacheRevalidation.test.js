import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { imageAvifFallback } from '../src/middleware/imageAvifFallback.js';

function request(server, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path: url, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

test('overwritten images revalidate at the same URL without a mounted page or cache-bust registry', async t => {
  const tempRoot = path.resolve(os.tmpdir());
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'linshe-image-cache-'));
  t.after(() => {
    assert.equal(path.dirname(dataDir), tempRoot);
    assert.ok(path.basename(dataDir).startsWith('linshe-image-cache-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dataDir, 'images', '.pending'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'avatars'));

  // Exercise the actual app middleware order without booting databases, schedulers or LLM services.
  const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const start = source.indexOf('// 图片编辑任务暂存预览');
  const end = source.indexOf('// 小镇像素素材', start);
  assert.ok(start >= 0 && end > start);
  const app = express();
  runInNewContext(source.slice(start, end), { app, express, path, DATA_DIR: dataDir, imageAvifFallback });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });

  try {
    const cases = [
      { name: 'PNG', file: 'original.png', url: '/images/original.png', type: 'image/png' },
      { name: 'direct AVIF', file: 'direct.avif', url: '/images/direct.avif' },
      { name: 'PNG to AVIF fallback', file: '压缩.avif', url: `/images/${encodeURIComponent('压缩.png')}`, type: 'image/avif' },
      { name: 'old cache-bust URL', file: 'versioned.png', url: '/images/versioned.png?_t=123', type: 'image/png' },
    ];
    for (const item of cases) {
      await t.test(item.name, async () => {
        const target = path.join(dataDir, 'images', item.file);
        fs.writeFileSync(target, 'old-image');
        fs.utimesSync(target, new Date('2020-01-01'), new Date('2020-01-01'));
        const first = await request(server, item.url);
        assert.equal(first.status, 200);
        assert.equal(first.body, 'old-image');
        assert.equal(first.headers['cache-control'], 'no-cache');
        if (item.type) assert.equal(first.headers['content-type'], item.type);
        assert.ok(first.headers.etag);
        assert.ok(first.headers['last-modified']);

        const validators = { 'If-None-Match': first.headers.etag, 'If-Modified-Since': first.headers['last-modified'] };
        const unchanged = await request(server, item.url, validators);
        assert.equal(unchanged.status, 304);
        assert.equal(unchanged.body, '');
        assert.equal(unchanged.headers['cache-control'], 'no-cache');

        // Same size, different modification time: emulate the task's atomic replacement.
        const pending = target + '.pending';
        fs.writeFileSync(pending, 'new-image');
        fs.utimesSync(pending, new Date('2020-01-02'), new Date('2020-01-02'));
        fs.renameSync(pending, target);
        const replaced = await request(server, item.url, validators);
        assert.equal(replaced.status, 200);
        assert.equal(replaced.body, 'new-image');
        assert.notEqual(replaced.headers.etag, first.headers.etag);
        assert.equal(replaced.headers['cache-control'], 'no-cache');

        const reused = await request(server, item.url, { 'If-None-Match': replaced.headers.etag });
        assert.equal(reused.status, 304);
        assert.equal(reused.body, '');
      });
    }

    await t.test('pending previews and avatars retain their existing cache policy', async () => {
      fs.writeFileSync(path.join(dataDir, 'images', '.pending', 'preview.png'), 'preview');
      fs.writeFileSync(path.join(dataDir, 'avatars', 'avatar.png'), 'avatar');
      const preview = await request(server, '/images/.pending/preview.png');
      const avatar = await request(server, '/avatars/avatar.png');
      assert.equal(preview.status, 200);
      assert.equal(preview.headers['cache-control'], 'public, max-age=300');
      assert.equal(avatar.status, 200);
      assert.equal(avatar.headers['cache-control'], 'public, max-age=2592000');
    });
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
