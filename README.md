# Lindbloom

*For Erica.*

---

This website is probably the most personal thing I've ever built.

Last time, when it was your birthday, I sent you letters through websites that someone else had already made. They were beautiful, and they helped me say what I wanted to say, but they never really felt like they were *mine*. Looking back, I realized I was borrowing someone else's creation to express something that belonged entirely to us.

So... this is my redemption.

This time, instead of searching for the perfect website, I decided to make one.

Every animation, every flower, every little interaction, every line of code—you'll know that I built it thinking about you.

That's what **Lindbloom** is.

Not just another web app.

It's my way of writing you a letter in the language I know best.

---

## Why I made this

I wanted to give you something that couldn't be found by searching the internet.

Something that only exists because *you* exist.

Anyone can buy a gift. Anyone can copy a message. But building something from nothing takes time, patience, frustration, dozens of rewrites, and a lot of late nights. Somehow, that felt fitting, because you deserve more than something convenient.

I wanted this to feel like opening a real letter.

One that's been waiting just for you.

The envelope opens. Flowers bloom. The words slowly appear, almost like I'm sitting beside you saying them instead of dumping everything onto the screen at once.

If I can't always be there in person, then maybe this little website can carry a piece of me until I can.

---

## Why "Lindbloom"?

The name just felt right.

Soft. Quiet. Growing.

Like something that blooms when it's cared for.

I don't really have a poetic explanation beyond that—I just knew it was the name this project was supposed to have.

---

## How it works

If I send you a hosted link (like GitHub Pages), it'll probably look something like:

`https://.../#g=...`

Everything that actually matters—the letter, the photos, the theme, and everything else—is stored after the `#`.

Browsers never send that part to a server, so even though the website itself is public, the contents of your letter stay inside the link. It's a surprisingly simple trick that makes something very personal stay personal.

If I ever send you the file itself instead, it's just one standalone HTML file. No installation. No accounts. No internet required after you've got it.

Just open it.

That's it.

The links are compressed too, so even long letters stay surprisingly small.

And if I decide to protect it with a passphrase, everything is encrypted directly in your browser using AES-GCM with PBKDF2 before it's ever viewed. I'll tell you the passphrase separately.

Some things deserve a little privacy.

---

## What's inside

* Four different card themes, each with its own personality.
* Up to four photos arranged like little Polaroids.
* A background song from YouTube, if I choose to include one.
* A typewriter effect that slowly reveals the letter instead of showing everything at once.
* My signature and the date, because handwritten letters always feel more complete.
* Custom prompts and little interactions throughout the experience.
* The ability to save the finished card as an image.
* A replay button, because sometimes one opening isn't enough.

---

## If you're curious about the code

* `index.html` — where everything begins.
* `style.css` — all the visual design and styling.
* `app.js` — the heart of the project: animations, flowers, themes, logic, and the letter itself.
* `worker.js` — an optional Cloudflare Worker for generating shorter links if I ever want to use one.

---

## One last thing

I didn't build **Lindbloom** because I wanted another project for my portfolio.

I built it because I wanted to create something that no one else could have made for you.

Every bug I fixed, every animation I adjusted, every tiny detail I obsessed over was another reminder that this wasn't just software anymore—it was becoming a gift.

Maybe years from now this website will look outdated.

Maybe there will be better animations, prettier designs, and cleaner code.

But I don't think any future version will ever mean as much to me as this first one, because this was the one I made for you.

If you're reading this, thank you for giving this little project a place to exist.

I hope it makes you smile.

And I hope, whenever you open it, you can tell that every line of code came from someone who cared enough to build you something instead of borrowing someone else's words.

With love,
Rhyyy
