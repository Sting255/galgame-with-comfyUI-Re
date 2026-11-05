import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { updateEnvContent, persistEnvValues, resolveEnvPath } from '../src/utils/envFile.js';
import { resolveServicePort } from '../src/utils/servicePort.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linshe-env-regression-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, '.env');
}

test('commented templates, spaced/exported keys and duplicates save without changing other settings', () => {
  const content = '# KEY=template\r\nexport KEY = old # keep\r\nKEY=duplicate\r\nOTHER="unchanged#value"\r\n';
  const updated = updateEnvContent(content, { KEY: 'new$&value#literal', ADDED: '' });
  assert.deepEqual(dotenv.parse(updated), { KEY: 'new$&value#literal', OTHER: 'unchanged#value', ADDED: '' });
  assert.ok(updated.includes('# KEY=template\r\n'));
  assert.ok(updated.includes('# keep\r\n'));
  assert.ok(updated.includes('OTHER="unchanged#value"\r\n'));
  assert.equal((updated.match(/^KEY=/gm) || []).length, 1);
  assert.equal(dotenv.parse(updateEnvContent('# KEY=example', { KEY: 'saved' })).KEY, 'saved');
});

test('values round-trip hashes, quotes, literal backslashes, whitespace, Unicode and newlines', () => {
  for (const value of [
    '', ' ordinary ', '密钥#测试', '$&$`$\'$$', 'a"b', "a'b", 'a`b',
    'line one\nline two', 'line one\r\nline two', String.raw`C:\new\relay`,
    JSON.stringify({ prompt: "don't strip #hash", path: String.raw`C:\new\relay`, text: 'one\ntwo' }),
  ]) {
    const result = updateEnvContent('KEY=old\n', { KEY: value });
    assert.equal(dotenv.parse(result).KEY, value);
    assert.equal(updateEnvContent(result, { KEY: value }), result, 'repeated saves do not accumulate entries');
  }
});

test('multiline assignments are replaced as a unit, preserving embedded key-looking text in unrelated values', () => {
  const result = updateEnvContent('OTHER="line\nKEY=inside\nend"\nKEY="old\nvalue"\nAFTER=keep\n', { KEY: 'new' });
  assert.deepEqual(dotenv.parse(result), { OTHER: 'line\nKEY=inside\nend', KEY: 'new', AFTER: 'keep' });
});

test('unrepresentable values fail before replacing any part of the file', t => {
  const envPath = fixture(t);
  fs.writeFileSync(envPath, 'KEY=original\nOTHER=original\n');
  assert.throws(() => persistEnvValues(envPath, { OTHER: 'new', KEY: 'bad\0value' }), /KEY/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'KEY=original\nOTHER=original\n');
  assert.deepEqual(fs.readdirSync(path.dirname(envPath)), ['.env']);
});

test('partial writes and failed renames retain the previous file and remove temporary files', t => {
  const envPath = fixture(t);
  fs.writeFileSync(envPath, 'KEY=original\n');
  for (const operation of ['writeFileSync', 'renameSync']) {
    const fsImpl = { ...fs, [operation](...args) {
      if (operation === 'writeFileSync') fs.writeFileSync(args[0], 'partial');
      throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
    } };
    assert.throws(() => persistEnvValues(envPath, { KEY: 'replacement' }, { fsImpl }), /fixture I\/O failure/);
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'KEY=original\n');
    assert.deepEqual(fs.readdirSync(path.dirname(envPath)), ['.env']);
  }
});

test('an empty installation saves and reloads through the production config and port readers', t => {
  const envPath = fixture(t);
  const values = { PORT: '3399', LLM_API_KEY: 'fixture#key', LLM_MODEL: 'fixture-model',
    LLM_HEADERS: JSON.stringify({ 'X-Path': String.raw`C:\new\relay#1` }), LLM_BASE_URL: 'http://127.0.0.1:9/v1' };
  persistEnvValues(envPath, values);
  assert.equal(resolveEnvPath({ LINSHE_ENV_PATH: envPath }), envPath);
  assert.equal(resolveServicePort({ env: { LINSHE_ENV_PATH: envPath } }), 3399);
  const env = { ...process.env, LINSHE_ENV_PATH: envPath, DB_PATH: ':memory:', LOG_TO_FILE: 'false' };
  for (const key of Object.keys(values)) delete env[key];
  const script = `import { config } from ${JSON.stringify(new URL('../src/config.js', import.meta.url).href)};
    console.log(JSON.stringify({ port: config.port, key: config.llm.apiKey, model: config.llm.model, headers: config.llm.headers }));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', windowsHide: true });
  const loaded = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(loaded, { port: 3399, key: values.LLM_API_KEY, model: values.LLM_MODEL, headers: JSON.parse(values.LLM_HEADERS) });
});
