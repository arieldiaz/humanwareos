import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderVersionDiff, renderVersionFooter, renderVersionHistory } from './versioning.mjs';

const dir = new URL('.', import.meta.url).pathname;
const itemJson = readFileSync(`${dir}fixtures/item.json`, 'utf8');
const item = JSON.parse(itemJson);
const patch = `${dir}fixtures/diff-r2.patch`;
const golden = (name) => readFileSync(`${dir}fixtures/${name}.html`, 'utf8');
const cli = (...args) => execFileSync('node', [`${dir}versioning.mjs`, ...args], { input: itemJson, encoding: 'utf8' });

const cases = [
  ['footer-current', ['footer', 'example-dossier-r3'], () => renderVersionFooter(item, 'example-dossier-r3')],
  ['footer-old', ['footer', 'example-dossier-r1'], () => renderVersionFooter(item, 'example-dossier-r1')],
  ['history', ['history'], () => renderVersionHistory(item)],
  ['diff-r2', ['diff', 'example-dossier-r2', patch], () => renderVersionDiff(item, 'example-dossier-r2', readFileSync(patch, 'utf8'))],
];

for (const [name, args, render] of cases) {
  test(`${name}: module and CLI match the golden fixture`, () => {
    assert.equal(render(), golden(name));
    assert.equal(cli(...args), golden(name));
  });
}

test('markup carries no styling', () => {
  for (const [name] of cases) assert.doesNotMatch(golden(name), /style|<script|<link/i);
});

test('host overrides for history address, lifetime dates, and commit refs', () => {
  const page = {
    ...item,
    history_url: '/page/diffs/',
    created: { date: '2026-01-01', date_label: 'Jan 1, 2026' },
    versions: item.versions.map((v, i) => (i === 2 ? { ...v, ref: 'abc1234' } : v)),
  };
  assert.match(renderVersionFooter(page, 'example-dossier-r3'), /Jan 1, 2026.*href="\/page\/diffs\/"/s);
  assert.match(renderVersionHistory(page), /<p class="commit-ref">abc1234<\/p>/);
});

test('unknown version fails closed', () => {
  assert.throws(() => renderVersionFooter(item, 'missing'), /unknown version/);
  assert.throws(() => renderVersionDiff(item, 'example-dossier-r1', ''), /no predecessor/);
});
