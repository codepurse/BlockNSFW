// Generates the static declarativeNetRequest ruleset from data/HOSTS.txt.
//
// WHY THIS EXISTS
//
// Until 1.8.0 the curated blocklist was enforced only by the content script:
// it ran at document_start, called window.stop() and redirected. That meant
// every blocked host still received the request — DNS, TLS, the GET, cookies,
// Referer — and it meant the list was enforced only where a content script
// runs. Sub-frames got no coverage at all, so an adult site loaded inside an
// iframe was filtered by nothing, and images hotlinked from a blocked host
// rendered anywhere they were embedded.
//
// These rules move that enforcement into the browser's own request engine.
//
// SCOPE: SUB-RESOURCES ONLY, DELIBERATELY
//
// main_frame is NOT blocked here, and that is a decision rather than an
// omission. A DNR `block` on a navigation produces the browser's own
// ERR_BLOCKED_BY_CLIENT page: no content script runs, so there is no blocked
// page, no reason shown, no audit-log entry and no counted stat. A DNR
// `redirect` could send the navigation to blocked.html, but redirect targets
// are static — carrying the original URL across needs regexSubstitution, and
// regex rules cap at 1,000 where this list needs thousands.
//
// So navigation keeps the content-script path, which is what makes the blocked
// page and the audit trail work, and everything invisible moves to the network
// layer where the user loses nothing by it.
//
// LIMITS THIS RESPECTS
//
//   Chrome  GUARANTEED_MINIMUM_STATIC_RULES = 30,000 enabled static rules
//   Chrome  "each rule must be less than 2KB once compiled"
//   Both    requestDomains matches sub-domains automatically (Chrome 101+,
//           Firefox 113+) — which is why the list folds so far, and why
//           minimum_chrome_version is 101.
//
// Compiled size is not JSON size, so the packer works to a conservative JSON
// budget and asserts the result, rather than assuming.
//
// Usage:  node scripts/build-dnr-ruleset.mjs [--check]
//         --check verifies the committed ruleset is current without writing.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data', 'HOSTS.txt');
const PSL_SOURCE = path.join(ROOT, 'data', 'public-suffixes.txt');
const OUT = path.join(ROOT, 'rules', 'blocklist-rules.json');

// The same guard the runtime applies, from the same modules — see
// shared/domain-policy.js. It matters more here than at runtime: a
// `requestDomains` entry matches sub-domains at the network layer, where the
// user cannot see what happened and cannot whitelist their way out of it. A
// rule containing `blogspot.com` would block every Blogger blog with no
// recourse, which is a strictly worse version of the bug that shipped.
const require = createRequire(import.meta.url);
const PublicSuffix = require(path.join(ROOT, 'shared', 'public-suffix.js'));
const DomainPolicy = require(path.join(ROOT, 'shared', 'domain-policy.js'));

// Well under Chrome's 30,000, leaving room for the list to grow and for the
// dynamic rules (SafeSearch, custom image blocks, whitelist allows) alongside.
export const MAX_RULES = 20000;
// JSON bytes per rule. Chrome's real limit is 2KB compiled; half that in JSON
// is the margin, since a domain list compiles to a trie rather than to text.
export const RULE_BUDGET_BYTES = 1024;
// Sub-resources only — see SCOPE above.
export const RESOURCE_TYPES = [
  'sub_frame', 'image', 'media', 'object', 'script', 'xmlhttprequest', 'font'
];
// Above the SafeSearch and custom-image dynamic rules (1-3), and below the
// whitelist allow rules, which have to outrank these. See ALLOW_RULE_PRIORITY
// in background.js.
export const BLOCK_RULE_PRIORITY = 10;

const DOMAIN_LABEL = '(?!-)(?:xn--[a-z0-9-]{2,61}|[a-z0-9-]{1,63})(?<!-)';
const LIKELY_DOMAIN = new RegExp(`^(?:${DOMAIN_LABEL}\\.)+${DOMAIN_LABEL}$`, 'i');

/** Same parse the background applies to HOSTS.txt, so the two cannot disagree. */
export function parseHosts(text) {
  const domains = new Set();
  const ipPattern = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    for (const part of line.split(/\s+/)) {
      if (!part || part.startsWith('#')) break;
      if (ipPattern.test(part) || part === '::1') continue;
      const normalized = part.trim().toLowerCase().replace(/^www\./, '');
      if (normalized.length <= 253 && LIKELY_DOMAIN.test(normalized)) {
        domains.add(normalized);
      }
    }
  }
  return domains;
}

/**
 * Drop every domain already covered by a listed parent.
 *
 * requestDomains matches sub-domains, so "cdn.example.com" is redundant when
 * "example.com" is on the list. Worth about 12% of the list, and it costs
 * nothing at match time because isUrlInDefaultBlocklist() already walks parent
 * labels the same way.
 */
export function foldSubdomains(domainSet) {
  const roots = [];
  for (const domain of domainSet) {
    const parts = domain.split('.');
    let covered = false;
    for (let i = 1; i < parts.length - 1; i++) {
      if (domainSet.has(parts.slice(i).join('.'))) { covered = true; break; }
    }
    if (!covered) roots.push(domain);
  }
  roots.sort();
  return roots;
}

/** Pack domains into rules, none exceeding the JSON byte budget. */
export function packRules(domains, budget = RULE_BUDGET_BYTES) {
  const rules = [];
  let batch = [];

  const emit = () => {
    if (!batch.length) return;
    rules.push({
      id: rules.length + 1,
      priority: BLOCK_RULE_PRIORITY,
      action: { type: 'block' },
      condition: { requestDomains: batch, resourceTypes: RESOURCE_TYPES }
    });
    batch = [];
  };

  // Measure the real serialized rule rather than estimating: the scaffolding
  // (id, priority, action, seven resource types) is most of a small rule.
  const scaffold = JSON.stringify({
    id: 999999, priority: BLOCK_RULE_PRIORITY, action: { type: 'block' },
    condition: { requestDomains: [], resourceTypes: RESOURCE_TYPES }
  }).length;

  let size = scaffold;
  for (const domain of domains) {
    const cost = domain.length + 3; // "domain",
    if (batch.length && size + cost > budget) { emit(); size = scaffold; }
    batch.push(domain);
    size += cost;
  }
  emit();
  return rules;
}

/**
 * Remove every name that must never stand in for its children.
 *
 * Runs BEFORE the subdomain fold, and the order is load-bearing: with
 * `b-cdn.net` dropped first, `18yos.b-cdn.net` no longer has a listed parent
 * and survives as its own entry. Folding first would have collapsed it into
 * the very name we are trying not to emit.
 *
 * @returns {{kept: Set<string>, dropped: string[]}}
 */
export function dropNamespaceEntries(domainSet, psl) {
  const intentional = DomainPolicy.blockedPublicSuffixSet();
  const suffixes = PublicSuffix.publicSuffixesAmong(domainSet, psl);
  for (const keep of intentional) suffixes.delete(keep);

  const dropped = [];
  const kept = new Set(domainSet);
  for (const name of [...suffixes, ...DomainPolicy.SHARED_HOST_PARENTS]) {
    if (intentional.has(name)) continue;
    if (kept.delete(name)) dropped.push(name);
  }
  dropped.sort();
  return { kept, dropped };
}

export function buildRuleset(hostsText, pslText) {
  const parsed = parseHosts(hostsText);
  const psl = PublicSuffix.parseList(pslText);
  const { kept, dropped } = dropNamespaceEntries(parsed, psl);
  const roots = foldSubdomains(kept);
  const rules = packRules(roots);

  // Belt and braces: nothing that reaches a rule may be a namespace. If this
  // ever fires, the guard above has a hole and the ruleset must not ship.
  const intentional = DomainPolicy.blockedPublicSuffixSet();
  const shared = DomainPolicy.sharedHostParentSet();
  for (const rule of rules) {
    for (const domain of rule.condition.requestDomains) {
      if (intentional.has(domain)) continue;
      if (shared.has(domain) || PublicSuffix.isPublicSuffix(domain, psl, { wildcards: false })) {
        throw new Error(
          `rule ${rule.id} would block the whole namespace "${domain}" — ` +
          `requestDomains matches sub-domains, so this must never be emitted`);
      }
    }
  }

  if (rules.length > MAX_RULES) {
    throw new Error(
      `${rules.length} rules exceeds MAX_RULES (${MAX_RULES}). The blocklist has ` +
      `outgrown the static budget — raise RULE_BUDGET_BYTES, or split across ` +
      `additional rulesets (Chrome allows 100, 50 enabled).`);
  }
  const oversized = rules.filter(r => JSON.stringify(r).length > RULE_BUDGET_BYTES);
  if (oversized.length) {
    throw new Error(`${oversized.length} rule(s) over the ${RULE_BUDGET_BYTES}B budget`);
  }
  const ids = new Set(rules.map(r => r.id));
  if (ids.size !== rules.length) throw new Error('duplicate rule ids');

  return { rules, parsed: parsed.size, roots: roots.length, dropped };
}

function main() {
  const check = process.argv.includes('--check');
  const hosts = fs.readFileSync(SOURCE, 'utf8');
  const pslText = fs.readFileSync(PSL_SOURCE, 'utf8');
  const { rules, parsed, roots, dropped } = buildRuleset(hosts, pslText);
  const json = JSON.stringify(rules, null, 0) + '\n';

  if (check) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== json) {
      console.error(
        'rules/blocklist-rules.json is out of date with data/HOSTS.txt.\n' +
        'Run: node scripts/build-dnr-ruleset.mjs');
      process.exit(1);
    }
    console.log(`ruleset is current (${rules.length} rules, ${roots} domains)`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);

  const largest = Math.max(...rules.map(r => JSON.stringify(r).length));
  console.log(`HOSTS.txt          ${parsed} domains`);
  console.log(`namespaces dropped ${dropped.length}  ${dropped.join(', ')}`);
  console.log(`after fold         ${roots} (-${(100 * (1 - roots / parsed)).toFixed(1)}%)`);
  console.log(`rules              ${rules.length} / ${MAX_RULES}`);
  console.log(`largest rule       ${largest} B / ${RULE_BUDGET_BYTES} B budget`);
  console.log(`ruleset            ${(json.length / 1024 / 1024).toFixed(2)} MB -> rules/blocklist-rules.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
