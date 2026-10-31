# Pass It On

An ask. The extension and a page on monolab.dev ask people BlockNSFW helped
to tell others about it, in public and in their own words, and to send me the
link if they like. Nothing is promised for it: a post written for a reward
would have to say so, and would then read as an ad.

Two parts: the page, and the card inside the extension, with the reply to
send. The card is built (`options.html`, `#pass-card`; `options-layout.js`).

## The page

`monolab.dev/blocknsfw/pass-it-on`, in the Portfolio repo
(`app/blocknsfw/pass-it-on/page.tsx`).

```
BlockNSFW · Pass it on

It reached you. Pass it on.

Someone out there is looking tonight for what helped you. If BlockNSFW helped, tell them, in public and in your own words. The good and the bad.

[Send me the link]   [What to write]

(It reached you → You → Someone still looking)

01 · WHAT TO WRITE

Your own words, the good and the bad. A few honest lines are enough.
You don't have to answer these, or tell your whole story. They're only a place to start.

01 What made you look for something like this?
02 What helped, and what didn't?
03 What do you wish you'd known on the first night?
04 What would you tell someone who's looking right now?

02 · WHERE TO POST

Where people are already looking.

01 A reply in a thread where someone is asking for help.
02 Your blog, or a newsletter.
03 A video, short or long.
04 A post where you already share things.

Before you post: many recovery communities don't allow promotion, even honest promotion. Read the rules first, and post where it's welcome. There's no need to add a link; the name is enough to find it.

03 · SEND ME THE LINK

If you post something, send me the link. I'd love to read it.

- You never have to show your face or use your real name. An anonymous account is fine.
- I never share your post, your name or your email without asking you first.

To: support@monolab.dev · Subject: Pass it on · Link to my post · OK to share it without my name?
[Send me the link]

04 · THANK YOU (the pine band)

Thank you for passing it on. Someone is looking tonight, and what you write might be what they find.

Alfon, makes BlockNSFW · Questions: support@monolab.dev
```

## Inside the extension

### Settings card

Built as `#pass-card` in `options.html`: the search that types itself, on the
2.0 band's ink.

```
Strip (folded)
  Pass it on · someone typed this tonight · tell them what helped · Show

Kicker
  pass it on · tell someone who's looking

Title
  Someone typed this tonight. <em>Be what they find.</em>

Lede
  Post honestly about BlockNSFW, in public, wherever people go looking for help. The good and the bad. If you post something, send me the link. I'd love to read it.

Actions
  [Send me the link]  -> the mailto link below
  What to write       -> https://monolab.dev/blocknsfw/pass-it-on
  no name or face needed
```

The mailto link opens an email with the subject and what to include already
in it:

```
mailto:support@monolab.dev?subject=Pass%20it%20on&body=Link%20to%20my%20post%3A%0A%0AOK%20to%20share%20it%20without%20my%20name%3F%20%28yes%2Fno%29%3A
```

### Where it shows

- **Settings › Welcome**, second after the 2.0 card. It shows from two weeks
  after BlockNSFW was first seen (`pblocker_first_seen`); on day one there's
  nothing to pass on yet. Its × folds it to its strip for good, like the
  others.
- **Not** on the blocked page, the popup's band, After a Slip or Your Week.
  Those are for the hard moment, and an ask there reads like an ad at the
  worst time.
- The release page and the GitHub release notes for the version it ships in.

### One line for release notes and posts

```
Pass It On: if BlockNSFW helped, tell someone who's still looking, in public and in your own words. monolab.dev/blocknsfw/pass-it-on
```

## Reply (to every link)

```
Subject: Re: Pass it on

Thank you for passing it on. I read it, and it means a lot.

[If they said yes to sharing:] Thank you for letting me share it. I'll leave your name off.
```

## Notes

1. **The page goes up first.** The card links to it, and only reaches people
   once its version is live in the stores, where Chrome and Edge reviews
   have run behind (Chrome on 2.0.1, Edge on 2.0.0 as of 2026-10-31).
2. **Inbox.** Filter the subject "Pass it on" into its own label, so links
   don't bury support emails.
3. **Keep a list.** One line per link: the date, the email, the link, and
   whether they said yes to sharing.
4. **Welcome holds three other cards** (the 2.0 card, Warden, What's New).
   That's one more reason the card waits two weeks: by then most people have
   folded the others to their strips.
5. **"I", not "we".** One person reads the links, and monolab's design system
   says the same: first person, never "we". The Community page still says
   "we".
6. **Store reviews can be asked for.** With nothing promised, a plain "a
   review on the store helps too" is within the stores' rules. It isn't on
   the card or the page yet.
