"""Configuration for the domain curation pipeline.

All tunable parameters live here for easy adjustment.
"""

# Scoring thresholds
AUTO_MERGE_THRESHOLD = 0.85   # Auto-merge into HOSTS.txt
REVIEW_THRESHOLD = 0.50       # Add to review queue

# Feature weights (must sum to 1.0, excluding safety penalty)
WEIGHT_KEYWORD = 0.35
WEIGHT_TLD = 0.15
WEIGHT_STRUCTURE = 0.15
WEIGHT_SIMILARITY = 0.25
WEIGHT_SAFETY_PENALTY = 0.20  # Subtracted from total

# Adult keywords — synced from shared/host-keywords.js STRONG_HOST_KEYWORDS
STRONG_HOST_KEYWORDS = [
    'porn', 'porno', 'pornos', 'xxx', 'xvideos', 'xhamster', 'xnxx', 'redtube',
    'youporn', 'brazzers', 'chaturbate', 'bongacams', 'cam4', 'pornhub',
    'spankbang', 'tube8', 'youjizz', 'nudography', 'onlyfans', 'erome',
    'hentai', 'hentaihaven', 'rule34', 'pornoizle', 'tubeporn',
    'seks', 'sikis', 'bokep', 'yadong',
    '色情', '야동', 'порно', 'سكس', 'หนังโป๊',
]

# Ambiguous keywords that should NOT trigger strong blocking
AMBIGUOUS_KEYWORDS = {
    'sex', 'jav', 'cam', 'tube', 'video', 'videos', 'live', 'hd',
    'red', 'pink', 'hot', 'free',
}

# Multilingual adult keywords for substring matching
MULTILINGUAL_KEYWORDS = [
    # Chinese
    '色情', '情色', '成人片', '成人影片', '成人视频', '成人視頻',
    '成人网站', '成人網站', '黄色片', '黃色片', '黄色网站', '黃色網站',
    '三级片', '三級片', '无码视频', '無碼視頻', '无码片', '無碼片',
    'av女优', 'av女優', '裸聊直播', '约炮平台', '約炮平台',
    # Japanese
    'エロ動画', 'エロ画像', 'アダルト動画', 'アダルトビデオ',
    'ポルノ動画', 'ポルノ画像', 'エッチ動画', 'セックス動画',
    'ハメ撮り', '無修正動画', 'AV女優',
    # Korean
    '야동', '야설', '성인사이트', '성인동영상', '성인비디오',
    '포륵', '한국야동', '일본야동', '떡방', '벗방', '조개모아',
    # Russian
    'порно', 'порнуха', 'порнушка', 'порнография',
    'порновидео', 'порнофильм', 'порно онлайн',
    'хентай', 'порево', 'секс видео', 'секс фото', 'секс чат',
    'анальный секс', 'анал порно',
    # Arabic
    'افلام سكس', 'افلام إباحية', 'سكس عربي',
    'مقاطع سكس', 'فيديو سكس',
    # Thai
    'หนังโป๊', 'หนังโป', 'คลิปโป๊', 'คลิปหลุด', 'โป๊เปลือย',
    'หนังเอ๊ก', 'หนังx',
    # Vietnamese
    'phim sex', 'phim nguoi lon', 'phim sex viet',
    'phim khiêu dâm',
    # Indonesian
    'video bokep', 'film bokep', 'bokep indo', 'bokep jepang', 'situs bokep',
    # Hindi
    'सेक्सी वीडियो', 'देसी सेक्स', 'सेक्स वीडियो',
    'पॉर्न वीडियो', 'अश्लील वीडियो',
    # Tagalog
    'kantot', 'kantutan', 'jakulan',
    # Turkish
    'porno izle', 'sikiş izle', 'türk porno', 'türk sikiş',
    # German
    'pornofilm', 'pornofilme', 'pornos kostenlos', 'porno kostenlos',
    'geile titten', 'nackte frauen', 'gratis porno',
    # French
    'porno gratuit', 'film porno', 'porno français', 'films pornos',
    # Italian
    'porno gratis', 'film porno', 'porno italiano', 'video porno',
    # Spanish
    'porno gratis', 'porno español', 'pornografía', 'videos porno',
    'peliculas porno',
    # Portuguese
    'pornô grátis', 'pornografia', 'porno brasileiro', 'videos porno',
    'filme pornô',
    # Polish
    'porno za darmo', 'ostre porno', 'darmowe porno', 'filmy porno',
    # Czech
    'porno zdarma', 'české porno', 'porno videa',
]

# Safety tokens — domains containing these are likely benign
SAFE_HOST_TOKENS = [
    'help', 'recovery', 'recover', 'quit', 'addiction', 'support',
    'therapy', 'counseling', 'counselling', 'treatment', 'awareness',
    'education', 'educate', 'protect', 'protection', 'accountability',
    'nofap', 'no-porn', 'stop-porn', 'antiporn', 'anti-porn',
    'safer', 'safe', 'healing', 'rehab', 'overcome', 'overcoming',
    'freedom', 'liberty', 'testimonial', 'testimony', 'research',
    'study', 'academic',
]

# TLD risk classification
HIGH_RISK_TLDS = {'xxx', 'adult', 'porn', 'sex'}
BENIGN_TLDS = {'edu', 'gov', 'ac', 'mil'}

# Second-level labels that are part of a country's public suffix (co.uk,
# com.br), so the site's own name is the label before them.
SECOND_LEVEL_SUFFIX_LABELS = {
    'co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go', 'mil',
    'gob', 'nic', 'ltd', 'plc', 'gen', 'info', 'biz', 'nom',
}

# Adult AI services: sex chat and companion apps, porn generators, and nudify,
# undress or deepfake tools. Their names rarely carry a word the scorer trusts
# (clothoff.net, undress.app, kupid.ai), so they were all dropped. A candidate
# that matches goes to the AI review list (REVIEW_AI_FILE) instead, never
# straight into HOSTS.txt. First match wins; matched against the whole host.
# "ai" only counts at the edge of a name, so "thaisex" and "maisexo" don't.
_ADULT = r'(porn|sex|nsfw|nude|nudes|hentai|xxx|lewd|horny|erotic|smut)'
AI_ADULT_KINDS = [
    ('nudify', r'nudif|undress|deep-?nude|cloth(es)?-?off|deep-?fake|deep-?swap'
               r'|(^|[-.\d])ai-?nudes?|nudes?-?ai($|[-.\d])'),
    ('companion', r'(ai|gpt|bot)-?girlfriend|girlfriend-?(ai|gpt|bot)|(^|[-.\d])ai-?gf($|[-.\d])'
                  r'|gf-?ai($|[-.\d])|spicychat|crushon|janitorai'
                  r'|' + _ADULT + r'-?(bot|chatbot|companion|gpt)($|[-.\d])'
                  r'|(ai|gpt)-?sexting|sexting-?(ai|gpt)'
                  r'|(^|[-.\d])ai-?' + _ADULT + r'-?chat|' + _ADULT + r'-?chat-?ai($|[-.\d])'),
    ('generator', r'(^|[-.\d])ai-?' + _ADULT + r'|' + _ADULT + r'-?ai($|[-.\d])'
                  r'|pornpen|promptchan'),
]
# An adult feed listing a .ai address is very likely listing an AI service,
# whatever the name says (candy.ai, kupid.ai, muah.ai).
AI_TLDS = {'ai'}
AI_KIND_TITLES = {
    'nudify': 'Nudify, undress or deepfake',
    'companion': 'AI sex chat or companion',
    'generator': 'AI porn generator',
    'ai-domain': 'Other .ai addresses',
}
# Puts a matching candidate in review, above REVIEW_THRESHOLD and below
# AUTO_MERGE_THRESHOLD.
AI_REVIEW_SCORE = 0.6

# External feed sources
EXTERNAL_FEEDS = [
    {
        'name': 'StevenBlack',
        'short': 'SB',
        'url': 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
        'format': 'hosts',
    },
    {
        'name': 'Block List Project',
        'short': 'BLP',
        'url': 'https://raw.githubusercontent.com/blocklistproject/Lists/master/alt-version/porn-nl.txt',
        'format': 'plain',
    },
]

# Lists read only as evidence on the AI review list: whether they also have a
# domain. Both are GPL-3.0 and HOSTS.txt is MIT, so nothing is copied from
# them; a domain still only goes in when someone marks it.
EVIDENCE_FEEDS = [
    {
        'name': 'HaGeZi NSFW',
        'short': 'HZ',
        'url': 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw.txt',
        'format': 'wildcard',
    },
    {
        'name': 'OISD NSFW',
        'short': 'OI',
        'url': 'https://nsfw.oisd.nl/domainswild',
        'format': 'wildcard',
    },
]

# Cloudflare for Families answers 0.0.0.0 for a domain it classes as adult or
# malware: a second opinion on the AI review list, and a way to tell a site
# that is gone (no such domain) from one that is up.
FAMILY_DOH_URL = 'https://family.cloudflare-dns.com/dns-query'
FAMILY_DOH_WORKERS = 16

# File paths (relative to repo root)
HOSTS_FILE = 'data/HOSTS.txt'
WHITELIST_FILE = 'data/WHITELIST.txt'
BLOCKLIST_JSON = 'blocklist.json'
REVIEW_QUEUE_FILE = 'data/REVIEW_QUEUE.md'
REVIEW_AI_FILE = 'data/REVIEW_AI.md'
# Domains a maintainer looked at and left out; never proposed again.
REVIEW_REJECTED_FILE = 'data/REVIEW_REJECTED.txt'
REPORTS_DIR = 'data/reports'

# Typosquat detection
TOP_BRAND_DOMAINS = [
    'pornhub.com', 'xvideos.com', 'xhamster.com', 'youporn.com', 'redtube.com',
    'brazzers.com',
]
