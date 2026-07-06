# Bloom Letters

A tiny private flower-letter app. Write a letter, tuck in a few photos, pick a
card theme, and share it as a link. The recipient gets a sealed envelope that
bursts into watercolor flowers before revealing a scrapbook card with your
letter, pictures, and their name in tiles.

## How it works

**Hosted (e.g. GitHub Pages):** "Create Gift" produces a private link like
`https://you.github.io/bloom/#g=...`. The whole gift — letter, photos, theme —
is encoded in the part of the URL after `#`, which browsers never send to any
server. So even though the page is hosted publicly, the gift itself never
touches GitHub. Send the link like any normal link.

Photos are automatically resized in your browser so the gift stays small enough
to travel comfortably inside the link.

**Offline (opening `index.html` from disk):** with no website to host a link,
"Create Gift" instead downloads a single standalone `.html` file with everything
baked in. Send the file itself.

Gift links are gzip-compressed in the browser, so even a long letter makes a
compact link.

The optional passphrase encrypts the gift client-side (AES-GCM, key derived via
PBKDF2) — without it, neither the link nor the file can be read. Share the
passphrase separately.

## Optional: short, fixed-length links (free backend)

By default the whole gift rides inside the link, so a gift with several photos
still makes a long link. If you'd rather have short, fixed links like
`https://you.github.io/bloom/#i=ab3k9xqz` regardless of content, deploy the tiny
included **`worker.js`** to a free Cloudflare Worker with a KV store, then paste
the Worker's URL into the `GIFT_API` constant near the top of `app.js`.

Full step-by-step setup is in the comment block at the top of `worker.js`. Once
configured, creating a gift stores it and puts only a short id in the link; the
recipient's page fetches it back on open. If the Worker is ever unreachable, the
app automatically falls back to a self-contained link, so gifts always work.
Leave `GIFT_API` blank to keep the pure no-backend behavior.

## Features

- **Four card themes** — Garden, Kraft, Starry night, and Blush.
- **Photos** — up to four, shown as tilted polaroids on the card; tap one to
  enlarge it.
- **Background song** — paste a YouTube link and it autoplays the moment the
  letter is revealed. Nothing is uploaded; only the video id travels in the
  link, so it stays short.
- **Typewriter reveal** — the letter types itself in.
- **Signature and date** on the note.
- **Custom wording** for the "tap to open" and "tap to reveal" prompts.
- **Save card as image** — the recipient can download the card as a PNG keepsake.
- **Replay** — watch the envelope-and-flowers intro again.
- **Optional passphrase** to lock a private letter.

## Files

- `index.html` — compose view + gift view
- `style.css` — theme, envelope, flower art, card, and animation styling
- `app.js` — flower art (SVG), compose logic, link/file generation, the reveal,
  themes, keepsake-image export
- `worker.js` — optional free Cloudflare Worker for short links (not part of the
  website; deploy it separately only if you want short links)
