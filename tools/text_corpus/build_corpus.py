#!/usr/bin/env python3
"""Build the AI Text Blocker's training/evaluation corpus from Common Crawl.

Why Common Crawl: the v3 model was trained on 217 hand-written adult phrases
(1.7 words each) against 347 benign sentences (8 words each). That length gap
is what inverted its vocabulary ("videos" outranked "nude"). A model that reads
real pages has to learn from real pages, in the shape the extension actually
sees them.

What it does, in three resumable stages:

  index   Ask the Common Crawl URL index (one ~1 KB request per domain) for a
          few captures of:
            - a seeded random sample of domains from data/HOSTS.txt  -> adult
            - the curated list in benign_domains.tsv                  -> benign
          plus a small number of random index blocks per TLD, which give the
          "ordinary long-tail web" (labelled by blocklist membership).
  fetch   Range-request each capture's single WARC record (~35 KB) from
          data.commoncrawl.org. Nobody visits any site from this machine; this
          is read-only archive data.
  (both)  Extract text EXACTLY the way content.js does at runtime -- the title,
          the seven meta tags in AI_TEXT_META_SELECTORS, and body.innerText
          split into lines -- so training text has the same shape as live text.

Output (git-ignored -- it contains adult text and third-party content):
  tools/text_corpus/cache/captures.jsonl   index results, one per capture
  tools/text_corpus/cache/pages.jsonl      extracted pages, one per capture

Usage:
  python tools/text_corpus/build_corpus.py all
  python tools/text_corpus/build_corpus.py index --adult-domains 2500
  python tools/text_corpus/build_corpus.py fetch
  python tools/text_corpus/build_corpus.py stats

Every stage appends and skips work already done, so an interrupted run is
resumed by running the same command again.
"""

import argparse
import gzip
import html
import json
import os
import random
import re
import sys
import threading
import time
import zlib
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
CACHE = os.path.join(HERE, "cache")
HOSTS_PATH = os.path.join(REPO, "data", "HOSTS.txt")
BENIGN_LIST = os.path.join(HERE, "benign_domains.tsv")

DEFAULT_CRAWL = "CC-MAIN-2026-34"
INDEX_BASE = "https://index.commoncrawl.org/{crawl}-index"
DATA_BASE = "https://data.commoncrawl.org/"
USER_AGENT = "BlockNSFW-text-corpus/1.0 (+https://github.com/codepurse/BlockNSFW)"

# Must mirror content.js. If these change there, change them here and rebuild.
AI_TEXT_META_KEYS = [
    ("name", "title"),
    ("property", "og:title"),
    ("name", "twitter:title"),
    ("name", "description"),
    ("property", "og:description"),
    ("name", "twitter:description"),
    ("name", "keywords"),
]
STORED_LINE_LIMIT = 150  # runtime reads 48 filtered lines; keep headroom

# Random-web sampling: a TLD and its weight. Each draw costs ~370 KB of index
# data (one block of 3,000 index lines), so this is used sparingly.
RANDOM_TLDS = [
    ("com", 40), ("org", 8), ("net", 6), ("de", 6), ("ru", 5), ("uk", 4),
    ("jp", 4), ("fr", 4), ("br", 4), ("it", 3), ("es", 3), ("pl", 3),
    ("nl", 3), ("in", 2), ("id", 2), ("vn", 2), ("tr", 2), ("kr", 2),
    ("cn", 2), ("au", 2), ("ca", 2), ("mx", 1), ("ar", 1), ("tw", 1),
    ("info", 1), ("io", 1),
]

_thread_local = threading.local()
_write_lock = threading.Lock()


def session():
    s = getattr(_thread_local, "session", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        _thread_local.session = s
    return s


class RateLimiter:
    """At most `rate` calls per second across all threads."""

    def __init__(self, rate):
        self.interval = 1.0 / rate
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + self.interval
        delay = at - time.monotonic()
        if delay > 0:
            time.sleep(delay)


def append_jsonl(path, obj):
    line = json.dumps(obj, ensure_ascii=False)
    with _write_lock:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # a line torn by an interrupted write
    return out


# --------------------------------------------------------------------------
# Domains
# --------------------------------------------------------------------------
def load_blocklist():
    domains = set()
    with open(HOSTS_PATH, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            d = parts[-1].lower().strip(".")
            if d.startswith("www."):
                d = d[4:]
            if d and d not in ("0.0.0.0", "localhost"):
                domains.add(d)
    return domains


def in_blocklist(host, blocklist):
    host = host.lower().strip(".")
    labels = host.split(".")
    for i in range(len(labels) - 1):
        if ".".join(labels[i:]) in blocklist:
            return True
    return False


_SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu", "ne", "or", "go", "gob", "nic"}


def site_of(host):
    """Registrable-domain approximation, used only to keep one site's pages on
    one side of the train/eval split (so eval never sees a trained site)."""
    labels = host.lower().strip(".").split(".")
    if labels and labels[0] == "www":
        labels = labels[1:]
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in _SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def load_benign_list():
    rows = []
    with open(BENIGN_LIST, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            target = parts[0].strip()
            category = parts[1].strip() if len(parts) > 1 else "general"
            rows.append((target, category))
    return rows


# --------------------------------------------------------------------------
# Index stage
# --------------------------------------------------------------------------
def cdx_get(crawl, params, limiter, tries=6):
    url = INDEX_BASE.format(crawl=crawl)
    backoff = 4.0
    for attempt in range(tries):
        limiter.wait()
        try:
            r = session().get(url, params=params, timeout=120)
        except requests.RequestException:
            time.sleep(backoff)
            backoff = min(backoff * 2, 90)
            continue
        if r.status_code == 404:
            return []  # "No Captures found"
        if r.status_code == 200:
            out = []
            for line in r.text.splitlines():
                line = line.strip()
                if line.startswith("{"):
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            return out
        if r.status_code == 400:
            return []
        time.sleep(backoff)  # 429/502/503/504: the index is busy
        backoff = min(backoff * 2, 90)
    return None  # gave up; not recorded, so a re-run retries it


def usable(cap):
    return (cap.get("status") == "200"
            and "html" in (cap.get("mime-detected") or cap.get("mime") or "")
            and cap.get("filename") and cap.get("offset") and cap.get("length"))


def choose_captures(caps, rng, k):
    """Prefer the homepage, then a random spread of distinct inner pages."""
    seen, uniq = set(), []
    for c in caps:
        if usable(c) and c["url"] not in seen:
            seen.add(c["url"])
            uniq.append(c)
    if not uniq:
        return []
    uniq.sort(key=lambda c: len(c["url"]))
    picked = [uniq[0]]
    rest = uniq[1:]
    rng.shuffle(rest)
    picked.extend(rest[: k - 1])
    return picked


def slim(cap, **extra):
    out = {
        "url": cap["url"],
        "filename": cap["filename"],
        "offset": int(cap["offset"]),
        "length": int(cap["length"]),
        "languages": cap.get("languages", ""),
        "timestamp": cap.get("timestamp", ""),
    }
    out.update(extra)
    return out


def index_domain_task(crawl, task, limiter, per_domain, seed):
    target, label, source, category = task
    params = {
        "output": "json",
        "limit": 40,
        "collapse": "urlkey",
        "fl": "url,status,mime,mime-detected,filename,offset,length,languages,timestamp",
    }
    if "/" in target:
        params["url"] = target  # an exact URL or a path prefix like example.com/wiki/*
    else:
        params["url"] = target
        params["matchType"] = "domain"
    caps = cdx_get(crawl, params, limiter)
    if caps is None:
        return None
    rng = random.Random(f"{seed}:{target}")
    k = 1 if "/" in target and not target.endswith("*") else per_domain
    chosen = choose_captures(caps, rng, k)
    return [slim(c, label=label, source=source, category=category, target=target)
            for c in chosen]


def run_index(args):
    os.makedirs(CACHE, exist_ok=True)
    captures_path = os.path.join(CACHE, "captures.jsonl")
    done_path = os.path.join(CACHE, "index_done.jsonl")
    done = {d["target"] for d in read_jsonl(done_path)}

    blocklist = load_blocklist()
    rng = random.Random(args.seed)
    adult_pool = sorted(blocklist)
    adult_sample = rng.sample(adult_pool, min(args.adult_domains, len(adult_pool)))

    tasks = []
    for d in adult_sample:
        tasks.append((d, 1, "blocklist", "adult"))
    for target, category in load_benign_list():
        host = target.split("/")[0]
        if in_blocklist(host, blocklist):
            print(f"[skip] curated benign target is on the blocklist: {target}", file=sys.stderr)
            continue
        tasks.append((target, 0, "curated", category))
    tasks = [t for t in tasks if t[0] not in done]
    print(f"index: {len(tasks)} domain queries to run ({len(done)} already done)", file=sys.stderr)

    limiter = RateLimiter(args.index_rate)
    found = 0
    with ThreadPoolExecutor(max_workers=args.index_workers) as pool:
        futs = {pool.submit(index_domain_task, args.crawl, t, limiter,
                            args.per_domain, args.seed): t for t in tasks}
        for i, fut in enumerate(as_completed(futs), 1):
            t = futs[fut]
            try:
                res = fut.result()
            except Exception as e:  # never let one domain kill the run
                print(f"[error] {t[0]}: {e}", file=sys.stderr)
                continue
            if res is None:
                continue
            for cap in res:
                append_jsonl(captures_path, cap)
            found += len(res)
            append_jsonl(done_path, {"target": t[0], "captures": len(res)})
            if i % 100 == 0:
                print(f"  {i}/{len(tasks)} queried, {found} captures", file=sys.stderr)

    run_random_blocks(args, blocklist, captures_path, done_path, done, limiter)


def run_random_blocks(args, blocklist, captures_path, done_path, done, limiter):
    if args.random_blocks <= 0:
        return
    rng = random.Random(args.seed + 1)
    tlds = [t for t, _ in RANDOM_TLDS]
    weights = [w for _, w in RANDOM_TLDS]
    draws = Counter(rng.choices(tlds, weights=weights, k=args.random_blocks))

    num_pages = {}
    for tld in draws:
        key = f"random-pages:{tld}"
        res = cdx_get(args.crawl, {"url": tld, "matchType": "domain", "showNumPages": "true"}, limiter)
        # showNumPages returns one JSON object: {"pages": N, ...}
        if res and isinstance(res[0], dict) and "pages" in res[0]:
            num_pages[tld] = int(res[0]["pages"])
        else:
            print(f"[warn] no page count for .{tld}", file=sys.stderr)

    jobs = []
    for tld, n in draws.items():
        if tld not in num_pages:
            continue
        for j in range(n):
            page = random.Random(f"{args.seed}:{tld}:{j}").randrange(num_pages[tld])
            target = f"random:{tld}:{page}"
            if target not in done:
                jobs.append((tld, page, target))
    print(f"random: {len(jobs)} index blocks to sample", file=sys.stderr)

    def one(job):
        tld, page, target = job
        caps = cdx_get(args.crawl, {
            "url": tld, "matchType": "domain", "page": page, "pageSize": 1, "output": "json",
            "fl": "url,status,mime,mime-detected,filename,offset,length,languages,timestamp",
        }, limiter)
        if caps is None:
            return target, None
        by_host = defaultdict(list)
        for c in caps:
            if usable(c):
                host = re.sub(r"^https?://", "", c["url"]).split("/")[0].split(":")[0].lower()
                by_host[host].append(c)
        hosts = sorted(by_host)
        r = random.Random(target)
        r.shuffle(hosts)
        picked = []
        for host in hosts[: args.hosts_per_block]:
            cap = r.choice(by_host[host])
            label = 1 if in_blocklist(host, blocklist) else 0
            picked.append(slim(cap, label=label, source="random",
                               category="random-adult" if label else "random", target=target))
        return target, picked

    with ThreadPoolExecutor(max_workers=max(1, args.index_workers - 1)) as pool:
        for target, res in pool.map(one, jobs):
            if res is None:
                continue
            for cap in res:
                append_jsonl(captures_path, cap)
            append_jsonl(done_path, {"target": target, "captures": len(res)})


# --------------------------------------------------------------------------
# Index stage, second source: the published index files (--index-source cluster)
# --------------------------------------------------------------------------
# The URL index server (index.commoncrawl.org) is a single, often-overloaded
# host that stalls or refuses clients it thinks are busy. The same index is
# published as files on data.commoncrawl.org, which is a CDN: cluster.idx
# (~100 MB) names the first key of every ~270 KB block of the sorted index, so
# a lookup is a binary search in memory plus one streamed block read that
# stops as soon as it has passed the site it wants.
#
# Adult sites are chosen from blocklisted hosts that START a block, so every
# adult lookup is a guaranteed hit and no bandwidth goes on sites the crawl
# never saw. That favours sites large enough to span blocks -- the sites
# people actually visit. A byte budget stops index traffic at a hard cap.
class ByteBudget:
    def __init__(self, cap_bytes):
        self.cap = cap_bytes
        self.used = 0
        self.lock = threading.Lock()

    def add(self, n):
        with self.lock:
            self.used += n

    def exhausted(self):
        return self.used >= self.cap


def download_cluster(crawl, budget):
    path = os.path.join(CACHE, f"cluster-{crawl}.idx")
    if os.path.exists(path):
        return path
    url = DATA_BASE + f"cc-index/collections/{crawl}/indexes/cluster.idx"
    part = path + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    print(f"cluster: downloading {url} (resuming at {have} bytes)", file=sys.stderr)
    with session().get(url, headers=headers, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(part, "ab") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
                budget.add(len(chunk))
    os.replace(part, path)
    return path


def load_cluster(path):
    """Block start keys, and each block's (file, offset, length)."""
    import array
    keys = []
    files, file_ids = [], {}
    fidx, offsets, lengths = array.array("H"), array.array("q"), array.array("l")
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            keys.append(parts[0].split(" ", 1)[0])
            fid = file_ids.get(parts[1])
            if fid is None:
                fid = file_ids[parts[1]] = len(files)
                files.append(parts[1])
            fidx.append(fid)
            offsets.append(int(parts[2]))
            lengths.append(int(parts[3]))
    return keys, (files, fidx, offsets, lengths)


def surt_of(target):
    """(prefix, mode) for a target: a domain -> 'com,example' (mode 'domain');
    a URL path -> 'org,wikipedia,en)/wiki/x' ('prefix' if it ended in *)."""
    host, _, path = target.partition("/")
    host = host.lower()
    if host.startswith("www."):
        host = host[4:]
    rev = ",".join(reversed(host.split(".")))
    if not path:
        return rev, "domain"
    p = "/" + path
    if p.endswith("*"):
        return rev + ")" + p[:-1].lower(), "prefix"
    return rev + ")" + p.lower(), "exact"


def key_matches(key, prefix, mode):
    if mode == "domain":
        return key.startswith(prefix + ")") or key.startswith(prefix + ",")
    return key.startswith(prefix)


def key_past(key, prefix, mode):
    """True once the sorted index has moved beyond every key for the target."""
    if mode == "domain":
        # ')' < ',' in ASCII: 'com,x)...' keys, then 'com,x,sub)...', then others.
        return key > prefix + "," and not key.startswith(prefix + ",")
    return key > prefix and not key.startswith(prefix)


def iter_block_lines(crawl, block, budget):
    fname, offset, length = block
    url = DATA_BASE + f"cc-index/collections/{crawl}/indexes/{fname}"
    r = session().get(url, headers={"Range": f"bytes={offset}-{offset + length - 1}"},
                      stream=True, timeout=90)
    try:
        if r.status_code not in (200, 206):
            return
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        buf = b""
        for chunk in r.iter_content(16384):
            budget.add(len(chunk))
            buf += d.decompress(chunk)
            lines = buf.split(b"\n")
            buf = lines.pop()
            for ln in lines:
                yield ln.decode("utf-8", "replace")
        buf += d.flush()
        if buf:
            yield buf.decode("utf-8", "replace")
    finally:
        r.close()


def parse_cdx_line(line):
    parts = line.split(" ", 2)
    if len(parts) < 3:
        return None, None
    try:
        obj = json.loads(parts[2])
    except json.JSONDecodeError:
        return parts[0], None
    obj["timestamp"] = parts[1]
    return parts[0], obj


class ClusterIndex:
    def __init__(self, crawl, keys, blocks, budget):
        self.crawl = crawl
        self.keys = keys
        self.files, self.fidx, self.offsets, self.lengths = blocks
        self.budget = budget

    def block(self, i):
        return self.files[self.fidx[i]], self.offsets[i], self.lengths[i]

    def lookup(self, target, want=60, max_blocks=2):
        import bisect
        prefix, mode = surt_of(target)
        start = prefix + ")" if mode == "domain" else prefix
        j = bisect.bisect_right(self.keys, start)
        i = j if (j < len(self.keys) and key_matches(self.keys[j], prefix, mode)) else max(0, j - 1)
        found = []
        for b in range(i, min(i + max_blocks, len(self.keys))):
            if b > i and not key_matches(self.keys[b], prefix, mode):
                break
            gen = iter_block_lines(self.crawl, self.block(b), self.budget)
            try:
                for line in gen:
                    key, cap = parse_cdx_line(line)
                    if key is None:
                        continue
                    if key_matches(key, prefix, mode):
                        if cap and (mode != "exact" or key == prefix or key.startswith(prefix + "?")):
                            found.append(cap)
                            if len(found) >= want:
                                return found
                    elif key_past(key, prefix, mode):
                        return found
            finally:
                gen.close()
        return found

    def sample_block(self, i, max_lines):
        out = []
        gen = iter_block_lines(self.crawl, self.block(i), self.budget)
        try:
            for line in gen:
                _key, cap = parse_cdx_line(line)
                if cap:
                    out.append(cap)
                if len(out) >= max_lines:
                    break
        finally:
            gen.close()
        return out


def blocklist_entry(host, blocklist):
    labels = host.lower().strip(".").split(".")
    for i in range(len(labels) - 1):
        cand = ".".join(labels[i:])
        if cand in blocklist:
            return cand
    return None


def host_of_key(key):
    hs = key.split(")", 1)[0]
    if ":" in hs or not hs or hs[0].isdigit():
        return None  # IP address or explicit port: not a site
    return ".".join(reversed(hs.split(",")))


def host_of_url(url):
    return re.sub(r"^https?://", "", url).split("/")[0].split(":")[0].lower()


def run_index_cluster(args):
    os.makedirs(CACHE, exist_ok=True)
    captures_path = os.path.join(CACHE, "captures.jsonl")
    done_path = os.path.join(CACHE, "index_done.jsonl")
    done = {d["target"] for d in read_jsonl(done_path)}
    budget = ByteBudget(int(args.index_budget_mb * 1e6))

    path = download_cluster(args.crawl, budget)
    keys, blocks = load_cluster(path)
    idx = ClusterIndex(args.crawl, keys, blocks, budget)
    print(f"cluster: {len(keys)} blocks loaded", file=sys.stderr)

    blocklist = load_blocklist()
    # Blocklisted sites that start a block: guaranteed to be in this crawl.
    entries = set()
    for key in keys:
        host = host_of_key(key)
        if host:
            e = blocklist_entry(host, blocklist)
            if e:
                entries.add(e)
    by_site = defaultdict(list)
    for e in sorted(entries):
        by_site[site_of(e)].append(e)
    rng = random.Random(args.seed)
    sites = sorted(by_site)
    rng.shuffle(sites)
    adult = [rng.choice(by_site[s]) for s in sites[: args.adult_domains]]
    print(f"cluster: {len(entries)} blocklisted hosts start a block ({len(by_site)} sites); "
          f"sampling {len(adult)}", file=sys.stderr)

    benign = []
    for target, category in load_benign_list():
        if in_blocklist(target.split("/")[0], blocklist):
            continue
        benign.append((target, category))
    traps = [(t, 0, "curated", c) for t, c in benign if c.startswith("trap-")]
    general = [(t, 0, "curated", c) for t, c in benign if not c.startswith("trap-")]
    adult_tasks = [(e, 1, "blocklist", "adult") for e in adult]
    # Traps first (they are the graduation gate), then adult and general
    # interleaved, so a budget cut-off costs a little of each, not all of one.
    tasks = list(traps)
    for k in range(max(len(adult_tasks), len(general))):
        if k < len(adult_tasks):
            tasks.append(adult_tasks[k])
        if k < len(general):
            tasks.append(general[k])
    tasks = [t for t in tasks if t[0] not in done]
    print(f"cluster: {len(tasks)} lookups to run", file=sys.stderr)

    def one(task):
        target, label, source, category = task
        if budget.exhausted():
            return task, None
        try:
            caps = idx.lookup(target)
        except requests.RequestException as e:
            print(f"[warn] {target}: {e}", file=sys.stderr)
            return task, None
        for c in caps:
            c.setdefault("url", "")
        k = args.adult_per_domain if label == 1 else args.per_domain
        if "/" in target and not target.endswith("*"):
            k = 1
        chosen = choose_captures(caps, random.Random(f"{args.seed}:{target}"), k)
        out = []
        for c in chosen:
            lab = label
            if label == 1 and not in_blocklist(host_of_url(c["url"]), blocklist):
                continue  # never label a page adult unless its own host is listed
            out.append(slim(c, label=lab, source=source, category=category, target=target))
        return task, out

    found = 0
    with ThreadPoolExecutor(max_workers=args.fetch_workers) as pool:
        for n, (task, res) in enumerate(pool.map(one, tasks), 1):
            if res is None:
                continue
            for cap in res:
                append_jsonl(captures_path, cap)
            found += len(res)
            append_jsonl(done_path, {"target": task[0], "captures": len(res)})
            if n % 50 == 0:
                print(f"  {n}/{len(tasks)} looked up, {found} captures, "
                      f"{budget.used / 1e6:.0f} MB index traffic", file=sys.stderr)

    # A little of the ordinary long-tail web, from random blocks.
    by_tld = defaultdict(list)
    for i, key in enumerate(keys):
        by_tld[key.split(",", 1)[0].split(")", 1)[0]].append(i)
    tlds = [t for t, _ in RANDOM_TLDS if by_tld.get(t)]
    weights = [w for t, w in RANDOM_TLDS if by_tld.get(t)]
    r = random.Random(args.seed + 1)
    jobs = []
    for j, tld in enumerate(r.choices(tlds, weights=weights, k=args.random_blocks)):
        bi = random.Random(f"{args.seed}:{tld}:{j}").choice(by_tld[tld])
        target = f"random-block:{bi}"
        if target not in done:
            jobs.append((bi, target))
    for bi, target in jobs:
        if budget.exhausted():
            break
        try:
            caps = idx.sample_block(bi, max_lines=1500)
        except requests.RequestException:
            continue
        per_host = defaultdict(list)
        for c in caps:
            if usable(c):
                per_host[host_of_url(c["url"])].append(c)
        hosts = sorted(per_host)
        rr = random.Random(target)
        rr.shuffle(hosts)
        picked = []
        for host in hosts[: args.hosts_per_block]:
            c = rr.choice(per_host[host])
            lab = 1 if in_blocklist(host, blocklist) else 0
            picked.append(slim(c, label=lab, source="random",
                               category="random-adult" if lab else "random", target=target))
        for cap in picked:
            append_jsonl(captures_path, cap)
        append_jsonl(done_path, {"target": target, "captures": len(picked)})
    print(f"cluster: done, {budget.used / 1e6:.0f} MB index traffic this run"
          + (" (budget reached)" if budget.exhausted() else ""), file=sys.stderr)


# --------------------------------------------------------------------------
# Top-up (plan-topup / topup): targeted additions after reading EVAL.md
# --------------------------------------------------------------------------
# The first corpus was English-heavy on the benign side and multilingual on
# the adult side (the blocklist is), so the model partly learned "not English
# -> adult": French beauty pages and Polish news scored high, while Japanese
# and Indonesian adult pages were missed. plan-topup writes topup_targets.tsv
# (committed, so the corpus is reproducible); topup fetches it.
TOPUP_PATH = os.path.join(HERE, "topup_targets.tsv")
ENGLISH_TLDS = {"com", "org", "net", "uk", "us", "gov", "edu", "ca", "au", "io",
                "co", "info", "nz", "ie", "app", "tv", "me", "club", "xxx", "porn", "sex"}
NON_ENGLISH_TLDS = ["jp", "cn", "tw", "kr", "hk", "id", "vn", "th", "ru", "ua", "de", "fr",
                    "br", "pl", "es", "it", "tr", "nl", "cz", "mx", "ar", "pt", "gr", "ro", "hu"]


def run_plan_topup(args):
    pages = [p for p in read_jsonl(os.path.join(CACHE, "pages.jsonl")) if "error" not in p]
    caps = read_jsonl(os.path.join(CACHE, "captures.jsonl"))
    rows = []

    only_adult = bool(args.topup_adult_tlds or args.topup_adult_regex)
    host_re = re.compile(args.topup_adult_regex) if args.topup_adult_regex else None
    # 1. Curated benign sites whose pages are not in English: more pages each.
    target_lang = defaultdict(Counter)
    url_target = {c["url"]: c.get("target") for c in caps}
    for p in pages:
        if p["source"] == "curated" and p["label"] == 0:
            t = url_target.get(p["url"])
            if t:
                target_lang[(t, p["category"])][(p.get("languages") or "?").split(",")[0]] += 1
    for (t, cat), c in sorted(target_lang.items()):
        lang, _ = c.most_common(1)[0]
        if lang not in ("eng", "?") and "/" not in t and not only_adult:
            rows.append((t, 0, cat, 6))

    # 2. Every recovery site, deeper: forums and articles about quitting porn
    #    are the trap this extension's users hit most.
    for target, category in load_benign_list():
        if category == "trap-recovery" and not only_adult:
            rows.append((target, 0, category, 10))

    # 3. Adult sites on non-English TLDs, not sampled before.
    used = {c.get("target") for c in caps if c.get("label") == 1}
    path = os.path.join(CACHE, f"cluster-{args.crawl}.idx")
    keys, _blocks = load_cluster(path)
    blocklist = load_blocklist()
    cands = set()
    for key in keys:
        host = host_of_key(key)
        if not host:
            continue
        if host_re is not None:
            if not host_re.search(host):
                continue
        else:
            tlds = args.topup_adult_tlds.split(",") if args.topup_adult_tlds else NON_ENGLISH_TLDS
            if host.rsplit(".", 1)[-1] not in tlds:
                continue
        e = blocklist_entry(host, blocklist)
        if e and e not in used:
            cands.add(e)
    by_site = defaultdict(list)
    for e in sorted(cands):
        by_site[site_of(e)].append(e)
    rng = random.Random(args.seed + 7)
    sites = sorted(by_site)
    rng.shuffle(sites)
    for s in sites[: args.topup_adult]:
        rows.append((rng.choice(by_site[s]), 1, "adult", args.adult_per_domain))

    # 4. Random blocks from non-English TLDs (the ordinary web, not in English).
    by_tld = defaultdict(list)
    for i, key in enumerate(keys):
        by_tld[key.split(",", 1)[0].split(")", 1)[0]].append(i)
    r = random.Random(args.seed + 11)
    avail = [t for t in NON_ENGLISH_TLDS if by_tld.get(t)]
    for j in range(0 if only_adult else args.topup_random):
        tld = avail[j % len(avail)]
        rows.append((f"random-block:{r.choice(by_tld[tld])}", -1, "random", args.hosts_per_block))

    # A later round appends to the plan, so the file records every round.
    existing = set()
    if os.path.exists(TOPUP_PATH):
        with open(TOPUP_PATH, "r", encoding="utf-8") as fh:
            existing = {ln.split("\t", 1)[0] for ln in fh if not ln.startswith("#")}
    rows = [r for r in rows if r[0] not in existing]
    with open(TOPUP_PATH, "a", encoding="utf-8", newline="\n") as fh:
        if not existing:
            fh.write("# Generated by `build_corpus.py plan-topup`; fetched by `build_corpus.py topup`.\n")
            fh.write("# target\tlabel (1 adult, 0 benign, -1 by blocklist)\tcategory\tpages\n")
        else:
            what = args.topup_adult_regex or args.topup_adult_tlds or "non-English TLDs"
            fh.write(f"# round: adult sites matching {what}\n")
        for t, lab, cat, k in rows:
            fh.write(f"{t}\t{lab}\t{cat}\t{k}\n")
    kinds = Counter((lab, cat.startswith("trap-")) for _, lab, cat, _ in rows)
    print(f"plan-topup: {len(rows)} targets -> {TOPUP_PATH}  {dict(kinds)}", file=sys.stderr)


def run_topup(args):
    captures_path = os.path.join(CACHE, "captures.jsonl")
    cand_path = os.path.join(CACHE, "candidates.jsonl")
    done_path = os.path.join(CACHE, "index_done.jsonl")
    done = {d["target"] for d in read_jsonl(done_path)}
    have = {c["url"] for c in read_jsonl(captures_path)}
    budget = ByteBudget(int(args.index_budget_mb * 1e6))
    keys, blocks = load_cluster(download_cluster(args.crawl, budget))
    idx = ClusterIndex(args.crawl, keys, blocks, budget)
    blocklist = load_blocklist()

    rows = []
    with open(TOPUP_PATH, "r", encoding="utf-8") as fh:
        for raw in fh:
            if raw.startswith("#") or not raw.strip():
                continue
            t, lab, cat, k = raw.rstrip("\n").split("\t")
            if "topup:" + t not in done:
                rows.append((t, int(lab), cat, int(k)))
    print(f"topup: {len(rows)} targets to run", file=sys.stderr)

    def one(row):
        t, lab, cat, k = row
        if budget.exhausted():
            return row, None
        try:
            if t.startswith("random-block:"):
                caps = idx.sample_block(int(t.split(":", 1)[1]), max_lines=1500)
            else:
                caps = idx.lookup(t, want=80)
        except requests.RequestException:
            return row, None
        for c in caps:
            if usable(c):
                append_jsonl(cand_path, slim(c, target=t))  # keep every candidate for later rounds
        rr = random.Random(f"{args.seed}:topup:{t}")
        out = []
        if t.startswith("random-block:"):
            per_host = defaultdict(list)
            for c in caps:
                if usable(c) and c["url"] not in have:
                    per_host[host_of_url(c["url"])].append(c)
            hosts = sorted(per_host)
            rr.shuffle(hosts)
            for host in hosts[:k]:
                c = rr.choice(per_host[host])
                l2 = 1 if in_blocklist(host, blocklist) else 0
                out.append(slim(c, label=l2, source="random",
                                category="random-adult" if l2 else "random", target=t))
            return row, out
        fresh = [c for c in caps if c.get("url") not in have]
        for c in choose_captures(fresh, rr, k):
            if lab == 1 and not in_blocklist(host_of_url(c["url"]), blocklist):
                continue
            out.append(slim(c, label=lab, source="blocklist" if lab == 1 else "curated",
                            category=cat, target=t))
        return row, out

    added = 0
    with ThreadPoolExecutor(max_workers=args.fetch_workers) as pool:
        for n, (row, res) in enumerate(pool.map(one, rows), 1):
            if res is None:
                continue
            for cap in res:
                append_jsonl(captures_path, cap)
            added += len(res)
            append_jsonl(done_path, {"target": "topup:" + row[0], "captures": len(res)})
            if n % 50 == 0:
                print(f"  {n}/{len(rows)} done, {added} new captures, "
                      f"{budget.used / 1e6:.0f} MB index traffic", file=sys.stderr)
    print(f"topup: {added} new captures, {budget.used / 1e6:.0f} MB index traffic"
          + (" (budget reached)" if budget.exhausted() else ""), file=sys.stderr)


# --------------------------------------------------------------------------
# Fetch stage
# --------------------------------------------------------------------------
def fetch_record(cap, tries=5):
    url = DATA_BASE + cap["filename"]
    start = cap["offset"]
    end = start + cap["length"] - 1
    backoff = 2.0
    for _ in range(tries):
        try:
            r = session().get(url, headers={"Range": f"bytes={start}-{end}"}, timeout=90)
            if r.status_code in (200, 206):
                return r.content
        except requests.RequestException:
            pass
        time.sleep(backoff)
        backoff = min(backoff * 2, 60)
    return None


def dechunk(body):
    out, i = bytearray(), 0
    while i < len(body):
        j = body.find(b"\r\n", i)
        if j < 0:
            break
        size_str = body[i:j].split(b";")[0].strip()
        try:
            size = int(size_str, 16)
        except ValueError:
            return body  # not actually chunked
        if size == 0:
            break
        out += body[j + 2: j + 2 + size]
        i = j + 2 + size + 2
    return bytes(out)


def parse_warc(raw):
    data = gzip.decompress(raw)
    head_end = data.find(b"\r\n\r\n")
    if head_end < 0:
        return None, None
    http_part = data[head_end + 4:]
    hdr_end = http_part.find(b"\r\n\r\n")
    if hdr_end < 0:
        return None, None
    http_headers = http_part[:hdr_end].decode("latin-1", "replace")
    body = http_part[hdr_end + 4:]
    lower = http_headers.lower()
    if "transfer-encoding: chunked" in lower:
        body = dechunk(body)
    if body[:2] == b"\x1f\x8b":
        try:
            body = gzip.decompress(body)
        except Exception:
            pass
    elif "content-encoding: deflate" in lower:
        try:
            body = zlib.decompress(body)
        except Exception:
            pass
    return http_headers, body


_CHARSET_RE = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-:.]+)""", re.I)


def decode_body(http_headers, body):
    charset = None
    m = re.search(r"charset=([\w\-:.]+)", http_headers or "", re.I)
    if m:
        charset = m.group(1)
    if not charset:
        m = _CHARSET_RE.search(body[:4096])
        if m:
            charset = m.group(1).decode("ascii", "ignore")
    for enc in (charset, "utf-8"):
        if not enc:
            continue
        try:
            return body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


# innerText inserts line breaks around block-level boxes. Approximated from
# the tag name, since CSS is not available offline.
BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "body", "br", "center", "dd", "details",
    "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
    "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "legend", "li",
    "main", "menu", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody",
    "thead", "tfoot", "tr", "ul", "caption", "option",
}
# Subtrees innerText never renders.
SKIP_TAGS = {"script", "style", "noscript", "template", "svg", "math", "head", "iframe",
             "object", "embed", "canvas", "select", "textarea", "video", "audio", "map"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
             "param", "source", "track", "wbr", "keygen"}
_HIDDEN_STYLE = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden", re.I)


class InnerTextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = None
        self._in_title = False
        self._title_buf = []
        self.metas = []  # (index into AI_TEXT_META_KEYS, content) in document order
        self.stack = []
        self.skip_from = None
        self.lines = []
        self.buf = []

    def _newline(self):
        if self.buf:
            self.lines.append("".join(self.buf))
            self.buf = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            for idx, (attr, key) in enumerate(AI_TEXT_META_KEYS):
                if a.get(attr, "").lower() == key and a.get("content"):
                    self.metas.append((idx, a["content"]))
                    break
            return
        if tag == "title" and self.title is None and "svg" not in self.stack:
            self._in_title = True
        if tag in VOID_TAGS:
            if tag == "br" and self.skip_from is None:
                self._newline()
            return
        self.stack.append(tag)
        if self.skip_from is None:
            hidden = "hidden" in a or _HIDDEN_STYLE.search(a.get("style", ""))
            if tag in SKIP_TAGS or hidden:
                self.skip_from = len(self.stack) - 1
            elif tag in BLOCK_TAGS:
                self._newline()

    def handle_endtag(self, tag):
        if tag == "title" and self._in_title:
            self._in_title = False
            self.title = "".join(self._title_buf)
        if tag in VOID_TAGS or tag not in self.stack:
            return
        while self.stack:
            top = self.stack.pop()
            if top == tag:
                break
        if self.skip_from is not None and len(self.stack) <= self.skip_from:
            self.skip_from = None
        elif self.skip_from is None and tag in BLOCK_TAGS:
            self._newline()

    def handle_data(self, data):
        if self._in_title:
            self._title_buf.append(data)
            return
        if self.skip_from is None:
            self.buf.append(data)

    def close(self):
        super().close()
        self._newline()
        if self._in_title and self.title is None:
            self.title = "".join(self._title_buf)


_WS = re.compile(r"\s+")


def extract(markup):
    p = InnerTextParser()
    try:
        p.feed(markup)
        p.close()
    except Exception:
        pass
    title = _WS.sub(" ", p.title or "").strip()
    metas = [(AI_TEXT_META_KEYS[i][1], _WS.sub(" ", html.unescape(c)).strip()) for i, c in p.metas]
    lines = []
    for raw in p.lines:
        line = _WS.sub(" ", raw).strip()
        if line:
            lines.append(line)
        if len(lines) >= STORED_LINE_LIMIT:
            break
    return title, metas, lines


def fetch_one(cap):
    raw = fetch_record(cap)
    if raw is None:
        return None
    try:
        headers, body = parse_warc(raw)
    except Exception:
        return {"url": cap["url"], "error": "warc-parse"}
    if body is None:
        return {"url": cap["url"], "error": "warc-parse"}
    markup = decode_body(headers, body)
    title, metas, lines = extract(markup)
    host = re.sub(r"^https?://", "", cap["url"]).split("/")[0].split(":")[0].lower()
    return {
        "url": cap["url"],
        "host": host,
        "site": site_of(host),
        "label": cap["label"],
        "source": cap["source"],
        "category": cap["category"],
        "languages": cap.get("languages", ""),
        "title": title,
        "metas": metas,
        "lines": lines,
        "bytes": len(raw),
    }


def run_fetch(args):
    captures = read_jsonl(os.path.join(CACHE, "captures.jsonl"))
    pages_path = os.path.join(CACHE, "pages.jsonl")
    have = {p["url"] for p in read_jsonl(pages_path)}
    seen, todo = set(), []
    for c in captures:
        if c["url"] in have or c["url"] in seen:
            continue
        seen.add(c["url"])
        todo.append(c)
    print(f"fetch: {len(todo)} records to fetch ({len(have)} already fetched)", file=sys.stderr)
    total_bytes = 0
    with ThreadPoolExecutor(max_workers=args.fetch_workers) as pool:
        futs = [pool.submit(fetch_one, c) for c in todo]
        for i, fut in enumerate(as_completed(futs), 1):
            try:
                page = fut.result()
            except Exception as e:
                print(f"[error] fetch: {e}", file=sys.stderr)
                continue
            if page is None:
                continue
            total_bytes += page.get("bytes", 0)
            append_jsonl(pages_path, page)
            if i % 200 == 0:
                print(f"  {i}/{len(todo)} fetched, {total_bytes / 1e6:.1f} MB", file=sys.stderr)
    print(f"fetch: done, {total_bytes / 1e6:.1f} MB downloaded this run", file=sys.stderr)


# --------------------------------------------------------------------------
# Runtime-equivalent text (mirrors gatherTextForModel in content.js)
# --------------------------------------------------------------------------
PAGE_TEXT_SCAN_MAX_LINES = 48
PAGE_TEXT_SCAN_MIN_LINE_LENGTH = 12


def page_parts(page, max_lines=PAGE_TEXT_SCAN_MAX_LINES):
    """(head, body) exactly as content.js hands them to the classifier: head is
    the title and the AI_TEXT_META_SELECTORS contents, body the first 48
    innerText lines of at least 12 characters. Length caps are applied by the
    scorer (scorePage / truncate_parts), not here."""
    head_parts = []
    if page.get("title"):
        head_parts.append(page["title"])
    for _key, content in page.get("metas", []):
        if content:
            head_parts.append(content)
    lines = [ln for ln in page.get("lines", []) if len(ln) >= PAGE_TEXT_SCAN_MIN_LINE_LENGTH]
    return " ".join(head_parts), " ".join(lines[:max_lines])


OVERRIDES_PATH = os.path.join(HERE, "label_overrides.tsv")


def load_overrides():
    out = {}
    with open(OVERRIDES_PATH, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            host, _, reason = line.partition("\t")
            out[host.strip().lower()] = reason.strip()
    return out


def excluded_by(host, overrides):
    """The override entry that excludes this host, or None."""
    labels = host.lower().split(".")
    for i in range(len(labels) - 1):
        cand = ".".join(labels[i:])
        if cand in overrides:
            return cand
    return None


def runtime_text(page):
    head, body = page_parts(page)
    return (head + " " + body).strip()


def run_stats(_args):
    pages = [p for p in read_jsonl(os.path.join(CACHE, "pages.jsonl")) if "error" not in p]
    caps = read_jsonl(os.path.join(CACHE, "captures.jsonl"))
    print(f"captures: {len(caps)}   pages: {len(pages)}")
    by = Counter((p["label"], p["source"]) for p in pages)
    for k in sorted(by):
        print(f"  label={k[0]} source={k[1]:<10} {by[k]}")
    sites = Counter((p["label"], p["site"]) for p in pages)
    print(f"distinct sites: adult={sum(1 for l, _ in sites if l == 1)} "
          f"benign={sum(1 for l, _ in sites if l == 0)}")
    lens = [len(runtime_text(p).split()) for p in pages]
    empty = sum(1 for n in lens if n < 12)
    print(f"runtime-text tokens: median={sorted(lens)[len(lens) // 2] if lens else 0} "
          f"under-12={empty}")
    langs = Counter((p["languages"] or "?").split(",")[0] for p in pages)
    print("top languages:", ", ".join(f"{k}={v}" for k, v in langs.most_common(15)))
    cats = Counter(p["category"] for p in pages if p["label"] == 0)
    print("benign categories:", ", ".join(f"{k}={v}" for k, v in cats.most_common()))
    mb = sum(p.get("bytes", 0) for p in pages) / 1e6
    print(f"record bytes fetched: {mb:.1f} MB")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("stage", choices=["index", "fetch", "all", "stats", "plan-topup", "topup"])
    ap.add_argument("--topup-adult", type=int, default=80)
    ap.add_argument("--topup-random", type=int, default=60)
    ap.add_argument("--topup-adult-tlds", default="",
                    help="plan-topup: add only adult sites on these comma-separated TLDs")
    ap.add_argument("--topup-adult-regex", default="",
                    help="plan-topup: add only adult sites whose host matches this regex")
    ap.add_argument("--crawl", default=DEFAULT_CRAWL)
    ap.add_argument("--adult-domains", type=int, default=2500)
    ap.add_argument("--per-domain", type=int, default=3)
    ap.add_argument("--random-blocks", type=int, default=120)
    ap.add_argument("--hosts-per-block", type=int, default=4)
    ap.add_argument("--index-workers", type=int, default=3)
    ap.add_argument("--index-rate", type=float, default=2.5, help="index requests per second")
    ap.add_argument("--fetch-workers", type=int, default=8)
    ap.add_argument("--seed", type=int, default=20260924)
    ap.add_argument("--index-source", choices=["server", "cluster"], default="server",
                    help="server: index.commoncrawl.org (light, but often overloaded); "
                         "cluster: the published index files on the data CDN")
    ap.add_argument("--index-budget-mb", type=float, default=200,
                    help="cluster source: hard cap on index traffic, cluster.idx included")
    ap.add_argument("--adult-per-domain", type=int, default=4)
    args = ap.parse_args(argv)

    if args.stage in ("index", "all"):
        if args.index_source == "cluster":
            run_index_cluster(args)
        else:
            run_index(args)
    if args.stage == "plan-topup":
        run_plan_topup(args)
    if args.stage == "topup":
        run_topup(args)
    if args.stage in ("fetch", "all"):
        run_fetch(args)
    if args.stage in ("stats", "all"):
        run_stats(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
