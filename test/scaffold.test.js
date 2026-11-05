'use strict';

const assert = require('node:assert');
const { test } = require('node:test');

test('src/index.js loads', () => {
  const djs = require('../src/index.js');
  assert.strictEqual(typeof djs.Client, 'function');
  assert.strictEqual(typeof djs.Options, 'function');
});

test('upstream version is pinned to 14.28.1', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.dependencies['@discordjs/rest'], '2.6.3');
  assert.strictEqual(pkg.dependencies['@discordjs/ws'], '1.2.3');
  assert.ok(!pkg.dependencies['@discordjs/rest'].startsWith('^'), 'rest phai pin exact');
  assert.ok(!pkg.dependencies['@discordjs/ws'].startsWith('^'), 'ws phai pin exact');
});

// Khai `export class X` trong typings la hua voi nguoi dung TypeScript rang
// `import { X } from '@trickstarcandina/discordjs-selfbot'` chay duoc. `tsc` khong kiem loi hua do:
// no chi doc file .d.ts, khong doi chieu voi `src/index.js`. Thieu export thi
// nguoi dung compile sach roi nhan `undefined` luc chay.
//
// Bon cai ngoai le duoi day den tu typings cua discord.js upstream: upstream khai
// chung nhung cung khong export tu index. Sua la viec cua upstream.
const KHONG_EXPORT_TU_UPSTREAM = new Set([
  'createChannel',
  'requestUploadSlots',
  'CategoryChannelChildManager',
  'PartialGroupDMMessageManager',
]);

test('moi ten typings khai deu export duoc tu src/index.js', () => {
  const { readFileSync } = require('node:fs');
  const lib = require('../src/index.js');

  const declared = [
    ...readFileSync('typings/index.d.ts', 'utf8').matchAll(
      /^export (?:declare )?(?:abstract )?(class|const|function|enum) (\w+)/gm,
    ),
  ].map(match => match[2]);

  assert.ok(declared.length > 200, `chi doc duoc ${declared.length} khai bao, regex hong roi`);

  const thieu = declared.filter(name => !KHONG_EXPORT_TU_UPSTREAM.has(name) && typeof lib[name] === 'undefined');
  assert.deepStrictEqual(thieu, [], `typings khai nhung src/index.js khong export: ${thieu.join(', ')}`);
});

test('danh sach ngoai le khong bi bo quen', () => {
  const lib = require('../src/index.js');

  // Ngay nao upstream export lai, xoa ten do khoi danh sach thay vi de no phinh mai.
  const thua = [...KHONG_EXPORT_TU_UPSTREAM].filter(name => typeof lib[name] !== 'undefined');
  assert.deepStrictEqual(thua, [], `da export duoc roi, bo khoi danh sach ngoai le: ${thua.join(', ')}`);
});
