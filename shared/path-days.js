// shared/path-days.js
// The thirty pages of the path: the words only. shared/path.js holds the
// logic (which day is open, what is done, the lines kept).
//
// Days 1 to 7 are free and whole here. Days 8 to 30 are a Supporter extra:
// here they keep only their titles, so the path can say what each is called,
// and extras/path-days.js (in store builds, not in this repository; see
// extras/README.md) adds the rest of each one with add().
//
// Each day: a title, a few short paragraphs, a `story` prompt where the
// author's own lines go, and today's one thing. `one.kind` is 'do' (Mark it
// done), 'line' (write one line, kept in the book shown on day 30) or 'link'
// (open a place in Settings, then Mark it done).
//
// The author's own lines go in `mine: ['…', '…']` on the day; until a day has
// them, the page shows its `story` prompt in brackets where they will go. The
// same holds for SIGNATURE, the line under every day. Fill both in before a
// release (RELEASE_CHECKLIST.md).
//
// Loaded as a classic <script> in pages and as a CommonJS module in tests.

(function (root) {
  'use strict';

  var WEEKS = [
    { n: 1, name: 'Seeing it', from: 1, to: 7 },
    { n: 2, name: 'Changing the setting', from: 8, to: 14 },
    { n: 3, name: 'The inside work', from: 15, to: 21 },
    { n: 4, name: 'The life after', from: 22, to: 30 }
  ];

  var DAYS = [
    // --- Week 1: Seeing it ---------------------------------------------------
    {
      n: 1,
      title: 'Why you’re here',
      body: [
        'You’re here because some part of you wants something different. That part is worth listening to, even if it’s quiet tonight, and even if it has been let down before.',
        'This path is thirty short pages, one a day. Each has a single idea and one small thing to do. None of it asks you to be perfect, and none of it takes long. Some days will land and some won’t. Read them anyway.',
        'It starts with the reason. Not the one you think you should have, the real one. Maybe you want to be present with someone you love. Maybe you’re tired of how you feel afterwards. Maybe you want your evenings back, or just to feel like yourself again.',
        'A reason you can say in one line is a reason you can remember at one in the morning. Write yours down today. It’s the first page of a small book you’ll keep this month, and you’ll read it again on day thirty.'
      ],
      story: 'A few lines from your own story: the moment you knew you wanted something different.',
      one: { kind: 'line', text: 'Write down why you’re here, in one honest line.', prompt: 'Why are you doing this?' }
    },
    {
      n: 2,
      title: 'It’s a loop, not a flaw',
      body: [
        'If you’ve fought this for a long time, it’s easy to decide that something is wrong with you. Almost everyone who struggles with it thinks that at some point. It isn’t true, and believing it only makes things harder.',
        'What you have is a loop. Something sets it off: a time of night, a feeling, being alone with a phone. Then the same routine runs, almost by itself. Then the payoff: relief, a break from whatever you were feeling. Each time the loop runs, it gets a little smoother.',
        'That’s how habits work for everyone. It’s also why willpower so often fails here. It’s being asked to stop the routine in the middle, when the loop is already running and you’re at your weakest.',
        'It works better to change the edges: the moment before it starts, and what you were getting from it. This week is about seeing those edges clearly. Today, only the first one.'
      ],
      story: 'A few lines from your own story: when you first saw it as a habit you had learned, not a verdict on who you are.',
      one: { kind: 'line', text: 'Think back to the last few times. What came just before? A time, a place, a feeling, a site.', prompt: 'What usually comes just before it?' }
    },
    {
      n: 3,
      title: 'An urge is a wave',
      body: [
        'An urge feels as if it will keep growing until you give in. It won’t. Urges rise, peak and fall, like a wave, and most of them pass if nothing feeds them, often sooner than you’d think.',
        'What feeds them is arguing, bargaining, or a quick look “just to check”. Fighting hard can feed them too, because you’re still giving them all of your attention.',
        'The other way is to watch it. Notice where you feel it: your chest, your stomach, a restless heat in your hands. Give it a number from one to ten. Breathe out slowly, longer than you breathe in. Then check the number again a few minutes later. It’s rarely where it was.',
        'Each time you ride one out, you learn something your body didn’t believe before: it ends, and you’re still here. When a page is held, the blocked page offers to wait it out with you for ten or twenty minutes.'
      ],
      story: 'A few lines from your own story: an urge you rode out, and what it was like when it passed.',
      one: { kind: 'do', text: 'Next time the pull comes, give it a number from one to ten. Wait ten minutes, then check the number again.' }
    },
    {
      n: 4,
      title: 'Hungry, angry, lonely, tired',
      body: [
        'Most nights it doesn’t start with wanting it. It starts with something else that hasn’t been looked after.',
        'There’s an old question from recovery groups. Before you trust an urge, ask: am I hungry, angry, lonely or tired? Any one of them makes the pull louder. Two or three together, late at night, and it can feel like the only thing that would help.',
        'It isn’t. It’s the nearest thing, not the thing you need. Food helps hungry. Saying it out loud helps angry. A message to someone helps lonely. Sleep helps tired. None of them are as fast, and all of them actually work.',
        'You don’t have to fix all four tonight. Just learn to ask the question before the urge answers it for you.'
      ],
      story: 'A few lines from your own story: a night when one of these four was the real reason.',
      one: { kind: 'do', text: 'Tonight, before bed, ask the four questions. If one is a yes, look after that one first.' }
    },
    {
      n: 5,
      title: 'Where it starts',
      body: [
        'Hardly anyone sets out to go looking. It starts somewhere ordinary: a feed, a search, a video that leads to another one. By the time it’s obvious where this is going, you’re most of the way there.',
        'That’s why the last step is so hard to stop and the first one is so easy. At the start you’re still thinking clearly, and saying no costs almost nothing. Ten steps in, the loop is running and you’re arguing with it.',
        'So look at the path, not where it ends. Where does it usually begin for you? For a lot of people it’s Instagram Explore, a particular subreddit, or image search late at night. For others it’s a certain show, or a certain kind of search.',
        'Once you know the door, you can put something in front of it. A gateway is a short pause before the sites you choose: ten seconds, your own words, and one question. Is this where it starts?'
      ],
      story: 'A few lines from your own story: where it usually started for you, and how harmless it looked at the time.',
      one: { kind: 'link', text: 'Choose one site where it tends to start for you, and make it a gateway.', href: 'options.html#gateways-group', label: 'Open Gateways' }
    },
    {
      n: 6,
      title: 'Your hard hours',
      body: [
        'The pull isn’t the same all day. For most people it keeps hours: late at night after everyone else has gone to bed, a long Sunday evening, the first hour home alone.',
        'Those hours have things in common. You’re tired, your guard is down, nobody is around, and the day’s stress is still in you with nowhere to go. You’re the same person in the same room, just at a weaker moment.',
        'Knowing your hours changes things. You stop being caught off guard by them. You can plan around them: be in bed before they start, keep the phone out of reach, have something ready to do instead.',
        'You can also set things up so protection is strongest exactly when you’re weakest. That’s what risk hours are for. Name the hours that are hardest, and every day during them the filters get stricter, and nothing that loosens protection can change until they end.'
      ],
      story: 'A few lines from your own story: the hours that were hardest for you, and what those nights were like.',
      one: { kind: 'link', text: 'Set your risk hours to the time it’s usually hardest, starting a little before it begins.', href: 'options.html#risk-group', label: 'Open risk hours' }
    },
    {
      n: 7,
      title: 'One person who knows',
      body: [
        'Almost everyone who struggles with this keeps it secret for a long time. That makes sense. It can feel like the most embarrassing thing about you. But hiding it means carrying it alone, and alone is where the habit does best.',
        'Telling one person changes that. Not everyone, and not the whole story. Just one person who knows you’re working on something hard, so it isn’t only yours to hold.',
        'Choose someone safe: a friend you trust, a brother or sister, a parent, a partner, a mentor, a counsellor. You can keep it short. “I’m trying to stop something that’s been hard to stop. Some nights are rough. Can I message you on those nights?”',
        'Most people are kinder about it than you fear. Later, if you want, the same person can be your witness, holding the code that lets you change your settings without waiting. You don’t have to tell them today. Today, just choose who.'
      ],
      story: 'A few lines from your own story: the first person you told, or what kept you from telling anyone.',
      one: { kind: 'line', text: 'Choose one person you could tell. You don’t have to tell them yet. Just write who they are to you.', prompt: 'Who is the one person you could tell?' }
    },

    // --- Week 2: Changing the setting ----------------------------------------
    { n: 8, title: 'Make it harder, on purpose' },
    { n: 9, title: 'The bedroom rule' },
    { n: 10, title: 'Bored is not an emergency' },
    { n: 11, title: 'A plan for 11 p.m.' },
    { n: 12, title: 'What it was doing for you' },
    { n: 13, title: 'Sleep, food, moving' },
    { n: 14, title: 'Two weeks in' },
    // --- Week 3: The inside work ---------------------------------------------
    { n: 15, title: 'Shame and guilt are different' },
    { n: 16, title: 'The voice that bargains' },
    { n: 17, title: 'Lonely is the real hunger' },
    { n: 18, title: 'Other ways out of stress' },
    { n: 19, title: 'What you’ve been numbing' },
    { n: 20, title: 'What you want instead' },
    { n: 21, title: 'If you slipped' },
    // --- Week 4: The life after ----------------------------------------------
    { n: 22, title: 'Trust, rebuilt slowly' },
    { n: 23, title: 'What you were really looking for' },
    { n: 24, title: 'Your people' },
    { n: 25, title: 'Helping someone else' },
    { n: 26, title: 'Your good days' },
    { n: 27, title: 'A letter to the next hard night' },
    { n: 28, title: 'Your plan on one page' },
    { n: 29, title: 'What has changed' },
    { n: 30, title: 'The path keeps going' }
  ];

  var SIGNATURE = '— Monolab';

  // Fills in days that have only a title here, from extras/path-days.js.
  // A day already whole is left as it is, and so is every title.
  function add(more) {
    (Array.isArray(more) ? more : []).forEach(function (d) {
      var day = d && DAYS[d.n - 1];
      if (!day || day.body || !Array.isArray(d.body)) return;
      Object.keys(d).forEach(function (k) {
        if (k !== 'n' && k !== 'title') day[k] = d[k];
      });
    });
  }

  // Whether day n's words are here to read.
  function has(n) {
    var day = DAYS[n - 1];
    return !!(day && Array.isArray(day.body) && day.body.length);
  }

  var exported = { WEEKS: WEEKS, DAYS: DAYS, SIGNATURE: SIGNATURE, add: add, has: has };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  } else if (root) {
    root.PathDays = exported;
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
