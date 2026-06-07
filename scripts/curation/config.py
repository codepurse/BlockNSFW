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

# External feed sources
EXTERNAL_FEEDS = [
    {
        'url': 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
        'format': 'hosts',
    },
    {
        'url': 'https://raw.githubusercontent.com/chadmayfield/pihole-blocklists/master/lists/porn.txt',
        'format': 'plain',
    },
]

# File paths (relative to repo root)
HOSTS_FILE = 'data/HOSTS.txt'
WHITELIST_FILE = 'data/WHITELIST.txt'
BLOCKLIST_JSON = 'blocklist.json'
REVIEW_QUEUE_FILE = 'data/REVIEW_QUEUE.md'
REPORTS_DIR = 'data/reports'

# Typosquat detection
TOP_BRAND_DOMAINS = [
    'pornhub.com', 'xvideos.com', 'xhamster.com', 'youporn.com', 'redtube.com',
    'brazzers.com',
]
