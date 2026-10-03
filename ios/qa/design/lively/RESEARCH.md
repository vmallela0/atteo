# Lively chat: what makes iMessage, WhatsApp and Instagram feel alive

Research brief for #764 ("make it bright, make people want to talk"). Oct 2026. Proposal: `PROPOSAL.md`. Prototype: `prototype.html`.

## What they do

**Bubbles, colour and grouping.** All three use bubbles, never rows. Your bubbles sit on the right in the brand colour (iMessage blue, WhatsApp green, Instagram's purple-to-pink gradient, which shifts as you scroll). Other people's bubbles sit on the left in a neutral fill. Consecutive messages from one sender stack with 2–4 px gaps, and only the last one gets the tail and the avatar. That rhythm alone makes a screen read as a conversation. In group chats, names are coloured per sender (WhatsApp, Telegram).

**Reactions and tapbacks.** Long-press or double-tap a message (Instagram's double-tap drops a heart; you can change the default). The reaction lands on the bubble's corner with a spring overshoot, and the bubble briefly scales up. iOS 26 lets any emoji or sticker be a tapback, draws them in full colour and shows who reacted in groups. Discord "Super Reactions" burst particles around the message. A reaction is the cheapest possible reply, which is why people send so many.

**Presence of the other side.** The typing bubble (three dots that breathe in a staggered wave) is the most "alive" pixel in messaging, and iOS 26 extended it to group chats. Delivery state is a small ladder that people watch closely: WhatsApp's one grey tick, two grey ticks, then two blue ticks; iMessage's "Delivered", then "Read 9:41"; Instagram's tiny avatar sliding down to the last message each person saw.

**Effects and celebrations.** iMessage has bubble effects (Slam, Loud, Gentle, Invisible Ink), screen effects (confetti, fireworks, balloons, triggered by words like "congrats") and, since iOS 18, per-word animations (Big, Explode, Ripple, Bloom…). Instagram has send effects (Hearts, Gift box, Flames, Confetti). Telegram has full-screen interactive emoji and a satisfying send animation. Outside messaging, Asana's "celebration creatures" (a unicorn or narwhal crossing the screen when a task is done) are the canonical work example. They are rare and random, and people love them enough that the forum asks for more.

**Expressiveness and speed.** Stickers and animated emoji (Telegram, Instagram), quick replies, swipe-to-reply with a haptic "tick" at the threshold (WhatsApp, Instagram, iMessage). Apple's HIG reserves haptics for success, failure and gesture thresholds, used consistently. Sounds are short and distinct for send and receive.

**Personalisation.** Per-chat backgrounds arrived in iOS 26 (sky, water, aurora, a colour or a photo). WhatsApp (2026 betas) has themes in Featured, Nature, Live (slowly animated), Minimal and Doodle categories, and **picks the bubble colour from the wallpaper automatically**. Instagram has chat themes. Avatars appear everywhere: the list, the header, the thread, the seen-by row.

**Habit loops.** Unread badges, stories and status rings (a ring around an avatar means "something new from them"), Snapchat streaks. Streaks work through loss aversion: research on teens finds them stressful and a source of obligation, and they are widely classed as a dark pattern.

**Motion.** Sent messages fly up from the composer on a spring. New messages slide in with a slight overshoot. List rows re-sort with animation. Nothing snaps.

## What fits Atteo, and what doesn't

Atteo is people *and their agents* doing work together. The thing to make addictive is **seeing work move and celebrating it together**, not time spent in the app.

**Fits, strongly:**
- **Bubbles with grouping and sender colour.** Today's rows read like a log. Bubbles read like a conversation.
- **A distinct agent bubble.** The Pebble already says it: the clay half is you, the bone half is your agent. Agent bubbles become the bone half, with the session chip (`claude-2`, `scout`) inside, so you can always tell who spoke.
- **The typing bubble as agent progress.** "vedu's agent is working… reading src/html.ts" is the most compelling thing Atteo can show. It is a typing indicator that carries real information.
- **Celebrate shipped work.** A change card that says "Shipped to production" gets a short confetti burst and a reaction prompt, in the spirit of Asana's creatures. It is earned, rare and tied to real progress.
- **Tasks that tick.** Animated checkmarks and a progress ring filling up: a small reward each step.
- **Reaction pop, double-tap to react, swipe-to-reply with a haptic, read ticks.** These are cheap, and Atteo already has the data (reactions, "Seen by", threads).
- **A warm bright theme with an optional wallpaper,** with bubble colours derived from it, as WhatsApp does.

**Doesn't fit:**
- **Streaks and loss-aversion counters.** Teams shouldn't feel punished for a weekend off.
- **Stories with 24-hour expiry.** Work context should persist. At most, borrow the *ring*: a ring on an agent's avatar while it is mid-task.
- **Word-triggered screen effects on every message.** Noisy in a work log. Celebrate *events* (shipped, approved, task done), not keywords.
- **Paid reaction tiers, autoplay sounds, infinite feeds, fake urgency.**

Every celebration should be skippable (Reduce Motion, a "Celebrations" toggle as Asana has), rare enough to stay special, and never block input.

## Sources
- [iOS 26 Messages features, Cult of Mac](https://www.cultofmac.com/how-to/ios-26-messages-features) · [iOS 26 group chat features, 9to5Mac](https://9to5mac.com/2026/01/12/ios-26s-messages-app-adds-five-great-new-group-chat-features/) · [iOS 26, Tech Advisor](https://www.techadvisor.com/article/2851632/here-are-all-the-new-features-in-notifications-in-ios-26.html)
- [Everything new in Messages in iOS 27, 9to5Mac](https://9to5mac.com/2026/09/17/heres-everything-new-for-messages-in-ios-27/)
- [iOS 18 text effects, AppleInsider](https://appleinsider.com/inside/ios-18/tips/how-to-use-the-new-text-effects-in-messages-on-iphone-with-ios-18)
- [WhatsApp chat themes with animated wallpapers on iOS, WABetaInfo](https://wabetainfo.com/whatsapp-tests-chat-themes-with-animated-wallpapers-on-ios/) · [New chat theme experience on Android, WABetaInfo](https://wabetainfo.com/whatsapp-introduces-a-new-chat-theme-experience-on-android/) · [Animated wallpapers, BusinessToday (Aug 2026)](https://www.businesstoday.in/technology/news/story/whatsapp-may-soon-let-you-personalise-iphone-chats-with-animated-wallpapers-and-new-chat-themes-548954-2026-08-13)
- [WhatsApp check marks explained](https://setsmart.io/blog/whatsapp-check-marks)
- [Instagram DM reactions 2026, NapoleonCat](https://napoleoncat.com/blog/how-to-react-to-messages-on-instagram/) · [Change the double-tap reaction, Guiding Tech](https://www.guidingtech.com/change-double-tap-or-default-reaction-on-instagram-messages/)
- [Telegram infinite reactions](https://telegram.org/blog/infinite-reactions-statuses) · [Telegram custom animated emoji](https://telegram.org/blog/custom-emoji)
- [Discord Super Reactions](https://discord.com/blog/super-reactions-make-emoji-burst-to-life-discord-nitro)
- [Asana celebration creatures, Asana Design](https://medium.com/asana-design/cause-for-celebration-dd4cfbb01fa0) · [7 ways Asana makes work more fun](https://asana.com/inside-asana/asana-makes-work-more-fun)
- [Snapstreak psychology, ScreenWise](https://screenwiseapp.com/guides/the-psychology-of-snapchat-streaks) · [Dark patterns comment, Common Sense Media](https://www.commonsensemedia.org/sites/default/files/featured-content/files/common-sense-dark-patterns-comment.pdf)
- [Haptics on Apple platforms](https://blog.eidinger.info/haptics-on-apple-platforms) · [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/playing-haptics)
