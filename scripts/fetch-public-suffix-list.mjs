// Refreshes data/public-suffixes.txt from publicsuffix.org.
//
// The Public Suffix List names every domain under which the public can
// register — .com, .co.uk, and also blogspot.com, github.io, pages.dev. The
// extension needs it for one job: never treat a public suffix as a "parent
// domain" when deciding whether a host is on the blocklist.
//
// Without it, one entry can block a whole namespace. data/HOSTS.txt carried
// `www.blogspot.com`, which the www-stripping normalizer turns into
// `blogspot.com` — and the parent-domain walk then matched every Blogger blog
// on the internet. `gob.mx`, listed bare, did the same for every Mexican
// government site. Both shipped.
//
// Run this occasionally; the list changes as registries and hosting providers
// come and go. It is committed so builds are reproducible offline.
//
// Usage: node scripts/fetch-public-suffix-list.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'public-suffixes.txt');
const SOURCE = 'https://publicsuffix.org/list/public_suffix_list.dat';

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`PSL download failed (${response.status})`);
const raw = await response.text();

// Keep the rule syntax intact — `*.` wildcards and `!` exceptions both change
// the answer, and shared/public-suffix.js implements them.
const rules = [];
for (const line of raw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//')) continue;
  rules.push(trimmed);
}
if (rules.length < 5000) {
  throw new Error(`only ${rules.length} rules parsed — the format may have changed`);
}

const header = [
  '# Public Suffix List — https://publicsuffix.org/',
  '# Licensed under the Mozilla Public License 2.0.',
  '# Fetched by scripts/fetch-public-suffix-list.mjs; do not edit by hand.',
  `# rules: ${rules.length}`,
  `# fetched: ${new Date().toISOString().slice(0, 10)}`,
  ''
].join('\n');

fs.writeFileSync(OUT, header + rules.join('\n') + '\n');
console.log(`wrote ${rules.length} rules -> data/public-suffixes.txt ` +
  `(${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
