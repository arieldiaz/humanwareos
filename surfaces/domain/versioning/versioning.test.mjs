import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderVersionFooter, renderVersionHistory } from './versioning.mjs';

const dir = new URL('.', import.meta.url).pathname;
const itemJson = readFileSync(`${dir}fixtures/item.json`, 'utf8');
const item = JSON.parse(itemJson);
const golden = (name) => readFileSync(`${dir}fixtures/${name}.html`, 'utf8');
const python = (...args) => execFileSync('python3', [`${dir}versioning.py`, ...args], { input: itemJson, encoding: 'utf8' });

const cases = [
  ['footer-current', ['footer', 'example-dossier-r3'], () => renderVersionFooter(item, 'example-dossier-r3')],
  ['footer-old', ['footer', 'example-dossier-r1'], () => renderVersionFooter(item, 'example-dossier-r1')],
  ['history', ['history'], () => renderVersionHistory(item)],
];

for (const [name, args, render] of cases) {
  test(`${name}: JavaScript and Python match the golden fixture`, () => {
    assert.equal(render(), golden(name));
    assert.equal(python(...args), golden(name));
  });
}

test('markup carries no styling', () => {
  for (const [name] of cases) assert.doesNotMatch(golden(name), /style|<script|<link/i);
});

test('unknown version fails closed', () => {
  assert.throws(() => renderVersionFooter(item, 'missing'), /unknown version/);
});
