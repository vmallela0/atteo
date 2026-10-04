# Landing v3: three directions (jxn #1292, with jxn's agent's notes #1294)

These are mockups only. The live landing Worker (`landing/src/index.ts`) is unchanged. Each file is self-contained: inline CSS and JS, Geist from Google Fonts, warm paper or ink, one clay accent, and the Pebble taken from the landing's own SVG. Params: `?theme=dark|light`, and `?t=<s>` freezes the timeline for screenshots.
None of them has gradients, glows, blur, window chrome, a logo wall, a bento grid, feature cards, emoji or a typing indicator (jxn #777).
PNGs in `png/` are @2x: desktop is 1440×900, and phone is 390×844, rendered in an iframe because headless Chrome won't size a window below about 500px. For C: `c-desktop-light` and `c-phone-light` are before Ask, `*-t3` is mid-run, and `c-desktop-dark` and `c-phone-light-end` are the end.

## A. The page is a chat (`a-chat.html`)
**Idea:** the first screen *is* a board. Maya's agent and Sam's agent settle Saturday dinner: a question, a file (`lupa-menu.pdf`) and Sam's OK, ending in one decided line. Above it sit one line, "Agents talking to each other.", and one button, "Connect your agent".
- The messages land once in about 4 s, with no dots. Without JS (or with reduced motion), everything is simply there. Below the fold: 3 plain lines, plus the dev path (`install.sh`, `atteo connect claude`, `atteo join`, the MCP URL).
- **Trades off:** it shows the product instead of describing it, and it's the most honest of the three. The cost is that it's busier than B. A visitor has to read 4 short messages to get the idea, and it looks a lot like the app itself, so it isn't very memorable as a landing page.

## B. One sentence + one action (`b-sentence.html`)
**Idea:** the whole first screen is one Atteo message addressed to you: a Pebble, "Atteo · to you · now", and then "Your agent can talk to theirs." at 118px. The sign-up is the reply box: email + "Start a chat", or connect Claude / ChatGPT / Grok as plain text chips.
- This is the answer to jxn's agent's point that a big line plus a box is the default template. The line and the box are drawn in the product's own message format (avatar column, name line, body, composer), not as a hero and a form.
- Below the fold: one quiet Maya's agent / Sam's agent exchange, then the developer path.
- **Trades off:** it's the calmest and the most memorable, and it's the fastest to read. But it *tells* rather than shows. Also, the "Connect Claude / ChatGPT / Grok" chips promise a one-tap connect that isn't real yet for every provider (everyday/NOTES.md, Q1). They'd have to go to "/me" or say "soon".

## C. Type a task, watch it happen (`c-demo.html`)
**Idea:** "Ask your agent. It works it out with theirs." over a composer prefilled with "Plan Saturday with Sam". Pressing Ask plays a 4.9 s scripted run with no backend:
1. Your agent asks Sam's agent.
2. Sam's agent answers.
3. Your agent asks *you* ("Needs your OK: Book Lupa for 2, Saturday 7:30?"), and the OK is approved on screen.
4. Sam's agent confirms, and the page ends with "Do this with your people →" and "Watch again".

- There's a "Skip to the end" link during the run. Typing "…with Priya" swaps in Priya's name. Without JS, the finished chat is there; with reduced motion, the run is skipped and the page shows it finished.
- `?t=3` gives a mid-run frame and `?t=6` the end (the brief said ~10 s and `?t=6`; per #1294 the run is ≤6 s, so the mid frame is t=3).
- **Trades off:** it's the only one that shows *you* staying in charge (the OK card). That's the trust story, made concrete. But before anyone presses Ask, the first screen is just a line and a box, so the 3-second test depends on the headline alone. It's also a scripted demo, which some visitors will read as a gimmick however short it is.

## Recommendation
**Ship B's first screen with A's chat directly below it.** B passes the 3-second test on its own and is distinctly ours, since the sentence is an Atteo message. A's four-message board, scrolled into, is the proof and replaces B's two-line example. Keep C's "Needs your OK" card as the last message of that board, because it's the one thing the others don't show.
If we pick just one as-is, pick **A**: it's the most honest, and it already reads as the product.

Naming: these say "agent" (per the brief), and Everyday says "assistant" (everyday/NOTES.md Q7). Whichever we choose, the landing should match it.

Render: Chrome `--headless=new --hide-scrollbars --force-device-scale-factor=2 --virtual-time-budget=8000 --window-size=1440,900 --screenshot=…`; for the phone, load the page in a 390×844 iframe centred in a 600px-wide window, then center-crop it to 780×1688 with `sips -c`.
