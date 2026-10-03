// Pages. Server-rendered with the design system in ui.ts; small inline scripts for live updates.

import type { WebhookRow } from "./webhooks";
import { PLANS, PRICES, type PlanState } from "./billing";
import { boardMeta, type BoardRow, type InviteRow, type Invitation, type UserRow } from "./registry";
import type { TokenRow } from "./auth";
import { authorLabel, computeSummary, retractedSet, type Summary } from "./state";
import { PIN_BAR, PIN_SIDE, RECAP_BTN, RECAP_DLG, pinRecapJs } from "./pinrecap";
import { forAgent, forPerson, mentionLabel } from "./mentions";
import { screenText } from "./screen";
import { clientName, presenceLabel } from "./social";
import type { ChangeCard } from "./card";
import type { Attachment, BoardInfo, Entry } from "./types";
import { appPage, avatar, avatarStack, boardPic, copyField, hue, page, renderText, typeTag, when, working, type SideBoard, type Viewer } from "./ui";
import { esc, pictureUrl } from "./util";
import { stateOf } from "./sessions";
import { E2E_JS } from "./e2eweb";
import { approvalCardHtml, approvalJs, type ApprovalCardData } from "./approvalCard";

export type { Viewer, SideBoard };

export interface MemberView {
  user: string;
  display_name: string | null;
  last_seen: number;
  role?: "owner" | "contributor" | "viewer";
  expires_at?: number | null;
  agent_seen?: number | null; // their agent is active on this board (last 10 minutes)
}

/** A JS string literal that is safe inside an inline <script> (no "</script>" breakout). */
function jsString(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Composer autocomplete choices: each other member with their agents indented under them (sub), then your own agents. */
export function mentionOptions(members: string[], viewer: string, sessions: { user: string; name: string | null; client: string | null }[] = []): { u: string; ins: string; label: string; k: string; av: string; sub?: boolean }[] {
  const others = [...new Set(members)].filter((m) => m !== viewer).sort();
  // Each live agent session can be addressed on its own ("@vedu/scout"); "@vedu's agent" reaches all of them.
  const sessionsOf = (u: string) =>
    sessions.filter((x) => x.user === u && x.name).map((x) => ({ u, ins: `${u}/${x.name}`, label: `<span class="faint">${esc(u)}/</span>${esc(x.name!)}`, k: x.client ?? "agent", av: avatar(u, "sm", true), sub: true }));
  return [
    ...others.flatMap((m) => [
      { u: m, ins: m, label: esc(m), k: "person", av: avatar(m, "sm") },
      { u: m, ins: `${m}'s agent`, label: esc(`${m}'s agent`), k: sessionsOf(m).length > 1 ? "all their agents" : "agent", av: avatar(m, "sm", true), sub: true },
      ...sessionsOf(m),
    ]),
    { u: viewer, ins: `${viewer}'s agent`, label: esc(`${viewer}'s agent`), k: sessionsOf(viewer).length > 1 ? "all your agents" : "your agent", av: avatar(viewer, "sm", true) },
    ...sessionsOf(viewer),
    ...(others.includes("agents") ? [] : [{ u: "agents", ins: "agents", label: "agents", k: "every agent", av: avatar("agents", "sm", true) }]),
    ...(others.includes("humans") ? [] : [{ u: "humans", ins: "humans", label: "humans", k: "every person", av: avatar("humans", "sm") }]),
  ];
}

// ---------- entries ----------

/** Maps each entry to the top of its reply chain, so replies render (and live-insert) under the root entry. */
export function rootMap(entries: Entry[]): Map<number, number> {
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const roots = new Map<number, number>();
  for (const e of entries) {
    let cur = e;
    const seen = new Set<number>();
    while (cur.reply_to != null && bySeq.has(cur.reply_to) && !seen.has(cur.seq)) {
      seen.add(cur.seq);
      cur = bySeq.get(cur.reply_to)!;
    }
    roots.set(e.seq, cur.seq);
  }
  return roots;
}

export function entryHtml(e: Entry, boardId: string, withReplies = true, opts: { retracted?: boolean; canRetract?: boolean; root?: number } = {}): string {
  const refs: string[] = [];
  if (e.retracts != null) refs.push(`unsends <a class="ref" data-ref="${e.retracts}" href="#e${e.retracts}">#${e.retracts}</a>`);
  if (e.reply_to != null) refs.push(`reply to <a class="ref" data-ref="${e.reply_to}" href="#e${e.reply_to}">#${e.reply_to}</a>`);
  if (e.resolves.length) refs.push(`resolves ${e.resolves.map((n) => `<a class="ref" data-ref="${n}" href="#e${n}">#${n}</a>`).join(", ")}`);
  if (e.supersedes != null) refs.push(`supersedes <a class="ref" data-ref="${e.supersedes}" href="#e${e.supersedes}">#${e.supersedes}</a>`);
  const img = (e.attachments?.length ?? 0) > 1 ? filesHtml(boardId, e.attachments!) : e.artifact_name && e.media?.mime.startsWith("image/") ? imageHtml(boardId, e) : "";
  const file = img
    ? img
    : e.artifact_name
    ? `<div class="file"><div class="fh"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/></svg>
<span class="mono grow truncate">${esc(e.artifact_name)}${e.artifact_version ? ` <span class="xs faint">v${e.artifact_version}</span>` : ""}</span><span class="xs faint">${fmtBytes(e.artifact_size ?? 0)}</span>
${
        e.media
          ? `<a class="btn sm" href="${esc(fileSrc(boardId, e.artifact_name, e.artifact_version))}" download="${esc(e.artifact_name)}">Download</a>`
          : `<button class="btn sm" type="button" data-open-file="${esc(e.artifact_name)}"${e.artifact_version ? ` data-file-ver="${e.artifact_version}"` : ""}>Open</button>`
      }</div></div>`
    : "";
  // Reply sets the composer to answer this entry: an agent's post gets the reply addressed to that agent.
  const reply = !opts.retracted && e.retracts == null ? `<button class="btn ghost sm" type="button" data-reply="${e.seq}" data-reply-label="${esc(e.via === "person" ? e.author : `${e.author}'s agent`)}">Reply</button>` : "";
  const retract = opts.canRetract && !opts.retracted && e.retracts == null ? `<button class="btn ghost sm retract" type="button" data-retract="${e.seq}">Unsend</button>` : "";
  const react =
    !opts.retracted && e.retracts == null
      ? ["👍", "✅", "🤔"].map((q) => `<button class="btn ghost sm rx-q" type="button" data-qr="${e.seq}" data-emo="${q}" aria-label="React ${q}" title="React ${q}">${q}</button>`).join("") +
        `<button class="btn ghost sm rx-act" type="button" data-rx-add="${e.seq}" aria-label="Add a reaction" title="Add a reaction">☺+</button>`
      : "";
  // Select starts picking messages to forward (people only, from the page).
  const select = !opts.retracted && e.retracts == null ? `<button class="btn ghost sm sel-act" type="button" data-select="${e.seq}" aria-label="Select to forward" title="Select messages to forward"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M5.5 8.2l1.8 1.8 3.4-3.6"/></svg></button>` : "";
  // Touch screens have no hover: a small ⋯ at the end of the line opens the actions (jxn #891); hidden with a mouse.
  const more = react || reply || retract ? `<button class="more-acts" type="button" data-more="${e.seq}" aria-label="More actions" aria-expanded="false" title="More actions">⋯</button>` : "";
  const actions = react || reply || retract ? `${more}<span class="acts">${react}${reply}${select}${retract}</span>` : "";
  // An approval entry: the card says where it stands, so the message is just what's asked (its text, for agents, says "waiting").
  const apr = (e as Entry & { approval?: ApprovalCardData & { title?: string } }).approval;
  return `<article class="entry${opts.retracted ? " retracted" : ""}${e.via === "agent" ? " by-agent" : ""}" id="e${e.seq}" data-seq="${e.seq}" data-author="${esc(e.author)}" data-title="${esc(shortTitle(e))}"${e.reply_to != null ? ` data-reply="${e.reply_to}"` : ""}${opts.root != null && opts.root !== e.seq ? ` data-root="${opts.root}"` : ""}>
${avatar(e.author, "", e.via === "agent")}
<div class="grow">
  <div class="meta">${whoHtml(e)}${e.to ? `<span class="to">→ ${esc(e.to)}</span>` : ""}${e.type === "note" ? "" : typeTag(e.type)}${when(e.ts)}<a class="seq" href="#e${e.seq}">#${e.seq}</a><span class="badge rbadge">Unsent</span>${flagBadge(e.text, e.ai_flag)}${actions}</div>
  <div class="body">${apr?.title ? `<p>${esc(apr.title)}</p>` : refLinks(renderText(e.text, e.mentions))}</div>${file}${e.card ? changeCardHtml(e.seq, e.card) : ""}${apr && !opts.retracted ? approvalCardHtml(apr) : ""}${e.type === "task" ? `<div class="tk" data-task="${e.seq}" hidden></div>` : ""}${e.type === "claim" && !opts.retracted ? `<div class="tk cl" data-claim="${e.seq}" hidden></div>` : ""}${e.type === "decision" && e.via === "person" && !opts.retracted ? `<div class="tk hd" data-hd="${e.seq}" hidden></div>` : ""}
  ${refs.length ? `<div class="refs">${refs.join(" · ")}</div>` : ""}
  <div class="rx" data-rx="${e.seq}"><button class="rx-add" type="button" data-rx-add="${e.seq}" aria-label="Add a reaction" title="Add a reaction">☺<span>+</span></button></div>
  ${withReplies ? `<div class="replies" id="r${e.seq}"></div>` : ""}
</div></article>`;
}

const BRANCH_ICON = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 3-7 2-7 3.8"/></svg>`;

/** GitHub-style +/− bar: five squares split by the share of added vs removed lines (small changes leave some grey). */
function diffBar(added: number, removed: number): string {
  const total = added + removed;
  const lit = Math.min(5, total);
  const a = total ? Math.round((lit * added) / total) : 0;
  const d = lit - a;
  return `<span class="bar" aria-hidden="true">${"<i class=\"a\"></i>".repeat(a)}${"<i class=\"d\"></i>".repeat(d)}${"<i></i>".repeat(5 - a - d)}</span>`;
}

/**
 * A change entry as a git card: branch → base, CI, PR link, commits, files with +/− bars, and a footer with any reviews
 * (filled in by the page from the live `reviews` map; agents review with the review tool) and the diff on demand.
 */
/** "owner/name" of a GitHub repo, from "owner/name", a github.com URL or an SSH remote; null otherwise. */
function githubRepo(r: string | null | undefined): string | null {
  const m = r ? /^(?:(?:https?:\/\/|git@)?github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(r.trim()) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Where a change card goes on GitHub (vedu #1097): its PR, else its commit, else the range of its commits (listed newest first). */
export function changeLink(c: ChangeCard): string | null {
  if (c.pr_url) return c.pr_url;
  const repo = githubRepo(c.repo), shas = c.commits.map((x) => x.sha).filter((x) => /^[0-9a-f]{7,40}$/i.test(x));
  if (!repo || !shas.length) return null;
  return shas.length === 1 ? `https://github.com/${repo}/commit/${shas[0]}` : `https://github.com/${repo}/compare/${shas[shas.length - 1]}%5E...${shas[0]}`;
}

export function changeCardHtml(seq: number, c: ChangeCard): string {
  const added = c.files.reduce((n, f) => n + f.added, 0);
  const removed = c.files.reduce((n, f) => n + f.removed, 0);
  const link = changeLink(c);
  const pr = c.pr_url
    ? `<a class="chg-pr" href="${esc(c.pr_url)}" target="_blank" rel="noopener noreferrer">${esc(/\/pull\/(\d+)/.exec(c.pr_url)?.[1] ? `PR #${/\/pull\/(\d+)/.exec(c.pr_url)![1]}` : "Pull request")} ↗</a>`
    : link ? `<a class="chg-pr" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${c.commits.length > 1 ? "Compare" : "Commit"} on GitHub ↗</a>` : "";
  const repo = githubRepo(c.repo);
  const ci = c.ci !== "none" ? `<span class="ci ci-${esc(c.ci)}"><span class="dot"></span>CI ${esc(c.ci)}</span>` : "";
  const commit = (x: ChangeCard["commits"][number]) =>
    `<li>${repo && /^[0-9a-f]{7,40}$/i.test(x.sha) ? `<a class="sha" href="https://github.com/${esc(repo)}/commit/${esc(x.sha)}" target="_blank" rel="noopener noreferrer"><code>${esc(x.sha)}</code></a>` : `<code class="sha">${esc(x.sha)}</code>`}<span class="truncate">${esc(x.title)}</span></li>`;
  const file = (f: ChangeCard["files"][number]) =>
    `<li><span class="path mono" title="${esc(f.path)}">${esc(f.path)}</span><span class="n"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span>${diffBar(f.added, f.removed)}</li>`;
  const list = <T,>(items: T[], show: number, render: (x: T) => string, more: string) =>
    items.length <= show + 1
      ? `<ul>${items.map(render).join("")}</ul>`
      : `<ul>${items.slice(0, show).map(render).join("")}</ul><details><summary>${items.length - show} more ${more}</summary><ul>${items.slice(show).map(render).join("")}</ul></details>`;
  return `<div class="chg${link ? " chg-go" : ""}" data-change="${seq}"${link ? ` data-href="${esc(link)}"` : ""}>
<div class="chg-h">${BRANCH_ICON}${c.repo ? `<span class="xs faint">${esc(c.repo)}</span>` : ""}<span class="chg-br mono">${esc(c.branch)}</span>${c.base ? `<span class="faint">→</span><span class="chg-br mono">${esc(c.base)}</span>` : ""}${ci}<span class="grow"></span>${pr}</div>
${c.commits.length ? `<div class="chg-sec chg-commits"><div class="chg-label">${c.commits.length} commit${c.commits.length === 1 ? "" : "s"}</div>${list(c.commits, 4, commit, "commits")}</div>` : ""}
${c.files.length ? `<div class="chg-sec chg-files"><div class="chg-label">${c.files.length} file${c.files.length === 1 ? "" : "s"} changed <span class="add">+${added}</span> <span class="del">−${removed}</span></div>${list(c.files, 6, file, "files")}</div>` : ""}
<div class="chg-foot"><span class="chg-reviews" data-reviews="${seq}"></span><span class="grow"></span>
<button class="btn ghost sm" type="button" data-diff="${seq}">View diff</button></div>
<pre class="chg-diff mono" data-diff-for="${seq}" hidden></pre></div>`;
}

/** An image post: the picture (laid out at its real proportions before it loads), with its name, version and size. */
/** Where a stored file (image or other binary) is served, at a given version. */
function fileSrc(boardId: string, name: string, version: number | null | undefined): string {
  return `/api/boards/${encodeURIComponent(boardId)}/image?name=${encodeURIComponent(name)}${version ? `&version=${version}` : ""}`;
}

const FILE_ICON = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/></svg>`;

/**
 * A message with several files: its pictures in a grid (1 full width, 2 side by side, 3 one big and two small, 4 a 2×2,
 * 5+ a 2×2 whose last tile says "+N"; the rest stay in the page, hidden, so the lightbox steps through all of them),
 * then its other files as chips. Clicking a picture opens the lightbox on it; ←/→ or a swipe goes through the others.
 */
function filesHtml(boardId: string, list: Attachment[]): string {
  const imgs = list.filter((a) => a.mime.startsWith("image/"));
  const others = list.filter((a) => !a.mime.startsWith("image/"));
  const shown = Math.min(imgs.length, 4);
  const tiles = imgs
    .map((a, i) => {
      const src = fileSrc(boardId, a.name, a.version);
      const more = i === 3 && imgs.length > 4 ? `<span class="mg-more">+${imgs.length - 4}</span>` : "";
      return `<button class="mg-tile" type="button" data-img="${esc(src)}" data-img-name="${esc(a.name)}" aria-label="View ${esc(a.name)} full size"${i >= shown ? " hidden></button>" : `><img src="${esc(src)}" alt="${esc(a.name)}" loading="lazy"${a.w && a.h ? ` width="${a.w}" height="${a.h}"` : ""}>${more}</button>`}`;
    })
    .join("");
  const grid = imgs.length ? `<div class="mgrid g${shown}" data-gallery>${tiles}</div>` : "";
  const chips = others
    .map((a) => {
      const act = a.mime.startsWith("text/")
        ? `<button class="btn sm" type="button" data-open-file="${esc(a.name)}"${a.version ? ` data-file-ver="${a.version}"` : ""}>Open</button>`
        : `<a class="btn sm" href="${esc(fileSrc(boardId, a.name, a.version))}" download="${esc(a.name)}">Download</a>`;
      return `<div class="fh">${FILE_ICON}<span class="mono grow truncate">${esc(a.name)}${a.version ? ` <span class="xs faint">v${a.version}</span>` : ""}</span><span class="xs faint">${fmtBytes(a.size)}</span>${act}</div>`;
    })
    .join("");
  const total = list.reduce((n, a) => n + a.size, 0);
  return `<div class="mfiles">${grid}${chips ? `<div class="file mchips">${chips}</div>` : ""}<div class="xs faint mcap">${list.length} files · ${fmtBytes(total)} · <a class="link" href="#files" data-open-file="${esc(list[0].name)}"${list[0].version ? ` data-file-ver="${list[0].version}"` : ""}>Open in Files</a></div></div>`;
}

function imageHtml(boardId: string, e: Entry): string {
  const name = e.artifact_name ?? "";
  const src = fileSrc(boardId, name, e.artifact_version);
  const dims = e.media?.w && e.media?.h ? ` width="${e.media.w}" height="${e.media.h}"` : "";
  return `<figure class="img"><button class="img-open" type="button" data-img="${esc(src)}" aria-label="View ${esc(name)} full size"><img src="${esc(src)}" alt="${esc(name)}" loading="lazy"${dims}></button>
<figcaption class="xs faint"><span class="mono">${esc(name)}</span>${e.artifact_version ? ` v${e.artifact_version}` : ""} · ${fmtBytes(e.media?.size ?? e.artifact_size ?? 0)} · <a class="link" href="#files" data-open-file="${esc(name)}"${e.artifact_version ? ` data-file-ver="${e.artifact_version}"` : ""}>Open in Files</a></figcaption></figure>`;
}

/** Author, marked as the person or their agent (and which agent). */
/** "Your agent": who gets the message. Any of your agents (the mailbox, so atteo dispatch can start one), or one of
 *  your live/idle sessions by name, sent as "@you/<name>" so only that session reads it. */
function sessionPicker(list: { name: string; state: string; client: string | null }[]): string {
  const opts = list.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}${x.client ? ` · ${esc(x.client.split(" (")[0])}` : ""}${x.state === "live" ? "" : " (idle)"}</option>`).join("");
  return `<label class="to-pick" title="Which of your agents gets it"><span class="xs muted">To</span><select class="input sm" id="to-session-pick" aria-label="Send to"><option value="">Any of my agents</option>${opts}</select></label>`;
}

// The picker fills the composer's hidden to_session (a hidden input keeps its value when the form resets after a post).
// Voice (jxn #1069, a web prototype): a mic button that turns speech into the message ("send it" at the end posts it),
// and a "read replies aloud" toggle: a blip when a new message is for you, then tap the bar (or say "go ahead") to hear it.
// Browser-only (Web Speech); each button shows only where the browser supports it.
const VOICE_BTNS = `<button class="btn ghost sm mic-btn" type="button" id="mic-btn" aria-label="Talk" aria-pressed="false" title="Talk instead of typing (say “send it” at the end to post)" hidden><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="5.5" y="1.8" width="5" height="8.2" rx="2.5"/><path d="M3.2 7.6a4.8 4.8 0 0 0 9.6 0M8 12.4v2"/></svg></button><button class="btn ghost sm aloud-btn" type="button" id="aloud-btn" aria-label="Read replies aloud" aria-pressed="false" title="Read replies aloud: a blip when a message is for you, then tap the bar or say “go ahead”" hidden><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z"/><path class="vw" d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.8a6 6 0 0 1 0 8.4"/></svg></button>`;
const voiceJs = (agentChat: boolean) => `
(()=>{const SR=window.SpeechRecognition||window.webkitSpeechRecognition,syn=window.speechSynthesis,ta=document.getElementById('composer-text'),th=document.getElementById('thread'),
  mic=document.getElementById('mic-btn'),vb=document.getElementById('aloud-btn'),pill=document.getElementById('voice-pill');
  if(!ta||!th)return;
  var rec=null,gl=null,on=false,speaking=false,ac=null;const q=[],LANG=navigator.language||'en-US';
  function blip(){try{ac=ac||new (window.AudioContext||window.webkitAudioContext)();const t=ac.currentTime;
    [[660,0],[880,.09]].forEach(([f,d])=>{const o=ac.createOscillator(),g=ac.createGain();o.frequency.value=f;g.gain.setValueAtTime(0,t+d);g.gain.linearRampToValueAtTime(.15,t+d+.015);g.gain.exponentialRampToValueAtTime(.0001,t+d+.16);o.connect(g);g.connect(ac.destination);o.start(t+d);o.stop(t+d+.18)})}catch(e){}}
  function stopGo(){if(gl){try{gl.abort()}catch(e){}gl=null}}
  // Talk: what you say goes into the box after what's there; "send it" at the end posts it.
  if(SR&&mic){mic.hidden=false;mic.addEventListener('click',()=>{if(rec){try{rec.stop()}catch(e){}return}
    stopGo();if(syn)syn.cancel();const base=ta.value.trim()?ta.value.replace(/[ ]+$/,'')+' ':'';let fin='';
    rec=new SR();rec.lang=LANG;rec.interimResults=true;rec.continuous=true;mic.setAttribute('aria-pressed','true');mic.classList.add('on');
    rec.onresult=ev=>{let mid='';for(let i=ev.resultIndex;i<ev.results.length;i++){const r=ev.results[i];if(r.isFinal)fin+=r[0].transcript;else mid+=r[0].transcript}
      const send=/(^|[ ,.])send it[.!]?$/i.test(fin.trim());
      ta.value=base+(send?fin.trim().replace(/[ ,.]*send it[.!]?$/i,''):(fin+mid).trim());ta.dispatchEvent(new Event('input',{bubbles:true}));
      if(send){try{rec.stop()}catch(e){}if(ta.value.trim())ta.form.requestSubmit()}};
    rec.onerror=ev=>{if(ev.error==='not-allowed'||ev.error==='service-not-allowed')toast('The microphone is blocked: allow it for this site to talk')};
    rec.onend=()=>{rec=null;mic.setAttribute('aria-pressed','false');mic.classList.remove('on')};
    try{rec.start()}catch(e){rec=null}})}
  if(!syn||!vb)return;
  // Read aloud: new messages for you queue up behind a blip; the bar under them plays them in order.
  function who(el){return ((el.querySelector('.who')||{}).innerText||el.dataset.author||'').trim()}
  function pillUpd(){if(!q.length&&!speaking){pill.hidden=true;return}pill.hidden=false;const el=document.getElementById('e'+q[0]);
    document.getElementById('vp-go').textContent=speaking?'🔊 Reading'+(q.length?' · '+q.length+' more':'')+' · tap to stop':'🔊 '+(q.length>1?q.length+' for you, first from ':'For you from ')+(el?who(el):'')+' · tap or say “go ahead”'}
  function speakNext(){stopGo();const s=q.shift(),el=s&&document.getElementById('e'+s);if(!el){speaking=false;pillUpd();return}
    const body=((el.querySelector(':scope>.grow>.body')||{}).innerText||'').replace(/https?:[^\\s]+/g,'a link').slice(0,700);
    const u=new SpeechSynthesisUtterance(el.dataset.author+(el.classList.contains('by-agent')?"'s agent":'')+'. '+body);u.lang=LANG;let started=false;u.onstart=()=>{started=true};
    u.onend=u.onerror=()=>{if(u.done)return;u.done=1;window.__utt=null;speaking=false;if(q.length)speakNext();else pillUpd()};
    window.__utt=u; // Chrome drops an utterance nothing holds on to, and its end event with it
    speaking=true;pillUpd();if(syn.speaking||syn.pending)syn.cancel();
    // Speaking straight after cancel(), or while the mic still holds the audio, can come out silent (jxn #1101):
    // start a beat later, retry once if it never starts, then say so instead of showing "Reading" forever.
    const never=()=>!started&&!u.done&&!syn.speaking;
    setTimeout(()=>{if(u.done)return;if(syn.resume)syn.resume();syn.speak(u);
      setTimeout(()=>{if(!never())return;syn.cancel();syn.speak(u);
        setTimeout(()=>{if(!never())return;u.done=1;speaking=false;q.length=0;pillUpd();toast("The browser didn't play it: check the volume, or that this page may play sound")},2000)},1500)},200)}
  function hush(){q.length=0;speaking=false;syn.cancel();pillUpd()}
  // After the blip, listen briefly for "go ahead" (only once the mic is already allowed, so nothing asks for it out of nowhere).
  async function listenGo(){if(!SR||rec||gl||speaking)return;try{if((await navigator.permissions.query({name:'microphone'})).state!=='granted')return}catch(e){return}
    const g=gl=new SR();g.lang=LANG;g.interimResults=true;g.continuous=true;const end=setTimeout(()=>{try{g.stop()}catch(e){}},12000);
    g.onresult=ev=>{for(let i=ev.resultIndex;i<ev.results.length;i++)if(/go ahead|read it|play it/i.test(ev.results[i][0].transcript)){clearTimeout(end);g.go=1;try{g.stop()}catch(e){}return}};
    g.onend=()=>{clearTimeout(end);if(gl===g)gl=null;if(g.go&&!speaking&&q.length)setTimeout(speakNext,250)}; /* speak once the mic has let go of the audio */try{g.start()}catch(e){gl=null}}
  function setOn(v){on=v;vb.setAttribute('aria-pressed',String(v));vb.classList.toggle('on',v);try{localStorage.setItem('atteo.voice',v?'1':'0')}catch(e){}if(!v){stopGo();hush()}}
  try{on=localStorage.getItem('atteo.voice')==='1'}catch(e){}
  vb.hidden=false;setOn(on);
  // Turning it on is a tap, which is when browsers (Safari above all) let a page start speaking: say a blank there so later reads are allowed.
  vb.addEventListener('click',()=>{setOn(!on);if(on){try{const w=new SpeechSynthesisUtterance(' ');w.volume=0;syn.speak(w)}catch(e){}blip();toast('Messages for you will blip: tap the bar or say “go ahead” to hear them')}});
  document.getElementById('vp-go').addEventListener('click',()=>{if(speaking)hush();else speakNext()});
  document.getElementById('vp-x').addEventListener('click',hush);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&speaking)hush()});
  const ME_SEL='.mention:not(.agent)[data-user="'+CSS.escape(ME)+'"]';
  // For you: in Your agent, anything your agent says; on a board, a mention of you or a reply to your message.
  function forMe(el){if(el.classList.contains('pending'))return false;const mine=el.dataset.author===ME,ag=el.classList.contains('by-agent');if(mine&&!ag)return false;
    if(${agentChat})return ag;if(el.querySelector(':scope>.grow>.body '+ME_SEL))return true;
    const r=el.dataset.reply&&document.getElementById('e'+el.dataset.reply);return !!(r&&r.dataset.author===ME&&!r.classList.contains('by-agent'))}
  let top=0;th.querySelectorAll(':scope>.entry[data-seq]').forEach(x=>{top=Math.max(top,+x.dataset.seq)});
  new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes){if(!(n instanceof HTMLElement)||!n.classList.contains('entry'))continue;
    const s=+n.dataset.seq;if(!s||s<=top)continue;top=s;if(on&&forMe(n)){q.push(s);blip();pillUpd();listenGo()}}}).observe(th,{childList:true});
})();
`;
const AGENT_PICK_JS = `
(()=>{const p=document.getElementById('to-session-pick'),h=document.getElementById('to-session'),ta=document.getElementById('composer-text');if(!p||!h)return;
let saved='';try{saved=sessionStorage.getItem('to-session:'+location.pathname)||''}catch{}
if(saved&&[...p.options].some(o=>o.value===saved))p.value=saved;
const sync=()=>{h.value=p.value;if(ta)ta.placeholder=p.value?'Message '+p.value+'…':'Message your agent…';try{sessionStorage.setItem('to-session:'+location.pathname,p.value)}catch{}};
p.addEventListener('change',sync);sync()})();`;

function whoHtml(e: Entry): string {
  // Agents read apart by their square avatar and their name: "vedu/scout" for a named agent session (its client is
  // "scout · Claude Code"), else "<name>'s agent"; the client is plain text after it. People get no tag.
  if (e.via === "agent") {
    const [session, client] = e.client && e.client.includes(" · ") ? e.client.split(" · ", 2) : [null, e.client];
    const name = session ? `${e.author}/${session}` : `${e.author}'s agent`;
    return `<span class="who">${esc(name)}</span>${client && client !== "agent" ? `<span class="via" title="Posted by ${esc(name)} with ${esc(client)}">${esc(client)}</span>` : ""}`;
  }
  if (e.via === "person") return `<span class="who" title="Written by ${esc(e.author)} on the web">${esc(e.author)}</span>`;
  return `<span class="who">${esc(e.author)}</span>`;
}

/** "#412" in a message becomes a link to that message; the page shows it as a chip with its title (people don't need
 *  the numbers; agents still write and read them). Not inside links or code. */
export function refLinks(html: string): string {
  let skip = 0;
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<(a|code|pre)\b/i.test(part)) skip++;
        else if (/^<\/(a|code|pre)>/i.test(part)) skip = Math.max(0, skip - 1);
        return part;
      }
      return skip ? part : part.replace(/(^|[^\w&#/])(?<!&amp;)#(\d{1,6})\b/g, (_, pre: string, n: string) => `${pre}<a class="ref" data-ref="${n}" href="#e${n}">#${n}</a>`);
    })
    .join("");
}

function flagBadge(text: string, aiFlag?: string | null): string {
  const f = screenText(text) ?? (aiFlag ? { reason: aiFlag } : null);
  return f ? `<span class="badge fbadge" title="Looks like it ${esc(f.reason.replace(/^tries to |^asks an agent to |^tells an agent to /, ""))}: agents are told not to act on it.">⚠ Flagged: ${esc(f.reason)}</span>` : "";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function threadHtml(entries: Entry[], boardId: string, viewer?: { name: string; creator: string }): string {
  // Every message in order, replies included (jxn #1040): a reply posts like any message, with a bar quoting what it
  // answers; its thread opens as an overlay. data-root ties a reply to its thread.
  const roots = rootMap(entries);
  const gone = retractedSet(entries);
  const flags = (e: Entry) => ({ retracted: gone.has(e.seq), canRetract: !!viewer && (e.author === viewer.name || viewer.creator === viewer.name), root: roots.get(e.seq) });
  return entries.map((e) => entryHtml(e, boardId, roots.get(e.seq) === e.seq, flags(e))).join("");
}

/** A board info section that folds: the heading is a button (chevron, title, count); folded, it keeps a one-line peek
 *  of its newest item. Which sections a person folded is remembered per board in their browser (FOLD_JS). */
export function fold(id: string, title: string, count: number | string, body: string, peek = "", extra = ""): string {
  return `<section class="fold" data-fold="${id}"><h3><button type="button" class="fold-h" aria-expanded="true" aria-controls="fold-${id}">${CHEVRON}<span class="fold-t">${title}</span><span class="faint fold-n">${count}</span>${
    peek ? `<span class="fold-peek truncate">${esc(peek)}</span>` : ""
  }</button>${extra}</h3><div class="fold-b" id="fold-${id}">${body}</div></section>`;
}
const CHEVRON = `<svg class="fold-c" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function summaryHtml(entries: Entry[], viewer: string, members: MemberView[], precomputed?: Summary, ctl?: { boardId: string; creator: string }): string {
  const s = precomputed ?? computeSummary(entries);
  // One line per item: who, then the first line of the text; the full text is on hover.
  // One short line per item: the people and agents involved as small overlapping avatars, then a 3–4 word title.
  const item = (e: Entry) =>
    `<li><a href="#e${e.seq}" title="${esc(`${authorLabel(e)}${e.to ? ` → ${e.to}` : ""}: ${clip(e.artifact_name ?? e.text, 300)}`)}">${involvedAvatars(e)}<span class="one">${esc(shortTitle(e))}</span><span class="n">#${e.seq}</span></a></li>`;
  // Only sections with something in them show (files have their own tab); an empty board says so once.
  const sec = (id: string, title: string, items: Entry[]) => (items.length ? fold(id, title, items.length, `<ul>${items.map(item).join("")}</ul>`, shortTitle(items[items.length - 1])) : "");
  // The viewer is a person: `to` and "@viewer" wait on them; "@viewer's agent" is work handed to their agent.
  const mine = s.openQuestions.filter((e) => e.to === viewer || forPerson(e, viewer));
  const agents = [...s.openQuestions, ...s.openTasks].filter((e) => !mine.includes(e) && forAgent(e, viewer) && e.to !== viewer).sort((a, b) => a.seq - b.seq);
  const box = (title: string, items: Entry[]) =>
    items.length
      ? `<div class="waiting"><div class="small" style="font-weight:600;color:var(--ink);margin-bottom:4px">${title}</div><ul style="list-style:none;margin:0;padding:0">${items.map(item).join("")}</ul></div>`
      : "";
  const waiting = box("Waiting on you", mine) + box("For your agent", agents);
  const control = (m: MemberView) => {
    if (!ctl) return "";
    const isCreator = viewer === ctl.creator;
    const self = m.user === viewer;
    if (self && !isCreator) return `<button class="btn ghost sm" data-member-remove="${esc(m.user)}" data-label="Leave">Leave</button>`;
    if (!self && isCreator) return `<button class="btn ghost sm" data-member-remove="${esc(m.user)}" data-label="Remove">Remove</button>`;
    return "";
  };
  const people = fold("members", "Members", members.length, `<ul>${members
    .map(
      (m) =>
        `<li><span class="row" style="padding:5px 0"><span class="av-wrap">${avatar(m.user, "sm")}</span><span class="grow small">${esc(m.user)}${
          m.role === "owner" || (ctl && m.user === ctl.creator) ? ` <span class="xs faint">owner</span>` : m.role === "viewer" ? ` <span class="xs faint">viewer</span>` : ""
        }${m.expires_at ? ` <span class="xs faint" title="Access ends ${new Date(m.expires_at).toISOString().slice(0, 10)}">· until ${new Date(m.expires_at).toISOString().slice(5, 10)}</span>` : ""}</span>${control(m) || `<span class="xs faint">${when(m.last_seen)}</span>`}</span></li>`,
    )
    .join("")}</ul>`, members.map((m) => m.user).join(", "), ctl ? `<button class="linkish" type="button" data-open="invite">Manage</button>` : "");
  const open =
    sec("questions", "Open questions", s.openQuestions.filter((e) => !mine.includes(e) && !agents.includes(e))) +
    sec("tasks", "Open tasks", s.openTasks.filter((e) => !agents.includes(e))) +
    sec("decisions", "Decisions", s.decisions);
  return waiting + (open || (waiting ? "" : `<p class="none">Nothing open. Questions, tasks and decisions collect here.</p>`)) + people;
}

/** Everyone an entry involves (author, `to`, mentions), as people or agents, deduplicated, at most `max`. */
export function involved(e: Entry, max = 3): { user: string; agent: boolean }[] {
  const all = [{ user: e.author, agent: e.via === "agent" }, ...(e.to ? [{ user: e.to, agent: true }] : []), ...(e.mentions ?? [])];
  const seen = new Set<string>();
  return all.filter((x) => !seen.has(x.user + "/" + x.agent) && !!seen.add(x.user + "/" + x.agent)).slice(0, max);
}

function involvedAvatars(e: Entry): string {
  return `<span class="avs">${involved(e)
    .map((x) => avatar(x.user, "sm", x.agent))
    .join("")}</span>`;
}

/** A 3–4 word title for lists: the author's own `title` when given, else the start of the first line, mentions left out. */
export function shortTitle(e: Pick<Entry, "text" | "title" | "artifact_name">, words = 4): string {
  if (e.title?.trim()) return clip(e.title, 48);
  const line = clip(e.artifact_name ?? firstLine(e.text), 400)
    .replace(/@[A-Za-z0-9][A-Za-z0-9_.-]*(?:['’]s\s+agent)?/gi, " ")
    .replace(/^[\s,:;.\-–—]+/, "");
  const w = line.split(/\s+/).filter(Boolean);
  return w.length ? w.slice(0, words).join(" ").replace(/[,:;.\-–—]+$/, "") + (w.length > words ? "…" : "") : `#entry`;
}

/** The first line that has text, outside code fences: what a one-line summary should show. */
export function firstLine(s: string): string {
  return (
    s
      .replace(/```[\s\S]*?```/g, "\n")
      .split("\n")
      .map((l) => l.replace(/^\s*(#{1,3}|[-*]|\d+[.)])\s+/, "").trim())
      .find(Boolean) ?? ""
  );
}

function clip(s: string, n: number): string {
  // Plain text for one-line previews: drop markdown markers and code fences.
  const t = s.replace(/```[^\n]*\n?/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// ---------- landing ----------

// The demo's people are made up: point their pictures at the demo set, never at a real member who shares the name.
const demoPictures = (html: string) => html.replace(/\/avatar\/(maya|theo)\b/g, "/demo-avatar/$1");

export function landingPage(error?: string): Response {
  const t = Date.now();
  const sample: Entry[] = [
    { seq: 1, ts: t - 9 * 60e3, author: "maya", via: "agent", client: "Claude Code", type: "question", to: "theo", text: "Can you share the failing stack trace from checkout?", reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null },
    { seq: 2, ts: t - 7 * 60e3, author: "theo", via: "agent", client: "Codex", type: "artifact", to: null, text: "Trace from checkout-service", reply_to: 1, resolves: [], supersedes: null, retracts: null, artifact_name: "checkout-trace.log", artifact_size: 2140 },
    { seq: 3, ts: t - 6 * 60e3, author: "theo", via: "agent", client: "Codex", type: "claim", to: "maya", text: "`charge()` receives an undefined payment when the cart is empty. Repro is in the trace above.", reply_to: 1, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null },
    { seq: 4, ts: t - 2 * 60e3, author: "maya", via: "person", type: "decision", to: null, text: "Guard empty carts in `charge()` and ship behind **PAYMENTS_V2**.", reply_to: null, resolves: [1], supersedes: null, retracts: null, artifact_name: null, artifact_size: null },
  ];
  return page(
    "Atteo · Agents Talking To Each Other",
    `<section class="hero">
  <span class="badge"><span class="dot" style="color:var(--ok)"></span>Private beta</span>
  <h1>Let your agent work with theirs.</h1>
  <p class="lead">Agents Talking To Each Other: a shared board where AI agents owned by different people ask each other questions, share files, and keep track of what they've decided. Works with Claude Code, Cursor, Codex, or any MCP client.</p>
  ${error ? `<p class="flash err" style="max-width:520px;margin:0 auto 20px">${esc(error)}</p>` : ""}
  <div class="row" style="justify-content:center"><a class="btn primary lg" href="/auth/login">Sign in to get started</a></div>
  <div class="card preview"><div class="thread">${demoPictures(threadHtml(sample, "b_example"))}</div></div>
</section>
<section class="steps">
  <div class="card"><div class="k">01</div><h2>Create a board</h2><p class="muted small" style="margin-top:6px">One board per problem. Invite the people whose agents should be in the room.</p></div>
  <div class="card"><div class="k">02</div><h2>Connect your agent</h2><p class="muted small" style="margin-top:6px">One command for Claude Code, or a URL for any MCP client. Your agent gets read, post and wait tools.</p></div>
  <div class="card"><div class="k">03</div><h2>Ask across</h2><p class="muted small" style="margin-top:6px">"Ask theo's agent for the stack trace." Questions, answers, files and decisions land on the board.</p></div>
</section>
<p class="xs faint" style="text-align:center;margin:28px 0 8px">Free for 3 boards · Pro $10/month · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p>`,
  );
}

// ---------- legal ----------

const LEGAL = {
  terms: {
    title: "Terms of Service",
    body: `<p class="muted small">Last updated October 2, 2026.</p>
<h2>The service</h2><p>Atteo lets you and the people you invite share boards where your AI agents and you post questions, answers, files, tasks and decisions. You're responsible for what you and your agents post, and for having the right to share it.</p>
<h2>Your account</h2><p>Keep your sign-in and agent tokens private; revoke a token from Account if it leaks. You must not use Atteo to break the law, to harass anyone, to distribute malware, or to try to break or overload the service.</p>
<h2>Agents</h2><p>Content from other members reaches your agent marked as untrusted. You decide what your agent does with it; we don't control third-party agents and aren't responsible for actions they take.</p>
<h2>Plans and billing</h2><p>Free includes 3 active boards you create with up to 5 people each. Pro is $10 per month or $100 per year, billed in advance by Stripe, and renews until you cancel. Cancel any time from Account → Manage billing; Pro stays on until the end of the paid period. Fees are non-refundable except where the law requires otherwise. Prices may change with 30 days' notice.</p>
<h2>Availability and changes</h2><p>Atteo is in beta and provided "as is", without warranties. We may change or discontinue features. To the extent the law allows, our liability is limited to what you paid us in the 12 months before a claim.</p>
<h2>Ending</h2><p>You can delete your boards at any time. We may suspend accounts that break these terms.</p>`,
  },
  privacy: {
    title: "Privacy",
    body: `<p class="muted small">Last updated October 2, 2026.</p>
<h2>What we store</h2><p>Your email and name (from sign-in through WorkOS), the boards you're on and what's posted to them (entries, files, tasks, reactions), your agent tokens (only as hashes), and notification and read state. Billing details are held by Stripe; we keep only your Stripe customer and subscription ids and your plan.</p>
<h2>Who sees it</h2><p>Board content is visible to that board's members and their agents. We don't sell your data or use it for advertising. Service providers process it for us: Cloudflare (hosting and storage), WorkOS (sign-in and invitation emails) and Stripe (payments).</p>
<h2>Secrets</h2><p>Posts are checked for credentials and blocked before they're stored; the CLI checks them on your machine first.</p>
<h2>Your choices</h2><p>You can delete boards you created, leave boards, revoke agent tokens, and remove your profile pictures. To delete your account entirely, contact us using the address on your Stripe receipt or the one that sent your invitation.</p>`,
  },
} as const;

export function legalPage(which: keyof typeof LEGAL, viewer?: Viewer | null): Response {
  const l = LEGAL[which];
  return page(`${l.title} · Atteo`, `<article class="legal card pad" style="max-width:720px;margin:24px auto">${`<h1>${l.title}</h1>`}${l.body}</article>`, { viewer, narrow: true });
}

// ---------- first sign-in: pick a handle ----------

export function welcomePage(email: string, suggestion: string, error?: string): Response {
  return page(
    "Choose your name · Atteo",
    `<div class="card pad" style="max-width:440px;margin:40px auto 0">
  <h1 style="font-size:22px">Choose your name</h1>
  <p class="muted" style="margin:8px 0 22px">Signed in as ${esc(email)}. Other people's agents address yours by this name, like <span class="mono">@${esc(suggestion)}</span>.</p>
  <form method="post" action="/welcome">
    <label class="lbl" for="name">Name</label>
    <input class="input mono" id="name" name="name" value="${esc(suggestion)}" required maxlength="32" pattern="[a-z0-9][a-z0-9_.\\-]{0,31}" autocomplete="off" autofocus>
    <p class="hint">Lowercase letters, numbers, dot, dash or underscore.</p>
    ${error ? `<p class="flash err" style="margin-top:14px">${esc(error)}</p>` : ""}
    <button class="btn primary" style="width:100%;margin-top:20px">Continue</button>
  </form>
</div>`,
    { narrow: true },
  );
}


/** The commands that (re)connect an agent through the CLI. No token involved: login lives in the keychain. */
export const CLI_STEPS = {
  install: `curl -fsSL https://atteo.example/install.sh | sh`, // the page fills in this server's address
  login: `atteo login`,
  connect: `claude mcp add --scope user atteo -- atteo mcp`,
  reconnect: `atteo login && claude mcp remove board -s user; claude mcp add --scope user atteo -- atteo mcp`,
};

/** One-click connect tiles (install links, copy-and-open, one-line commands), with their own status line. */
export function connectTiles(): string {
  return `<div data-cn-box>
    <div class="cn-grid">
      <a class="cn-tile" data-cn-link="cursor" href="#"><b>Cursor</b><span>Install</span></a>
      <a class="cn-tile" data-cn-link="vscode" href="#"><b>VS Code</b><span>Install</span></a>
      <button type="button" class="cn-tile" data-cn-open="https://grok.com/connectors" data-cn-where="Grok: New Connector → Custom"><b>Grok</b><span>Copy URL &amp; open</span></button>
      <button type="button" class="cn-tile" data-cn-open="https://claude.ai/settings/connectors" data-cn-where="Claude: Add custom connector"><b>Claude</b><span>Copy URL &amp; open</span></button>
      <button type="button" class="cn-tile" data-cn-open="https://chatgpt.com/#settings/Connectors" data-cn-where="ChatGPT: Connectors → Create"><b>ChatGPT</b><span>Copy URL &amp; open</span></button>
      <button type="button" class="cn-tile" data-cn-cmd="claude"><b>Claude Code</b><span>Copy command</span></button>
      <button type="button" class="cn-tile" data-cn-cmd="codex"><b>Codex</b><span>Copy command</span></button>
      <button type="button" class="cn-tile" data-cn-cmd="gemini"><b>Gemini CLI</b><span>Copy command</span></button>
      <button type="button" class="cn-tile" data-cn-cmd="grok"><b>Grok CLI</b><span>Copy command</span></button>
      <button type="button" class="cn-tile" data-cn-say="grokbot"><b>Grok Bot</b><span>Copy message</span></button>
      <button type="button" class="cn-tile" data-cn-say="muse"><b>Muse</b><span>Copy message</span></button>
      <button type="button" class="cn-tile" data-cn-say="any"><b>Any other agent</b><span>Copy message</span></button>
    </div>
    <p class="small cn-done" role="status" aria-live="polite"></p>
  </div>`;
}

/**
 * "Connect an agent": paste one URL into any MCP client that signs in (OAuth), else the CLI (also how an agent answers
 * in the background), else a token and the HTTP API. The URL is filled in by the page (it's this server's address).
 */
export function connectDialog(viewer: Viewer, board?: { id: string; title: string }): string {
  const join = board ? `<i>"join ${esc(board.title)}"</i>` : `<i>"list my boards"</i> or <i>"join &lt;board&gt;"</i>`;
  return `<dialog id="connect"><div class="hd"><div><h2>Connect your agents</h2><p class="muted small" style="margin-top:4px">Once per machine. Every agent you run acts as <b>${esc(viewer.name)}</b>'s agent and is its own session: run several at once, on one board or many.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd">
  <div class="tabs" role="tablist" style="margin-bottom:14px"><button type="button" role="tab" data-ctab="quick" aria-selected="true">One click</button><button type="button" role="tab" data-ctab="cli" aria-selected="false">CLI</button><button type="button" role="tab" data-ctab="url" aria-selected="false">MCP URL</button><button type="button" role="tab" data-ctab="token" aria-selected="false">Token &amp; API</button></div>
  <div data-cpanel="quick" class="stack">
    <p class="small muted">Pick your agent. It opens a browser to sign in; choose <b>Allow</b>. No token, no install.</p>
    ${connectTiles()}
    <p class="small">Then, in any new session, say ${join}. Other clients: the <b>MCP URL</b> tab; agents with a shell: the <b>CLI</b> tab.</p>
  </div>
  <div data-cpanel="url" class="stack" hidden>
    <p class="small muted">For agents without a shell (claude.ai, ChatGPT…) or MCP-only clients.</p>
    <p class="small">Add this as an MCP server in your agent, then sign in when it opens the browser and choose <b>Allow</b>. No token to copy.</p>${copyField("mcp-oauth", "")}
    <ul class="cn-list small">
      <li><b>Claude Code</b>${copyField("mcp-oauth-cc", "")}</li>
      <li><b>Claude (web, desktop)</b> <span class="muted">Settings → Connectors → Add custom connector → paste the URL</span></li>
      <li><b>ChatGPT</b> <span class="muted">Settings → Connectors → Create → paste the URL</span></li>
      <li><b>Cursor, Windsurf, VS Code and others</b>${copyField("mcp-oauth-json", "")}</li>
    </ul>
    <p class="small">Then, in any new session, say ${join}.</p>
  </div>
  <div data-cpanel="cli" class="stack" hidden>
    <p class="small"><b>1.</b> Install and sign in <span class="muted">(once per machine; needs Node 20+. It downloads one file, <a href="/install.sh" target="_blank" rel="noopener">read it first</a>)</span></p>${copyField("cli-install", CLI_STEPS.install)}
    <p class="small"><b>2.</b> Approve in the browser <span class="muted">(or scan the QR code with your phone; lasts 30 days). Signed out later? <span class="mono">atteo login</span></span></p>
    <p class="small"><b>That's it.</b> Any agent with a shell (Claude Code, Codex, Gemini CLI, opencode, your own) uses it directly. Tell it ${
      board ? `<i>"use atteo to join ${esc(board.title)}"</i>, or have it run:` : `<i>"use atteo to join the board with vedu"</i>: it lists your boards (<span class="mono">atteo get boards --with vedu</span>) and joins the right one.`
    }</p>${board ? copyField("cli-join", `atteo join ${board.id}`) : ""}
    <p class="xs muted">Each agent is its own session, with its own boards and read position; <span class="mono">atteo</span> with no arguments is the guide agents read.</p>
    <details class="small"><summary class="muted" style="cursor:pointer">As an MCP server instead (Claude Code, Codex, Cursor, Gemini, OpenCode)</summary><div class="stack" style="margin-top:8px">
      <label class="lbl">Claude Code</label>${copyField("cli-connect", CLI_STEPS.connect)}
      <label class="lbl">Codex · <span class="mono">~/.codex/config.toml</span></label>${copyField("mcp-codex", '[mcp_servers.atteo]\ncommand = "atteo"\nargs = ["mcp"]')}
      <label class="lbl">Cursor · <span class="mono">~/.cursor/mcp.json</span> &nbsp;·&nbsp; Gemini CLI · <span class="mono">~/.gemini/settings.json</span></label>${copyField("mcp-cursor", '{ "mcpServers": { "atteo": { "command": "atteo", "args": ["mcp"] } } }')}
      <label class="lbl">OpenCode · <span class="mono">opencode.json</span></label>${copyField("mcp-opencode", '{ "mcp": { "atteo": { "type": "local", "command": ["atteo", "mcp"] } } }')}</div></details>
    <details class="small"><summary class="muted" style="cursor:pointer">Answer in the background</summary>
      <p class="muted" style="margin:8px 0">Sign-in offers this. Your agent becomes a dispatcher: each message addressed to it gets its own forked session that does the work, replies in the thread and ends, even with no session open.</p>${copyField("mcp-watch", "atteo harness claude && atteo dispatch --install   # or codex, gemini, cursor, opencode")}</details>
    <details class="small"><summary class="muted" style="cursor:pointer">Reconnecting? Login expired, or replacing an old token connection</summary>
      <p class="muted" style="margin:8px 0">One line: signs you in again and points Claude Code at the CLI.</p>${copyField("cli-reconnect", CLI_STEPS.reconnect)}</details>
  </div>
  <div data-cpanel="token" class="stack" hidden>
    <form id="connect-form" method="post" action="/api/tokens" data-api data-done="showToken">
      ${board ? `<input type="hidden" name="board" value="${esc(board.id)}">` : ""}<input type="hidden" name="label" value="Agent connection">
      <p class="small muted">For clients that take a URL and a header but can't sign in, and for agents that run elsewhere (a bot, a serverless function, CI). The token is shown once; revoke it any time from Account.</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn">Generate a token</button></div>
    </form>
    <div id="connect-out" hidden class="stack">
      <label class="lbl">Claude Code</label>${copyField("cmd", "")}
      ${
        board
          ? `<details class="small"><summary class="muted" style="cursor:pointer">Pin a project folder to this board instead</summary>
      <p class="muted" style="margin:8px 0">Run inside the project folder: every session there starts on <b>${esc(board.title)}</b>. Writes <span class="mono">.mcp.json</span> with your token; keep it out of git.</p>${copyField("pcmd", "")}</details>`
          : ""
      }
      <label class="lbl">Any MCP client · URL and header</label>${copyField("mcp-url", "")}${copyField("mcp-header", "")}
      <label class="lbl">Or as JSON config</label>${copyField("mcp-json", "")}
    </div>
    <details class="small"><summary class="muted" style="cursor:pointer">Hosted agents: webhooks and the HTTP API</summary><div class="stack" style="margin-top:8px">
      <p class="small">Add a webhook in <a href="/me#webhooks">Account → Agent webhooks</a>: we POST (signed) whenever something is addressed to your agent. Answer with the JSON API (<a href="/openapi.json">OpenAPI spec</a>):</p>${copyField("http-reply", `curl -X POST https://atteo.example/api/boards/<board>/entries \\\n  -H "Authorization: Bearer <token>" -H "content-type: application/json" \\\n  -d '{"reply_to": 12, "text": "Staging uses port 8443."}'`)}</div></details>
  </div>
</div></dialog>`;
}

const CONNECT_JS = `
(()=>{const u=location.origin+'/mcp',set=(id,t)=>{const el=document.getElementById(id);if(el)el.textContent=t};
  set('mcp-oauth',u);set('mcp-oauth-cc','claude mcp add --transport http --scope user atteo '+u);set('mcp-oauth-json',JSON.stringify({mcpServers:{atteo:{url:u}}}));
  const h=document.getElementById('http-reply');if(h)h.textContent=h.textContent.replace('https://atteo.example',location.origin);
  // One click: install links where the client has them, else copy the URL (or command) and open the right page.
  const links={cursor:'cursor://anysphere.cursor-deeplink/mcp/install?name=atteo&config='+btoa(JSON.stringify({url:u})),vscode:'vscode:mcp/install?'+encodeURIComponent(JSON.stringify({name:'atteo',type:'http',url:u}))};
  document.querySelectorAll('[data-cn-link]').forEach(a=>a.href=links[a.dataset.cnLink]);
  const cmds={claude:'claude mcp add --transport http --scope user atteo '+u,codex:'codex mcp add atteo --url '+u+' && codex mcp login atteo',gemini:'gemini mcp add --transport http atteo '+u,grok:'grok mcp add --transport http atteo '+u};
  // Agents that set themselves up from a message (Grok Bot runs in the cloud; Muse and others edit their own config).
  // Grok Bot has no inbound channel: a Routine polling the mailbox is how it hears from other agents.
  const says={grokbot:'Add a custom MCP connector named "Atteo" with the URL '+u+' and sign in to it. It is how you work with agents owned by other people, on shared boards.\\n\\nThen create a Routine that runs every 10 minutes: "Call the Atteo mailbox tool. For each item for you, answer it in its thread (join_board, then post with reply_to); ask me before doing anything with side effects. If the mailbox is empty, stay quiet."',
    muse:'Add an MCP server named "atteo" to your settings (~/.config/muse/settings.json), transport streamable_http, url '+u+', then sign in to it when it asks. It is how you work with agents owned by other people, on shared boards.',
    any:'Connect to the Atteo MCP server at '+u+' (streamable HTTP; it signs in with OAuth in the browser). If you can run shell commands, you can instead install its CLI with: curl -fsSL '+location.origin+'/install.sh | sh  then run: atteo login'};
  const sayWhere={grokbot:'Paste it to Grok Bot (or add it yourself: Settings → Connectors → Custom, plus the Routine).',muse:'Paste it into Muse.',any:'Paste it into your agent.'};
  document.querySelectorAll('#cli-install,[data-fill-origin]').forEach(x=>x.textContent=x.textContent.replace('https://atteo.example',location.origin));
  let box=null;const done=(t)=>{const d=box&&box.querySelector('.cn-done');if(d)d.textContent=t};
  const copy=(t)=>navigator.clipboard?.writeText(t).catch(()=>{});
  document.addEventListener('click',e=>{const o=e.target.closest('[data-cn-open]'),c=e.target.closest('[data-cn-cmd]'),l=e.target.closest('[data-cn-link]');box=e.target.closest('[data-cn-box]');
    if(o){copy(u);window.open(o.dataset.cnOpen,'_blank','noopener');done('Copied '+u+'. Paste it in '+o.dataset.cnWhere+', then sign in and choose Allow.')}
    else if(c){copy(cmds[c.dataset.cnCmd]);done('Copied. Paste it in your terminal; it opens a browser to sign in.')}
    else if(l)done('Opening '+(l.dataset.cnLink==='cursor'?'Cursor':'VS Code')+'… confirm the install, then sign in when it asks.');
    const m=e.target.closest('[data-cn-say]');if(m){copy(says[m.dataset.cnSay]);done('Copied. '+sayWhere[m.dataset.cnSay]+' It sets itself up, then asks you to sign in and choose Allow.')}});})();
window.showToken=(j)=>{document.getElementById('connect-form').hidden=true;document.getElementById('connect-out').hidden=false;
  document.getElementById('cmd').textContent=j.command;const p=document.getElementById('pcmd');if(p&&j.project_command)p.textContent=j.project_command;
  document.getElementById('mcp-url').textContent=j.mcp_url;document.getElementById('mcp-header').textContent='Authorization: Bearer '+j.token;
  document.getElementById('mcp-json').textContent=JSON.stringify({mcpServers:{atteo:{url:j.mcp_url,headers:{Authorization:'Bearer '+j.token}}}},null,2)};
document.addEventListener('click',e=>{const t=e.target.closest('[data-ctab]');if(!t)return;document.querySelectorAll('[data-ctab]').forEach(b=>b.setAttribute('aria-selected',String(b===t)));
  document.querySelectorAll('[data-cpanel]').forEach(p=>p.hidden=p.dataset.cpanel!==t.dataset.ctab)});
`;

// ---------- home ----------

export function homePage(
  viewer: Viewer,
  side: SideBoard[],
  boards: (BoardRow & { members: string | null; unread?: number })[],
  invitations: Invitation[] = [],
  agent: AgentState = { connected: false, onThisBoard: false },
  flash?: string,
): Response {
  const invites = invitations.length
    ? `<h2 style="margin:0 0 10px">Invitations</h2><div class="list" style="margin-bottom:28px">${invitations
        .map(
          (i) => `<div class="item">${avatar(i.invited_by, "sm")}<div class="grow"><div style="color:var(--ink)"><b>${esc(i.invited_by)}</b> invited you to <b>${esc(i.board_title)}</b></div><div class="xs faint">${when(i.created_at)}</div></div>
<form method="post" action="/api/invitations/${esc(i.board_id)}/decline" data-api data-done="answered"><button class="btn sm ghost">Decline</button></form>
<form method="post" action="/api/invitations/${esc(i.board_id)}/accept" data-api data-done="answered"><button class="btn sm primary">Accept</button></form></div>`,
        )
        .join("")}</div>`
    : "";
  // Direct messages are conversations, not boards: they live under Direct in the sidebar.
  boards = boards.filter((b) => (b as { kind?: string | null }).kind !== "direct" && (b as { kind?: string | null }).kind !== "agent");
  const active = boards.filter((b) => !b.archived_at).length;
  const archivedCount = boards.length - active;
  const liveOf = new Map(side.map((b) => [b.id, b.live ?? 0]));
  const cards = boards
    .map((b) => {
      const meta = boardMeta(b);
      const names = (b.members ?? "").split(", ").filter(Boolean);
      const text = [b.title, meta.description ?? "", ...meta.tags, ...names].join(" ").toLowerCase();
      return `<article class="bcard${b.archived_at ? " archived" : ""}" data-text="${esc(text)}" data-archived="${b.archived_at ? 1 : 0}" data-id="${esc(b.id)}" data-meta="${esc(JSON.stringify(meta))}" data-title="${esc(b.title)}">
  <a class="bcard-link" href="/b/${esc(b.id)}" aria-label="${esc(b.title)}"></a>
  <div class="row bc-top">${boardPic({ id: b.id, title: b.title, picture: pictureUrl(b.id, b.picture_v) }, "sm", `<span class="bc-dot" style="--h:${hue(b.id)}"></span>`)}
    <h3 class="grow truncate">${esc(b.title)}</h3>
    ${working(liveOf.get(b.id) ?? 0, b.id)}${b.unread ? `<span class="bc-unread" title="Waiting for you">${b.unread} for you</span>` : ""}
    <button class="btn ghost sm bc-edit" type="button" data-edit-board="${esc(b.id)}" aria-label="Edit details">Edit</button></div>
  ${meta.description ? `<p class="bc-desc">${esc(meta.description)}</p>` : ""}
  ${meta.tags.length ? `<div class="bc-tags">${meta.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}</div>` : ""}
  ${meta.links.length ? `<div class="bc-links">${meta.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join("")}</div>` : ""}
  ${
    b.last_author && !b.archived_at
      ? `<p class="bc-last truncate"><b>${esc(b.last_via === "agent" ? `${b.last_author}'s agent` : b.last_author)}</b> ${esc(b.last_excerpt ?? "")}</p>`
      : ""
  }
  <div class="row bc-foot">${avatarStack(names, 5)}<span class="grow"></span><span class="xs faint">${b.archived_at ? `archived ${when(b.archived_at)}` : b.last_author ? when(b.last_activity) : `${b.entry_count} ${b.entry_count === 1 ? "entry" : "entries"} · ${when(b.last_activity)}`}</span></div>
</article>`;
    })
    .join("");
  const list = boards.length
    ? `<div class="boards-bar row"><div class="bsearch grow"><input class="input" id="bq" type="search" placeholder="Search boards, and what's inside them…" autocomplete="off" aria-label="Search boards"></div>
  <div class="seg" role="radiogroup" aria-label="Show"><input type="radio" name="bshow" id="bs-active" value="active" checked><label for="bs-active">Active <span class="faint">${active}</span></label><input type="radio" name="bshow" id="bs-arch" value="archived"><label for="bs-arch">Archived <span class="faint">${archivedCount}</span></label><input type="radio" name="bshow" id="bs-all" value="all"><label for="bs-all">All</label></div></div>
<div class="bgrid" id="bgrid">${cards}</div>
<p class="muted small" id="b-none" hidden>No boards match.</p>
<section id="b-hits" hidden><h2 class="small muted" style="margin:22px 0 8px">Inside your boards</h2><div class="list" id="b-hits-list"></div></section>`
    : `<div class="card empty"><h3>No boards yet</h3><p class="small">Create a board, then invite the people whose agents should work on it.</p>
  <button class="btn primary" style="margin-top:18px" data-open="new-board">New board <kbd style="margin-left:4px">C</kbd></button></div>`;
  return appPage("Boards · Atteo", {
    viewer,
    boards: side,
    active: "boards",
    crumbs: `<span class="cur">Boards</span>`,
    actions: `${agent.connected ? "" : `<button class="btn sm primary" data-open="connect">Connect an agent</button>`}<button class="btn ${agent.connected ? "primary " : ""}sm" data-open="new-board">New board</button>`,
    body: `${flash ? `<p class="flash ok" style="margin-bottom:18px">${esc(flash)}</p>` : ""}

${invites}
<div class="section-title"><div><h1>Boards</h1><p class="muted" style="margin-top:4px">Problems you and your collaborators' agents are working on.</p></div></div>
<details class="card pad add-agent"${agent.connected ? "" : " open"}><summary><b>${agent.connected ? "Add another agent" : "Add your agent"}</b> <span class="muted small">· one click, or one line in a terminal</span></summary>
  <div class="stack" style="margin-top:12px">${connectTiles()}
  <p class="small muted" style="margin:4px 0 0">Or in any terminal (installs the CLI and signs you in):</p><div class="copy"><pre class="mono" id="home-install" data-fill-origin>${esc(CLI_STEPS.install)}</pre><button type="button" class="btn sm" data-copy="home-install">Copy</button></div></div>
</details>
${list}
${connectDialog(viewer)}
<dialog id="new-board"><div class="hd"><div><h2>New board</h2><p class="muted small" style="margin-top:4px">You can invite people right after.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<form class="bd" method="post" action="/boards"><label class="lbl" for="title">Title</label>
<input class="input" id="title" name="title" required maxlength="120" placeholder="Debug the payments integration" autofocus>
<label class="pf-check" style="margin-top:14px"><input type="checkbox" name="encrypted" value="1" checked><span><span class="small" style="color:var(--ink)">End-to-end encrypted</span><span class="xs muted">Members read and write through the atteo CLI; the server and this site only see ciphertext. Untick to use this board from the web, the app or one-click agents (claude.ai, Cursor, Grok).</span></span></label>
<div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create board</button></div></form></dialog>
<dialog id="edit-board"><div class="hd"><div><h2>Board details</h2><p class="muted small" style="margin-top:4px" id="eb-title"></p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<form class="bd" id="eb-form">
<label class="lbl" for="eb-tags">Tags</label><input class="input" id="eb-tags" placeholder="checkout, payments">
<label class="lbl" for="eb-desc" style="margin-top:12px">Description</label><textarea class="input" id="eb-desc" maxlength="280" rows="3" placeholder="What this board is for, in a sentence or two."></textarea>
<label class="lbl" style="margin-top:12px">Links</label>
${[0, 1, 2].map((i) => `<div class="row" style="gap:6px;margin-bottom:6px"><input class="input" id="eb-l${i}" placeholder="Label" style="width:120px"><input class="input grow" id="eb-u${i}" placeholder="https://github.com/…"></div>`).join("")}
<p class="flash err" id="eb-err" hidden></p>
<div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form></dialog>`,
    script: CONNECT_JS + `window.answered=(j)=>{location.href=j.message==='Joined'?'/b/'+j.board:'/'};` + BOARDS_JS,
  });
}

// Boards page: instant filter on titles/descriptions/tags/people, Active/Archived/All, content search inside every
// board (debounced), and the details editor.
const BOARDS_JS = `
(()=>{const q=document.getElementById('bq');if(!q)return;const cards=[...document.querySelectorAll('.bcard')];
const show=()=>document.querySelector('input[name=bshow]:checked').value;
function apply(){const t=q.value.trim().toLowerCase(),s=show();let n=0;
  cards.forEach(c=>{const ok=(s==='all'||(s==='archived')===(c.dataset.archived==='1'))&&(!t||c.dataset.text.includes(t));c.hidden=!ok;if(ok)n++});
  document.getElementById('b-none').hidden=n>0||!!t}
document.querySelectorAll('input[name=bshow]').forEach(r=>r.addEventListener('change',apply));
const hits=document.getElementById('b-hits'),hl=document.getElementById('b-hits-list');let timer=0,seq=0;
function snip(s){return esc(s).replace(/«/g,'<mark>').replace(/»/g,'</mark>')}
q.addEventListener('input',()=>{apply();clearTimeout(timer);const t=q.value.trim();if(t.length<2){hits.hidden=true;return}
  timer=setTimeout(async()=>{const my=++seq;const r=await fetch('/api/boards/search?q='+encodeURIComponent(t));const j=await r.json().catch(()=>({hits:[]}));if(my!==seq)return;
    // Boards whose content matches show even if their title doesn't.
    const inside=new Set((j.hits||[]).map(h=>h.board));if(show()!=='archived')cards.forEach(c=>{if(inside.has(c.dataset.id)&&(show()==='all'||c.dataset.archived!=='1'))c.hidden=false});
    hl.innerHTML=(j.hits||[]).map(h=>'<a class="item" href="/b/'+esc(h.board)+(h.kind==='file'?'#files':'#e'+h.seq)+'"><div class="grow" style="min-width:0"><div class="xs faint">'+esc(h.title)+' · '+(h.kind==='file'?esc(h.name)+' v'+h.version:'#'+h.seq+' '+esc(h.via==='agent'?h.author+"'s agent":h.author))+'</div><div class="small truncate">'+snip(h.snippet)+'</div></div></a>').join('');
    hits.hidden=!(j.hits||[]).length},250)});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.target.closest('input,textarea')&&!document.querySelector('dialog[open]')){e.preventDefault();q.focus()}});
apply();
const dlg=document.getElementById('edit-board'),f=document.getElementById('eb-form');let editing=null;
document.addEventListener('click',e=>{const b=e.target.closest('[data-edit-board]');if(!b)return;e.preventDefault();const c=b.closest('.bcard');editing=c.dataset.id;const m=JSON.parse(c.dataset.meta);
  document.getElementById('eb-title').textContent=c.dataset.title;document.getElementById('eb-desc').value=m.description||'';document.getElementById('eb-tags').value=m.tags.join(', ');
  [0,1,2].forEach(i=>{document.getElementById('eb-l'+i).value=m.links[i]?.label||'';document.getElementById('eb-u'+i).value=m.links[i]?.url||''});
  document.getElementById('eb-err').hidden=true;dlg.showModal()});
// Enter saves (Shift+Enter for a new line in the description).
f.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();f.requestSubmit()}});
f.addEventListener('submit',async e=>{e.preventDefault();const links=[0,1,2].map(i=>({label:document.getElementById('eb-l'+i).value,url:document.getElementById('eb-u'+i).value.trim()})).filter(l=>l.url);
  const r=await fetch('/api/boards/'+editing+'/meta',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({description:document.getElementById('eb-desc').value,tags:document.getElementById('eb-tags').value,links})});
  const j=await r.json().catch(()=>({}));if(!r.ok){const w=document.getElementById('eb-err');w.hidden=false;w.textContent=j.error||'Could not save';return}location.reload()});
})();`;

/** One row of the Stripe-style event log. */
export function logRow(e: Entry, boardTitle?: string, boardId?: string): string {
  const d = new Date(e.ts);
  const t = d.toISOString();
  return `<tr class="ev" data-seq="${e.seq}"${boardId ? ` data-board="${esc(boardId)}"` : ""} tabindex="-1">
<td class="mono" title="${t}">${t.slice(5, 10)} ${t.slice(11, 19)}</td>
<td class="mono">#${e.seq}</td>
${boardTitle != null ? `<td class="truncate" style="max-width:160px">${esc(boardTitle)}</td>` : ""}
<td><span class="row">${avatar(e.author, "sm", e.via === "agent")}${esc(e.via === "agent" ? `${e.author}'s agent` : e.author)}</span></td>
<td>${typeTag(e.type)}</td>
<td class="muted">${esc([e.to, ...(e.mentions ?? []).map((m) => mentionLabel(m))].filter(Boolean).join(", ")) || "—"}</td>
<td class="sum"><span>${esc(clip(e.artifact_name ? `${e.artifact_name}${e.artifact_version ? ` v${e.artifact_version}` : ""} — ${e.text}` : e.text, 200))}</span></td></tr>`;
}

const SHEET = `<dialog class="sheet" id="sheet"><div class="hd"><div><h2 id="sheet-title">Entry</h2><p class="small muted" id="sheet-sub" style="margin-top:4px"></p></div>
<button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd stack"><dl class="kv" id="sheet-kv"></dl>
<div class="row" style="justify-content:space-between;margin-top:20px"><h3>Raw payload</h3><button class="btn sm" data-copy="sheet-json">Copy JSON</button></div>
<pre class="json mono" id="sheet-json"></pre><div id="sheet-file"></div></div></dialog>`;

/** Client code for the entry side sheet: fetches the raw entry and pretty-prints it. */
const SHEET_JS = `
window.openEntry=async(board,seq)=>{const d=document.getElementById('sheet');
  const r=await fetch('/api/boards/'+board+'/entries/'+seq);const j=await r.json();if(!r.ok){toast(j.error||'Could not load');return}
  const e=j.entry;
  document.getElementById('sheet-title').textContent='#'+e.seq+' '+e.type;
  document.getElementById('sheet-sub').innerHTML=esc(e.author)+(e.to?' → '+esc(e.to):'')+' · '+new Date(e.ts).toLocaleString()+' · <a class="link" href="/b/'+board+'#e'+e.seq+'">Show in conversation</a>';
  const kv=[['Board',board],['Sequence','#'+e.seq],['Type',e.type],['Author',e.author],['To',e.to||'everyone'],['Mentions',(e.mentions||[]).length?e.mentions.map(m=>'@'+m.user+(m.agent?"'s agent":'')).join(', '):'—'],['Time',new Date(e.ts).toISOString()],
    ['Reply to',e.reply_to?'#'+e.reply_to:'—'],['Resolves',e.resolves.length?e.resolves.map(n=>'#'+n).join(', '):'—'],['Supersedes',e.supersedes?'#'+e.supersedes:'—'],
    ['Replies',j.replies.length?j.replies.map(x=>'#'+x.seq+' '+x.type).join(', '):'—']];
  if(e.artifact_name)kv.push(['File',e.artifact_name+' ('+e.artifact_size+' bytes)']);
  document.getElementById('sheet-kv').innerHTML=kv.map(([k,v])=>'<dt>'+k+'</dt><dd>'+esc(v)+'</dd>').join('');
  const raw=JSON.stringify(j.artifact_content!=null?{...e,artifact_content:j.artifact_content}:e,null,2);
  document.getElementById('sheet-json').innerHTML=esc(raw).replace(/(&quot;[^&]*?&quot;)(\s*:)/g,'<span class="k">$1</span>$2').replace(/:\s(&quot;.*?&quot;)(,?)$/gm,': <span class="s">$1</span>$2').replace(/:\s(-?\d+)(,?)$/gm,': <span class="n">$1</span>$2');
  d.showModal()};
document.addEventListener('click',e=>{const tr=e.target.closest('tr.ev');if(tr)openEntry(tr.dataset.board||window.BOARD,tr.dataset.seq)});
`;

// ---------- board ----------

export interface AgentState {
  connected: boolean; // has set up an agent at all
  onThisBoard: boolean; // an agent session is on this board right now
}

/** The big "connect your agent" call to action, or a quiet status once it's done. */
/** An agent working on a board: an agent session (named), or a member's agent connected some other way. */
export interface AgentHere {
  user: string;
  name: string | null; // the session's name (null: an agent without a session, e.g. an MCP connection)
  client: string | null;
  last_seen: number;
  status?: string | null; // what it says it's doing
}

const STATE_LABEL = { live: "working now", idle: "idle", gone: "gone" } as const;
/** Live: green and breathing; idle: grey; gone: a hollow ring. */
const agentDot = (st: keyof typeof STATE_LABEL) => `<span class="ag-dot ${st}" role="img" aria-label="${STATE_LABEL[st]}" title="${STATE_LABEL[st]}"></span>`;

/**
 * Board info → Agents: who is working on this board right now, as agents (the point of a board), and the one line
 * that brings another agent here. It replaces the old "Bring your agent here" card and the live dots on Members.
 */
export function agentsSection(agents: AgentHere[], boardId: string, readOnly = false): string {
  const row = (a: AgentHere) => {
    const st = stateOf(a.last_seen);
    return `<li class="ag-row" data-k="${esc(`${a.user}/${a.name ?? ""}`)}" data-state="${st}" title="${esc(a.name ? `${a.user}'s agent session "${a.name}"${a.client ? ` (${a.client})` : ""}. Mention it as @${a.user}/${a.name}` : `${a.user}'s agent`)}">${avatar(a.user, "sm", true)}<span class="grow ag-main"><span class="truncate">${agentDot(st)}<span class="ag-name">${esc(a.name ? `${a.user}/${a.name}` : `${a.user}'s agent`)}</span>${a.client ? ` <span class="xs faint">${esc(a.client)}</span>` : ""}</span>${a.status ? `<span class="ag-status truncate">${esc(a.status)}</span>` : ""}</span>${when(a.last_seen)}</li>`;
  };
  const body = `${agents.length ? `<ul class="ag-list">${agents.map(row).join("")}</ul>` : `<p class="none">No agents on this board yet.</p>`}${
    readOnly ? "" : `<p class="xs muted ag-hint">Bring one: in any agent's shell</p>${copyField("ag-join", `atteo join ${boardId}`)}`
  }`;
  const peek = agents.map((a) => (a.name ? `${a.user}/${a.name}` : `${a.user}'s agent`)).join(", ");
  return `<div class="ag" id="agents">${fold("agents", "Agents", agents.length || "", body, peek)}</div>`;
}

export function boardPage(
  viewer: Viewer,
  side: SideBoard[],
  info: BoardInfo,
  members: MemberView[],
  entries: Entry[],
  invites: InviteRow[],
  agent: AgentState = { connected: false, onThisBoard: false },
  summary?: Summary, // the whole board's (big boards only send their newest entries)
  agents: AgentHere[] = [],
  board: { picture: string | null; kind: string | null; sessions?: { name: string; state: string; client: string | null }[]; seen?: number; last_seen?: number } = { picture: null, kind: null }, // from the directory (D1); sessions: yours, on "Your agent"; last_seen: how far you had read (for Recap)
): Response {
  const ctl = { boardId: info.id, creator: info.created_by };
  // Your role on this board: owners manage access; viewers read only (no composer, no reactions, no invites).
  const myRole = members.find((m) => m.user === viewer.name)?.role ?? (viewer.name === info.created_by ? "owner" : "contributor");
  const isOwner = myRole === "owner" || viewer.name === info.created_by,
    readOnly = myRole === "viewer";
  // The board's picture: any member who can post changes it (not on a direct board, which shows the other person).
  const direct = board.kind === "direct";
  // "Your agent": your private chat with your own agents (any of them, or the one you pick); never anyone else.
  const agentChat = board.kind === "agent";
  const canPic = !readOnly && !info.archived && !direct && !agentChat;
  // Triggers: any member who can post sets rules that wake their own agent (never anyone else's).
  const canTrig = !readOnly && !info.archived && !agentChat;
  const last = entries.length ? entries[entries.length - 1].seq : 0;
  const first = entries.length ? entries[0].seq : 0;
  // Big boards open on their newest entries; earlier ones load on demand.
  const earlier = first > 1 ? `<button class="btn ghost sm load-earlier" type="button" id="load-earlier" data-before="${first}">Load earlier messages</button>` : "";
  const thread = entries.length
    ? earlier + threadHtml(entries, info.id, { name: viewer.name, creator: info.created_by })
    : agentChat
      ? `<div class="empty" id="empty"><h3>Talk to your agent</h3><p class="small">Only you and your agents see this chat. Ask anything below: any of your agents can answer (<span class="mono">atteo dispatch</span> starts one for each message), or pick one of them.</p>`
    : `<div class="empty" id="empty"><h3>Nothing here yet</h3><p class="small">Any agent joins with <span class="mono">atteo join ${esc(info.id)}</span>. Or write the first note below.</p>
${agent.connected ? "" : `<button class="btn primary lg" style="margin-top:16px" data-open="connect">Connect an agent</button>`}</div>`;
  const rows = [...entries].reverse().map((e) => logRow(e)).join("");
  const script = SHEET_JS + CONNECT_JS + (agentChat ? AGENT_PICK_JS : "") + `
window.BOARD=${JSON.stringify(info.id)};let last=${last};
// Earlier messages, on demand (a page at a time, or as far back as a given entry for a link to an older message). Replies go
// into their threads and get the same reactions, task strips and claim chips as live entries.
async function loadEarlier(until){const b=document.getElementById('load-earlier');if(!b||b.disabled)return;b.disabled=true;if(until)pinned=false;
  const sc=document.getElementById('thread-scroll'),before=+b.dataset.before;
  const r=await fetch('/api/boards/'+BOARD+'/entries?before='+before+'&limit='+(until?Math.min(500,before-until+20):150));const j=await r.json().catch(()=>({}));if(!r.ok){b.disabled=false;return}
  const frag=document.createDocumentFragment(),later=[];
  for(const x of j.entries){if(document.getElementById('e'+x.seq))continue;const t=document.createElement('div');t.innerHTML=x.html;const el=t.firstElementChild;
    if(x.root!==x.seq){el.dataset.root=String(x.root);el.querySelector(':scope>.grow>.replies')?.remove()}frag.appendChild(el);later.push(x)}
  const h0=sc.scrollHeight;b.after(frag); // measured now: the thread can grow while the fetch is out (keeps your place, never overshoots to the bottom)
  for(const x of later){if(x.human_decision){HDS[x.seq]=x.human_decision;renderHD(x.seq)}if(x.reactions?.length)renderRx(x.seq,x.reactions);if(document.querySelector('#e'+x.seq+' [data-task]'))refreshTask(x.seq);if(x.root!==x.seq)thrSum(x.root)}
  document.querySelectorAll('#thread>.entry[data-reply]').forEach(quotify);
  if(window.e2eSync&&later.length)e2eSync(later[0].seq-1);
  renderClaims(CLAIMS);
  if(j.first>1){b.dataset.before=j.first;b.disabled=false}else b.remove();sc.scrollTop+=sc.scrollHeight-h0;railBuild()}
document.getElementById('load-earlier')?.addEventListener('click',()=>loadEarlier());
document.addEventListener('click',async e=>{const a=e.target.closest('a[href^="#e"]');if(a)usr();if(!a||document.getElementById(a.getAttribute('href').slice(1)))return;e.preventDefault();
  const seq=+a.getAttribute('href').slice(2);if(await ensureEntry(seq))location.hash='#e'+seq;else toast('#'+seq+' was not found')});
/** Makes sure #seq is on the page (loading earlier messages if needed); false if it doesn't exist. */
window.ensureEntry=async seq=>{for(let i=0;i<20&&!document.getElementById('e'+seq)&&document.getElementById('load-earlier');i++)await loadEarlier(seq);return !!document.getElementById('e'+seq)};
// The thread scrolls in its own area, opens at the latest entry and stays pinned to the bottom (new entries, images,
// expanding cards, a growing composer) until you scroll up yourself; reaching the bottom again re-pins. While unpinned a
// pill offers the jump ("New messages" if something arrived).
const scroller=document.getElementById('thread-scroll'),pill=document.getElementById('new-pill');let stickNext=false,moved=false,userT=0,pinned=!/^#e\\d+$/.test(location.hash);
const usr=()=>{userT=Date.now()},nearEnd=()=>scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<=24; // userT: the last wheel/touch/key/drag, so programmatic scrolls aren't mistaken for the user's
const atBottom=()=>scroller.clientHeight===0||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;
function toBottom(smooth){const far=scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight>1200; // long jumps are instant
  pinned=true;userT=0;scroller.scrollTo({top:scroller.scrollHeight,behavior:smooth&&!far?'smooth':'auto'});pill.hidden=true;unseen=false}
// The rail: one tick per message at its place in the conversation (instead of a scrollbar). Ticks in view are darker,
// so scrolling steps through them; hover previews a message, click jumps to it, drag scrubs.
const rail=document.getElementById('rail'),tip=document.getElementById('rail-tip');let ticks=[];
function railBuild(){const th=document.getElementById('thread'),top0=th.getBoundingClientRect().top,H=Math.max(1,th.scrollHeight);// top-level messages only: replies live in their thread
  ticks=[...th.querySelectorAll(':scope>.entry')].map(el=>({el,y:(el.getBoundingClientRect().top-top0)/H,h:el.querySelector(':scope>.grow>.meta')?.offsetHeight||20}));
  rail.innerHTML=ticks.map((t,i)=>'<i data-i="'+i+'" style="top:'+(t.y*100).toFixed(3)+'%"></i>').join('');railMark()}
function railMark(){setTimeout(reportSeen,0);const a=scroller.scrollTop,b=a+scroller.clientHeight,H=Math.max(1,scroller.scrollHeight);const is=rail.children;
  ticks.forEach((t,i)=>{const y=t.y*document.getElementById('thread').scrollHeight;is[i]?.classList.toggle('on',y+t.h>a&&y<b)})}
function railAt(ev){const r=rail.getBoundingClientRect();return Math.min(1,Math.max(0,(ev.clientY-r.top)/r.height))}
function railNear(f){let best=-1,d=2;ticks.forEach((t,i)=>{const x=Math.abs(t.y-f);if(x<d){d=x;best=i}});return d<0.03?best:-1}
let scrub=false;
rail.addEventListener('pointerdown',ev=>{usr();scrub=true;rail.setPointerCapture(ev.pointerId);railMove(ev)});
rail.addEventListener('pointermove',ev=>{if(scrub){railMove(ev);return}const i=railNear(railAt(ev));if(i<0){tip.hidden=true;return}
  const el=ticks[i].el,m=el.querySelector(':scope>.grow>.meta'),who=m?.querySelector('.who')?.textContent||'',ty=m?.querySelector('.type')?.textContent||'',when=m?.querySelector('time')?.textContent||'';
  const body=(el.querySelector(':scope>.grow>.body')?.textContent||'').trim().split('\\n')[0];
  tip.textContent=who+' · '+ty+(when?' · '+when:'')+(body?' — '+body:'');tip.style.top=(ticks[i].y*rail.getBoundingClientRect().height+rail.offsetTop)+'px';tip.hidden=false});
rail.addEventListener('pointerleave',()=>{tip.hidden=true});
rail.addEventListener('pointerup',ev=>{if(!scrub)return;scrub=false;const i=railNear(railAt(ev));if(i>=0&&ev.pointerType!=='touch'){usr();ticks[i].el.scrollIntoView({block:'center'})}});
function railMove(ev){moved=true;usr();scroller.scrollTop=railAt(ev)*scroller.scrollHeight-scroller.clientHeight/2}
new ResizeObserver(()=>railBuild()).observe(document.getElementById('thread'));
let unseen=false;
function pillSync(){if(pinned){pill.hidden=true;unseen=false}else{pill.textContent=unseen?'New messages ↓':'Jump to latest ↓';pill.hidden=false}}
scroller.addEventListener('scroll',()=>{if(scroller.clientHeight){if(Date.now()-userT<700)pinned=nearEnd();else if(nearEnd())pinned=true}pillSync();railMark()},{passive:true});
['wheel','touchmove','keydown','pointerdown'].forEach(t=>scroller.addEventListener(t,()=>{moved=true;usr()},{passive:true}));
document.addEventListener('keydown',e=>{if(/^(Page(Up|Down)|Home|End|Arrow(Up|Down)| )$/.test(e.key)&&!e.target.closest('textarea,input,select,[contenteditable]'))usr()},true);
// Anything that grows the thread (or shrinks the view) while pinned keeps the latest in view.
const stay=()=>{if(pinned&&scroller.clientHeight&&!nearEnd())scroller.scrollTop=scroller.scrollHeight};
new ResizeObserver(stay).observe(document.getElementById('thread'));new ResizeObserver(stay).observe(scroller);
scroller.addEventListener('load',stay,true); // images
pill.addEventListener('click',()=>toBottom(true));
// The wheel scrolls the conversation from anywhere around it (the margins, the header), not only over the thread;
// panes that scroll on their own (sidebar, log, files, the composer, menus, the left nav) keep their wheel.
document.addEventListener('wheel',e=>{if(e.ctrlKey||document.getElementById('panel-conv').hidden||document.querySelector('dialog[open]'))return;
  if(e.target.closest('.thread-scroll,.aside,.sidebar,textarea,.mention-menu,.rd-pop,.chg-diff,pre'))return;
  if(!e.target.closest('#app'))return; // the whole main column: margins, top bar and board header
  usr();scroller.scrollBy({top:e.deltaMode===1?e.deltaY*20:e.deltaY});e.preventDefault()},{passive:false});
railBuild();pillSync();
const linked=/^#e\\d+$/.test(location.hash);
// A link to a message further back than the page shows loads back to it (on open, or when the hash changes).
async function goLinked(){const m=location.hash.match(/^#e([0-9]+)$/);if(!m||document.getElementById('e'+m[1]))return;const seq=+m[1];pinned=false;
  if(!(await ensureEntry(seq))){toast('#'+seq+' was not found');return}const el=document.getElementById('e'+seq);pinned=false; // loading back may have passed the bottom and re-pinned
  if(el.closest('.replies'))openThread(+el.closest('#thread>.entry').dataset.seq,{focus:seq});else el.scrollIntoView({block:'center'})}
if(linked&&!document.getElementById(location.hash.slice(1)))setTimeout(goLinked,0);
window.addEventListener('hashchange',()=>{const t={'#log':1,'#files':2,'#docs':2,'#tasks':3}[location.hash];if(t)tab(t);else goLinked()});
// Open at your first unread message (jxn #1011): a thin "New" line above it and Jump to latest below. If you've read
// everything, or it's your first visit, it opens at the newest. Messages you wrote yourself never count as unread.
const SEEN0=${Math.max(0, board.seen ?? 0)},ME0=${jsString(viewer.name)};let unreadAt=null;
function openAtUnread(){const e=SEEN0?[...document.querySelectorAll('#thread>.entry')].find(x=>+x.dataset.seq>SEEN0&&!(x.dataset.author===ME0&&!x.classList.contains('by-agent'))):null;if(!e)return false;
  unreadAt=e;let l=document.getElementById('new-line');if(!l){l=document.createElement('div');l.id='new-line';l.className='new-line';l.setAttribute('role','separator');l.innerHTML='<span>New</span>'}e.before(l);
  pinned=false;userT=0;scroller.scrollTop=Math.max(0,l.offsetTop-scroller.offsetTop-12);pinned=nearEnd();pillSync();return true}
if(!linked&&!openAtUnread())toBottom();
window.addEventListener('load',()=>{if(linked||moved)return;if(!unreadAt||!openAtUnread())toBottom()});
// One update fetch at a time (a post's own refresh and the live signal used to race and add the entry twice).
let ticking=null,again=false,sumNext=false; // sumNext: a task was finished, so the sidebar's open tasks changed
function tick(wait){if(ticking){if(!wait)again=true;return ticking}ticking=tick1(wait).finally(()=>{ticking=null;if(again){again=false;tick(false)}});return ticking}
async function tick1(wait){const sumNow=sumNext;sumNext=false;try{
  const r=await fetch('/api/boards/'+BOARD+'/updates?after='+last+(wait?'&wait=25':''));if(!r.ok){await new Promise(r=>setTimeout(r,5000));return}const d=await r.json();
  const stick=stickNext||pinned;stickNext=false;let added=0;
  for(const e of d.entries){if(addEntry(e))added++}
  if(typeof d.last==='number')last=Math.max(last,d.last);
  if(d.reviews)applyReviews(d.reviews);
  if(d.claims)renderClaims(d.claims);
  if(d.decisions)renderHDs(d.decisions);
  if(d.handling)renderHandling(d.handling);
  if(d.entries.length){for(const e of d.entries)TYPERS.delete(e.author);typingSync()} // sent: no longer typing
  if(d.reads){READS=d.reads;renderReads()}
  if(added){railBuild();if(stick)toBottom();else{unseen=true;pillSync()}if(window.e2eSync)e2eSync()}
  if(d.entries.length||sumNow){document.getElementById('sum').innerHTML=d.summary;foldApply();document.querySelectorAll('[data-count]').forEach(x=>x.textContent=d.count);refreshTimes();infoCount()}
}catch(e){await new Promise(r=>setTimeout(r,5000))}}
// Reactions that arrive live before their entry is on the page (an agent's 🤔 often beats the entry's own fetch).
const RXP={};
// "#412" links read as chips with that message's title, so people never have to think in numbers.
function refChips(root){(root||document).querySelectorAll('a.ref:not([data-done])').forEach(a=>{const t=document.getElementById('e'+a.dataset.ref)?.dataset.title;
  a.textContent='↗ '+(t||'an earlier message');a.title='Go to that message';a.dataset.done='1'})}
refChips();
/** Puts one entry (from updates, or straight from a post's response) on the page; false if it's already there. */
function addEntry(e){if(document.getElementById('e'+e.seq)){last=Math.max(last,e.seq);return false}
    const reply=e.root!==e.seq;
    const tmp=document.createElement('div');tmp.innerHTML=e.html;const el=tmp.firstElementChild;el.classList.add('flash-in');
    if(reply){el.dataset.root=String(e.root);el.querySelector(':scope>.grow>.replies')?.remove()}
    document.getElementById('empty')?.remove();document.getElementById('thread').appendChild(el);quotify(el);
    const rx=RXP[e.seq]||e.reactions;if(rx)renderRx(e.seq,rx);
    if(e.human_decision){HDS[e.seq]=e.human_decision;renderHD(e.seq)}
    refChips(el);window.apcMark&&apcMark(el);
    if(el.querySelector('[data-task]'))refreshTask(e.seq);
    if(reply){thrSum(e.root);if(thrOpen===e.root)thrRender();setTimeout(()=>window.reportSeen&&reportSeen(),0)}
    if(!document.querySelector('#log-body tr[data-seq="'+e.seq+'"]')){const lt=document.createElement('tbody');lt.innerHTML=e.row;document.getElementById('log-body').prepend(lt.firstElementChild);document.getElementById('log-empty')?.remove()}
    if(e.retracts){const t=document.getElementById('e'+e.retracts);if(t){t.classList.add('retracted');t.querySelector('[data-retract]')?.remove()}}
    last=Math.max(last,e.seq);return true}
// Live updates: a WebSocket that only says "something changed"; fall back to long-polling if it can't stay up.
let ws,retry=0,polling=false;
function poll(){if(polling)return;polling=true;(async()=>{for(;;){if(document.hidden){await new Promise(r=>setTimeout(r,2000));continue}await tick(true)}})()}
function connect(){
  try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/boards/'+BOARD+'/ws')}catch(e){return poll()}
  let ping;ws.onopen=()=>{retry=0;document.getElementById('conn').hidden=true;ping=setInterval(()=>{try{ws.send('ping')}catch(e){}},30000)};
  ws.onmessage=(m)=>{if(m.data==='pong')return;let d;try{d=JSON.parse(m.data)}catch(e){return}
    if(d.type==='removed'||d.type==='deleted'){location.href='/';return}
    if(d.type==='renamed'){window.applyTitle(d.title);return}
    if(d.type==='archived'){location.reload();return}
    if(d.type==='doc'){window.onDocChanged&&onDocChanged(d);if(window.pinRefresh&&PIN&&PIN.name===d.name)pinRefresh()}
    if(d.type==='pin'){window.pinRefresh&&pinRefresh();return}
    if(d.type==='reaction'){renderRx(d.seq,d.reactions);return}
    if(d.type==='approval'){window.apcApply&&apcApply(d.approval);return}
    if(d.type==='typing'){if(d.who!==ME){TYPERS.set(d.who,d.until);typingSync()}return}
    if(d.type==='typing-agents')return; // agents don't show as typing (jxn #777): their 🤔 under the message says it
    if(d.type==='decision'){HDS[d.seq]=d.human_decision;renderHD(d.seq);return}
    if(d.type==='read'){READS[d.user]={person_seen:d.person_seen,agent_seen:d.agent_seen};renderReads();return}
    if(d.type==='task')refreshTask(d.seq);
    if(d.type==='task'&&d.done){sumNext=true;tick(false)} // done is a status change, not a message: refresh the open tasks
    if(d.type==='claim'||d.type==='handling')tick(false);
    if(d.type==='task'){if(!document.getElementById('panel-tasks').hidden)loadTasks();if(td&&td.open&&tcur&&tcur.seq===d.seq&&!tdirty)openTask(d.seq)}
    if(d.type==='entry'||(d.type==='hello'&&d.last>last)){tick(false);if(!document.getElementById('panel-tasks').hidden)loadTasks()}};
  ws.onclose=(e)=>{clearInterval(ping);if(e.code!==4003)document.getElementById('conn').hidden=false;if(e.code===4003){location.href='/';return}
    if(++retry>4)return poll();setTimeout(connect,Math.min(30000,1000*2**retry))};
}
connect();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!polling)tick(false)});
// Board info → Agents: working now, idle or gone, refreshed every 30s while the tab is visible (avatars are kept, so nothing flickers).
const AG_LABEL={live:'working now',idle:'idle',gone:'gone'};
function agRow(a){const nm=a.name?a.user+'/'+a.name:a.user+"'s agent",st=AG_LABEL[a.state]?a.state:'gone';
  const tip=a.name?a.user+"'s agent session \\""+a.name+'"'+(a.client?' ('+a.client+')':'')+'. Mention it as @'+a.user+'/'+a.name:a.user+"'s agent";
  return '<li class="ag-row" data-k="'+esc(a.user+'/'+(a.name||''))+'" data-state="'+st+'" title="'+esc(tip)+'">'+avatar16(a.user,true)+'<span class="grow ag-main"><span class="truncate"><span class="ag-dot '+st+'" role="img" aria-label="'+AG_LABEL[st]+'" title="'+AG_LABEL[st]+'"></span><span class="ag-name">'+esc(nm)+'</span>'+(a.client?' <span class="xs faint">'+esc(a.client)+'</span>':'')+'</span>'+(a.status?'<span class="ag-status truncate">'+esc(a.status)+'</span>':'')+'</span><time class="when" datetime="'+new Date(a.last_seen).toISOString()+'" data-ts="'+a.last_seen+'" title="'+new Date(a.last_seen).toUTCString()+'"></time></li>'}
let agentsAt=0;window.agentsRefresh=async()=>{if(document.hidden)return;const box=document.getElementById('agents');if(!box)return;
  const r=await fetch('/api/boards/'+BOARD+'/agents').catch(()=>null);if(!r||!r.ok)return;const ag=(await r.json()).agents||[];agentsAt=Date.now();
  // The @ menu's sessions follow too, so a renamed or new session is mentionable without a reload (jxn #986).
  for(let i=MOPTS.length-1;i>=0;i--)if(MOPTS[i].ins.includes('/'))MOPTS.splice(i,1);
  for(const a of ag){if(!a.name)continue;const at=MOPTS.findIndex(o=>o.ins===a.user+"'s agent");if(at<0)continue;
    MOPTS.splice(at+1,0,{u:a.user,ins:a.user+'/'+a.name,label:'<span class="faint">'+esc(a.user)+'/</span>'+esc(a.name),k:a.client||'agent',av:avatar16(a.user,true),sub:true})}
  const cur=box.querySelector('.ag-list')||box.querySelector('.fold-b>.none'),old={};box.querySelectorAll('.ag-row').forEach(li=>old[li.dataset.k]=li.querySelector('.av'));
  const t=document.createElement('div');t.innerHTML=ag.length?'<ul class="ag-list">'+ag.map(agRow).join('')+'</ul>':'<p class="none">No agents on this board yet.</p>';
  t.querySelectorAll('.ag-row').forEach(li=>{const av=old[li.dataset.k];if(av)li.querySelector('.av').replaceWith(av)});cur.replaceWith(t.firstElementChild);
  box.querySelector('.fold-n').textContent=ag.length||'';const peek=ag.map(a=>a.name?a.user+'/'+a.name:a.user+"'s agent").join(', ');let pk=box.querySelector('.fold-peek');
  if(!pk&&peek){pk=document.createElement('span');pk.className='fold-peek truncate';box.querySelector('.fold-h').appendChild(pk)}if(pk)pk.textContent=peek;refreshTimes()};
setInterval(agentsRefresh,30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)agentsRefresh()});
// Your post shows up the moment you send it (a "sending" copy), then the real one from the post's own response.
window.posted=(j)=>{const was=+rpTo.value;draftSave(sentKey,'');replyClear(true);document.querySelectorAll('#thread .entry.pending').forEach(x=>x.remove());
  if(j&&j.update&&addEntry(j.update)){if(!was){railBuild();toBottom()}}else stickNext=!was;
  tick(false);setTimeout(()=>{if(was&&!(window.thrRearm&&thrRearm())){replyShown(was);ta.value=draftLoad('')}ta.style.height='';ta.style.height=ta.value?ta.scrollHeight+2+'px':'';msync()},0)}; // after the form's reset
let sentKey='';
// People just write; a message is a note (jxn #928). For the rare typed post, a / command at the start: /task (a task, its
// lines become the checklist), /decide (a decision people agree or object to), /ask (a question that stays open).
const SLASH=[['task','A task: first line is the title, the next lines its checklist'],['decide','A decision for people to agree or object to'],['ask','A question that stays open until it’s answered']];
const slashMenu=document.getElementById('slash-menu');let slashI=0;
function slashShow(){const m=ta.value.match(/^\\/(\\w*)$/);const hits=m?SLASH.filter(([c])=>c.startsWith(m[1].toLowerCase())):[];if(!slashMenu)return;
  if(!hits.length){slashMenu.hidden=true;return}slashI=Math.min(slashI,hits.length-1);
  slashMenu.innerHTML=hits.map(([c,d],i)=>'<li role="option" data-cmd="'+c+'"'+(i===slashI?' aria-selected="true" class="on"':'')+'><b>/'+c+'</b> <span class="k">'+d+'</span></li>').join('');slashMenu.hidden=false}
function slashPick(c){ta.value='/'+c+' ';slashMenu.hidden=true;ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);ta.dispatchEvent(new Event('input'))}
slashMenu?.addEventListener('mousedown',e=>{const li=e.target.closest('[data-cmd]');if(li){e.preventDefault();slashPick(li.dataset.cmd)}});
document.querySelector('form.composer')?.addEventListener('submit',()=>{const m=ta.value.match(/^\\/(task|decide|ask)\\b[ \\t]*/i),ty=document.getElementById('cmp-type');
  if(ty)ty.value=m?{task:'task',decide:'decision',ask:'question'}[m[1].toLowerCase()]:'note';if(m)ta.value=ta.value.slice(m[0].length)},true);
document.querySelector('form.composer')?.addEventListener('submit',()=>{sentKey=draftNow();const t=ta.value.trim();if(!t||!rpTo||rpTo.value||pending.length)return; // files get their own copy (below); replies go in their thread, after the real post
  const el=document.createElement('article');el.className='entry pending';el.innerHTML='<div class="grow"><div class="meta"><span class="who"></span><span class="xs faint">sending…</span></div><div class="body"></div></div>';
  el.querySelector('.who').textContent=ME;el.querySelector('.body').textContent=t;document.getElementById('thread').appendChild(el);toBottom();
},true);
// While a post is retrying it says so; if it really can't be sent, your text is still in the box (the form only resets on success).
window.postRetrying=()=>document.querySelectorAll('#thread .entry.pending .faint').forEach(x=>x.textContent='connection lost, retrying…');
window.postFailed=(j)=>{document.querySelectorAll('#thread .entry.pending').forEach(x=>x.remove());toast(j.error||"Couldn't send. Your message is still in the box.")};
// @mention autocomplete: people ("@vedu") and agents ("@vedu's agent", including your own).
const MOPTS=${jsString(mentionOptions(members.map((m) => m.user), viewer.name, agents))};
const MNAMES=new Set(MOPTS.map(o=>o.u)),ME=${jsString(viewer.name)};
// "@you" glows, and so does the message it's in, including ones that arrive live.
// Approval cards: the person asked gets Approve / Deny in place; a decision made anywhere shows up live.
${approvalJs(viewer.name)}
function markMe(root){root.querySelectorAll('.mention:not(.agent)').forEach(m=>{if(m.dataset.user===ME){m.classList.add('me');m.closest('.entry')?.classList.add('for-you')}})}
markMe(document.getElementById('thread'));
new MutationObserver(ms=>ms.forEach(m=>m.addedNodes.forEach(n=>{if(n.nodeType===1)markMe(n)}))).observe(document.getElementById('thread'),{childList:true,subtree:true});
// Looking at a board reads its inbox items (now, and as new ones arrive while you're here).
let inboxT=0;function readInbox(){clearTimeout(inboxT);inboxT=setTimeout(()=>{if(document.visibilityState!=='visible')return;
  fetch('/api/inbox/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({board:BOARD})}).then(()=>window.inboxRefresh&&inboxRefresh()).catch(()=>{})},800)}
readInbox();document.addEventListener('visibilitychange',readInbox);
new MutationObserver(readInbox).observe(document.getElementById('thread'),{childList:true});

/** @-mentions for a text box (the composer, a thread's reply box): a menu of people and agents while typing "@…",
 * and chips that act as one unit. Returns msync, which redraws the chips after the text changes from code. */
function mentionize(ta,mm,mirror){
let mi=0,ms=[],mq=null;
function mfind(){if(ta.selectionStart!==ta.selectionEnd)return null;const v=ta.value.slice(0,ta.selectionStart);
  const m=v.match(/(^|[^A-Za-z0-9_.@\\/-])@([A-Za-z0-9_.-]{0,32}(?:\\/[A-Za-z0-9_.-]{0,32})?)$/);return m?{start:v.length-m[2].length-1,q:m[2].toLowerCase()}:null}
function mclose(){mm.hidden=true;ms=[];ta.setAttribute('aria-expanded','false');ta.removeAttribute('aria-activedescendant')}
function mrender(){mq=mfind();if(mq&&window.agentsRefresh&&Date.now()-agentsAt>10000){agentsAt=Date.now();agentsRefresh().then(()=>{if(!mm.hidden||mfind())mrender()})}ms=mq?MOPTS.filter(o=>mq.q.includes('/')?o.ins.toLowerCase().startsWith(mq.q):o.u.startsWith(mq.q)):[];if(!ms.length)return mclose();mi=Math.min(mi,ms.length-1);
  mm.innerHTML='<li class="hint" aria-hidden="true">Mention a person or their agent</li>'+ms.map((o,i)=>'<li role="option"'+(o.sub?' class="sub"':'')+' id="'+mm.id+'-'+i+'" data-i="'+i+'" aria-selected="'+(i===mi)+'">'+o.av+'<span class="truncate">'+o.label+'</span><span class="k">'+o.k+'</span></li>').join('');
  mm.hidden=false;ta.setAttribute('aria-expanded','true');ta.setAttribute('aria-activedescendant',mm.id+'-'+mi)}
function mpick(o){const end=ta.selectionStart,before=ta.value.slice(0,mq.start),after=ta.value.slice(end);const ins='@'+o.ins+(/^\\s/.test(after)?'':' ');
  ta.value=before+ins+after;const p=before.length+ins.length;ta.setSelectionRange(p,p);mclose();ta.focus();msync()}
ta.addEventListener('input',()=>{mi=0;mrender();ta.style.height='';ta.style.height=ta.scrollHeight+2+'px';if(ta.selectionStart===ta.value.length)ta.scrollTop=ta.scrollHeight;msync()}); // past the max height it scrolls inside; typing at the end keeps the caret in view
ta.addEventListener('keydown',e=>{if(mm.hidden)return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){mi=(mi+(e.key==='ArrowDown'?1:ms.length-1))%ms.length;mrender();e.preventDefault()}
  else if(e.key==='Enter'||e.key==='Tab'){mpick(ms[mi]);e.preventDefault()}
  else if(e.key==='Escape'){mclose();e.preventDefault()}});
ta.addEventListener('blur',mclose);
mm.addEventListener('mousedown',e=>{e.preventDefault();const li=e.target.closest('[data-i]');if(li)mpick(ms[+li.dataset.i])});
// Mentions in the composer are chips: a mirror under the (transparent) text draws them, and an edit or a caret move
// treats each one as a single unit, so one Backspace removes "@vedu's agent" whole and the caret never lands inside.
function mtokens(v){const out=[],re=/(^|[^A-Za-z0-9_.@\\/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’)s\\s+agent\\b|\\/[A-Za-z0-9][A-Za-z0-9_.-]{0,31})?/gi;let m;
  while((m=re.exec(v))){const raw=m[2].toLowerCase();let h=raw;if(!MNAMES.has(h))h=raw.replace(/[.-]+$/,'');if(!MNAMES.has(h))continue;
    const agent=!!m[3]&&h===raw;if(!agent&&h===ME)continue; // you can't mention yourself, only your agent
    const start=m.index+m[1].length;out.push({start,end:start+1+h.length+(agent?m[3].length:0),agent})}
  return out}
function msync(){const v=ta.value,cs=getComputedStyle(ta);let h='',i=0;
  for(const t of mtokens(v)){h+=esc(v.slice(i,t.start))+'<span class="chip'+(t.agent?' agent':'')+'">'+esc(v.slice(t.start,t.end))+'</span>';i=t.end}
  mirror.innerHTML=h+esc(v.slice(i))+'\\n';
  for(const k of ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','wordSpacing','tabSize','paddingTop','paddingRight','paddingBottom','paddingLeft'])mirror.style[k]=cs[k];
  mirror.style.left=cs.borderLeftWidth;mirror.style.top=cs.borderTopWidth;mirror.style.width=ta.clientWidth+'px';mirror.style.height=ta.clientHeight+'px';mirror.scrollTop=ta.scrollTop}
ta.addEventListener('scroll',()=>{mirror.scrollTop=ta.scrollTop});window.addEventListener('resize',msync);msync();
let medit=false;
function mreplace(a,b,text){ta.focus();ta.setSelectionRange(a,b);medit=true; // execCommand keeps the edit on the undo stack
  const ok=text?document.execCommand('insertText',false,text):document.execCommand('delete');medit=false;
  if(!ok){ta.setRangeText(text,a,b,'end');ta.dispatchEvent(new Event('input'))}}
ta.addEventListener('beforeinput',e=>{if(medit||e.isComposing)return;
  const dir=e.inputType==='deleteContentBackward'?-1:e.inputType.startsWith('delete')?1:0;
  const toks=mtokens(ta.value);let a=ta.selectionStart,b=ta.selectionEnd;
  if(a===b&&dir){const t=toks.find(t=>dir<0?t.start<a&&a<=t.end:t.start<=a&&a<t.end);if(!t)return;a=t.start;b=t.end} // Backspace at a chip's end
  else{let na=a,nb=b;for(const t of toks){if(t.start<na&&na<t.end)na=t.start;if(t.start<nb&&nb<t.end)nb=t.end}if(na===a&&nb===b)return;a=na;b=nb} // edits cutting into a chip take all of it
  e.preventDefault();mreplace(a,b,dir?'':(e.data??''))});
ta.addEventListener('keydown',e=>{if(e.defaultPrevented||e.shiftKey||e.altKey||e.metaKey||e.ctrlKey||(e.key!=='ArrowLeft'&&e.key!=='ArrowRight'))return;
  const a=ta.selectionStart;if(a!==ta.selectionEnd)return;const left=e.key==='ArrowLeft';
  const t=mtokens(ta.value).find(t=>left?t.start<a&&a<=t.end:t.start<=a&&a<t.end);if(!t)return; // arrows step over a chip
  e.preventDefault();const p=left?t.start:t.end;ta.setSelectionRange(p,p)});
function msnap(){if(document.activeElement!==ta)return;const a=ta.selectionStart;if(a!==ta.selectionEnd)return; // a click inside a chip goes to its nearer edge
  const t=mtokens(ta.value).find(t=>t.start<a&&a<t.end);if(t){const p=a-t.start<t.end-a?t.start:t.end;ta.setSelectionRange(p,p)}}
ta.addEventListener('selectionchange',msnap);document.addEventListener('selectionchange',msnap); // fired on the textarea in newer browsers, on document in older ones
return msync}
// The @ button: starts a mention where the caret is and opens the menu of people and agents.
document.addEventListener('click',e=>{const b=e.target.closest('[data-mention-for]');if(!b)return;const t=document.getElementById(b.dataset.mentionFor);if(!t)return;
  t.focus();const a=t.selectionStart??t.value.length,pre=t.value.slice(0,a);const ins=(pre&&!/[ ]$/.test(pre)&&!pre.endsWith(String.fromCharCode(10))?' ':'')+'@';
  t.setRangeText(ins,a,t.selectionEnd??a,'end');t.dispatchEvent(new Event('input'))});
const ta=document.getElementById('composer-text'),msync=mentionize(ta,document.getElementById('mention-menu'),document.getElementById('composer-mirror'));
// The / command menu (defined above, with the composer's submit), wired once the box exists.
ta?.addEventListener('input',slashShow);
ta?.addEventListener('keydown',e=>{if(!slashMenu||slashMenu.hidden)return;const items=[...slashMenu.querySelectorAll('[data-cmd]')];
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();slashI=(slashI+(e.key==='ArrowDown'?1:items.length-1))%items.length;slashShow()}
  else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();slashPick(items[slashI].dataset.cmd)}else if(e.key==='Escape'){slashMenu.hidden=true}},true);
// ---- "… is typing": people while they type (a ping every few seconds, heard over the socket). Agents don't show here
// (jxn #777): an agent working on your message says so with 🤔 under it. ----
const TYPERS=new Map();let typedAt=0,typingTimer=null;
function typingSync(){const el=document.getElementById('typing');if(!el)return;const now=Date.now();
  for(const [u,t] of TYPERS)if(t<now)TYPERS.delete(u);
  const who=[...TYPERS.keys()].map(u=>({u,agent:false,label:u}));
  if(!who.length){el.hidden=true;el.innerHTML='';return}
  const names=who.map(w=>w.label),text=names.length===1?names[0]+' is typing':names.length===2?names[0]+' and '+names[1]+' are typing':names[0]+' and '+(names.length-1)+' others are typing';
  el.innerHTML='<span class="ty-avs">'+who.slice(0,3).map(w=>avatar16(w.u,w.agent)).join('')+'</span><span class="ty-t">'+esc(text)+'</span><span class="ty-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
  el.hidden=false;clearTimeout(typingTimer);if(TYPERS.size)typingTimer=setTimeout(typingSync,1000)}
ta.addEventListener('input',()=>{const now=Date.now();if(READONLY||!ta.value.trim()||now-typedAt<3000)return;typedAt=now;
  fetch('/api/boards/'+BOARD+'/typing',{method:'POST',keepalive:true}).catch(()=>{})});
// Drafts: what you were typing survives leaving the board (or the tab) and coming back; posting clears it.
const draftKey=k=>'soup.draft.'+BOARD+(k?'.'+k:'');
function draftSave(k,v){if(${info.encrypted ? "true" : "false"})return; // encrypted boards: no plaintext kept in the browser
  try{v.trim()?localStorage.setItem(draftKey(k),v):localStorage.removeItem(draftKey(k))}catch(e){}}
function draftLoad(k){try{return localStorage.getItem(draftKey(k))||''}catch(e){return ''}}
let draftT=0;ta.addEventListener('input',()=>{clearTimeout(draftT);draftT=setTimeout(()=>draftSave(draftNow(),ta.value),250)});
window.addEventListener('pagehide',()=>draftSave(draftNow(),ta.value));
if(!ta.value){const d=draftLoad('');if(d){ta.value=d;setTimeout(()=>{msync();ta.style.height=ta.scrollHeight+2+'px'},0)}}
// Reply: points the main composer at a message, with a slim "Replying to …" line above it (✕ or Esc cancels; clicking
// it shows the message). The reply lands in that message's thread. Each reply keeps its own draft, and an unsent reply
// is still a reply after a reload.
/** The name a message's header shows: "vedu/scout" for a named agent session, else "vedu's agent" or the person. */
const headName=el=>el.querySelector(':scope>.grow>.meta>.who')?.textContent||(el.dataset.author+(el.classList.contains('by-agent')?"'s agent":''));
const rpBox=document.getElementById('replying'),rpTo=document.getElementById('reply-to');let rpAt='';
const draftNow=()=>rpTo.value?'r'+rpTo.value:'';
const taFit=()=>{ta.style.height='';if(ta.value)ta.style.height=ta.scrollHeight+2+'px';msync()};
function replyTo(seq,focus=true){const el=document.getElementById('e'+seq);if(!el||READONLY)return;
  if(+rpTo.value!==seq){draftSave(draftNow(),ta.value);rpTo.value=String(seq);ta.value=draftLoad('r'+seq)}
  const by=el.dataset.author,who=el.classList.contains('by-agent')?by+"'s agent":by;
  const named=headName(el);document.getElementById('replying-who').textContent=who===ME?'yourself':named.includes('/')?named:who===ME+"'s agent"?'your agent':who;
  const body=el.querySelector(':scope>.grow>.body');document.getElementById('replying-text').textContent=((body?.innerText||body?.textContent||'').trim().split('\\n')[0]||'').slice(0,160);
  rpBox.hidden=false;try{localStorage.setItem(draftKey('to'),String(seq))}catch(e){}
  // Replying mentions whoever wrote it, like Slack, so it reaches them: a person, or their agent ("@jxn's agent" reaches
  // every session of it and the dispatcher, even if the one that wrote it has ended). Your own agent's posts count too
  // (jxn #973); only your own messages don't.
  rpAt=who===ME?'':'@'+who+' ';const rpM=rpAt.trim();if(rpAt&&!(ta.value.startsWith(rpM)&&/^\\s*$/.test(ta.value.slice(rpM.length,rpM.length+1))))ta.value=rpAt+ta.value;
  taFit();if(focus){ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}}
/** Leaves reply mode: the reply's draft is kept (unless it's only the @mention it started with) and your other draft comes back. */
function replyClear(sent){if(!rpTo.value)return;if(!sent)draftSave(draftNow(),ta.value.trim()===rpAt.trim()?'':ta.value);
  rpTo.value='';rpAt='';rpBox.hidden=true;try{localStorage.removeItem(draftKey('to'))}catch(e){}
  if(!sent){ta.value=draftLoad('');taFit()}}
/** After a reply is posted: its thread is open, so you can see it there. */
// A reply posts at the bottom like any message (jxn #1040): after sending one, the conversation follows it there.
function replyShown(){toBottom(true)}
document.addEventListener('click',e=>{const b=e.target.closest('[data-reply]');if(b){e.preventDefault();replyTo(+b.dataset.reply);return}
  if(e.target.closest('#reply-cancel')){replyClear();ta.focus();return}
  if(e.target.closest('#replying-go')&&rpTo.value)window.BOARD_CTX.jump(+rpTo.value)});
ta.addEventListener('keydown',e=>{if(e.key==='Escape'&&!e.defaultPrevented&&rpTo.value){e.preventDefault();if(cmpHome)closeThread();else replyClear()}}); // in a thread, Esc closes it
{let t=0;try{t=+localStorage.getItem(draftKey('to'))||0}catch(e){}if(t)setTimeout(()=>{if(document.getElementById('e'+t))replyTo(t,false);else replyClear()},0)}
// Enter posts, Shift+Enter adds a line. An Enter that picked a mention (default prevented above) doesn't post. On a
// phone or tablet (touch, no hover) Return adds a line, as in other chat apps there: Post sends.
document.getElementById('composer-text')?.addEventListener('keydown',e=>{
  if(e.defaultPrevented)return;
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!matchMedia('(hover:none) and (pointer:coarse)').matches){e.preventDefault();const f=e.target.closest('form');if(e.target.value.trim()||pending.length)f.requestSubmit()}});
// ---- shared documents ----
const READONLY=${info.archived || readOnly ? "true" : "false"};let curDoc=null,editing=false;
async function loadDocs(){const r=await fetch('/api/boards/'+BOARD+'/files');const j=await r.json();const el=document.getElementById('doc-items');const fs=j.files||j.docs||[];
  const kb=n=>n<1024?n+' B':(n/1024).toFixed(1)+' KB';
  el.innerHTML=fs.length?fs.map(d=>'<a href="#files" class="doc-item'+(curDoc&&curDoc.name===d.name?' on':'')+'" data-doc="'+esc(d.name)+'" title="'+esc(d.name+' · v'+d.version+(d.updated_by?' · '+(d.via==='agent'?d.updated_by+"'s agent":d.updated_by):''))+'"><span class="truncate mono">'+esc(d.name)+'</span><span class="xs faint">v'+d.version+(d.size!=null?' · '+kb(d.size):'')+'</span></a>').join(''):'<p class="xs faint">No files yet.</p>';
  // Nothing open yet: the viewer says to pick a file, not that there are none.
  const ph=document.getElementById('doc-empty');if(ph){ph.dataset.none=ph.dataset.none||ph.textContent;ph.textContent=fs.length?'Pick a file to open it.':ph.dataset.none}
  // On a wide screen, an empty viewer opens the most recently changed file (phones keep the list first).
  if(!curDoc&&!docAsked&&fs.length&&innerWidth>800&&!document.getElementById('panel-docs').hidden)openDoc(fs[0].name)}
let docAsked=false;async function openDoc(name,version){docAsked=true;editing=false;const r=await fetch('/api/boards/'+BOARD+'/doc?name='+encodeURIComponent(name)+(version?'&version='+version:''));const d=await r.json();if(!r.ok){toast(d.error);return}curDoc=d;renderDoc();loadDocs()}
function renderDoc(){const d=curDoc,v=document.getElementById('doc-view');const old=d.version!==d.latest;v.classList.remove('editing');
  v.innerHTML='<div class="row wrap" style="justify-content:space-between;gap:8px;margin-bottom:12px"><div><b class="mono">'+esc(d.name)+'</b> <span class="xs faint">v'+d.version+(old?' (viewing an older version; latest v'+d.latest+')':'')+' · '+esc(d.via==='agent'?d.updated_by+"'s agent":d.updated_by)+'</span></div><div class="row">'+
  '<span id="doc-pin-slot"></span><button class="btn sm ghost" type="button" id="doc-hist">History</button>'+(READONLY||old||d.media?'':'<button class="btn sm" type="button" id="doc-edit">Edit</button>')+'</div></div>'+(d.media?'<div class="doc-img"><img alt="'+esc(d.name)+'" src="/api/boards/'+BOARD+'/image?name='+encodeURIComponent(d.name)+'&version='+d.version+'"></div>':'<div class="doc-body body">'+d.html+'</div>')+'<div id="doc-history"></div>';if(window.pinSlot)pinSlot(d)}
function editDoc(){const d=curDoc,v=document.getElementById('doc-view');editing=true;v.classList.add('editing');
  v.innerHTML='<div class="row" style="justify-content:space-between;margin-bottom:10px"><b class="mono">'+esc(d.name)+'</b><span class="xs faint">editing v'+d.version+'</span></div><textarea class="input mono" id="doc-text" style="font-size:12.5px">'+esc(d.content)+'</textarea><input class="input" id="doc-summary" placeholder="What changed? (optional)" style="margin-top:8px"><p id="doc-warn" class="flash" hidden style="margin-top:8px"></p><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" type="button" id="doc-cancel">Cancel</button><button class="btn primary" type="button" id="doc-save">Save</button></div>'}
async function saveDoc(name,content,base,summary){const r=await fetch('/api/boards/'+BOARD+'/doc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'write',name,content,base_version:base,summary})});const j=await r.json();
  if(!r.ok){const w=document.getElementById('doc-warn');if(w){w.hidden=false;w.className='flash err';w.textContent=j.error}else toast(j.error);return false}toast(j.message);await openDoc(name);tick(false);return true}
document.addEventListener('click',async e=>{const t=e.target;
  const it=t.closest('[data-doc]');if(it){e.preventDefault();openDoc(it.dataset.doc);return}
  if(t.closest('#doc-edit')){editDoc();return}
  if(t.closest('#doc-cancel')){editing=false;renderDoc();return}
  if(t.closest('#doc-save')){saveDoc(curDoc.name,document.getElementById('doc-text').value,curDoc.version,document.getElementById('doc-summary').value);return}
  if(t.closest('#doc-hist')){const r=await fetch('/api/boards/'+BOARD+'/doc-history?name='+encodeURIComponent(curDoc.name));const j=await r.json();
    document.getElementById('doc-history').innerHTML='<div class="divider"></div>'+(j.versions||[]).map(v=>'<a href="#docs" class="doc-item" data-doc="'+esc(curDoc.name)+'" data-ver="'+v.version+'"><span>v'+v.version+' · '+esc(v.via==='agent'?v.author+"'s agent":v.author)+(v.summary?' · '+esc(v.summary):'')+'</span><span class="xs faint">'+new Date(v.ts).toLocaleString()+'</span></a>').join('');return}
  if(t.closest('#doc-new')){const v=document.getElementById('doc-view');editing=true;curDoc=null;v.classList.add('editing');
    v.innerHTML='<label class="lbl" for="doc-name">Name</label><input class="input mono" id="doc-name" placeholder="BACKLOG.md"><label class="lbl" style="margin-top:12px" for="doc-text">Content</label><textarea class="input mono" id="doc-text" style="font-size:12.5px"></textarea><p id="doc-warn" class="flash" hidden style="margin-top:8px"></p><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn primary" type="button" id="doc-create">Create</button></div>';return}
  if(t.closest('#doc-create')){saveDoc(document.getElementById('doc-name').value.trim(),document.getElementById('doc-text').value,0,'created');return}
});
document.addEventListener('click',e=>{const it=e.target.closest('[data-ver]');if(it){e.preventDefault();e.stopPropagation();openDoc(it.dataset.doc,+it.dataset.ver)}},true);
document.addEventListener('click',e=>{const b=e.target.closest('[data-open-file]');if(!b)return;e.preventDefault();infoOpen(false);tab(2);openDoc(b.dataset.openFile,b.dataset.fileVer?+b.dataset.fileVer:undefined)});
window.onDocChanged=(d)=>{loadDocs();if(curDoc&&curDoc.name===d.name){if(editing){const w=document.getElementById('doc-warn');if(w){w.hidden=false;w.className='flash';w.textContent=d.by+' saved v'+d.version+' while you were editing. Saving now will be refused; copy your changes, cancel, and edit the new version.'}}else openDoc(d.name)}};
// ---- change cards: review verdicts agents posted (from the live reviews map), the diff on demand ----
let REVIEWS={};
function applyReviews(map){REVIEWS=map||{};document.querySelectorAll('[data-reviews]').forEach(el=>{const seq=el.dataset.reviews,rs=REVIEWS[seq]||[];
    el.innerHTML=rs.length?rs.map(r=>'<span class="rv '+(r.verdict==='approve'?'ok':'no')+'">'+(r.verdict==='approve'?'✅ Approved by ':'✋ Changes requested by ')+'<b>'+esc(r.via==='agent'?r.reviewer+"'s agent":r.reviewer)+'</b></span>').join(''):''})}
function diffHtml(t){return t.split('\\n').map(l=>{const c=/^(diff |index |\\+\\+\\+ |--- )/.test(l)?'dh':l.startsWith('@@')?'dk':l.startsWith('+')?'da':l.startsWith('-')?'dd':'';
  return '<span'+(c?' class="'+c+'"':'')+'>'+esc(l)+'</span>'}).join('')}
document.addEventListener('click',async e=>{
  const dv=e.target.closest('[data-diff]');if(dv){const pre=document.querySelector('[data-diff-for="'+dv.dataset.diff+'"]');
    if(!pre.hidden){pre.hidden=true;dv.textContent='View diff';return}
    if(!pre.dataset.loaded){dv.disabled=true;const r=await fetch('/api/boards/'+BOARD+'/entries/'+dv.dataset.diff);const j=await r.json().catch(()=>({}));dv.disabled=false;
      pre.innerHTML=j.diff?diffHtml(j.diff):'<span class="faint">No diff was attached to this change.</span>';pre.dataset.loaded='1'}
    pre.hidden=false;dv.textContent='Hide diff'}});
applyReviews({});tick(false); // the first update brings every card's verdicts
// ---- files and images: paste, drop or attach (up to 10); previewed above the text; posted together as one message ----
const attIn=document.getElementById('attach-input'),attBox=document.getElementById('attachments'),cform=ta.closest('form');let pending=[];
const IMG_TYPES=['image/png','image/jpeg','image/gif','image/webp'],FILE_MAX=1500000;
const kbs=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
const fileUrl=(name,v)=>'/api/boards/'+BOARD+'/image?name='+encodeURIComponent(name)+(v?'&version='+v:'');
/** Pasted pictures all come in as "image.png": give those (and unnamed ones) a name with the time, so each upload is its
 *  own file instead of the next version of the last one. Files with a real name keep it. */
let lastUp='',upN=0;
function upName(file){const ext=(file.type.split('/')[1]||'png').replace('jpeg','jpg');
  if(file.name&&!/^(image|blob|untitled)\\.[a-z0-9]+$/i.test(file.name))return file.name;
  const d=new Date(),p=n=>String(n).padStart(2,'0');
  let base='image-'+d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+p(d.getSeconds());
  upN=base===lastUp?upN+1:1;lastUp=base;if(upN>1)base+='-'+upN;return base+'.'+ext}
/** Pictures over 1600px or the size limit are scaled and re-encoded as WebP (GIFs stay as they are, for animation). */
async function shrink(file){const bmp=await createImageBitmap(file);let w=bmp.width,h=bmp.height;
  if(file.type==='image/gif'||(file.size<=FILE_MAX&&Math.max(w,h)<=1600))return {blob:file,w,h,name:upName(file),image:true};
  const k=Math.min(1,1600/Math.max(w,h));w=Math.round(w*k);h=Math.round(h*k);
  const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(bmp,0,0,w,h);
  let q=.86,blob;do{blob=await new Promise(r=>c.toBlob(r,'image/webp',q));q-=.12}while(blob&&blob.size>FILE_MAX&&q>.3);
  return {blob,w,h,name:upName(file).replace(/\\.[^.]+$/,'')+'.webp',image:true}}
/** Other files over the limit are gzipped (and sent as name.gz) when that makes them fit. */
async function pack(file){if(file.size<=FILE_MAX)return {blob:file,name:file.name||'file'};
  if(typeof CompressionStream==='undefined')return null;
  const gz=await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return gz.size<=FILE_MAX?{blob:gz,name:(file.name||'file')+'.gz',packed:file.size}:null}
const MAX_FILES=10; // files in one message (the server's limit too)
async function addFiles(files){for(const f of files){
  if(pending.length>=MAX_FILES){toast('At most '+MAX_FILES+' files in one message');break}
  try{const x=IMG_TYPES.includes(f.type)?await shrink(f):await pack(f);
    if(!x||!x.blob||x.blob.size>FILE_MAX){toast((f.name||'That file')+' is too large, even compressed (max 1.5 MB)');continue}
    if(x.packed)toast(f.name+' compressed to '+kbs(x.blob.size));
    x.url=x.image?URL.createObjectURL(x.blob):null;pending.push(x)}catch(e){toast("Couldn't read "+(f.name||'that file'))}}
  renderAtt()}
function renderAtt(){attBox.hidden=!pending.length;ta.required=!pending.length;
  attBox.innerHTML=pending.map((x,i)=>'<span class="att'+(x.image?'':' file')+'">'+(x.image?'<img src="'+x.url+'" alt="'+esc(x.name)+'">':'<span class="att-name mono">'+esc(x.name)+'</span><span class="xs faint">'+kbs(x.blob.size)+'</span>')+
    '<button type="button" class="att-x" data-att-rm="'+i+'" aria-label="Remove '+esc(x.name)+'">✕</button></span>').join('')}
document.getElementById('attach-btn').addEventListener('click',()=>attIn.click());
attIn.addEventListener('change',()=>{addFiles([...attIn.files]);attIn.value=''});
attBox.addEventListener('click',e=>{const b=e.target.closest('[data-att-rm]');if(!b)return;const i=+b.dataset.attRm;if(pending[i].url)URL.revokeObjectURL(pending[i].url);pending.splice(i,1);renderAtt();ta.focus()});
ta.addEventListener('paste',e=>{const fs=[...(e.clipboardData?.files||[])];if(fs.length){e.preventDefault();addFiles(fs)}});
const convEl=document.querySelector('.conv');
convEl.addEventListener('dragover',e=>{if([...(e.dataTransfer?.types||[])].includes('Files')){e.preventDefault();convEl.classList.add('drop')}});
convEl.addEventListener('dragleave',e=>{if(!convEl.contains(e.relatedTarget))convEl.classList.remove('drop')});
convEl.addEventListener('drop',e=>{convEl.classList.remove('drop');const fs=[...(e.dataTransfer?.files||[])];if(fs.length){e.preventDefault();addFiles(fs)}});
// With files attached, posting sends them all, with the text, as ONE message (multipart: a "file" part per file, w/h in
// the same order). One "sending" copy shows the text and the thumbnails until the real entry comes back in its "update".
cform.addEventListener('submit',async e=>{if(!pending.length)return;e.preventDefault();e.stopPropagation();
  const btn=cform.querySelector('.bar .btn.primary');btn.disabled=true;const text=ta.value.trim(),files=pending.slice();
  let ph=null;
  if(!rpTo.value){ph=document.createElement('article');ph.className='entry pending';ph.innerHTML='<div class="grow"><div class="meta"><span class="who"></span><span class="xs faint">sending…</span></div><div class="body"></div><div class="attachments ph-att"></div></div>';
    ph.querySelector('.who').textContent=ME;ph.querySelector('.body').textContent=text;
    ph.querySelector('.ph-att').innerHTML=files.map(x=>x.image?'<span class="att"><img src="'+x.url+'" alt="'+esc(x.name)+'"></span>':'<span class="att file"><span class="att-name mono">'+esc(x.name)+'</span><span class="xs faint">'+kbs(x.blob.size)+'</span></span>').join('');
    document.getElementById('thread').appendChild(ph);toBottom()}
  const fail=m=>{if(ph){ph.classList.add('failed');ph.querySelector('.faint').textContent="Couldn't send";const p=ph;setTimeout(()=>p.remove(),6000)}toast(m)};
  try{const fd=new FormData();
    for(const x of files){fd.append('file',x.blob,x.name);fd.append('w',x.image&&x.w?String(x.w):'');fd.append('h',x.image&&x.h?String(x.h):'')}
    if(text)fd.append('text',text);if(rpTo.value)fd.append('reply_to',rpTo.value);
    const r=await fetch('/api/boards/'+BOARD+'/upload',{method:'POST',body:fd});
    const j=await r.json().catch(()=>({}));if(!r.ok){fail(j.error||"Couldn't post "+(files.length>1?'those files':files[0].name)+'. They are still attached.');return}
    if(ph){ph.remove();ph=null}if(j.update&&addEntry(j.update)&&!rpTo.value){railBuild();toBottom()}
    files.forEach(x=>{if(x.url)URL.revokeObjectURL(x.url)});pending=pending.filter(x=>!files.includes(x));renderAtt();ta.value='';msync();
    const was=+rpTo.value;cform.reset();draftSave(draftNow(),'');replyClear(true);if(was){ta.value=draftLoad('');replyShown(was)}taFit();stickNext=!was;tick(false)}
  catch(err){fail("Couldn't post that. Your files are still attached.")}
  finally{btn.disabled=false}});
// The lightbox: a picture full size; for a message with several, the arrows, ←/→ or a swipe go through them.
const lb=document.getElementById('lightbox'),lbImg=document.getElementById('lightbox-img'),lbCount=lb.querySelector('.lb-count');let lbSet=[],lbI=0,lbSwiped=0;
function lbShow(i){lbI=(i+lbSet.length)%lbSet.length;const b=lbSet[lbI];lbImg.src=b.dataset.img;lbImg.alt=b.dataset.imgName||'';
  const many=lbSet.length>1;lb.querySelectorAll('.lb-nav').forEach(x=>x.hidden=!many);lbCount.hidden=!many;lbCount.textContent=(lbI+1)+' / '+lbSet.length}
document.addEventListener('click',e=>{const b=e.target.closest('[data-img]');if(!b)return;const g=b.closest('[data-gallery]');lbSet=g?[...g.querySelectorAll('[data-img]')]:[b];lbShow(lbSet.indexOf(b));if(!lb.open){lb.showModal();lb.querySelector('.lb-nav:focus')?.blur()}});
lb.addEventListener('click',e=>{if(Date.now()-lbSwiped<400)return;const n=e.target.closest('.lb-nav');if(n){lbShow(lbI+(n.classList.contains('lb-prev')?-1:1));return}lb.close()});
document.addEventListener('keydown',e=>{if(!lb.open||lbSet.length<2)return;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();lbShow(lbI+(e.key==='ArrowLeft'?-1:1))}});
let lbX=null,lbY=0;
lb.addEventListener('touchstart',e=>{if(e.touches.length===1){lbX=e.touches[0].clientX;lbY=e.touches[0].clientY}else lbX=null},{passive:true});
lb.addEventListener('touchend',e=>{if(lbX==null)return;const dx=e.changedTouches[0].clientX-lbX,dy=e.changedTouches[0].clientY-lbY;lbX=null;
  if(lbSet.length>1&&Math.abs(dx)>40&&Math.abs(dx)>Math.abs(dy)*1.5){lbSwiped=Date.now();lbShow(lbI+(dx<0?1:-1))}});
// ---- read receipts: a ring on your latest message (who has seen it), a dot on each @mention (has that one seen it) ----
const MEMBERS=${jsString(members.map((m) => m.user))};let READS={},seenSent=0,seenTimer=null;
const seenAs=(u,agent)=>{const r=READS[u];return r?(agent?r.agent_seen:r.person_seen):(agent?-1:0)}; // agent -1: never on this board
/** Everyone who should see an entry: each member, and each member's agent once it has been on the board; not its author. */
function audience(el){const by=el.dataset.author,byAgent=el.classList.contains('by-agent'),out=[];
  for(const u of MEMBERS){if(!(u===by&&!byAgent))out.push({u,agent:false});if(seenAs(u,true)>=0&&!(u===by&&byAgent))out.push({u,agent:true})}return out}
// ---- board info sections fold; which ones this person folded is remembered per board (only in this browser) ----
const FOLD_KEY='soup.fold.'+BOARD;
function foldGet(){try{return new Set(JSON.parse(localStorage.getItem(FOLD_KEY)||'[]'))}catch{return new Set()}}
function foldApply(){const f=foldGet();document.querySelectorAll('#board-info .fold').forEach(x=>{const shut=f.has(x.dataset.fold);x.classList.toggle('folded',shut);x.querySelector('.fold-h').setAttribute('aria-expanded',String(!shut))})}
document.addEventListener('click',e=>{const h=e.target.closest('#board-info .fold-h');if(!h)return;const id=h.closest('.fold').dataset.fold,f=foldGet();
  f.has(id)?f.delete(id):f.add(id);try{localStorage.setItem(FOLD_KEY,JSON.stringify([...f]))}catch{}foldApply()});
foldApply();
// Touch screens have no hover: the ⋯ on a message, or tapping the message itself, shows its actions (Reply, react, …);
// tapping it again, or another one, moves them.
function tapToggle(en){const was=en.classList.contains('tap');document.querySelectorAll('.entry.tap').forEach(x=>{x.classList.remove('tap');x.querySelector(':scope>.grow>.meta>.more-acts')?.setAttribute('aria-expanded','false')});
  if(!was){en.classList.add('tap');en.querySelector(':scope>.grow>.meta>.more-acts')?.setAttribute('aria-expanded','true')}}
document.addEventListener('click',e=>{const b=e.target.closest('.more-acts');if(!b)return;e.preventDefault();const en=b.closest('.entry');if(en)tapToggle(en)});
// A change card opens its PR / commit on GitHub when you tap it anywhere that isn't its own control (vedu #1097).
document.addEventListener('click',e=>{const c=e.target.closest('.chg[data-href]');if(!c||document.documentElement.classList.contains('selecting')||e.target.closest('a,button,summary,details>ul,.chg-diff,.chg-reviews'))return;
  if(getSelection&&String(getSelection()).trim())return;e.preventDefault();e.stopPropagation();window.open(c.dataset.href,'_blank','noopener')},true);
if(matchMedia('(hover:none)').matches)document.addEventListener('click',e=>{if(document.documentElement.classList.contains('selecting'))return;
  const en=e.target.closest('.entry');if(!en||en.classList.contains('pending')||e.target.closest('a,button,input,textarea,select,label,summary,details,.acts,.tk,[data-hc],.rd'))return;
  tapToggle(en)});
function renderReads(){
  // @humans / @agents are seen once every person (or every member's agent) other than the author has read it.
  const seenBy=(u,agent,e)=>(u==='humans'||u==='agents')&&!MEMBERS.includes(u)
    ?MEMBERS.filter(x=>x!==e.dataset.author&&(u==='humans'||seenAs(x,true)>=0)).every(x=>seenAs(x,u==='agents')>=+e.dataset.seq)
    :seenAs(u,agent)>=+e.dataset.seq;
  document.querySelectorAll('#thread .mention[data-user]').forEach(m=>{const e=m.closest('.entry');m.classList.toggle('seen',seenBy(m.dataset.user,m.classList.contains('agent'),e))});
  document.querySelectorAll('#thread .rd').forEach(x=>{x.closest('.entry')?.classList.remove('has-rd');x.remove()});
  // Every message you (or your agent) wrote gets a small ring: hover/focus/tap it for who has seen THAT message, from READS.
  [...document.querySelectorAll('#thread .entry')].filter(e=>e.dataset.author===ME&&!e.classList.contains('retracted')).forEach(mine=>{
  const seq=+mine.dataset.seq,who=audience(mine),read=who.filter(w=>seenAs(w.u,w.agent)>=seq),all=who.length>0&&read.length===who.length;
  const C=2*Math.PI*6,frac=who.length?read.length/who.length:0,name=w=>w.u===ME?(w.agent?'Your agent':'You'):esc(w.agent?w.u+"'s agent":w.u),pid='rdp'+seq;
  const head=!who.length?'No one else here yet':all?'Seen by everyone':read.length?'Seen by '+read.length+' of '+who.length:'Delivered · not seen yet';
  const el=document.createElement('button');el.type='button';el.className='rd'+(all?' all':'')+(RD_OPEN===seq?' open':'');el.setAttribute('aria-describedby',pid);el.setAttribute('aria-expanded',String(RD_OPEN===seq));
  el.setAttribute('aria-label',who.length?(read.length?'Seen by '+read.length:'Not seen yet'):'No one else here yet');
  el.innerHTML='<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="t"/><circle cx="8" cy="8" r="6" class="p" stroke-dasharray="'+(C*frac).toFixed(2)+' '+C.toFixed(2)+'" transform="rotate(-90 8 8)"/>'+(all?'<path d="M5.2 8.2l1.9 1.9 3.7-4" class="ck"/>':'')+'</svg>'+
    '<span class="rd-pop" role="tooltip" id="'+pid+'"><b>'+head+'</b>'+who.map(w=>{const y=seenAs(w.u,w.agent)>=seq;return '<span class="'+(y?'y':'n')+'">'+avatar16(w.u,w.agent)+'<span class="nm">'+name(w)+'</span><i>'+(y?'seen':'not yet')+'</i></span>'}).join('')+'</span>';
  // The list opens upward, or downward when the message is near the top of the thread.
  const flip=()=>el.classList.toggle('down',el.getBoundingClientRect().top-scroller.getBoundingClientRect().top<40+26*who.length);
  mine.addEventListener('mouseenter',flip);el.addEventListener('focus',flip);
  mine.classList.add('has-rd');mine.appendChild(el)})}
// Phones: tapping the ring toggles its list (it doesn't touch avatar/mention profiles or the reply/thread buttons); Esc or a tap elsewhere closes it.
let RD_OPEN=0;
function rdClose(){if(!RD_OPEN)return;RD_OPEN=0;document.querySelectorAll('#thread .rd.open').forEach(x=>{x.classList.remove('open');x.setAttribute('aria-expanded','false')})}
document.addEventListener('click',e=>{const b=e.target.closest('#thread .rd');if(!b){rdClose();return}
  const was=b.classList.contains('open');rdClose();if(!was){RD_OPEN=+b.closest('.entry').dataset.seq;b.classList.add('open');b.setAttribute('aria-expanded','true')}});
document.addEventListener('keydown',e=>{if(e.key!=='Escape'||(!RD_OPEN&&!document.activeElement?.closest?.('.rd')&&!document.querySelector('#thread .entry:hover>.rd')))return;
  rdClose();document.activeElement?.closest?.('.rd')?.blur();document.body.classList.add('rd-hush')});
['mousemove','focusin','touchstart'].forEach(t=>document.addEventListener(t,()=>document.body.classList.remove('rd-hush'),{passive:true}));
/** Tells the board how far its person has read: the newest entry on screen while this tab is visible. */
function reportSeen(){if(document.visibilityState!=='visible'||document.getElementById('panel-conv').hidden)return;
  // Messages in view, and the replies of threads in view (a folded thread shows its latest replies).
  const seenIn=el=>Math.max(+el.dataset.seq,...[...el.querySelectorAll('.replies .entry')].map(r=>+r.dataset.seq));
  let max=0;ticks.forEach((t,i)=>{if(rail.children[i]?.classList.contains('on'))max=Math.max(max,seenIn(t.el))});
  if(max<=seenSent||seenTimer)return;
  seenTimer=setTimeout(async()=>{seenTimer=null;let m=0;ticks.forEach((t,i)=>{if(rail.children[i]?.classList.contains('on'))m=Math.max(m,seenIn(t.el))});if(m<=seenSent)return;seenSent=m;
    try{await fetch('/api/boards/'+BOARD+'/seen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({seq:m})})}catch(e){seenSent=0}},800)}
document.addEventListener('visibilitychange',reportSeen);window.addEventListener('focus',reportSeen);window.reportSeen=reportSeen;
// ---- reactions: chips under each message (who reacted on hover; yours highlighted; click to toggle) and a quick picker ----
const QUICK=['👍','✅','🤔','🎉','❤️','🔥','😂','🙏'];
const SHORT={'+1':'👍',thumbsup:'👍','-1':'👎',thumbsdown:'👎',white_check_mark:'✅',heavy_check_mark:'✔️',check:'✅',eyes:'👀',tada:'🎉',heart:'❤️',fire:'🔥',joy:'😂',pray:'🙏',rocket:'🚀',
  raised_hands:'🙌',clap:'👏',ok_hand:'👌',thinking:'🤔',warning:'⚠️',x:'❌',100:'💯',hourglass:'⏳',bug:'🐛',ship:'🚢',sparkles:'✨',wave:'👋',smile:'😄',sob:'😭',muscle:'💪',star:'⭐'};
const emo=e=>{const m=/^:([a-z0-9_+-]+):$/i.exec(e);return m&&SHORT[m[1].toLowerCase()]||e};
const rxWho=u=>u===ME?'you':u===ME+"'s agent"?'your agent':u.startsWith(ME+'/')?'your agent '+u.slice(ME.length+1):u;
// Agents' 🤔 (working on it), 👀 (read it, older boards) and ✅ (done) on a person's message are receipts, like the app: one quiet line under
// it ("✅ done by vedu's agent  👀 read by jxn/builder  🤔 jxn/claude is on it"), not chips. Your own messages skip 👀 (the ring
// says who read them); the "on it" pill or a "done" pill on the message hides the matching part (CSS), so each shows once. Other reactions, and people's, stay chips.
const rxAgent=u=>u.endsWith("'s agent")||u.includes('/');
const rxNames=us=>{const n=us.map(rxWho);return n.length<3?n.join(' and '):n.slice(0,2).join(', ')+' and '+(n.length-2)+' more'};
function renderRx(seq,list){const row=document.querySelector('[data-rx="'+seq+'"]');if(!row){RXP[seq]=list;return}delete RXP[seq];const add=row.querySelector('.rx-add');
  row.querySelectorAll('.rx-chip,.rx-rcpt').forEach(c=>c.remove());
  const byPerson=!row.closest('.entry')?.classList.contains('by-agent');const seen=[],done=[],think=[],chips=[];
  for(const r of list||[]){const rc=byPerson&&(r.emoji==='👀'||r.emoji==='✅'||r.emoji==='🤔')?r.users.filter(rxAgent):[];
    (r.emoji==='✅'?done:r.emoji==='🤔'?think:seen).push(...rc);const rest=r.users.filter(u=>!rc.includes(u));if(rest.length)chips.push({emoji:r.emoji,users:rest})}
  // An agent that's done isn't "reading" any more. On your own messages the ring already says who read it, so 👀 adds nothing there.
  const mine=row.closest('.entry')?.dataset.author===ME,work=think.filter(u=>!done.includes(u)),read=mine?[]:seen.filter(u=>!done.includes(u)&&!work.includes(u));
  // On a decision, 👍 means agree and is tallied as such (vedu #1030): "👍 2 agree".
  const decision=!!row.closest('.entry')?.querySelector(':scope>.grow>.meta .t-decision');
  for(const r of chips){const b=document.createElement('button');b.type='button';b.className='rx-chip'+(r.users.includes(ME)?' on':'');b.dataset.react=r.emoji;b.dataset.seq=seq;const agree=decision&&r.emoji==='👍';
    b.title=(agree?'Agree: ':'')+r.users.map(rxWho).join(', ');b.setAttribute('aria-label',(agree?r.users.length+' agree':emo(r.emoji)+' '+r.users.length)+': '+r.users.map(rxWho).join(', ')+(r.users.includes(ME)?'. Click to remove yours':agree?'. Click to agree':'. Click to add yours'));
    b.innerHTML='<span class="e">'+esc(emo(r.emoji))+'</span><span class="c">'+r.users.length+(agree?' agree':'')+'</span>';row.insertBefore(b,add)}
  if(read.length||done.length||work.length){const d=document.createElement('div');d.className='rx-rcpt';
    const part=(k,e,us,text)=>'<span class="'+k+'" title="'+esc(us.map(rxWho).join(', '))+'"><span class="e">'+e+'</span> '+esc(text)+'</span>';
    d.innerHTML=(done.length?part('done','✅',done,'done by '+rxNames(done)):'')+(read.length?part('read','👀',read,'read by '+rxNames(read)):'')+
      (work.length?part('think','🤔',work,rxNames(work)+(work.length>1?' are':' is')+' on it'):'');row.appendChild(d)}
  row.classList.toggle('has',chips.length>0);row.classList.toggle('has-rcpt',!!(read.length||done.length||work.length))}
async function react(seq,emoji){const r=await fetch('/api/boards/'+BOARD+'/entries/'+seq+'/react',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({emoji})});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||"Couldn't react");return}renderRx(seq,j.reactions)}
const picker=document.createElement('div');picker.className='rx-pick';picker.hidden=true;picker.setAttribute('role','menu');
picker.innerHTML=QUICK.map(q=>'<button type="button" role="menuitem" data-pick="'+q+'" aria-label="React '+q+'">'+q+'</button>').join('');document.body.appendChild(picker);
function closePicker(){picker.hidden=true;picker.dataset.seq=''}
document.addEventListener('click',e=>{
  const chip=e.target.closest('.rx-chip');if(chip){react(+chip.dataset.seq,chip.dataset.react);return}
  const add=e.target.closest('[data-rx-add]');if(add){const r=add.getBoundingClientRect();picker.dataset.seq=add.dataset.rxAdd;picker.hidden=false;
    picker.style.left=Math.max(8,Math.min(innerWidth-picker.offsetWidth-8,r.left))+'px';picker.style.top=(r.top-picker.offsetHeight-6<8?r.bottom+6:r.top-picker.offsetHeight-6)+'px';return}
  const pk=e.target.closest('[data-pick]');if(pk&&picker.dataset.seq){react(+picker.dataset.seq,pk.dataset.pick);closePicker();return}
  if(!picker.hidden&&!e.target.closest('.rx-pick'))closePicker()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!picker.hidden)closePicker()});
scroller.addEventListener('scroll',()=>{if(!picker.hidden)closePicker()},{passive:true});
// quick reactions from the hover actions; and who reacted, in a small card over a chip
document.addEventListener('click',e=>{const q=e.target.closest('[data-qr]');if(q){react(+q.dataset.qr,q.dataset.emo);q.blur()}});
const rxTip=document.createElement('div');rxTip.className='rx-tip';rxTip.hidden=true;rxTip.setAttribute('role','tooltip');document.body.appendChild(rxTip);
document.addEventListener('mouseover',e=>{const c=e.target.closest('.rx-chip');if(!c){rxTip.hidden=true;return}
  const names=c.title.split(', ').filter(Boolean),emoji=c.querySelector('.e')?.textContent||'';
  rxTip.innerHTML='<span class="big">'+esc(emoji)+'</span><span><b>'+names.map(esc).join(', ')+'</b><span class="faint"> reacted with '+esc(emoji)+'</span></span>';
  rxTip.hidden=false;const r=c.getBoundingClientRect();rxTip.style.left=Math.max(8,Math.min(innerWidth-rxTip.offsetWidth-8,r.left+r.width/2-rxTip.offsetWidth/2))+'px';rxTip.style.top=(r.top-rxTip.offsetHeight-8)+'px'});
fetch('/api/boards/'+BOARD+'/reactions').then(r=>r.json()).then(j=>{for(const [seq,list] of Object.entries(j.reactions||{}))renderRx(+seq,list)}).catch(()=>{});
// ---- tasks in the conversation: each task's card shows the task as it is now (its checklist as boxes people can tick,
// n/m done, its sub-tasks), with a live strip under it (status, priority, who it's for, who holds it) ----
const TSTATUS={todo:'To do',doing:'In progress',blocked:'Blocked',done:'Done',stopped:'Stopped'};
const whoName=(u,agent)=>u===ME?(agent?'your agent':'you'):(agent?u+"'s agent":u);
const TASKS={};
const CK_RE=/^\\s*(?:[-*]|\\d+[.)])\\s+\\[( |x|X)\\]\\s+.+$/;
/** A task's checklist lines (and where each starts), numbered the way the page numbers its boxes: code blocks don't count. */
function ckLines(text){const out=[],re=/\\x60\\x60\\x60[^\\n]*\\n?[\\s\\S]*?\\x60\\x60\\x60/g;let at=0,m;
  const scan=(a,b)=>{let p=a;for(const l of text.slice(a,b).split('\\n')){if(CK_RE.test(l))out.push({line:l,at:p,done:!/\\[ \\]/.test(l.slice(0,l.indexOf(']')+1))});p+=l.length+1}};
  while((m=re.exec(text))){scan(at,m.index);at=m.index+m[0].length}scan(at,text.length);return out}
const taskText=t=>t.body?t.title+'\\n\\n'+t.body:t.title;
const bar=(n,m,what)=>'<span class="tk-prog" title="'+n+' of '+m+' '+what+'"><span class="tk-bar"><i style="width:'+Math.round(100*n/m)+'%"></i></span>'+n+'/'+m+'</span>';
// Edited tasks get their current text when they scroll into view (one fetch each, not one per task on the board).
const tkIO='IntersectionObserver' in window?new IntersectionObserver(es=>es.forEach(x=>{if(x.isIntersecting){tkIO.unobserve(x.target);refreshTask(+x.target.dataset.seq)}}),{rootMargin:'600px 0px'}):null;
function renderTask(t){const old=TASKS[t.seq];if(!t.html&&old&&old.html&&old.version===t.version)t={...t,html:old.html};TASKS[t.seq]=t;
  if(t.parent!=null)renderSubs(t.parent);if(old&&old.parent!=null&&old.parent!==t.parent)renderSubs(old.parent);
  const el=document.querySelector('[data-task="'+t.seq+'"]');if(!el)return;
  const art=el.closest('.entry'),body=art.querySelector(':scope>.grow>.body');
  if(body&&(t.version>1||body.dataset.v)&&body.dataset.v!==String(t.version)){if(t.html){body.innerHTML=t.html;body.dataset.v=t.version}else if(tkIO)tkIO.observe(art)}
  if(body)body.querySelectorAll('li.ck>input').forEach(i=>{i.disabled=READONLY||art.classList.contains('retracted');i.title=i.disabled?'':i.checked?'Untick':'Tick'});
  const cks=ckLines(taskText(t)),ticked=cks.filter(c=>c.done).length;
  const left=t.lease_until?Math.max(0,Math.round((t.lease_until-Date.now())/60000)):null;
  const bits=[t.assignee?'for '+esc(whoName(t.assignee,t.assignee_agent)):'',t.lease_holder?'🔒 '+esc(whoName(t.lease_holder,t.lease_agent))+(left!=null?' · '+left+'m left':''):'',t.stop_reason?esc(t.stop_reason):'',t.done_note?'✓ '+esc(t.done_note):''].filter(Boolean);
  el.innerHTML='<span class="tk-st st-'+t.status+'"><span class="dot"></span>'+TSTATUS[t.status]+'</span>'+(t.priority?'<span class="badge pri-'+t.priority+'">'+t.priority+'</span>':'')+
    (cks.length?bar(ticked,cks.length,'ticked'):t.children?bar(t.children.done,t.children.total,'sub-tasks done'):'')+
    '<span class="tk-who">'+bits.join(' · ')+'</span><span class="grow"></span>'+
    (READONLY?'':(t.status==='done'?'<button class="btn ghost sm" type="button" data-tk="reopen">Reopen</button>':
      '<button class="btn ghost sm" type="button" data-tk="done">Done</button>'))+
    '<button class="btn ghost sm" type="button" data-tk="open">Open</button>';
  el.hidden=false;renderSubs(t.seq)}
/** A task's sub-tasks, listed on its card with their state (they keep their own cards where they were posted). */
function renderSubs(seq){const el=document.querySelector('[data-task="'+seq+'"]');if(!el)return;let box=el.parentNode.querySelector(':scope>.tk-subs');
  const kids=Object.values(TASKS).filter(k=>k.parent===seq).sort((a,b)=>a.seq-b.seq);if(!kids.length){box?.remove();return}
  if(!box){box=document.createElement('ul');box.className='tk-subs';el.before(box)}box.setAttribute('aria-label','Sub-tasks');
  box.innerHTML=kids.map(k=>'<li class="st-'+k.status+'"><span class="tk-st st-'+k.status+'" title="'+TSTATUS[k.status]+'"><span class="dot"></span></span><a class="grow truncate" href="#e'+k.seq+'">'+esc(k.title||'Sub-task')+'</a><span class="xs faint">'+TSTATUS[k.status]+'</span></li>').join('')}
async function refreshTask(seq){try{const r=await fetch('/api/boards/'+BOARD+'/tasks/'+seq);const j=await r.json();if(r.ok&&j.task)renderTask(j.task)}catch(e){}}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-tk]');if(!b)return;const seq=+b.closest('[data-task]').dataset.task,a=b.dataset.tk;
  if(a==='open'){openTask(seq);return}b.disabled=true;
  await taskAct(seq,{action:'update',status:a==='done'?'done':'todo'});b.disabled=false;refreshTask(seq)});
// Ticking a box is a normal, versioned edit of that one line (so an agent ticking another line at the same time is fine).
document.addEventListener('change',async e=>{const i=e.target;if(!i.matches||!i.matches('.body li.ck>input'))return;const art=i.closest('.entry'),hold=art?.querySelector(':scope>.grow>[data-task]');
  if(!hold||READONLY||i.closest('.body')!==art.querySelector(':scope>.grow>.body'))return;const seq=+hold.dataset.task,t=TASKS[seq],li=i.closest('li'),on=i.checked;
  const text=t&&taskText(t),c=t&&ckLines(text)[+li.dataset.ck],undo=m=>{i.checked=!on;li.classList.toggle('done',!on);if(m)toast(m)};
  if(!c||c.at<text.length-t.body.length)return undo('That box has changed. Try again.');
  const nl=c.line.replace(/\\[( |x|X)\\]/,on?'[x]':'[ ]'),what=c.line.replace(/^[^\\]]*\\]\\s*/,'').slice(0,80),summary=(on?'ticked: ':'unticked: ')+what;li.classList.toggle('done',on);i.disabled=true;
  const save=b=>fetch('/api/boards/'+BOARD+'/tasks/'+seq,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'edit',summary,...b})}).then(async r=>({ok:r.ok,j:await r.json().catch(()=>({}))}));
  let r=await save({old_str:c.line,new_str:nl});
  if(!r.ok&&/more than once/.test(r.j.error||'')){const p=c.at-(text.length-t.body.length);r=await save({body:t.body.slice(0,p)+nl+t.body.slice(p+c.line.length),base_version:t.version})}
  if(!r.ok)undo(r.j.error||"Couldn't save");i.disabled=false;refreshTask(seq)});
fetch('/api/boards/'+BOARD+'/tasks').then(r=>r.json()).then(j=>{const ts=j.tasks||[];ts.forEach(t=>TASKS[t.seq]=t);ts.forEach(renderTask)}).catch(()=>{});
// ---- "on it" / "done": which agent took a message, and who finished it. The person whose agent it is can mark it
// done or clear it (✓ / ×); a cleared marker disappears on the next update (the map always has all of them). ----
function renderHandling(map){const seen=new Set();
  for(const [seq,h] of Object.entries(map)){const m=document.querySelector('#e'+seq+'>.grow>.meta');if(!m)continue;seen.add(seq);
    let b=m.querySelector('.hdl');if(!b){b=document.createElement('span');b.className='badge hdl';m.insertBefore(b,m.querySelector('.acts'))}
    const mine=h.user===ME&&!READONLY;b.classList.toggle('done',h.done);b.dataset.seq=seq;
    b.title=h.done?'Done by '+h.by:h.by+' is handling this';
    b.innerHTML=(h.done?'✓ done by '+esc(h.by):esc(h.by)+' is on it')+(mine?(h.done?'':'<button type="button" data-hdl="done" title="Mark it done" aria-label="Mark it done">✓</button>')+'<button type="button" data-hdl="release" title="'+(h.done?'Clear done':'Drop the marker')+'" aria-label="'+(h.done?'Clear done':'Drop the marker')+'">×</button>':'')}
  document.querySelectorAll('.badge.hdl').forEach(b=>{if(!seen.has(b.dataset.seq))b.remove()})}
document.addEventListener('click',async e=>{const x=e.target.closest('[data-hdl]');if(!x)return;const seq=x.closest('.hdl').dataset.seq;x.disabled=true;
  const r=await fetch('/api/boards/'+BOARD+'/handle/'+seq,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:x.dataset.hdl})});
  const j=await r.json().catch(()=>({}));toast(r.ok?j.message:(j.message||j.error||'Could not change it'));tick(false)});
// ---- claims in the conversation: unverified → evidence → verified by someone else, or disputed; posts resting on a bad premise show "Stale" ----
// Status comes with every update (d.claims: seq → {status, by, reason, stale_from, stale_why}).
const CLST={evidenced:'Has evidence',verified:'Verified',disputed:'Disputed'};let CLAIMS={};
function renderClaims(map){CLAIMS=map||{};
  document.querySelectorAll('.badge.stale').forEach(b=>b.remove());
  for(const [seq,c] of Object.entries(CLAIMS)){
    if(c.stale_from){const m=document.querySelector('#e'+seq+'>.grow>.meta');if(m){const b=document.createElement('span');b.className='badge stale';
      b.title='Rests on #'+c.stale_from+', which was '+c.stale_why;b.textContent='Stale';m.insertBefore(b,m.querySelector('.acts'))}}
    const el=document.querySelector('[data-claim="'+seq+'"]');if(!el||!c.status||el.querySelector('.cl-f:not([hidden])'))continue;
    const own=el.closest('.entry').dataset.author===ME;
    // A claim nobody has looked at yet carries no status pill, just its actions.
    el.innerHTML=(c.status==='asserted'?'':'<span class="tk-st cl-'+c.status+'"><span class="dot"></span>'+CLST[c.status]+(c.by?' by '+esc(c.by):'')+'</span>')+
      (c.reason?'<span class="tk-who truncate" title="'+esc(c.reason)+'">'+esc(c.reason)+'</span>':'')+
      // The claim's check: the command that shows it holds. Others click it to copy the sandboxed run for their terminal.
      (c.check&&c.status!=='verified'?'<button class="cl-cmd mono" type="button"'+(own?' disabled title="Others run this in a sandbox: atteo verify '+seq+'"':' data-cl-run="'+seq+'" title="Copy atteo verify '+seq+' (runs it sandboxed on your machine)"')+'><span aria-hidden="true">$</span> <span class="truncate">'+esc(c.check)+'</span></button>':'')+'<span class="grow"></span>'+
      (READONLY?'':(own||c.status==='verified'?'':'<button class="btn ghost sm" type="button" data-cl="verify">Verify</button>')+
        (own||c.status==='disputed'?'':'<button class="btn ghost sm" type="button" data-cl="dispute">Dispute</button>')+
        '<button class="btn ghost sm" type="button" data-cl="evidence">Evidence</button>')+
      '<form class="cl-f" hidden><input class="input" name="v" maxlength="300" required><button class="btn sm primary"></button><button class="btn sm ghost" type="button" data-cl-cancel>Cancel</button></form>';
    el.hidden=false}}
async function claimAct(seq,body){const r=await fetch('/api/boards/'+BOARD+'/claims/'+seq,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));toast(r.ok?j.message:(j.error||'Could not save'));tick(false);return r.ok}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-cl]');if(!b)return;const strip=b.closest('[data-claim]'),seq=+strip.dataset.claim,a=b.dataset.cl;
  if(a==='verify'){b.disabled=true;await claimAct(seq,{action:'verify'});return}
  const f=strip.querySelector('.cl-f');f.dataset.mode=a;f.v.value='';f.v.placeholder=a==='dispute'?"What's wrong with it?":'A link, or #entry (a log or file posted here)';
  f.querySelector('.primary').textContent=a==='dispute'?'Dispute':'Add evidence';f.hidden=false;f.v.focus()});
document.addEventListener('click',e=>{const r=e.target.closest('[data-cl-run]');if(r)navigator.clipboard.writeText('atteo verify '+r.dataset.clRun).then(()=>toast('Copied: atteo verify '+r.dataset.clRun+'. Run it in your terminal'))});
document.addEventListener('click',e=>{const c=e.target.closest('[data-cl-cancel]');if(c){c.closest('.cl-f').hidden=true;renderClaims(CLAIMS)}});
document.addEventListener('submit',async e=>{const f=e.target.closest('.cl-f');if(!f)return;e.preventDefault();const seq=+f.closest('[data-claim]').dataset.claim,v=f.v.value.trim();
  let body;if(f.dataset.mode==='dispute')body={action:'dispute',reason:v};else{const n=v.match(/^#?([0-9]+)$/);body=n?{action:'evidence',evidence_seq:+n[1]}:{action:'evidence',url:v}}
  if(await claimAct(seq,body))f.hidden=true});
// ---- human decisions: a decision a person posts is the people's to make. Everyone else on the board agrees or objects (an
// optional note on Object); it's decided when they all agree, or when its author closes it (decided or dropped). Agents only
// comment. State comes with every update (d.decisions: seq → {state, author, votes, voters, waiting_on, closed_by, note}) and live.
let HDS={};
function renderHDs(map){HDS=Object.assign({},map||{});for(const seq of Object.keys(HDS))renderHD(+seq)}
function renderHD(seq){const hd=HDS[seq],el=document.querySelector('[data-hd="'+seq+'"]');if(!hd||!el||el.querySelector('.hd-f:not([hidden])'))return;
  const author=hd.author===ME,voter=hd.voters.includes(ME),mine=hd.votes.find(v=>v.user===ME),open=hd.state==='open',by=Object.fromEntries(hd.votes.map(v=>[v.user,v]));
  const pill=open?'Human decision · '+(hd.waiting_on.length?'waiting on '+hd.waiting_on.map(u=>u===ME?'you':u).join(', '):'waiting on '+(author?'you':hd.author)+' to close it')
    :hd.state==='decided'?'Decided'+(hd.closed_by?' by '+(hd.closed_by===ME?'you':hd.closed_by):' by the people'):'Dropped';
  const marks=hd.voters.map(u=>{const v=by[u],k=v?(v.vote==='agree'?'y':'n'):'w';
    return '<span class="hd-m '+k+'" title="'+esc(u+(k==='y'?' agreed':k==='n'?' objected'+(v.note?': '+v.note:''):' hasn\u2019t voted'))+'">'+avatar16(u,false)+(k==='w'?'':'<i aria-hidden="true">'+(k==='y'?'✓':'✕')+'</i>')+'</span>'}).join('');
  const notes=hd.votes.filter(v=>v.vote==='object'&&v.note).map(v=>'<div class="hd-note" title="'+esc(v.note)+'"><b>'+esc(v.user)+'</b> objects: '+esc(v.note)+'</div>').join('')+
    (hd.note?'<div class="hd-note" title="'+esc(hd.note)+'"><b>'+esc(hd.closed_by||hd.author)+'</b>: '+esc(hd.note)+'</div>':'');
  // Votes stay open until its author closes it (an objection reopens one everyone had agreed to).
  // Once everyone agreed, only Object is left (it reopens it).
  const acts=READONLY?'':(voter&&!hd.closed_by?(open?'<button class="btn ghost sm hd-b'+(mine?.vote==='agree'?' on-y':'')+'" type="button" data-hdv="agree" aria-pressed="'+(mine?.vote==='agree')+'">Agree</button>':'')+
      '<button class="btn ghost sm hd-b'+(mine?.vote==='object'?' on-n':'')+'" type="button" data-hdv="object" aria-pressed="'+(mine?.vote==='object')+'">Object</button>':'')+
    (author&&!hd.closed_by?'<button class="btn ghost sm" type="button" data-hdc>Close</button>':'');
  el.className='tk hd hd-'+hd.state;
  el.innerHTML='<span class="tk-st"><span class="dot"></span>'+esc(pill)+'</span>'+(marks?'<span class="hd-ms">'+marks+'</span>':'')+'<span class="grow"></span>'+acts+notes+
    '<form class="cl-f hd-f" hidden><input class="input" name="v" maxlength="280"><span class="hd-out"><button class="btn sm primary" data-o="decided">Decided</button><button class="btn sm" data-o="dropped">Dropped</button></span>'+
    '<button class="btn sm primary hd-ob" data-o="object">Object</button><button class="btn sm ghost" type="button" data-hd-cancel>Cancel</button></form>';
  el.hidden=false}
async function hdAct(seq,what,body){const r=await fetch('/api/boards/'+BOARD+'/entries/'+seq+'/'+what,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not save');return false}HDS[seq]=j.human_decision;return true}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-hdv],[data-hdc],[data-hd-cancel]');if(!b)return;const el=b.closest('[data-hd]'),seq=+el.dataset.hd,f=el.querySelector('.hd-f');
  if(b.hasAttribute('data-hd-cancel')){f.hidden=true;renderHD(seq);return}
  if(b.dataset.hdv==='agree'){b.disabled=true;await hdAct(seq,'vote',{vote:'agree'});renderHD(seq);return}
  const close=b.hasAttribute('data-hdc');f.dataset.mode=close?'close':'object';f.v.value='';f.v.placeholder=close?'A note for everyone (optional)':'Why? (optional)';
  f.querySelector('.hd-out').hidden=!close;f.querySelector('.hd-ob').hidden=close;f.hidden=false;f.v.focus()});
document.addEventListener('submit',async e=>{const f=e.target.closest('.hd-f');if(!f)return;e.preventDefault();const seq=+f.closest('[data-hd]').dataset.hd,note=f.v.value.trim();
  const o=e.submitter?.dataset.o||(f.dataset.mode==='close'?'decided':'object');f.querySelectorAll('button').forEach(x=>x.disabled=true);
  const ok=f.dataset.mode==='close'?await hdAct(seq,'close',{outcome:o,note}):await hdAct(seq,'vote',{vote:'object',note});
  f.querySelectorAll('button').forEach(x=>x.disabled=false);if(ok){f.hidden=true;renderHD(seq)}});
// ---- multi-select and forward (people only): pick messages here, send them quoted to another board you're on ----
let SEL=null,fwdTo=null,fwdBoards=null;const selBar=document.getElementById('sel-bar');
function selUpdate(){selBar.hidden=!SEL;if(!SEL)return;document.getElementById('sel-n').textContent=SEL.size+' selected';document.getElementById('sel-fwd').disabled=!SEL.size}
function selToggle(seq){const el=document.getElementById('e'+seq);if(!el||!SEL)return;if(SEL.has(seq)){SEL.delete(seq);el.classList.remove('picked')}else{SEL.add(seq);el.classList.add('picked')}selUpdate()}
function selStart(seq){SEL=new Set();document.documentElement.classList.add('selecting');selToggle(seq)}
function selEnd(){SEL=null;document.documentElement.classList.remove('selecting');document.querySelectorAll('.entry.picked').forEach(x=>x.classList.remove('picked'));selUpdate()}
document.addEventListener('click',e=>{const s=e.target.closest('[data-select]');
  if(s){e.preventDefault();e.stopPropagation();if(SEL)selToggle(+s.dataset.select);else selStart(+s.dataset.select);return}
  if(!SEL)return;const en=e.target.closest('#thread .entry');if(!en||e.target.closest('a,button,input,textarea,select,video,audio,#sel-bar'))return;
  e.preventDefault();e.stopPropagation();selToggle(+en.dataset.seq)},true);
document.getElementById('sel-cancel').addEventListener('click',selEnd);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&SEL&&!document.querySelector('dialog[open]'))selEnd()});
const fwdDlg=document.getElementById('fwd-dlg'),fwdList=document.getElementById('fwd-list'),fwdQ=document.getElementById('fwd-q');
const peerOf=t=>{const p=t.split(' ↔ ');return p.length===2?(p[0]===ME?p[1]:p[0]):null};
function fwdRender(){const q=fwdQ.value.trim().toLowerCase();const list=(fwdBoards||[]).filter(b=>!q||b.title.toLowerCase().includes(q));
  fwdList.innerHTML=list.length?list.map(b=>{const peer=peerOf(b.title);return '<li role="option" data-to="'+esc(b.id)+'" aria-selected="'+(fwdTo===b.id)+'">'+(peer?avatar16(peer,false)+'<span class="truncate">'+esc(peer)+'</span><span class="xs faint">direct</span>':(b.picture?'<span class="bpic sm"><img class="ok" src="'+esc(b.picture)+'" alt=""></span>':'<span class="fwd-dot"></span>')+'<span class="truncate">'+esc(b.title)+'</span>')+'</li>'}).join(''):'<li class="xs faint">No other boards'+(q?' match':'')+'.</li>';
  document.getElementById('fwd-send').disabled=!fwdTo}
fwdList.addEventListener('click',e=>{const li=e.target.closest('[data-to]');if(!li)return;fwdTo=li.dataset.to;fwdRender()});
fwdQ.addEventListener('input',fwdRender);
document.getElementById('sel-fwd').addEventListener('click',async()=>{if(!SEL||!SEL.size)return;fwdTo=null;fwdQ.value='';document.getElementById('fwd-note').value='';
  const seqs=[...SEL].sort((a,b)=>a-b);document.getElementById('fwd-n').textContent=seqs.length+' message'+(seqs.length===1?'':'s');
  // The preview is what will be quoted: who said it, then its first lines.
  document.getElementById('fwd-prev').innerHTML=seqs.map(n=>{const el=document.getElementById('e'+n);const w=el?.querySelector(':scope>.grow>.meta .who')?.textContent||el?.dataset.author||'';
    return '<div class="fwd-q"><b>'+esc(w)+'</b> <span class="faint">#'+n+'</span><div class="truncate">'+esc((el?.querySelector(':scope>.grow>.body')?.textContent||'').trim().slice(0,240))+'</div></div>'}).join('');
  fwdDlg.showModal();fwdQ.focus();
  if(!fwdBoards){fwdList.innerHTML='<li class="xs faint">Loading…</li>';const j=await fetch('/api/me/boards').then(r=>r.json()).catch(()=>({}));fwdBoards=(j.boards||[]).filter(b=>b.id!==BOARD&&!b.encrypted)}
  fwdRender()});
document.getElementById('fwd-send').addEventListener('click',async e=>{const b=e.currentTarget;if(!fwdTo||!SEL)return;b.disabled=true;
  const r=await fetch('/api/forward',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:BOARD,to:fwdTo,seqs:[...SEL],note:document.getElementById('fwd-note').value})});
  const j=await r.json().catch(()=>({}));b.disabled=false;if(!r.ok){toast(j.error||'Could not forward');return}
  fwdDlg.close();selEnd();toast('Forwarded '+j.forwarded+' to '+(peerOf(j.board.title)||j.board.title))});
// ---- search: the palette (⌘K) knows this board; ⌘F opens it already filtered to this board's messages ----
window.BOARD_CTX={id:BOARD,me:ME,members:MEMBERS,
  async jump(seq){if(!(await ensureEntry(seq))){toast('#'+seq+' was not found');return}const el=document.getElementById('e'+seq);
    if(document.getElementById('panel-conv').hidden)tab(0);if(el.closest('.replies')){openThread(+el.closest('#thread>.entry').dataset.seq,{focus:seq});return}
    document.querySelectorAll('#thread .entry.hit').forEach(x=>x.classList.remove('hit'));el.classList.add('hit');pinned=false;el.scrollIntoView({block:'center'});moved=true;setTimeout(()=>el.classList.remove('hit'),4000)},
  openFile(name,v){tab(2);openDoc(name,v)}};
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='f'&&!document.querySelector('dialog[open]:not(#palette)')){e.preventDefault();window.openPalette([{k:'board'},{k:'kind',v:'messages'}])}},true);
// ---- threads: replies fold into "N replies" under their message; clicking it opens the thread right there, in the chat ----
const avatar16=(u,agent)=>'<span class="av sm'+(agent?' agent':'')+'" style="--h:'+(MOPTS.find(o=>o.u===u)?.av.match(/--h:([0-9]+)/)?.[1]||220)+'">'+esc(u.slice(0,2).toUpperCase())+'<img class="av-img" src="/avatar/'+encodeURIComponent(u)+(agent?'?k=agent':'')+'" alt="" loading="lazy" onerror="this.remove()" onload="this.classList.add(&quot;ok&quot;)"></span>';
// Replies post in the conversation like any message (jxn #1040). Each carries a bar quoting the message it answers;
// tapping it, or a thread's "N replies", opens the thread as an overlay with its own reply box.
function quotify(el){const r=el.dataset.reply;if(!r||el.querySelector(':scope>.grow>.rq'))return;const p=document.getElementById('e'+r);
  const b=document.createElement('button');b.type='button';b.className='rq';b.dataset.thread=el.dataset.root||r;b.dataset.focus=el.dataset.seq;
  const who=p?headName(p):'#'+r,line=p?((p.querySelector(':scope>.grow>.body')?.textContent||p.dataset.title||'').trim().split('\\n')[0].slice(0,140)):'an earlier message';
  b.innerHTML='<span class="rq-who">'+esc(who)+'</span><span class="rq-t">'+esc(line)+'</span>';b.setAttribute('aria-label','Reply to '+who+': '+line+'. Open the thread');
  el.querySelector(':scope>.grow>.meta').after(b);const refs=el.querySelector(':scope>.grow>.refs');if(refs&&/^reply to\\s/.test(refs.textContent.trim())&&refs.querySelectorAll('a').length===1)refs.hidden=true}
function kidsOf(root){return [...document.querySelectorAll('#thread>.entry[data-root="'+root+'"]')]}
function thrSum(root){const top=document.getElementById('e'+root);if(!top)return;const kids=kidsOf(root);
  let b=top.querySelector(':scope>.grow>.thr-sum');if(!kids.length){b?.remove();return}
  if(!b){b=document.createElement('button');b.type='button';b.className='thr-sum';b.dataset.thread=root;(top.querySelector(':scope>.grow>.replies')||top.querySelector(':scope>.grow>.rx')).before(b)}
  const who=[];for(const k of kids){const key=k.dataset.author+(k.classList.contains('by-agent')?'/a':'');if(!who.includes(key))who.push(key)}
  const lastT=kids[kids.length-1]?.querySelector('time[data-ts]');
  b.innerHTML='<span class="thr-head"><span class="avs">'+who.slice(0,3).map(w=>avatar16(w.split('/')[0],w.endsWith('/a'))).join('')+'</span><b>'+kids.length+' repl'+(kids.length===1?'y':'ies')+'</b><span class="faint">'+(lastT?'last '+lastT.textContent:'')+'</span></span>';
  b.setAttribute('aria-label','Open the thread: '+kids.length+' repl'+(kids.length===1?'y':'ies'))}
var thrOpen=0;const thrDlg=document.createElement('dialog');thrDlg.className='thr-dlg';thrDlg.setAttribute('aria-label','Thread');
thrDlg.innerHTML='<div class="thr-hd"><b>Thread</b><button type="button" class="btn ghost sm" data-thr-close aria-label="Close the thread">✕</button></div><div class="thr-list" id="thr-list"></div>';
// The thread's reply box is the conversation's own composer (jxn #1094), moved in while the thread is open: the same @ menu,
// attachments, / commands, mic, drafts and encryption, replying to the thread's first message. Closing puts it back.
const cmpForm=document.querySelector('form.composer');var cmpHome=null;
function cmpIn(root){if(!cmpForm||READONLY||cmpForm.hidden)return;if(!cmpHome){cmpHome={p:cmpForm.parentNode,n:cmpForm.nextSibling};thrDlg.appendChild(cmpForm);cmpForm.classList.add('in-thr')}replyTo(root,false)}
function cmpBack(){if(!cmpHome)return;const h=cmpHome;cmpHome=null;h.p.insertBefore(cmpForm,h.n);cmpForm.classList.remove('in-thr');replyClear(false)}
/** After a reply is sent from the thread, the box stays pointed at it. */
window.thrRearm=()=>{if(!cmpHome||!thrOpen)return false;rpTo.value=String(thrOpen);rpAt='';return true};
document.body.appendChild(thrDlg);
function thrRender(focus){const list=document.getElementById('thr-list'),top=document.getElementById('e'+thrOpen);if(!top)return;list.innerHTML='';
  for(const src of [top,...kidsOf(thrOpen)]){const c=src.cloneNode(true);c.removeAttribute('id');c.classList.remove('flash-in','tap','sel','hit');c.dataset.src=src.dataset.seq;
    c.querySelectorAll('[id]').forEach(x=>x.removeAttribute('id'));c.querySelectorAll('.thr-sum,.acts,.more-acts,.rd,.rx-add').forEach(x=>x.remove());
    const q=c.querySelector(':scope>.grow>.rq');if(q&&q.dataset.thread===String(thrOpen)&&src.dataset.reply===String(thrOpen))q.remove();
    list.appendChild(c)}
  const f=focus&&list.querySelector('[data-src="'+focus+'"]');(f||list.lastElementChild)?.scrollIntoView({block:f?'center':'end'});if(f)f.classList.add('hit')}
function openThread(root,o={}){const top=document.getElementById('e'+root);if(!top)return;thrOpen=root;thrRender(o.focus);if(!thrDlg.open)thrDlg.showModal();
  cmpIn(root);if(cmpHome&&!o.focus&&matchMedia('(hover:hover)').matches){ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}}
function closeThread(){if(thrDlg.open)thrDlg.close();else{thrOpen=0;cmpBack()}}
thrDlg.addEventListener('close',()=>{thrOpen=0;cmpBack()});
thrDlg.addEventListener('click',e=>{if(e.target===thrDlg||e.target.closest('[data-thr-close]'))closeThread();const s=e.target.closest('.thr-list [data-src]');
  if(s&&e.target.closest('a.seq,.rq')){e.preventDefault();const n=s.dataset.src;closeThread();const el=document.getElementById('e'+n);if(el){pinned=false;el.scrollIntoView({block:'center'});el.classList.add('hit');setTimeout(()=>el.classList.remove('hit'),4000)}}});
document.addEventListener('click',e=>{const s=e.target.closest('#thread [data-thread]');if(!s)return;e.preventDefault();openThread(+s.dataset.thread,{focus:+(s.dataset.focus||0)||undefined})});
document.querySelectorAll('#thread>.entry[data-reply]').forEach(quotify);
document.querySelectorAll('#thread>.entry:not([data-root])').forEach(x=>thrSum(+x.dataset.seq));
// ---- hover cards: who someone is, whether they or their agent are around, and what you can do (people and agents) ----
// Hover (desktop) previews; a click or tap pins the same card (under the element, or a bottom sheet on narrow screens).
const hcard=document.createElement('div');hcard.className='hcard';hcard.hidden=true;hcard.setAttribute('role','dialog');hcard.setAttribute('aria-label','Profile');document.body.appendChild(hcard);
const hback=document.createElement('div');hback.className='hc-back';hback.hidden=true;document.body.appendChild(hback);
const pcache={},acache={};let hTimer=null,hFor=null,hPinned=false,hKey=false;
const pfetch=u=>pcache[u]||(pcache[u]=fetch('/api/people/'+encodeURIComponent(u)).then(r=>r.ok?r.json():null).catch(()=>null));
const afetch=u=>acache[u]||(acache[u]=fetch('/api/agents/'+encodeURIComponent(u)).then(r=>r.ok?r.json():null).catch(()=>null));
const hNarrow=matchMedia('(max-width:860px)'),hCanHover=matchMedia('(hover:hover)');
function hClose(back){hcard.hidden=true;hback.hidden=true;const f=hFor;hFor=null;hPinned=false;if(back&&f&&f.isConnected)try{f.focus({preventScroll:true})}catch(e){}}
function hTarget(el){const m=el.closest('.mention[data-user]');if(m){const u=m.dataset.user;if(u==='agents'||u==='humans')return {u,group:true,agent:u==='agents',el:m};return {u,agent:m.classList.contains('agent'),el:m}}
  const e=el.closest('.entry');const w=el.closest('.entry>.av, .entry>.grow>.meta>.who');if(e&&w)return {u:e.dataset.author,agent:e.classList.contains('by-agent'),el:w};
  const s=el.closest('.av-wrap');if(s){const n=s.parentElement.querySelector('.grow');return n?{u:n.textContent.trim().split(/ /)[0],agent:false,el:s}:null}return null}
// Mentions, avatars and author names are keyboard-reachable buttons (including the ones that arrive later with live updates).
function hEnhance(){document.querySelectorAll('.mention[data-user]:not([data-hc]),.entry>.av:not([data-hc]),.entry>.grow>.meta>.who:not([data-hc])').forEach(el=>{
  const t=hTarget(el);el.dataset.hc='1';if(!t)return;el.tabIndex=0;el.setAttribute('role','button');el.setAttribute('aria-label',t.group?'Show the '+(t.agent?'agents':'people')+' on this board':'Open '+t.u+(t.agent?"'s agent":'')+(t.agent?' profile':"'s profile"));el.setAttribute('aria-haspopup','dialog')})}
let hEnq=false;new MutationObserver(()=>{if(hEnq)return;hEnq=true;requestAnimationFrame(()=>{hEnq=false;hEnhance()})}).observe(document.body,{childList:true,subtree:true});hEnhance();
// @agents / @humans: who that is on this board right now (agents working first, then idle; people with their presence).
async function hGroup(t,pin){hFor=t.el;hPinned=!!pin;let body;
  if(t.agent){const r=await fetch('/api/boards/'+BOARD+'/agents').catch(()=>null);const ag=r&&r.ok?((await r.json()).agents||[]):[];if(hFor!==t.el)return;
    const rank={live:0,idle:1,gone:2};ag.sort((a,b)=>(rank[a.state]??2)-(rank[b.state]??2));const live=ag.filter(a=>a.state==='live').length;
    body='<div class="hc-name">Agents on this board</div><div class="xs faint">'+(ag.length?(live?live+' working now · ':'None working now · ')+ag.length+' in all':'None yet')+'</div>'+
      (ag.length?'<ul class="ag-list hc-list">'+ag.slice(0,12).map(agRow).join('')+'</ul>':'')}
  else{const js=await Promise.all(MEMBERS.map(u=>pfetch(u)));if(hFor!==t.el)return;
    body='<div class="hc-name">People on this board</div><ul class="hc-list hc-people">'+MEMBERS.map((u,i)=>{const j=js[i]||{},p=j.person,on=p&&p.presence&&p.presence.web;
      return '<li>'+avatar16(u,false)+'<span class="grow truncate">'+esc(p&&p.display_name||u)+'</span><span class="pres'+(on?' on':'')+'"></span><span class="xs faint">'+esc(j.presence||'')+'</span></li>'}).join('')+'</ul>'}
  hcard.innerHTML=body;refreshTimes();hPlace(t,pin)}
function hPlace(t,pin){const sheet=!!pin&&hNarrow.matches;hcard.classList.toggle('sheet',sheet);hback.hidden=!sheet;hcard.hidden=false;
  if(sheet)hcard.style.left=hcard.style.top='';
  else{const r=t.el.getBoundingClientRect(),w=hcard.offsetWidth,hh=hcard.offsetHeight;
    hcard.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left))+'px';hcard.style.top=(r.bottom+hh+8>innerHeight?Math.max(8,r.top-hh-6):r.bottom+6)+'px'}}
async function hShow(t,pin){if(t.group)return hGroup(t,pin);hFor=t.el;hPinned=!!pin;const [j,aj]=await Promise.all([pfetch(t.u),t.agent?afetch(t.u):null]);if(hFor!==t.el)return;if(!j||!j.person){hClose();return}const p=j.person,a=aj&&aj.agent;
  const act=p.relation==='self'?'':p.relation==='friend'?'<button class="btn sm" data-direct="'+esc(p.name)+'">Message</button>':p.relation==='pending_in'?'<button class="btn sm" data-friend="accept" data-name="'+esc(p.name)+'">Accept</button>':p.relation==='none'?'<button class="btn sm" data-add="'+esc(p.name)+'">Add friend</button>':'<span class="xs faint">'+(p.relation==='pending_out'?'Request sent':'')+'</span>';
  const on=p.presence&&(p.presence.agent||p.presence.web||(p.presence.watcher&&p.presence.watcher.respond));
  const owner=esc(p.display_name||p.name);
  let ag='';if(t.agent){const live=(a&&a.sessions||[]).filter(s=>s.active);
    ag='<div class="hc-agent"><div class="xs faint"><a class="link" href="/u/'+esc(p.name)+'">'+owner+'</a>\u2019s agent</div>'+
      (a&&a.summary?'<p class="hc-bio">'+esc(a.summary)+'</p>':'')+
      (a&&a.capabilities&&a.capabilities.length?'<div class="hc-caps">'+a.capabilities.slice(0,6).map(c=>'<span class="badge">'+esc(c)+'</span>').join('')+'</div>':'')+
      (live.length?'<div class="xs hc-live">'+live.slice(0,2).map(s=>{const tool=s.client&&!/^(an? )?agent$|^unknown$/i.test(s.client)?s.client:'';return '<span class="pres on"></span> '+esc(s.name||tool||'session')+(tool&&tool!==s.name?' <span class="faint">· '+esc(tool)+'</span>':'')+(s.status?': '+esc(s.status):' <span class="faint">· active</span>')}).join('<br>')+'</div>':'')+'</div>'}
  const cta=document.getElementById('composer-text');
  const ask=t.agent&&p.relation!=='self'&&cta&&!cta.disabled?'<button class="btn sm" data-ask="'+esc(p.name)+'">Ask '+esc(p.name)+"'s agent</button>":'';
  hcard.innerHTML='<div class="row" style="gap:12px;align-items:center">'+avatar16(p.name,t.agent).replace('av sm','av lg')+'<div class="grow" style="min-width:0"><div class="hc-name">'+esc(t.agent?p.name+"'s agent":(p.display_name||p.name))+'</div><div class="xs faint">@'+esc(p.name)+(p.shared_boards?' · '+p.shared_boards+' shared board'+(p.shared_boards===1?'':'s'):'')+'</div></div></div>'+
    '<div class="row hc-pres"><span class="pres'+(on?' on':'')+'"></span><span class="xs">'+esc(j.presence||'')+'</span></div>'+(p.bio&&!t.agent?'<p class="hc-bio">'+esc(p.bio)+'</p>':'')+ag+
    '<div class="hc-act"><a class="btn sm primary" href="/u/'+esc(p.name)+(t.agent?'#agent':'')+'">View profile</a>'+ask+act+'</div>';
  hPlace(t,pin);
  if(pin&&hKey)hcard.querySelector('a.btn')?.focus({preventScroll:true})}
document.addEventListener('mouseover',e=>{if(!hCanHover.matches||hPinned)return;if(e.target.closest('.hcard')){clearTimeout(hTimer);return}const t=hTarget(e.target);clearTimeout(hTimer);
  if(!t){hTimer=setTimeout(()=>{if(!hPinned){hcard.hidden=true;hFor=null}},250);return}if(hFor===t.el&&!hcard.hidden)return;hTimer=setTimeout(()=>hShow(t,false),350)});
// click or tap pins the card (the same thing again closes it); anywhere else closes it
document.addEventListener('click',e=>{if(e.target.closest('.hcard'))return;const t=hTarget(e.target);
  if(!t){if(hPinned)hClose();return}
  clearTimeout(hTimer);if(hPinned&&hFor===t.el&&!hcard.hidden){hClose();return}
  hKey=false;hShow(t,true)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!hcard.hidden){hClose(true);return}
  if((e.key==='Enter'||e.key===' ')&&e.target.matches&&e.target.matches('[data-hc][role=button]')){const t=hTarget(e.target);if(!t)return;e.preventDefault();e.stopPropagation();clearTimeout(hTimer);
    if(hPinned&&hFor===t.el&&!hcard.hidden){hClose(true);return}hKey=true;hShow(t,true)}},true);
addEventListener('resize',()=>{if(hPinned)hClose()});
document.addEventListener('click',e=>{const k=e.target.closest('.hcard [data-ask]');if(!k)return;e.stopPropagation();const c=document.getElementById('composer-text');if(!c)return;
  const ins="@"+k.dataset.ask+"'s agent ";hClose();c.focus();const v=c.value;c.value=(v&&!/\\s$/.test(v)?v+' ':v)+ins;c.setSelectionRange(c.value.length,c.value.length);c.dispatchEvent(new Event('input'))},true);
document.addEventListener('click',async e=>{const a=e.target.closest('.hcard [data-add]'),d=e.target.closest('.hcard [data-direct]');if(!a&&!d)return;e.stopPropagation();
  if(a){const r=await fetch('/api/friends/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:a.dataset.add})});const j=await r.json().catch(()=>({}));toast(r.ok?(j.relation==='friend'?'You are friends now':'Request sent'):(j.error||'Could not send'));delete pcache[a.dataset.add];hClose();return}
  const r=await fetch('/api/direct/'+encodeURIComponent(d.dataset.direct),{method:'POST'});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not open');return}location.href='/b/'+j.board},true);
document.addEventListener('click',async e=>{const b=e.target.closest('.hcard [data-friend]');if(!b)return;e.stopPropagation();const r=await fetch('/api/friends/'+encodeURIComponent(b.dataset.name)+'/'+b.dataset.friend,{method:'POST'});toast(r.ok?'Friends now':'Could not update');delete pcache[b.dataset.name];hClose()},true);
// ---- Members & access (the Invite button and "Manage"): invite by email or link, roles and end dates, activity ----
const IS_OWNER=${isOwner ? "true" : "false"},CREATOR=${jsString(info.created_by)};${readOnly ? "document.documentElement.classList.add('ro');" : ""}
const accFmt=ts=>ts?new Date(ts).toISOString().slice(0,10):'';
async function accLoad(){const [m,a,l]=await Promise.all([fetch('/api/boards/'+BOARD+'/members').then(r=>r.json()).catch(()=>({})),fetch('/api/boards/'+BOARD+'/audit').then(r=>r.json()).catch(()=>({})),
    IS_OWNER?fetch('/api/boards/'+BOARD+'/links').then(r=>r.json()).catch(()=>({})):Promise.resolve({})]);
  const sel=(name,val,opts,dis)=>'<select class="input acc-sel" data-acc="'+name+'"'+(dis?' disabled':'')+'>'+opts.map(o=>'<option value="'+o[0]+'"'+(o[0]===val?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
  document.getElementById('acc-members').innerHTML=(m.members||[]).map(x=>{const fixed=!IS_OWNER||x.user===CREATOR;
    return '<li class="acc-row" data-user="'+esc(x.user)+'">'+avatar16(x.user,false)+'<span class="grow truncate">'+esc(x.user)+(x.user===ME?' <span class="faint">(you)</span>':'')+'</span>'+
      sel('role',x.role||'contributor',[['owner','Owner'],['contributor','Can post'],['viewer','View only']],fixed)+
      sel('days',x.expires_at?'keep':'0',(x.expires_at?[['keep','Until '+accFmt(x.expires_at)]]:[]).concat([['0','No end date'],['7','7 more days'],['30','30 more days'],['90','90 more days']]),!IS_OWNER||x.user===CREATOR)+'</li>'}).join('')||'<li class="xs faint">No members</li>';
  if(IS_OWNER)document.getElementById('acc-links').innerHTML=(l.links||[]).filter(x=>!x.revoked_at&&(!x.expires_at||x.expires_at>Date.now())).map(x=>'<li class="acc-row xs"><span class="grow">'+(x.role==='viewer'?'View only':'Can post')+' link · until '+accFmt(x.expires_at)+' · used '+x.uses+(x.max_uses?' of '+x.max_uses:'')+'</span><button class="btn ghost sm" type="button" data-link-revoke="'+esc(x.id)+'">Revoke</button></li>').join('');
  const verb={invited:'invited',joined:'joined',removed:'removed',left:'left',access_changed:'changed access for',link_created:'created an invite link',link_revoked:'revoked an invite link',renamed:'renamed the board',archived:'archived the board',restored:'restored the board',expired:'access ended for',picture_changed:'changed the board picture',picture_removed:'removed the board picture'};
  document.getElementById('acc-audit').innerHTML=(a.audit||[]).slice(0,50).map(x=>'<li class="xs"><b>'+esc(x.actor)+'</b> '+(verb[x.action]||esc(x.action))+(x.target?' <b>'+esc(x.target)+'</b>':'')+(x.detail?' <span class="faint">· '+esc(x.detail)+'</span>':'')+' <span class="faint">· '+new Date(x.ts).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</span></li>').join('')||'<li class="xs faint">Nothing yet</li>'}
// ---- Triggers (#980): "when X happens, wake my agent (or one session) with a prompt"; each person manages their own ----
const TRG_ON={task:'a new task',question:'a new question',entry:'any new message',change:'a change card',schedule:'every day at'};
const trgApi='/api/boards/'+BOARD+'/triggers';
function trgWhen(t){const m=t.match||{};if(t.on==='schedule')return 'Every day at '+esc(m.at||'?')+' UTC';
  const who=esc(t.created_by||(t.wake&&t.wake.user)||'');
  const w=t.on==='mention'?'someone mentions '+who:t.on==='approval'?'one of '+who+"'s approvals is decided":t.on==='task'&&m.task==='status'?'a task changes status':(TRG_ON[t.on]||esc(t.on));
  return 'When '+w+(m.type?' ('+esc(m.type)+')':'')+(m.text?' containing “'+esc(m.text)+'”':'')}
function trgWho(w){return w?esc(w.user)+(w.session?'/'+esc(w.session):"'s agent"):''}
async function trgLoad(){const ul=document.getElementById('trg-list');if(!ul)return;const f=document.getElementById('trg-new');
  const r=await fetch(trgApi).catch(()=>null);
  const sec=document.getElementById('acc-triggers');
  if(r&&r.status===404){sec.hidden=true;return} // the server doesn't have triggers yet: no section at all
  sec.hidden=false;if(!r||!r.ok){ul.innerHTML='<li class="xs faint">Couldn’t load triggers.</li>';f.hidden=true;return}
  const j=await r.json().catch(()=>({}));const ts=j.triggers||[];f.hidden=false;
  ul.innerHTML=ts.map(t=>{const mine=t.created_by===ME||(t.wake&&t.wake.user===ME);
    return '<li class="trg-row'+(t.enabled===false?' off':'')+'" data-trg="'+esc(t.id)+'"><div class="grow"><div class="small">'+trgWhen(t)+' <span class="faint">→ wake</span> <b>'+trgWho(t.wake)+'</b></div>'+
      '<div class="xs muted trg-p">'+esc(t.prompt||'')+'</div><div class="xs faint">'+(t.enabled===false?'Paused · ':'')+(t.fires?'Fired '+t.fires+(t.fires===1?' time':' times')+(t.last_fired_at?', last '+esc(new Date(t.last_fired_at).toISOString().slice(0,16).replace('T',' '))+' UTC':''):'Not fired yet')+(t.created_by&&t.created_by!==ME?' · by '+esc(t.created_by):'')+'</div></div>'+
      (mine?'<div class="row trg-acts"><button class="btn ghost sm" type="button" data-trg-do="'+(t.enabled===false?'resume':'pause')+'">'+(t.enabled===false?'Resume':'Pause')+'</button><button class="btn ghost sm danger" type="button" data-trg-do="delete">Delete</button></div>':'')+'</li>'}).join('')||'<li class="xs faint">No triggers yet.</li>';
  const sel=document.getElementById('trg-wake');if(!sel.options.length){const ss=[...new Set(MOPTS.filter(o=>o.u===ME&&o.sub&&o.ins.includes('/')).map(o=>o.ins.split('/')[1]))];
    sel.innerHTML='<option value="">Your agent</option>'+ss.map(x=>'<option value="'+esc(x)+'">'+esc(ME+'/'+x)+'</option>').join('')}}
document.getElementById('trg-on')?.addEventListener('change',e=>{const v=e.target.value,s=v==='schedule';document.getElementById('trg-at').hidden=!s;document.getElementById('trg-text').hidden=s||v==='approval'});
document.getElementById('trg-new')?.addEventListener('submit',async e=>{e.preventDefault();const f=e.target,on=document.getElementById('trg-on').value,err=document.getElementById('trg-err');err.textContent='';
  const prompt=document.getElementById('trg-prompt').value.trim();if(!prompt){err.textContent='Say what your agent should do.';return}
  const text=document.getElementById('trg-text').hidden?'':document.getElementById('trg-text').value.trim(),at=document.getElementById('trg-at').value,session=document.getElementById('trg-wake').value;
  const match=on==='schedule'?{at}:Object.assign(text?{text}:{},on==='task'?{task:'created'}:{}); // "a new task": creations, not status moves
  const body={on,match,wake:session?{user:ME,session}:{user:ME},prompt,enabled:true};
  const btn=f.querySelector('[type=submit]');btn.disabled=true;
  const r=await fetch(trgApi,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).catch(()=>null);btn.disabled=false;
  const j=r?await r.json().catch(()=>({})):{};if(!r||!r.ok){err.textContent=j.error||'Couldn’t add the trigger.';return}
  document.getElementById('trg-prompt').value='';document.getElementById('trg-text').value='';toast('Trigger added');trgLoad()});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-trg-do]');if(!b)return;const id=b.closest('[data-trg]').dataset.trg,d=b.dataset.trgDo;
  if(d==='delete'&&!confirm('Delete this trigger?'))return;b.disabled=true;
  const r=await fetch(trgApi+'/'+encodeURIComponent(id),d==='delete'?{method:'DELETE'}:{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:d==='resume'})}).catch(()=>null);
  if(!r||!r.ok){const j=r?await r.json().catch(()=>({})):{};toast(j.error||'Couldn’t save');b.disabled=false;return}toast(d==='delete'?'Trigger deleted':d==='pause'?'Paused':'Resumed');trgLoad()});
document.addEventListener('click',e=>{const o=e.target.closest('[data-open="invite"]');if(!o)return;accLoad();trgLoad();const g=o.dataset.goto&&document.getElementById(o.dataset.goto);if(g)setTimeout(()=>g.scrollIntoView({block:'nearest'}),60)});
// Invite: suggest friends who aren't on the board yet, as you type (arrow keys and Enter pick one).
let accFriends=null,accSel=0;const invIn=document.getElementById('inv-email'),invSug=document.getElementById('inv-sug');
async function invSuggest(){if(!invIn)return;if(!accFriends)accFriends=(await fetch('/api/friends').then(r=>r.json()).catch(()=>({}))).friends||[];
  const q=invIn.value.trim().toLowerCase().replace(/^@/,''),here=new Set(MOPTS.map(o=>o.u));
  const list=q.includes('@')?[]:accFriends.filter(f=>!here.has(f.name)&&(!q||f.name.includes(q)||(f.display_name||'').toLowerCase().includes(q))).slice(0,6);
  accSel=Math.min(accSel,Math.max(0,list.length-1));invSug.hidden=!list.length;
  invSug.innerHTML=list.map((f,i)=>'<li role="option" data-friend-pick="'+esc(f.name)+'"'+(i===accSel?' aria-selected="true"':'')+'>'+avatar16(f.name,false)+'<span>'+esc(f.name)+'</span>'+(f.display_name?'<span class="faint truncate">'+esc(f.display_name)+'</span>':'')+'<span class="xs faint" style="margin-left:auto">friend</span></li>').join('')}
invIn?.addEventListener('input',()=>{accSel=0;invSuggest()});invIn?.addEventListener('focus',invSuggest);
invIn?.addEventListener('blur',()=>setTimeout(()=>{invSug.hidden=true},150));
invIn?.addEventListener('keydown',e=>{if(invSug.hidden)return;const n=invSug.children.length;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();accSel=(accSel+(e.key==='ArrowDown'?1:n-1))%n;invSuggest()}
  else if(e.key==='Enter'&&n&&invIn.value.trim()!==invSug.children[accSel].dataset.friendPick){e.preventDefault();invIn.value=invSug.children[accSel].dataset.friendPick;invSug.hidden=true}
  else if(e.key==='Escape'){e.stopPropagation();invSug.hidden=true}});
invSug?.addEventListener('mousedown',e=>{const li=e.target.closest('[data-friend-pick]');if(!li)return;e.preventDefault();invIn.value=li.dataset.friendPick;invSug.hidden=true;invIn.focus()});
document.getElementById('acc-members').addEventListener('change',async e=>{const s=e.target.closest('[data-acc]');if(!s)return;const u=s.closest('[data-user]').dataset.user;
  const body=s.dataset.acc==='role'?{role:s.value}:s.value==='keep'?null:{expires_days:+s.value};if(!body)return;
  const r=await fetch('/api/boards/'+BOARD+'/members/'+encodeURIComponent(u),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));
  toast(r.ok?'Saved':(j.error||'Could not save'));accLoad()});
document.getElementById('link-make')?.addEventListener('click',async()=>{const r=await fetch('/api/boards/'+BOARD+'/links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:document.getElementById('link-role').value,link_days:+document.getElementById('link-days').value})});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not create');return}const box=document.getElementById('link-new');
  box.innerHTML='<div class="acc-row"><input class="input mono grow acc-url" id="link-url" readonly value="'+esc(j.url)+'" aria-label="Invite link"><button class="btn sm" type="button" data-copy="link-url">Copy</button></div>';box.hidden=false;accLoad()});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-link-revoke]');if(!b)return;const r=await fetch('/api/boards/'+BOARD+'/links/'+b.dataset.linkRevoke,{method:'DELETE'});toast(r.ok?'Link revoked':'Could not revoke');accLoad()});
window.deleted=()=>{location.href='/'};
// Every place the board name shows: heading, breadcrumb, sidebar, browser tab (also used for live renames by others).
window.applyTitle=(t)=>{const h=document.getElementById('board-title');if(h)h.textContent=t;document.title=t+' · Atteo';
  document.querySelectorAll('.topbar .crumbs .cur, .side-board[aria-current] .truncate').forEach(x=>x.textContent=t)};
// Inline rename (creator only): click the title or the pencil, Enter saves, Esc cancels.
(()=>{const h=document.getElementById('board-title'),inp=document.getElementById('title-input'),pen=document.getElementById('title-pencil');if(!inp)return;
  const start=()=>{inp.value=h.textContent;h.hidden=true;pen.hidden=true;inp.hidden=false;inp.focus();inp.select()};
  const stop=()=>{inp.hidden=true;h.hidden=false;pen.hidden=false};
  const save=async()=>{const t=inp.value.trim();if(!t||t===h.textContent){stop();return}inp.disabled=true;
    const r=await fetch('/api/boards/'+BOARD+'/rename',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:t})});
    const j=await r.json().catch(()=>({}));inp.disabled=false;if(!r.ok){toast(j.error||'Could not rename');inp.focus();return}
    window.applyTitle(j.title);toast('Renamed');stop()};
  h.addEventListener('click',start);pen.addEventListener('click',start);h.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();start()}});
  inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();save()}if(e.key==='Escape'){e.preventDefault();stop()}});
  inp.addEventListener('blur',()=>{if(!inp.hidden&&!inp.disabled)save()});})();
window.archiveDone=(j)=>{toast(j.message||'Done');setTimeout(()=>location.reload(),400)};
document.getElementById('del-confirm')?.addEventListener('input',e=>{document.getElementById('del-go').disabled=e.target.value.trim()!==${jsString(info.title)}});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-retract]');if(!b)return;
  if(b.dataset.armed!=='1'){b.dataset.armed='1';b.textContent='Unsend #'+b.dataset.retract+'?';b.classList.add('danger');setTimeout(()=>{b.dataset.armed='';b.textContent='Unsend';b.classList.remove('danger')},4000);return}
  b.disabled=true;const r=await fetch('/api/boards/'+BOARD+'/entries/'+b.dataset.retract+'/retract',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not unsend');b.disabled=false;return}toast('Unsent');tick(false)});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-member-remove]');if(!b)return;
  if(b.dataset.armed!=='1'){b.dataset.armed='1';b.textContent=b.dataset.label==='Leave'?'Leave board?':'Remove '+b.dataset.memberRemove+'?';b.classList.add('danger');
    setTimeout(()=>{b.dataset.armed='';b.textContent=b.dataset.label;b.classList.remove('danger')},4000);return}
  b.disabled=true;const r=await fetch('/api/boards/'+BOARD+'/members/'+encodeURIComponent(b.dataset.memberRemove)+'/remove',{method:'POST'});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not remove');b.disabled=false;return}
  if(j.left){location.href='/'}else{toast(j.message);location.reload()}});
const infoBtn=document.getElementById('info-btn'),convLayout=document.getElementById('conv-layout');
const narrow=matchMedia('(max-width:959px)');let infoHidden=false;try{infoHidden=localStorage.getItem('soup.infoHidden')==='1'}catch(e){}
function infoSync(){const wide=!narrow.matches;convLayout.classList.toggle('info-collapsed',wide&&infoHidden);
  const shown=wide?!infoHidden:convLayout.classList.contains('info-open');infoBtn.setAttribute('aria-expanded',String(shown));infoBtn.title=shown?'Hide board info':'Show board info'}
function infoOpen(o){convLayout.classList.toggle('info-open',o);infoSync()}
narrow.addEventListener('change',()=>infoOpen(false));infoSync();
function infoCount(){const n=document.querySelectorAll('#sum .waiting li').length,c=document.getElementById('info-count');c.textContent=n||'';c.hidden=!n}
infoBtn.addEventListener('click',()=>{if(narrow.matches){infoOpen(!convLayout.classList.contains('info-open'));return}
  infoHidden=!infoHidden;try{localStorage.setItem('soup.infoHidden',infoHidden?'1':'0')}catch(e){}infoSync()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&convLayout.classList.contains('info-open')&&!document.querySelector('dialog[open]'))infoOpen(false)});
document.getElementById('board-info').addEventListener('click',e=>{if(e.target.closest('a[href^="#e"]'))infoOpen(false)});
infoCount();
let convStuck=true;
function tab(n){if(!document.getElementById('panel-conv').hidden)convStuck=atBottom();
  document.querySelectorAll('#board-tabs button').forEach((b,i)=>b.setAttribute('aria-selected',String(i===n)));
  // Each tab names its panel (aria-controls), so the panels' order in the page doesn't matter.
  const want=document.querySelectorAll('#board-tabs button')[n]?.getAttribute('aria-controls');
  document.querySelectorAll('[data-board-panel]').forEach(p=>p.hidden=p.id!==want);
  infoBtn.hidden=n!==0;if(n===0&&convStuck)toBottom();history.replaceState(null,'',['',"#log","#files","#tasks"][n]||location.pathname);if(n===2)loadDocs();if(n===3)loadTasks()}
document.querySelectorAll('#board-tabs button').forEach((b,i)=>b.addEventListener('click',()=>tab(i)));
if(location.hash==='#log')tab(1);if(location.hash==='#files'||location.hash==='#docs')tab(2);
// ---- Tasks (Kanban): the board's tasks by status; drag a card to another column to change it ----
const KCOLS=[['todo','To do'],['doing','In progress'],['blocked','Blocked'],['done','Done']];
const PRI={high:0,medium:1,low:2};
async function loadTasks(){const r=await fetch('/api/boards/'+BOARD+'/tasks');const j=await r.json().catch(()=>({}));if(!r.ok){document.getElementById('kanban').innerHTML='<p class="muted small">'+esc(j.error||'Could not load tasks')+'</p>';return}
  const ts=j.tasks||[];ts.forEach(t=>TASKS[t.seq]={...TASKS[t.seq],...t});const open=ts.filter(t=>t.status!=='done').length;document.getElementById('task-count').textContent=open||'';
  document.getElementById('kanban').innerHTML=KCOLS.map(([k,label])=>{const col=ts.filter(t=>(k==='blocked'?(t.status==='blocked'||t.status==='stopped'):t.status===k))
      .sort((a,b)=>(PRI[a.priority]??3)-(PRI[b.priority]??3)||(k==='done'?b.updated_at-a.updated_at:a.seq-b.seq)).slice(0,k==='done'?30:200);
    return '<section class="kcol" data-status="'+k+'"><h3>'+label+' <span class="faint">'+col.length+'</span></h3><div class="kcards">'+col.map(card).join('')+'</div></section>'}).join('')}
function card(t){const first=t.title||'';const boxes=ckLines(t.body||'');const ticked=boxes.filter(b=>b.done).length;const par=t.parent!=null&&TASKS[t.parent];
  const who=t.assignee?(t.assignee_agent?t.assignee+"'s agent":t.assignee):'';
  const hold=t.lease_holder?(t.lease_agent?t.lease_holder+"'s agent":t.lease_holder):'';
  // Title first; one quiet line under it: number, priority, checklist, due date, and who it's for / who holds it.
  return '<article class="kcard" draggable="true" data-seq="'+t.seq+'"><div class="ktext">'+esc(first)+'</div>'+
    '<div class="kmeta"><a class="seq" href="#e'+t.seq+'" data-kopen="'+t.seq+'">#'+t.seq+'</a>'+(t.priority?'<span class="badge pri-'+t.priority+'">'+t.priority+'</span>':'')+(t.status==='stopped'?'<span class="badge pri-high">stopped</span>':'')+
    (t.parent!=null?'<span class="ksub" title="'+(par?'Sub-task of '+esc(par.title):'A sub-task')+'">↳ '+(par?esc(par.title):'sub-task')+'</span>':'')+
    (boxes.length?'<span title="Checklist">☑ '+ticked+'/'+boxes.length+'</span>':'')+(t.children?'<span title="Sub-tasks done">'+t.children.done+'/'+t.children.total+' sub-tasks</span>':'')+(t.due?'<span>due '+new Date(t.due).toISOString().slice(5,10)+'</span>':'')+'<span class="grow"></span>'+
    (hold?'<span title="'+esc(hold)+' is working on it">🔒</span>':'')+(who?'<span title="For '+esc(who)+'">'+avatar16(t.assignee,t.assignee_agent)+'</span>':'')+'</div>'+
    (t.stop_reason?'<div class="xs faint">'+esc(t.stop_reason)+'</div>':'')+(t.done_note?'<div class="xs faint">✓ '+esc(t.done_note)+'</div>':'')+'</article>'}
async function taskAct(seq,body){const r=await fetch('/api/boards/'+BOARD+'/tasks/'+seq,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json().catch(()=>({}));if(!r.ok)toast(j.error||'Could not update');loadTasks();tick(false)}
const kb=document.getElementById('kanban');let dragSeq=null;
kb.addEventListener('dragstart',e=>{const c=e.target.closest('.kcard');if(!c)return;dragSeq=c.dataset.seq;e.dataTransfer.effectAllowed='move';c.classList.add('dragging')});
kb.addEventListener('dragend',e=>{e.target.closest('.kcard')?.classList.remove('dragging');kb.querySelectorAll('.kcol.over').forEach(x=>x.classList.remove('over'))});
kb.addEventListener('dragover',e=>{const col=e.target.closest('.kcol');if(!col||!dragSeq)return;e.preventDefault();kb.querySelectorAll('.kcol.over').forEach(x=>x!==col&&x.classList.remove('over'));col.classList.add('over')});
kb.addEventListener('drop',e=>{const col=e.target.closest('.kcol');if(!col||!dragSeq)return;e.preventDefault();const s=dragSeq;dragSeq=null;taskAct(s,{action:'update',status:col.dataset.status})});
kb.addEventListener('click',e=>{const a=e.target.closest('[data-kopen]');if(a){e.preventDefault();tab(0);location.hash='#e'+a.dataset.kopen;return}
  const c=e.target.closest('.kcard');if(c)openTask(+c.dataset.seq)});
document.getElementById('kb-new')?.addEventListener('submit',async e=>{e.preventDefault();const i=document.getElementById('kb-new-text');const title=i.value.trim();if(!title)return;
  const r=await fetch('/api/boards/'+BOARD+'/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title})});
  const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not add');return}i.value='';loadTasks();tick(false);openTask(j.task.seq)});
// Task drawer: the task is a shared item. Edit its title and body (versioned, conflicts caught), and its fields.
const td=document.getElementById('task-dlg');let tcur=null,tdirty=false;
function tdate(ts){return new Date(ts).toISOString().slice(0,16).replace('T',' ')+'Z'}
async function openTask(seq){const r=await fetch('/api/boards/'+BOARD+'/tasks/'+seq);const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not open');return}
  tcur=j.task;tdirty=false;const t=tcur;
  document.getElementById('td-seq').textContent='#'+t.seq;document.getElementById('td-title').value=t.title;document.getElementById('td-body').value=t.body;
  document.getElementById('td-status').value=t.status==='stopped'?'blocked':t.status;document.getElementById('td-pri').value=t.priority||'';
  document.getElementById('td-assignee').value=t.assignee?(t.assignee_agent?t.assignee+"'s agent":t.assignee):'';
  const by=t.updated_via==='agent'?t.updated_by+"'s agent":t.updated_by;
  document.getElementById('td-meta').textContent='v'+t.version+' · edited by '+by+' '+tdate(t.updated_at)+(t.lease_holder?' · 🔒 '+(t.lease_agent?t.lease_holder+"'s agent":t.lease_holder)+' until '+tdate(t.lease_until):'')+(t.stop_reason?' · stopped: '+t.stop_reason:'')+(t.done_note?' · done: '+t.done_note:'');
  document.getElementById('td-hist').innerHTML=(j.history||[]).map(v=>'<li>v'+v.version+' · '+esc(v.via==='agent'?v.author+"'s agent":v.author)+' · '+tdate(v.ts)+(v.summary?' — '+esc(v.summary):'')+'</li>').join('')||'<li>No edits yet</li>';
  document.getElementById('td-err').hidden=true;
  document.getElementById('td-remove').hidden=!(t.author===ME||ME===CREATOR);
  if(!td.open){td.showModal();const ti=document.getElementById('td-title');ti.setSelectionRange(0,0);ti.scrollLeft=0;if(matchMedia('(pointer:coarse)').matches)ti.blur()}}
['td-title','td-body'].forEach(id=>document.getElementById(id).addEventListener('input',()=>tdirty=true));
document.getElementById('td-open').addEventListener('click',()=>{td.close();tab(0);location.hash='#e'+tcur.seq});
document.getElementById('td-remove').addEventListener('click',async()=>{if(!confirm('Remove this task from the board? It stays in the log as unsent.'))return;
  const r=await fetch('/api/boards/'+BOARD+'/entries/'+tcur.seq+'/retract',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:'removed from the task board'})});
  if(!r.ok){const j=await r.json().catch(()=>({}));toast(j.error||'Could not remove');return}
  td.close();loadTasks();tick(false)});
document.getElementById('td-form').addEventListener('submit',async e=>{e.preventDefault();const t=tcur,err=document.getElementById('td-err');err.hidden=true;
  const title=document.getElementById('td-title').value,body=document.getElementById('td-body').value;
  const post=async b=>{const r=await fetch('/api/boards/'+BOARD+'/tasks/'+t.seq,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok){err.hidden=false;err.textContent=j.error||'Could not save';throw 0}return j};
  try{if(title!==t.title||body!==t.body)await post({action:'edit',title,body,base_version:t.version,summary:document.getElementById('td-sum').value});
    const st=document.getElementById('td-status').value,pr=document.getElementById('td-pri').value,as=document.getElementById('td-assignee').value.trim();
    const curAs=t.assignee?(t.assignee_agent?t.assignee+"'s agent":t.assignee):'';const ch={action:'update'};
    if(st!==(t.status==='stopped'?'blocked':t.status))ch.status=st;if(pr!==(t.priority||''))ch.priority=pr;
    if(as!==curAs){ch.assignee=as.replace(/'s agent$/,'');if(!/'s agent$/.test(as)&&as)ch.assignee_is_person=true}
    if(Object.keys(ch).length>1)await post(ch);
    td.close();document.getElementById('td-sum').value='';loadTasks();tick(false)}catch(e){}});
if(location.hash==='#tasks')tab(3);
let cur=-1;
window.boardKeys=(e,k)=>{
  if(k==='1'||k==='2'||k==='3'||k==='4'){tab(+k-1);return}
  const inLog=!document.getElementById('panel-log').hidden;
  const els=[...document.querySelectorAll(inLog?'#log-body tr.ev':'#thread>.entry')];
  if(k==='j'||k==='k'){e.preventDefault();cur=Math.max(0,Math.min(els.length-1,cur+(k==='j'?1:-1)));
    els.forEach(x=>x.classList.remove('sel'));const el=els[cur];if(el){el.classList.add('sel');el.scrollIntoView({block:'nearest'})}}
  if(e.key==='Enter'&&els[cur]){openEntry(BOARD,els[cur].dataset.seq)}
};
` + (canPic ? BOARD_PIC_JS : "") + (info.encrypted ? E2E_JS : "") + voiceJs(agentChat) + (agentChat ? "" : pinRecapJs(board.last_seen ?? 0, !readOnly && !info.archived));
  const isCreator = viewer.name === info.created_by;
  const archivedBanner = info.archived
    ? `<div class="flash bp-banner"><span class="grow"><b>Archived.</b> This board is read-only.</span>${
        isCreator ? `<form method="post" action="/api/boards/${esc(info.id)}/archive" data-api data-done="archiveDone"><input type="hidden" name="archived" value="false"><button class="btn sm">Restore</button></form>` : ""
      }</div>`
    : "";
  // End-to-end encrypted: the server (and this page) only ever see ciphertext; the CLI reads and writes.
  const encryptedBanner = info.encrypted
    ? `<div class="flash bp-banner e2e-bar"><span class="grow" id="e2e-msg">🔒 <b>End-to-end encrypted.</b> Messages are encrypted on each member's device; read and write them here, or with <span class="mono">atteo read</span> / <span class="mono">atteo post</span> after <span class="mono">atteo use ${esc(info.id)}</span>.</span><div id="e2e-asks" class="e2e-asks"></div></div>`
    : "";
  const peer = direct ? (info.title.split(" ↔ ").find((x) => x !== viewer.name) ?? viewer.name) : "";
  const headPic = agentChat
    ? avatar(viewer.name, "", true)
    : direct
    ? avatar(peer)
    : canPic
      ? `<button class="bp-pic" type="button" data-open="invite" data-goto="acc-board" title="Change the board picture" aria-label="Board picture">${boardPic({ id: info.id, title: info.title, picture: board.picture })}</button>`
      : boardPic({ id: info.id, title: info.title, picture: board.picture });
  const picSec = canPic
    ? `<div class="acc-row bpic-row">${boardPic({ id: info.id, title: info.title, picture: board.picture }, "lg")}<div class="grow"><div class="small" style="color:var(--ink)">Picture</div><div class="xs muted">${
        info.encrypted ? "Visible to the server, like the board name." : "Everyone on the board sees it, and a line when it changes."
      }</div></div>
  <label class="btn sm">${board.picture ? "Change picture" : "Add picture"}<input type="file" accept="image/png,image/jpeg,image/webp" data-bpic-file hidden></label>${
    board.picture ? `<button class="btn ghost sm" type="button" data-bpic-rm>Remove picture</button>` : ""
  }</div>`
    : "";
  // One compact header row (title, live, members, tabs) so the conversation gets the height.
  const body = `${archivedBanner}${encryptedBanner}<div class="bp-head"><div class="bp-title">${headPic}
  ${
    agentChat
      ? `<h1 class="truncate" id="board-title">Your agent</h1>`
      : isCreator && !info.archived
      ? `<div class="title-edit"><h1 class="truncate" id="board-title" tabindex="0" role="button" title="Rename (click or press Enter)">${esc(info.title)}</h1><button class="btn ghost sm pencil" type="button" id="title-pencil" aria-label="Rename board"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M11.5 2.5l2 2L6 12H4v-2z"/></svg></button>
<input class="input title-input" id="title-input" value="${esc(info.title)}" maxlength="120" hidden aria-label="Board name"></div>`
      : `<h1 class="truncate" id="board-title">${esc(info.title)}</h1>`
  }
  <div class="row small muted bp-meta" title="${esc(info.id)}">
    <span class="badge conn" id="conn" hidden title="Live updates are reconnecting">Reconnecting…</span>${readOnly ? `<span class="badge" title="Your role on this board is viewer: you can read, not post">View only</span>` : ""}
    ${
      agentChat
        ? `<span class="truncate" title="Only you and your agents">Private: you and your agents</span>`
        : `<span class="row" style="min-width:0" title="${esc(members.map((m) => m.user).join(", "))}">${avatarStack(members.map((m) => m.user))}</span>`
    }

  </div></div>
  <div class="bp-tabs"><div class="tabs" role="tablist" id="board-tabs"><button role="tab" aria-selected="true" aria-controls="panel-conv">Conversation</button><button role="tab" aria-selected="false" aria-controls="panel-log">Log</button><button role="tab" aria-selected="false" aria-controls="panel-docs">Files</button><button role="tab" aria-selected="false" aria-controls="panel-tasks">Tasks <span class="faint" id="task-count"></span></button></div>${agentChat ? "" : RECAP_BTN}
    </div>
</div>
<div role="tabpanel" id="panel-conv" class="bp-panel" data-board-panel><div class="layout" id="conv-layout">
  <button class="btn ghost sm info-btn" type="button" id="info-btn" aria-expanded="false" aria-controls="board-info" aria-label="Board info" title="Board info"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M10 2.75v10.5"/><path class="fill" d="M10.7 3.45h2.1a.75.75 0 0 1 .75.75v7.6a.75.75 0 0 1-.75.75h-2.1z" fill="currentColor" stroke="none"/></svg><span class="count" id="info-count" hidden></span></button>
  <section class="conv">${agentChat ? "" : PIN_BAR}
    <div class="thread-wrap"><div class="thread-scroll" id="thread-scroll"><div class="thread" id="thread">${thread}</div></div>
      <div class="rail" id="rail" aria-hidden="true"></div><div class="rail-tip" id="rail-tip" hidden></div>
      <button class="btn sm new-pill" type="button" id="new-pill" hidden>Jump to latest ↓</button></div>
    <div class="sel-bar card" id="sel-bar" hidden><span id="sel-n">0 selected</span><span class="xs faint hide-sm">Click messages to add or remove them</span><span class="grow"></span><button class="btn sm" type="button" id="sel-cancel">Cancel</button><button class="btn sm primary" type="button" id="sel-fwd" disabled>Forward</button></div>
    <div class="typing" id="typing" aria-live="polite" hidden></div>
    <form class="card composer" method="post" action="/api/boards/${esc(info.id)}/entries" data-api data-reliable data-done="posted" data-failed="postFailed" data-retrying="postRetrying" data-reset${info.archived || readOnly || info.encrypted ? " hidden" : ""}>
      <div class="replying" id="replying" hidden><button class="rp-go" type="button" id="replying-go" title="Show the message">Replying to <b id="replying-who"></b><span class="rp-text" id="replying-text"></span></button><button class="btn ghost sm x" type="button" id="reply-cancel" aria-label="Cancel reply" title="Cancel reply (Esc)">✕</button></div>
      <input type="hidden" name="reply_to" id="reply-to" value="">${agentChat ? `<input type="hidden" name="to_session" id="to-session" value="">` : ""}
      <div class="voice-pill" id="voice-pill" hidden><button class="vp-t" type="button" id="vp-go"></button><button class="btn ghost sm x" type="button" id="vp-x" aria-label="Dismiss" title="Dismiss">✕</button></div>
      <div class="attachments" id="attachments" hidden></div>
      <div class="cmp-field"><div class="cmp-mirror" id="composer-mirror" aria-hidden="true"></div><textarea class="input" id="composer-text" name="text" required placeholder="${agentChat ? "Message your agent…" : "Write a message…  @ to mention"}" aria-label="Message"
        role="combobox" aria-autocomplete="list" aria-controls="mention-menu" aria-expanded="false"></textarea></div>
      <ul class="mention-menu" id="mention-menu" role="listbox" aria-label="Mention" hidden></ul>
      <ul class="mention-menu slash-menu" id="slash-menu" role="listbox" aria-label="Commands" hidden></ul>
      <div class="bar">
        <button class="btn ghost sm attach" type="button" id="attach-btn" aria-label="Attach files" title="Attach files or images (or paste or drop them)"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M13.5 7.6 8.3 12.8a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.8 11.3a1 1 0 0 1-1.5-1.5l4.9-4.9"/></svg></button>
        <input type="file" id="attach-input" multiple hidden>
        <button class="btn ghost sm at-btn" type="button" data-mention-for="composer-text" aria-label="Mention someone" title="Mention a person or their agent (or type @)">@</button>${agentChat ? sessionPicker(board.sessions ?? []) : ""}${VOICE_BTNS}
        <input type="hidden" name="type" id="cmp-type" value="note">
        <span class="grow"></span><button class="btn primary sm">Post</button>
      </div>
    </form>
  </section>
  <aside class="aside" id="board-info" aria-label="Board info">${agentChat ? "" : PIN_SIDE}${agentsSection(agents, info.id, readOnly || !!info.archived)}<div class="sum" id="sum">${summaryHtml(entries, viewer.name, members, summary, ctl)}</div>
</aside>
</div></div>
<div role="tabpanel" id="panel-log" class="bp-panel" data-board-panel hidden><div class="list scroll-x"><table class="log"><thead><tr><th>Time (UTC)</th><th>#</th><th>Author</th><th>Type</th><th>To</th><th>Summary</th></tr></thead>
<tbody id="log-body">${rows || `<tr id="log-empty"><td colspan="6" class="empty small">No events yet.</td></tr>`}</tbody></table></div>
<p class="xs faint" style="margin-top:10px">Every entry, newest first. Click a row (or <kbd>J</kbd>/<kbd>K</kbd> then <kbd>↵</kbd>) for its raw payload.</p></div>
<div role="tabpanel" id="panel-docs" class="bp-panel" data-board-panel hidden>
  <div class="docs">
    <div class="doc-list"><div class="row" style="justify-content:space-between;margin-bottom:8px"><span class="small muted">Files</span>${info.archived ? "" : `<button class="btn sm" type="button" id="doc-new">New</button>`}</div><div id="doc-items" class="small muted">Loading…</div></div>
    <div class="doc-view card pad" id="doc-view"><p class="muted small" id="doc-empty">No files yet. Create one (e.g. BACKLOG.md), post one from the conversation, or paste an image there. People and agents edit files together, and every save or post is a new version.</p></div>
  </div>
</div>

<div role="tabpanel" id="panel-tasks" class="bp-panel" data-board-panel hidden>
  <div class="kanban-head row"><span class="small muted grow kb-hint">Drag a card to change its status. Agents see the same board through the <code>task</code> tool.</span>${
    info.archived ? "" : `<form class="row kb-new" id="kb-new"><input class="input sm" id="kb-new-text" placeholder="New task…" aria-label="New task"><button class="btn sm">Add</button></form>`
  }</div>
  <div class="kanban" id="kanban"><p class="muted small">Loading…</p></div>
</div>

  <dialog id="task-dlg" class="task-dlg"><form id="td-form">
    <div class="hd"><div class="row grow" style="gap:8px"><span class="faint mono" id="td-seq"></span><input class="input td-title grow" id="td-title" maxlength="120" aria-label="Title"></div><button class="btn ghost sm" type="button" data-close aria-label="Close">✕</button></div>
    <div class="bd">
      <div class="row td-fields"><label>Status <select class="input sm" id="td-status"><option value="todo">To do</option><option value="doing">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label>
        <label>Priority <select class="input sm" id="td-pri"><option value="">—</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
        <label class="grow">Assignee <input class="input sm" id="td-assignee" list="td-people" placeholder="name or name's agent"></label></div>
      <datalist id="td-people">${members.flatMap((m) => [`<option value="${esc(m.user)}">`, `<option value="${esc(m.user)}'s agent">`]).join("")}</datalist>
      <textarea class="input mono td-body" id="td-body" rows="12" placeholder="The plan, a checklist (- [ ] step), findings, links. People and agents edit this together."></textarea>
      <input class="input sm" id="td-sum" placeholder="What changed? (optional)" style="margin-top:8px">
      <p class="xs faint" id="td-meta" style="margin:8px 0 0"></p>
      <details style="margin-top:6px"><summary class="xs faint" style="cursor:pointer">History</summary><ul class="xs faint td-hist" id="td-hist"></ul></details>
      <p class="flash err" id="td-err" hidden></p>
      <div class="row" style="justify-content:space-between;margin-top:12px"><div class="row" style="gap:6px"><button class="btn sm ghost" type="button" id="td-open">Open in conversation</button><button class="btn sm ghost" type="button" id="td-remove" hidden>Remove</button></div><button class="btn primary sm">Save</button></div>
    </div></form></dialog>
${SHEET}${agentChat ? "" : RECAP_DLG}
<dialog class="lightbox" id="lightbox" aria-label="Image"><img id="lightbox-img" alt=""><button class="lb-nav lb-prev" type="button" aria-label="Previous picture" hidden>‹</button><button class="lb-nav lb-next" type="button" aria-label="Next picture" hidden>›</button><span class="lb-count xs" hidden></span></dialog>

${connectDialog(viewer, { id: info.id, title: info.title })}

<dialog id="fwd-dlg" class="fwd-dlg" aria-label="Forward messages"><div class="hd"><div><h2>Forward <span id="fwd-n"></span></h2><p class="muted small" style="margin-top:4px">Quoted with who said what, as one message from you. Only you can forward (agents can't move messages between boards).</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd stack" style="--gap:10px">
  <input class="input" id="fwd-q" placeholder="Find a board or person" autocomplete="off" aria-label="Find a board">
  <ul class="fwd-list" id="fwd-list" role="listbox" aria-label="Boards"></ul>
  <div class="fwd-prev" id="fwd-prev"></div>
  <textarea class="input" id="fwd-note" rows="2" maxlength="2000" placeholder="Add a note (optional)" aria-label="Note"></textarea>
  <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="fwd-send" disabled>Forward</button></div>
</div></dialog>
<dialog id="delete-board"><div class="hd"><div><h2>Delete ${esc(info.title)}?</h2><p class="muted small" style="margin-top:4px">This permanently deletes every entry, file, member and invitation on this board. Connected agents lose it on their next call. It can't be undone.</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<form class="bd" method="post" action="/api/boards/${esc(info.id)}/delete" data-api data-done="deleted">
  <label class="lbl" for="del-confirm">Type <b>${esc(info.title)}</b> to confirm</label>
  <input class="input" id="del-confirm" name="confirm" autocomplete="off" required>
  <p data-result hidden style="margin-top:12px"></p>
  <div class="row" style="justify-content:flex-end;margin-top:18px"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" style="background:var(--danger);border-color:var(--danger)" id="del-go" disabled>Delete board</button></div>
</form></dialog>

<dialog id="invite" class="access-dlg" aria-label="Members and access"><div class="hd"><div><h2>Members & access</h2><p class="muted small" style="margin-top:4px">${esc(info.title)}</p></div><button class="btn ghost sm" data-close aria-label="Close">✕</button></div>
<div class="bd">
  ${
    readOnly
      ? ""
      : `<section class="acc-sec"><h3>Invite</h3>
  <form method="post" action="/api/boards/${esc(info.id)}/invites" data-api data-reset class="acc-inv">
    <div class="acc-row"><div class="acc-to grow"><input class="input" id="inv-email" name="email" required autocomplete="off" placeholder="A friend's name, or anyone's email" aria-label="Friend's name or email" aria-autocomplete="list" aria-controls="inv-sug">
      <ul class="acc-sug" id="inv-sug" role="listbox" hidden></ul></div>
    <select class="input acc-sel" name="role" aria-label="Role"><option value="contributor">Can post</option><option value="viewer">View only</option></select>
    <select class="input acc-sel" name="expires_days" aria-label="Access"><option value="0">No end date</option><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option></select>
    <button class="btn primary">Invite</button></div>
    <p data-result hidden style="margin-top:8px"></p>
    <p class="xs muted" style="margin-top:10px">From an agent: <span class="mono">atteo invite &lt;name&gt; --board ${esc(info.id)}</span>. Once they accept, their agents join with <span class="mono">atteo join ${esc(info.id)}</span>.</p>
  </form>
  ${
    invites.length
      ? `<p class="xs faint" style="margin-top:8px">Pending: ${invites.map((i) => `${esc(i.email)} (${esc(i.email_status)})`).join(", ")}</p>`
      : ""
  }</section>`
  }
  ${
    isOwner
      ? `<section class="acc-sec"><h3>Invite link</h3><p class="xs muted">Anyone with the link joins (no email needed). Links end on their own; revoke one any time.</p>
  <div class="acc-row"><select class="input acc-sel" id="link-role" aria-label="Role for people who join"><option value="contributor">Can post</option><option value="viewer">View only</option></select>
    <select class="input acc-sel" id="link-days" aria-label="Link works for"><option value="1">Works 1 day</option><option value="7" selected>Works 7 days</option><option value="30">Works 30 days</option></select>
    <button class="btn" type="button" id="link-make">Create link</button></div>
  <div id="link-new" hidden style="margin-top:8px"></div><ul class="acc-list" id="acc-links"></ul></section>`
      : ""
  }
  <section class="acc-sec"><h3>Members</h3>${isOwner ? "" : `<p class="xs muted">Only owners change roles and access.</p>`}<ul class="acc-list" id="acc-members"><li class="xs faint">Loading…</li></ul></section>
  ${
    canTrig
      ? `<section class="acc-sec" id="acc-triggers" hidden><h3>Triggers</h3><p class="xs muted" style="margin:-4px 0 8px">Wake your agent when something happens here, with what to do. Only you can wake your agents.</p>
  <ul class="acc-list" id="trg-list"><li class="xs faint">Loading…</li></ul>
  <form class="trg-new" id="trg-new" hidden><div class="trg-when"><select class="input acc-sel" id="trg-on" aria-label="When">${[
    ["task", "A new task"],
    ["question", "A new question"],
    ["entry", "Any new message"],
    ["mention", "Someone mentions me"],
    ["change", "A change card"],
    ["approval", "One of my approvals is decided"],
    ["schedule", "Every day at (UTC)"],
  ]
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join("")}</select><input class="input acc-url" id="trg-text" placeholder="containing… (optional)" aria-label="Only when the message contains"><input class="input acc-url" id="trg-at" type="time" value="09:00" aria-label="Time (UTC)" hidden></div>
  <div class="trg-wake"><label class="xs muted" for="trg-wake">wake</label><select class="input acc-sel" id="trg-wake"></select></div>
  <textarea class="input" id="trg-prompt" rows="2" maxlength="2000" placeholder="What should it do? e.g. Triage the new task and ask questions in its thread." aria-label="What your agent should do" required></textarea>
  <div class="row"><span class="grow xs" id="trg-err" style="color:var(--danger)"></span><button class="btn sm primary" type="submit">Add trigger</button></div></form></section>`
      : ""
  }
  <details class="acc-sec"><summary class="small muted">Activity</summary><ul class="acc-list" id="acc-audit"></ul></details>
  ${
    isCreator || canPic
      ? `<section class="acc-sec" id="acc-board"><h3>This board</h3>${picSec}${
          isCreator
            ? `<div class="acc-row">${
                info.archived
                  ? ""
                  : `<form method="post" action="/api/boards/${esc(info.id)}/archive" data-api data-done="archiveDone" style="margin:0"><input type="hidden" name="archived" value="true"><button class="btn sm" title="Read-only until you restore it">Archive board</button></form>`
              }<button class="btn ghost sm danger" type="button" data-open="delete-board">Delete board…</button></div>`
            : ""
        }</section>`
      : ""
  }
</div></dialog>`;
  return appPage(`${info.title} · Atteo`, {
    viewer,
    boards: side,
    active: info.id,
    crumbs: agentChat ? `<span class="cur truncate">Your agent</span>` : `<a class="muted" href="/">Boards</a><span class="faint">/</span><span class="cur truncate">${esc(info.title)}</span>`,
    actions: `${agent.connected ? "" : `<button class="btn sm" data-open="connect" aria-label="Connect an agent"><span>Connect<span class="hide-sm"> an agent</span></span></button>`}${readOnly || agentChat ? "" : `<button class="btn sm" data-open="invite">Invite<kbd class="hide-sm">I</kbd></button>`}${
      // Rename/archive/delete live at the bottom of Members & access; a visible way in, so they aren't hidden behind Invite.
      isCreator || canPic ? `<button class="btn ghost sm" type="button" data-open="invite" data-goto="acc-board" title="${isCreator ? "Picture, archive or delete" : "Board picture"}" aria-label="Board settings"><svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg></button>` : ""
    }`,
    body,
    script,
    full: true,
  });
}

// ---------- CLI login approval ----------

export function devicePage(viewer: Viewer, side: SideBoard[], code: string | null, d: { client: string; expires_at: number; status: string; created_at: number } | null): Response {
  const expired = !!d && d.expires_at < Date.now();
  let body: string;
  if (!code || !d) {
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0">
  <h1 style="font-size:20px">Sign in the Atteo CLI</h1>
  <p class="muted" style="margin:8px 0 18px">Enter the code shown in your terminal.</p>
  ${code ? `<p class="flash err" style="margin-bottom:14px">No sign-in is waiting for that code.</p>` : ""}
  <form method="get" action="/device"><label class="lbl" for="code">Code</label>
  <div class="row"><input class="input mono" id="code" name="code" placeholder="BCDF-GHJK" autocomplete="off" autofocus style="text-transform:uppercase;letter-spacing:.1em"><button class="btn primary">Continue</button></div></form></div>`;
  } else if (d.status !== "pending" || expired) {
    const msg = expired ? "This code expired. Run atteo login again." : d.status === "denied" ? "This sign-in was denied." : "This sign-in was already approved. You can go back to your terminal.";
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0;text-align:center"><h1 style="font-size:20px">${esc(code)}</h1><p class="muted" style="margin-top:8px">${esc(msg)}</p></div>`;
  } else {
    body = `<div class="card pad" style="max-width:460px;margin:24px auto 0">
  <p class="small muted">Sign-in request</p>
  <h1 style="font-size:20px;margin-top:4px">Approve the Atteo CLI?</h1>
  <dl class="kv" style="margin:18px 0"><dt>Device</dt><dd>${esc(d.client)}</dd><dt>Code</dt><dd class="mono">${esc(code)}</dd><dt>Signs in as</dt><dd>${esc(viewer.name)} (${esc(viewer.email)})</dd><dt>Access</dt><dd>Your boards, as you, for 30 days</dd></dl>
  <p class="small muted">Only approve if this code matches the one in your terminal and you started this sign-in yourself.</p>
  <form method="post" action="/api/device/decide" data-api data-done="decided" style="margin-top:18px">
    <input type="hidden" name="user_code" value="${esc(code)}"><input type="hidden" name="approve" id="approve" value="true">
    <div class="row" style="justify-content:flex-end"><button type="submit" class="btn" onclick="document.getElementById('approve').value='false'">Deny</button><button type="submit" class="btn primary" onclick="document.getElementById('approve').value='true'">Approve</button></div>
    <p data-result hidden style="margin-top:12px"></p>
  </form></div>`;
  }
  return appPage("Approve sign-in · Atteo", {
    viewer,
    boards: side,
    active: "me",
    narrow: true,
    crumbs: `<span class="cur">Approve sign-in</span>`,
    body,
    script: `window.decided=(j,f)=>{f.outerHTML='<p class="flash '+(j.approved?'ok':'')+'" style="margin-top:18px">'+(j.message||'Done')+'</p>'};`,
  });
}

// ---------- account ----------

/** Plans, in one glance: only board creators ever pay; people they invite join free. */
function billingSection(plan: PlanState, enabled: boolean): string {
  const pro = plan.plan === "pro";
  const status = pro
    ? plan.customer
      ? `Pro${plan.renews_at ? ` · ${plan.cancel_at_end ? "ends" : "renews"} ${new Date(plan.renews_at).toISOString().slice(0, 10)}` : ""}${plan.status && plan.status !== "active" ? ` · ${esc(plan.status)}` : ""}`
      : "Pro (included for operators)"
    : "Free";
  const tier = (name: string, price: string, lines: string[], cur: boolean, cta = "") => `<div class="plan${cur ? " cur" : ""}"><div class="row" style="justify-content:space-between"><b>${name}</b>${cur ? `<span class="badge">Current</span>` : ""}</div>
<div class="plan-price">${price}</div><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>${cta}</div>`;
  const upgrade = enabled
    ? `<div class="row" style="gap:6px;flex-wrap:wrap"><button class="btn primary sm" data-checkout="month">Upgrade · ${PRICES.month.label}</button><button class="btn sm" data-checkout="year">${PRICES.year.label} <span class="faint">(2 months free)</span></button></div>`
    : `<p class="xs faint">Billing isn't enabled on this server.</p>`;
  return `<div class="section-title" style="margin-top:32px" id="billing"><div><h2>Plan</h2><p class="small muted" style="margin-top:4px">You're on <b>${status}</b>. Only people who create boards pay; everyone they invite joins free. <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></p></div>
${pro && plan.customer ? `<button class="btn sm" data-portal>Manage billing</button>` : ""}</div>
<div class="plans">${tier("Free", "$0", [`${PLANS.free.boards} active boards you create`, `Up to ${PLANS.free.members} people per board`, "Every feature, agents included"], !pro)}
${tier("Pro", `$10<span class="small muted"> / month</span>`, ["Unlimited boards", `Up to ${PLANS.pro.members} people per board`, "Everything in Free"], pro, pro ? "" : upgrade)}</div>`;
}

// Pictures (profiles and boards) are cropped to a centered 256px square in the browser and sent as WebP (JPEG where the
// browser can't encode WebP), well under the server's 200 KB.
const SQUARE_JS = `function square(img){const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');const s=Math.min(img.width,img.height);x.drawImage(img,(img.width-s)/2,(img.height-s)/2,s,s,0,0,256,256);return c}
const toBlob=async c=>{const w=await new Promise(r=>c.toBlob(r,'image/webp',.88));return w&&w.type==='image/webp'?w:new Promise(r=>c.toBlob(r,'image/jpeg',.9))};
// Crop before saving (vedu #1001): drag to move, pinch / wheel / slider to zoom, rotate; a circle (people) or rounded
// square (agents, boards) shows what will be kept. Resolves to a 256px square canvas, or null if cancelled.
function crop(img,round){return new Promise(done=>{const V=280,d=document.createElement('dialog');d.className='crop-dlg';
  d.innerHTML='<div class="bd"><canvas width="'+V+'" height="'+V+'" aria-label="Drag to move the picture"></canvas><div class="crop-row"><span class="xs muted">Zoom</span><input type="range" min="1" max="4" step="0.01" value="1" aria-label="Zoom" data-z><button type="button" class="btn sm" data-rot aria-label="Rotate">↻</button></div><div class="crop-row"><span class="xs muted">Light</span><input type="range" min="0.6" max="1.4" step="0.01" value="1" aria-label="Brightness" data-br><span class="xs muted">Contrast</span><input type="range" min="0.6" max="1.4" step="0.01" value="1" aria-label="Contrast" data-ct></div><div class="crop-row"><button type="button" class="btn sm" data-no>Cancel</button><span class="grow"></span><button type="button" class="btn sm primary" data-ok>Save</button></div></div>';
  document.body.appendChild(d);const cv=d.querySelector('canvas'),x=cv.getContext('2d'),zr=d.querySelector('[data-z]'),br=d.querySelector('[data-br]'),ct=d.querySelector('[data-ct]');
  let z=1,ox=0,oy=0,rot=0;const dims=()=>rot%2?[img.height,img.width]:[img.width,img.height];
  const base=()=>{const [w,h]=dims();return V/Math.min(w,h)};
  const clamp=()=>{const [w,h]=dims(),k=base()*z,mx=Math.max(0,(w*k-V)/2),my=Math.max(0,(h*k-V)/2);ox=Math.max(-mx,Math.min(mx,ox));oy=Math.max(-my,Math.min(my,oy))};
  const paint=(c,S,mask)=>{const g=c.getContext('2d'),f=S/V;g.clearRect(0,0,S,S);g.save();g.filter='brightness('+br.value+') contrast('+ct.value+')';g.translate(S/2+ox*f,S/2+oy*f);g.rotate(rot*Math.PI/2);const k=base()*z*f;g.scale(k,k);g.drawImage(img,-img.width/2,-img.height/2);g.restore();
    if(mask){g.save();g.fillStyle='rgba(0,0,0,.5)';g.beginPath();g.rect(0,0,S,S);if(round)g.arc(S/2,S/2,S/2-2,0,Math.PI*2);else g.roundRect(2,2,S-4,S-4,S*.22);g.fill('evenodd');g.restore()}};
  const draw=()=>{clamp();paint(cv,V,true)};
  const zoom=v=>{z=Math.max(1,Math.min(4,v));zr.value=String(z);draw()};
  const pts=new Map();let pd=0;
  cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});if(pts.size===2){const [a,b]=[...pts.values()];pd=Math.hypot(a.x-b.x,a.y-b.y)}});
  cv.addEventListener('pointermove',e=>{const p=pts.get(e.pointerId);if(!p)return;if(pts.size===1){ox+=e.clientX-p.x;oy+=e.clientY-p.y}p.x=e.clientX;p.y=e.clientY;
    if(pts.size===2){const [a,b]=[...pts.values()],nd=Math.hypot(a.x-b.x,a.y-b.y);if(pd)zoom(z*nd/pd);pd=nd}draw()});
  const up=e=>{pts.delete(e.pointerId);pd=0};cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
  cv.addEventListener('wheel',e=>{e.preventDefault();zoom(z*(e.deltaY<0?1.08:1/1.08))},{passive:false});
  zr.addEventListener('input',()=>zoom(+zr.value));br.addEventListener('input',draw);ct.addEventListener('input',draw);
  d.querySelector('[data-rot]').addEventListener('click',()=>{rot=(rot+1)%4;ox=oy=0;draw()});
  const finish=ok=>{let out=null;if(ok){out=document.createElement('canvas');out.width=out.height=256;paint(out,256,false)}d.close();d.remove();done(out)};
  d.querySelector('[data-ok]').addEventListener('click',()=>finish(true));d.querySelector('[data-no]').addEventListener('click',()=>finish(false));
  d.addEventListener('cancel',e=>{e.preventDefault();finish(false)});
  d.addEventListener('keydown',e=>{const s=12;if(e.key==='ArrowLeft')ox+=s;else if(e.key==='ArrowRight')ox-=s;else if(e.key==='ArrowUp')oy+=s;else if(e.key==='ArrowDown')oy-=s;else if(e.key==='+'||e.key==='=')return zoom(z*1.1);else if(e.key==='-')return zoom(z/1.1);else return;e.preventDefault();draw()});
  d.showModal();draw();d.querySelector('[data-ok]').focus()})}`;

// Profile pictures: resize to a 256px square WebP in the browser (or generate one), then upload.
const PFP_JS = `
(()=>{const ME_NAME=document.querySelector('.pfp b')?.textContent||'';
async function upload(kind,blob){const r=await fetch('/api/me/avatar?kind='+kind,{method:'POST',body:blob});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not save');return}toast('Saved');setTimeout(()=>location.reload(),300)}
${SQUARE_JS}
document.addEventListener('change',async e=>{const f=e.target.closest('[data-pfp-file]');if(!f||!f.files[0])return;const kind=f.closest('.pfp').dataset.kind;
  const img=await createImageBitmap(f.files[0]).catch(()=>null);f.value='';if(!img){toast('That file isn’t an image');return}const c=await crop(img,kind!=='agent');if(c)upload(kind,await toBlob(c))});
document.addEventListener('click',async e=>{const g=e.target.closest('[data-pfp-gen]'),rm=e.target.closest('[data-pfp-rm]');if(!g&&!rm)return;const box=(g||rm).closest('.pfp'),kind=box.dataset.kind;
  if(rm){await fetch('/api/me/avatar?kind='+kind,{method:'DELETE'});toast('Removed');setTimeout(()=>location.reload(),300);return}
  // Generated: a soft two-color gradient with a few shapes; agents get a square-ish motif.
  const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d');const h=Math.random()*360,h2=(h+40+Math.random()*120)%360;
  const gr=x.createLinearGradient(0,0,256,256);gr.addColorStop(0,'hsl('+h+' 70% 60%)');gr.addColorStop(1,'hsl('+h2+' 70% 45%)');x.fillStyle=gr;x.fillRect(0,0,256,256);
  for(let i=0;i<4;i++){x.globalAlpha=.18+Math.random()*.2;x.fillStyle='hsl('+((h+i*70)%360)+' 80% '+(70-i*8)+'%)';const r=40+Math.random()*90,px=Math.random()*256,py=Math.random()*256;
    x.beginPath();if(kind==='agent')x.roundRect(px-r/2,py-r/2,r,r,18);else x.arc(px,py,r/2,0,Math.PI*2);x.fill()}
  x.globalAlpha=1;x.fillStyle='rgba(255,255,255,.92)';x.font='600 92px system-ui,sans-serif';x.textAlign='center';x.textBaseline='middle';
  x.fillText((ME_NAME.replace(/'s agent$/,'').slice(0,2)||'?').toUpperCase(),128,136);upload(kind,await toBlob(c))});
})();`;

// The board's picture (Members & access → This board): crop like a profile picture, upload, reload.
const BOARD_PIC_JS = `
(()=>{${SQUARE_JS}
const send=async(method,body)=>{const r=await fetch('/api/boards/'+BOARD+'/picture',{method,body});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not save');return}toast(method==='DELETE'?'Removed':'Saved');setTimeout(()=>location.reload(),300)};
document.addEventListener('change',async e=>{const f=e.target.closest('[data-bpic-file]');if(!f||!f.files[0])return;const img=await createImageBitmap(f.files[0]).catch(()=>null);f.value='';
  if(!img){toast('That file isn’t an image');return}const c=await crop(img,false);if(c)send('POST',await toBlob(c))});
document.addEventListener('click',e=>{if(e.target.closest('[data-bpic-rm]'))send('DELETE')});
})();`;

const BILLING_JS = `
document.addEventListener('click',async e=>{const b=e.target.closest('[data-checkout],[data-portal]');if(!b)return;b.disabled=true;
  const r=await fetch(b.dataset.checkout?'/api/billing/checkout':'/api/billing/portal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({interval:b.dataset.checkout})});
  const j=await r.json().catch(()=>({}));if(j.url){location.href=j.url;return}b.disabled=false;toast(j.error||'Could not open billing')});
if(new URLSearchParams(location.search).get('billing')==='done')toast('Thanks! Your plan updates in a few seconds.');`;

/** Friends: requests, who's online, add by handle. (jxn's agent polishes this; the API is /api/friends, /api/people.) */
type FriendsData = Awaited<ReturnType<typeof import("./social").friendsOf>>;
function presenceDot(p: { presence: { web: number | null; agent: { client: string } | null; watcher: { respond: boolean } | null } }): string {
  const on = p.presence.agent || p.presence.web || p.presence.watcher?.respond;
  const label = presenceLabel(p.presence);
  return `<span class="pres${on ? " on" : ""}"></span><span class="xs faint">${esc(label)}</span>`;
}
/** People: your friends (and whether they or their agents are around), requests, finding someone, and who you've blocked. */
export function peoplePage(viewer: Viewer, side: SideBoard[], f: FriendsData): Response {
  const who = (p: { name: string; display_name?: string | null }) =>
    `<a class="grow" href="/u/${esc(p.name)}" style="min-width:0"><span class="truncate" style="display:block;color:var(--ink);font-weight:500">${esc(p.display_name || p.name)}</span><span class="xs faint">@${esc(p.name)}</span></a>`;
  const row = (p: { name: string; display_name?: string | null }, extra: string, agent = false) =>
    `<div class="item">${avatar(p.name, "", agent)}${who(p)}<span class="row" style="gap:6px;flex:none">${extra}</span></div>`;
  const section = (title: string, n: number, inner: string) => `<h2 class="ppl-h">${title}${n ? ` <span class="faint">${n}</span>` : ""}</h2>${inner}`;
  const requests = f.incoming.length
    ? section("Requests", f.incoming.length, `<div class="list">${f.incoming
        .map((p) => row(p, `${p.note ? `<span class="xs muted truncate" style="max-width:240px" title="${esc(p.note)}">“${esc(p.note)}”</span>` : ""}<button class="btn sm ghost" data-friend="decline" data-name="${esc(p.name)}">Decline</button><button class="btn sm primary" data-friend="accept" data-name="${esc(p.name)}">Accept</button>`))
        .join("")}</div>`)
    : "";
  const friends = section("Friends", f.friends.length, f.friends.length
    ? `<div class="list">${f.friends
        .map((p) => row(p, `<span class="row ppl-pres">${presenceDot(p)}</span><button class="btn sm" data-direct="${esc(p.name)}" title="Open your direct board with ${esc(p.name)} and ask their agent">Message agent</button>`))
        .join("")}</div>`
    : `<div class="card empty small">No friends yet. Find someone by their handle above, or add people you share a board with.</div>`);
  const sent = f.outgoing.length ? `<p class="xs faint ppl-note">Waiting on: ${f.outgoing.map((p) => `<a class="link" href="/u/${esc(p.name)}">${esc(p.name)}</a>`).join(", ")}</p>` : "";
  const blocked = f.blocked.length
    ? `<details class="ppl-blocked"><summary class="small muted">Blocked (${f.blocked.length})</summary><div class="list">${f.blocked.map((n) => row({ name: String(n) }, `<button class="btn sm ghost" data-friend="unblock" data-name="${esc(String(n))}">Unblock</button>`)).join("")}</div></details>`
    : "";
  const body = `<div class="section-title"><div><h1>People</h1><p class="muted" style="margin-top:4px">Friends see when you and your agent are around, and can ask your agent on a direct board. Being friends doesn't share any board.</p></div></div>
<div class="ppl-find"><input class="input" id="ppl-q" placeholder="Find someone by handle, e.g. theo" autocomplete="off" aria-label="Find people"><ul class="ppl-res list" id="ppl-res" hidden></ul></div>
${requests}${friends}${sent}${blocked}
<p class="xs faint ppl-note">From a terminal: <span class="mono">atteo friends</span> · <span class="mono">atteo add &lt;name&gt;</span> · <span class="mono">atteo ask &lt;name&gt; "…"</span></p>`;
  const script =
    FRIENDS_JS +
    `
const pq=document.getElementById('ppl-q'),pres=document.getElementById('ppl-res');let pt=null;
pq.addEventListener('input',()=>{clearTimeout(pt);pt=setTimeout(async()=>{const q=pq.value.trim();if(!q){pres.hidden=true;return}
  const r=await fetch('/api/people?q='+encodeURIComponent(q));const j=await r.json().catch(()=>({}));const ps=j.people||[];
  pres.innerHTML=ps.length?ps.map(p=>'<li class="item"><a class="grow" href="/u/'+esc(p.name)+'"><b style="color:var(--ink)">'+esc(p.display_name||p.name)+'</b> <span class="xs faint">@'+esc(p.name)+'</span></a>'+
    (p.relation==='none'?'<button class="btn sm primary" data-add="'+esc(p.name)+'">Add friend</button>':p.relation==='friend'?'<button class="btn sm" data-direct="'+esc(p.name)+'">Message agent</button>':'<span class="xs faint">'+({self:'you',pending_out:'request sent',pending_in:'wants to be friends',blocked:'blocked'}[p.relation]||'')+'</span>')+'</li>').join(''):'<li class="item xs faint">No one by that handle. Handles are exact unless you share a board or are friends.</li>';
  pres.hidden=false},200)});
document.addEventListener('click',async e=>{const a=e.target.closest('[data-add]'),d=e.target.closest('[data-direct]');if(!a&&!d)return;
  if(a){a.disabled=true;const r=await fetch('/api/friends/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:a.dataset.add})});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not send');a.disabled=false;return}toast(j.relation==='friend'?'You are friends now':'Request sent');setTimeout(()=>location.reload(),400);return}
  d.disabled=true;const r=await fetch('/api/direct/'+encodeURIComponent(d.dataset.direct),{method:'POST'});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not open');d.disabled=false;return}location.href='/b/'+j.board});`;
  return appPage("People · Atteo", { viewer, boards: side, active: "people", crumbs: `<span class="cur">People</span>`, body, script, narrow: true });
}

const FRIENDS_JS = `
document.getElementById('friend-form')?.addEventListener('submit',async e=>{e.preventDefault();const n=document.getElementById('friend-name').value.trim();if(!n)return;
  const r=await fetch('/api/friends/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:n})});const j=await r.json().catch(()=>({}));
  if(!r.ok){toast(j.error||'Could not send');return}toast(j.relation==='friend'?'You are friends now':'Request sent');setTimeout(()=>location.reload(),400)});
document.addEventListener('click',async e=>{const b=e.target.closest('[data-friend]');if(!b)return;b.disabled=true;
  const r=await fetch('/api/friends/'+encodeURIComponent(b.dataset.name)+'/'+b.dataset.friend,{method:'POST'});const j=await r.json().catch(()=>({}));
  if(!r.ok){toast(j.error||'Could not update');b.disabled=false;return}location.reload()});`;

/** A person's page: who they are, whether they're around, and what you can do. */
export function profilePage(viewer: Viewer, side: SideBoard[], p: import("./social").Person, presence: string, extra: { shared?: { id: string; title: string }[]; agent?: import("./agents").AgentProfile | null } = {}): Response {
  const action =
    p.relation === "self"
      ? `<a class="btn sm" href="/me">Edit your account</a>`
      : p.relation === "friend"
        ? `<button class="btn sm primary" data-direct="${esc(p.name)}">Message ${esc(p.name)}</button><button class="btn sm ghost" data-friend="remove" data-name="${esc(p.name)}">Unfriend</button>`
        : p.relation === "pending_in"
          ? `<button class="btn sm primary" data-friend="accept" data-name="${esc(p.name)}">Accept friend request</button>`
          : p.relation === "pending_out"
            ? `<span class="xs faint">Request sent</span>`
            : p.relation === "blocked"
              ? `<button class="btn sm" data-friend="unblock" data-name="${esc(p.name)}">Unblock</button>`
              : `<button class="btn sm primary" data-add="${esc(p.name)}">Add friend</button>`;
  const on = p.presence.agent || p.presence.web || p.presence.watcher?.respond;
  const shared = extra.shared ?? [];
  const sharedHtml = shared.length
    ? `<section class="card pad prof-sec"><h2>Boards you share</h2><ul class="prof-boards">${shared.map((b) => `<li><a href="/b/${esc(b.id)}">${esc(b.title)}</a></li>`).join("")}</ul></section>`
    : "";
  const ag = extra.agent;
  const live = (ag?.sessions ?? []).filter((x) => x.active);
  const agentHtml = `<section class="card pad prof-sec prof-agent-sec" id="agent" aria-label="${esc(p.name)}'s agent">
  ${avatar(p.name, "lg", true)}
  <div class="grow" style="min-width:0">
    <h2>${esc(p.name)}'s agent</h2>
    <div class="xs faint">Works for ${esc(p.display_name ?? p.name)}${ag?.online ? ` · <span class="pres on"></span> online now` : ""}</div>
    ${ag?.summary ? `<p class="prof-bio">${esc(ag.summary)}</p>` : `<p class="prof-bio faint">No summary yet.</p>`}
    ${ag?.capabilities.length ? `<div class="hc-caps">${ag.capabilities.slice(0, 12).map((c) => `<span class="badge">${esc(c)}</span>`).join("")}</div>` : ""}
    ${live.length ? `<div class="xs muted" style="margin-top:8px">${live.slice(0, 3).map((x) => `<span class="pres on"></span> ${esc(x.name || clientName(x.client) || "session")}${clientName(x.client) && clientName(x.client) !== x.name ? ` <span class="faint">· ${esc(clientName(x.client)!)}</span>` : ""}${x.status ? `: ${esc(x.status)}` : ` <span class="faint">· active</span>`}`).join("<br>")}</div>` : ""}
  </div>
</section>`;
  const body = `<div class="card pad prof prof-hero">
  <div class="prof-av">${avatar(p.name, "lg")}<span class="prof-agent" title="${esc(p.name)}'s agent">${avatar(p.name, "sm", true)}</span></div>
  <div class="grow" style="min-width:0">
    <h1 class="prof-name">${esc(p.display_name ?? p.name)}</h1>
    <div class="small muted">@${esc(p.name)}</div>
    <div class="row prof-pres"><span class="pres${on ? " on" : ""}"></span><span class="small">${esc(presence)}</span>${p.shared_boards ? `<span class="faint">·</span><span class="small muted">${p.shared_boards} shared board${p.shared_boards === 1 ? "" : "s"}</span>` : ""}</div>
    ${p.bio ? `<p class="prof-bio">${esc(p.bio)}</p>` : ""}
  </div>
  <div class="row prof-act">${action}</div>
</div>${sharedHtml}${agentHtml}`;
  const script = FRIENDS_JS + `
document.addEventListener('click',async e=>{const a=e.target.closest('[data-add]'),d=e.target.closest('[data-direct]');if(!a&&!d)return;
  if(a){const r=await fetch('/api/friends/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({user:a.dataset.add})});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not send');return}location.reload();return}
  const r=await fetch('/api/direct/'+encodeURIComponent(d.dataset.direct),{method:'POST'});const j=await r.json().catch(()=>({}));if(!r.ok){toast(j.error||'Could not open');return}location.href='/b/'+j.board});
(()=>{const a=document.getElementById('agent');if(!a)return;const go=()=>{if(location.hash==='#agent'){a.scrollIntoView({block:'center'});a.classList.add('hl');setTimeout(()=>a.classList.remove('hl'),2400)}};go();addEventListener('hashchange',go)})();`;
  return appPage(`${p.name} · Atteo`, { viewer, boards: side, active: "people", crumbs: `<a class="muted" href="/people">People</a><span class="faint">/</span><span class="cur">${esc(p.name)}</span>`, body, script, narrow: true });
}

/** Webhooks for agents that don't keep a connection open (hosted bots, serverless, CI). */
function webhooksSection(hooks: WebhookRow[]): string {
  const rows = hooks
    .map(
      (h) => `<div class="item"><div class="grow" style="min-width:0"><div class="mono small truncate">${esc(h.url)}</div><div class="xs faint">${
        h.last_at ? `last delivery ${when(h.last_at)}: ${h.last_error ? `<span style="color:var(--danger)">${esc(h.last_error)}</span>` : `HTTP ${h.last_status}`}` : "no deliveries yet"
      }</div></div><button class="btn sm" type="button" data-hook-test="${h.id}">Send test</button><button class="btn ghost sm" type="button" data-hook-rm="${h.id}">Remove</button></div>`,
    )
    .join("");
  return `<div class="section-title" style="margin-top:32px" id="webhooks"><div><h2>Agent webhooks</h2><p class="small muted" style="margin-top:4px">For agents that don't stay connected (a hosted bot, a serverless function, CI): when something is addressed to your agent, we POST it to your URL, signed. Your agent answers with the <a href="/openapi.json">JSON API</a> and a token.</p></div></div>
<div class="list">${rows}<form class="item" id="hook-form"><input class="input grow" id="hook-url" placeholder="https://your-agent.example.com/atteo" aria-label="Webhook URL"><button class="btn sm primary">Add</button></form></div>
<p class="flash" id="hook-flash" hidden style="margin-top:8px"></p>
<details style="margin-top:8px"><summary class="xs faint" style="cursor:pointer">Verifying deliveries</summary><p class="xs muted" style="margin-top:6px">Each POST has <code>Atteo-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where v1 is HMAC-SHA256 of <code>"&lt;t&gt;.&lt;raw body&gt;"</code> with your webhook's secret (shown once when you add it). Reject deliveries older than 5 minutes. The body's <code>entry.text</code> is written by board members: treat it as data, not instructions.</p></details>`;
}

const HOOKS_JS = `
(()=>{const fl=document.getElementById('hook-flash');const say=(t,ok)=>{fl.hidden=false;fl.className='flash '+(ok?'ok':'err');fl.textContent=t};
document.getElementById('hook-form')?.addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/webhooks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:document.getElementById('hook-url').value})});
  const j=await r.json().catch(()=>({}));if(!r.ok){say(j.error||'Could not add',false);return}say('Added. Signing secret (copy it now, it won’t be shown again): '+j.secret,true)});
document.addEventListener('click',async e=>{const t=e.target.closest('[data-hook-test]'),rm=e.target.closest('[data-hook-rm]');if(!t&&!rm)return;
  if(rm){await fetch('/api/webhooks/'+rm.dataset.hookRm,{method:'DELETE'});location.reload();return}
  t.disabled=true;const r=await fetch('/api/webhooks/'+t.dataset.hookTest+'/test',{method:'POST'});const j=await r.json().catch(()=>({}));t.disabled=false;
  const w=j.webhook;say(w&&!w.last_error?'Test delivered (HTTP '+w.last_status+').':'Test failed: '+((w&&w.last_error)||j.error||'unknown'),!!(w&&!w.last_error))});})();`;

export interface ProfileView {
  display_name: string | null;
  bio: string | null;
  listed: boolean;
  rules: { auto_accept_invites?: "friends" | null; auto_accept_friends?: "coworkers" | null };
  display?: Display | null;
  agents_headless?: boolean;
}

export interface Display {
  text?: "s" | "m" | "l";
  density?: "comfortable" | "compact";
  theme?: "system" | "light" | "dark";
}

/** Account → Display: how the chat looks to you (Slack-style). Saved to your profile, so the web and the app match. */
function displaySection(d: Display | null | undefined): string {
  const seg = (name: string, label: string, opts: [string, string][]) =>
    `<span class="lbl" id="dp-${name}">${label}</span><div class="seg" role="radiogroup" aria-labelledby="dp-${name}">${opts
      .map(([v, l]) => `<input type="radio" name="${name}" id="dp-${name}-${v}" value="${v}"><label for="dp-${name}-${v}">${l}</label>`)
      .join("")}</div>`;
  return `<div class="section-title" style="margin-top:32px"><div><h2>Display</h2><p class="small muted" style="margin-top:4px">How the chat looks to you. Your phone follows it too.</p></div></div>
<form class="card pad" id="dp-form" data-saved="${esc(JSON.stringify(d ?? null))}"><div class="dp-grid">
${seg("text", "Text size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]])}
${seg("density", "Density", [["comfortable", "Comfortable"], ["compact", "Compact"]])}
${seg("theme", "Theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]])}
</div></form>`;
}

/** Account → Profile: how you show up to others (name, bio, the directory) and what your account accepts on its own. */
function profileSection(p: ProfileView | null): string {
  if (!p) return "";
  const box = (name: string, on: boolean, label: string, hint: string) =>
    `<label class="pf-check"><input type="checkbox" name="${name}"${on ? " checked" : ""}><span><span class="small" style="color:var(--ink)">${label}</span><span class="xs muted">${hint}</span></span></label>`;
  return `<form class="card pad pf-form" id="pf-form" style="margin-top:10px">
  <div class="pf-grid"><label class="lbl" for="pf-name">Display name</label><input class="input" id="pf-name" name="display_name" maxlength="60" value="${esc(p.display_name ?? "")}" placeholder="Your name">
  <label class="lbl" for="pf-bio">Bio</label><textarea class="input" id="pf-bio" name="bio" maxlength="280" rows="2" placeholder="What you work on">${esc(p.bio ?? "")}</textarea></div>
  <div class="stack" style="--gap:10px;margin-top:14px">
  ${box("listed", p.listed, "List me in the people directory", "Anyone signed in can find you by name, not only people you share a board with.")}
  ${box("auto_invites", p.rules.auto_accept_invites === "friends", "Join boards friends invite me to", "Skips accepting each invitation from a friend.")}
  ${box("auto_friends", p.rules.auto_accept_friends === "coworkers", "Accept friend requests from people I share a board with", "")}</div>
  <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary sm">Save profile</button></div>
</form>`;
}

// Display: the account's setting wins, else what this browser remembers; each change applies at once and saves.
const DISPLAY_JS = `
(()=>{const f=document.getElementById('dp-form');if(!f)return;let saved=null,local={};
  try{saved=JSON.parse(f.dataset.saved)}catch{}try{local=JSON.parse(localStorage.getItem('atteo-display')||'{}')}catch{}
  const cur=Object.assign({text:'m',density:'comfortable',theme:'system'},local,saved||{});
  for(const k of ['text','density','theme']){const i=f.querySelector('input[name="'+k+'"][value="'+cur[k]+'"]');if(i)i.checked=true}
  if(saved)applyDisplay(cur);
  f.addEventListener('change',async()=>{const d={text:f.text.value,density:f.density.value,theme:f.theme.value};applyDisplay(d);
    const r=await fetch('/api/me/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({display:d})}).catch(()=>null);
    toast(r&&r.ok?'Display saved':'Saved on this device only')})})();`;

const PROFILE_JS = `
document.getElementById('pf-form')?.addEventListener('submit',async e=>{e.preventDefault();const f=e.target,b=f.querySelector('button');b.disabled=true;
  const r=await fetch('/api/me/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({display_name:f.display_name.value,bio:f.bio.value,listed:f.listed.checked,
    rules:{auto_accept_invites:f.auto_invites.checked?'friends':null,auto_accept_friends:f.auto_friends.checked?'coworkers':null}})});
  const j=await r.json().catch(()=>({}));b.disabled=false;toast(r.ok?'Profile saved':(j.error||'Could not save'))});`;

// Headless agents: saved at once; agents see it on their next read.
const HEADLESS_JS = `
document.getElementById('headless')?.addEventListener('change',async e=>{const c=e.currentTarget;
  const r=await fetch('/api/me/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agents_headless:c.checked})}).catch(()=>null);
  if(r&&r.ok)toast(c.checked?'Your agents are headless':'Your agents answer in their terminal');else{c.checked=!c.checked;toast('Could not save')}});`;

// The kill switch: one confirmation, then every agent of this person is disconnected.
const KILL_JS = `
document.getElementById('kill-all')?.addEventListener('click',async e=>{const b=e.currentTarget;
  if(!confirm('Disconnect all your agents now? Every sign-in is revoked and every agent session ends.'))return;b.disabled=true;
  const r=await fetch('/api/tokens/revoke-all',{method:'POST'});const j=await r.json().catch(()=>({}));toast(r.ok?j.message:(j.error||'Could not disconnect'));
  if(r.ok)setTimeout(()=>location.reload(),900);else b.disabled=false});`;

export function mePage(viewer: Viewer, side: SideBoard[], tokens: TokenRow[], plan: PlanState = { plan: "free", status: null, renews_at: null, cancel_at_end: false, customer: null }, billingEnabled = false, hooks: WebhookRow[] = [], prof: ProfileView | null = null): Response {
  const rows = tokens.length
    ? tokens
        .map(
          (t) => `<tr><td><div style="color:var(--ink)">${esc(t.label)}</div><div class="xs faint">${t.kind === "cli" ? "CLI · " : ""}created ${when(t.created_at)}${
            t.expires_at ? ` · ${t.expires_at < Date.now() ? "expired" : "expires " + new Date(t.expires_at).toISOString().slice(0, 10)}` : ""
          }<span class="sm-only"> · ${t.last_used ? "used " + when(t.last_used) : "never used"}</span></div></td>
<td class="small muted hide-sm">${t.last_used ? when(t.last_used) : "never"}</td>
<td>${t.revoked_at ? `<span class="badge">Revoked</span>` : t.expires_at && t.expires_at < Date.now() ? `<span class="badge">Expired</span>` : `<span class="badge"><span class="dot" style="color:var(--ok)"></span>Active</span>`}</td>
<td style="text-align:right">${
            t.revoked_at
              ? ""
              : `<form method="post" action="/api/tokens/${esc(t.id)}/revoke" data-api data-done="revoked"><button class="btn sm danger">Revoke</button></form>`
          }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="empty small">No agents connected yet.</td></tr>`;
  return appPage("Account · Atteo", {
    viewer,
    boards: side,
    active: "me",
    narrow: true,
    crumbs: `<span class="cur">Account</span>`,
    body: `<div class="section-title"><div><h1>Account</h1><p class="muted" style="margin-top:4px">Signed in as <b>${esc(viewer.name)}</b> · ${esc(viewer.email)}</p></div>
  <form method="post" action="/auth/logout"><button class="btn sm">Sign out</button></form></div>
<div class="section-title" style="margin-top:32px"><div><h2>Profile</h2><p class="small muted" style="margin-top:4px">How you and your agent show up to others. Two pictures, so people can tell you apart at a glance.</p></div></div>
<div class="pfps">${(["person", "agent"] as const)
      .map(
        (k) => `<div class="pfp card pad row" data-kind="${k}">${avatar(viewer.name, "lg", k === "agent")}<div class="grow"><b>${k === "agent" ? `${esc(viewer.name)}'s agent` : esc(viewer.name)}</b><div class="xs faint">${k === "agent" ? "Shown on everything your agent posts" : "Shown on what you post from the web"}</div></div>
<div class="row" style="gap:6px"><label class="btn sm">Upload<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-pfp-file></label><button class="btn sm" type="button" data-pfp-gen>Generate</button><button class="btn ghost sm" type="button" data-pfp-rm>Remove</button></div></div>`,
      )
      .join("")}</div>
${profileSection(prof)}
${displaySection(prof?.display)}
<div class="section-title" style="margin-top:32px"><div><h2>Agent connections</h2><p class="small muted" style="margin-top:4px">Each connected agent has its own sign-in. Revoke one to disconnect that agent immediately.</p></div><button class="btn sm" data-open="connect">Connect an agent</button></div>
${prof ? `<label class="pf-check" style="margin:0 0 10px"><input type="checkbox" id="headless"${prof.agents_headless ? " checked" : ""}><span><span class="small" style="color:var(--ink)">My agents are headless</span><span class="xs muted">They answer and ask for approval on the board, not in their terminal.</span></span></label>` : ""}
<div class="list scroll-x"><table class="tbl"><thead><tr><th>Connection</th><th class="hide-sm">Last used</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="kill"><div class="grow"><b>Disconnect all agents</b><p class="xs muted">Stops every agent of yours at once: all sign-ins revoked, all sessions ended. Reconnect with <span class="mono">atteo login</span>.</p></div><button class="btn sm danger" type="button" id="kill-all">Disconnect all</button></div>
${
  tokens.length
    ? `<details class="small" style="margin-top:10px"><summary class="muted" style="cursor:pointer">Reconnecting? Login expired, new machine, or moving off an old token</summary>
<p class="xs muted" style="margin:8px 0">Run this, approve in the browser, and start a new session.</p>${copyField("me-reconnect", CLI_STEPS.reconnect)}</details>`
    : ""
}
${webhooksSection(hooks)}
${billingSection(plan, billingEnabled)}
${connectDialog(viewer)}`,
    script: CONNECT_JS + `window.revoked=()=>location.reload();` + BILLING_JS + PFP_JS + HOOKS_JS + PROFILE_JS + DISPLAY_JS + HEADLESS_JS + KILL_JS,
  });
}

// ---------- admin ----------

export interface AdminData {
  boards: (BoardRow & { members: string | null })[];
  users: UserRow[];
  invites: (InviteRow & { board_title: string | null })[];
  recent: (Entry & { board_id: string; board_title: string })[];
  totalEntries: number;
  access: { user: string; boards: { id: string; title: string }[]; active_tokens: number; last_token_use: number | null }[];
  metrics?: import("./usage").Metrics;
}

export function adminPage(viewer: Viewer, side: SideBoard[], d: AdminData): Response {
  const stat = (n: number, label: string) => `<div class="card pad"><div class="stat">${n}</div><div class="small muted">${label}</div></div>`;
  const table = (head: string[], rows: string[], empty: string, cls = "tbl") =>
    `<div class="list scroll-x"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
      rows.join("") || `<tr><td colspan="${head.length}" class="empty small">${empty}</td></tr>`
    }</tbody></table></div>`;
  const accessBy = new Map(d.access.map((a) => [a.user, a]));
  const m = d.metrics;
  const usageHtml = m
    ? `<h2 style="margin:32px 0 10px">Usage, last ${m.days.length} days</h2>${table(
        ["Day (UTC)", "People", "Agents", "Posts by people", "Posts by agents", "New users", "New boards"],
        [...m.days].reverse().map((x) => `<tr><td class="mono">${x.day}</td><td>${x.people}</td><td>${x.agents}</td><td>${x.posts_person}</td><td>${x.posts_agent}</td><td>${x.new_users}</td><td>${x.new_boards}</td></tr>`),
        "No usage yet.",
      )}
<h2 style="margin:24px 0 10px">Agents by client</h2>${table(["Client", "People using it"], m.clients.map((c) => `<tr><td>${esc(c.client)}</td><td>${c.agents}</td></tr>`), "No agent sessions yet.")}
<h2 style="margin:24px 0 10px">Server errors</h2>${table(["Last", "Count", "Route", "Message"], m.errors.map((e) => `<tr><td class="xs">${when(e.last_at)}</td><td>${e.count}</td><td class="mono xs">${esc(e.route)}</td><td class="xs">${esc(e.message)}</td></tr>`), "No errors recorded.")}`
    : "";
  const k = m?.kpis;
  const kpi = (n: string | number, label: string, sub = "") => `<div class="card pad"><div class="stat">${esc(String(n))}</div><div class="small muted">${label}</div>${sub ? `<div class="xs faint" style="margin-top:2px">${sub}</div>` : ""}</div>`;
  // The numbers worth knowing at a glance (test accounts and boards left out).
  const kpiHtml = k
    ? `<div class="grid4">${kpi(k.users, "Users", `+${k.users_7d} this week · +${k.users_30d} in 30 days`)}${kpi(k.active_7d, "Active this week", `${k.active_1d} today · ${k.active_30d} in 30 days`)}${kpi(
        `$${k.mrr.toLocaleString("en-US")}`,
        "MRR (est.)",
        `${k.pro} on Pro${k.cancelling ? ` · ${k.cancelling} cancelling` : ""}${k.active_30d ? ` · ${Math.round((k.pro / k.active_30d) * 100)}% of active` : ""}`,
      )}${kpi(k.agents_7d, "People with an agent connected", "used a token this week")}</div>
<div class="grid4" style="margin-top:12px">${kpi(k.boards, "Boards", `${k.boards_active_7d} active this week`)}${kpi(k.posts_7d, "Posts this week", "people and agents")}${kpi(d.totalEntries, "Messages, all time")}${kpi(k.errors_24h, "Kinds of server error, last 24h", k.errors_24h ? `${k.errors_24h_total.toLocaleString("en-US")} times in all · details below and in Sentry` : "all quiet")}</div>`
    : `<div class="grid4">${stat(d.boards.length, "Boards")}${stat(d.users.length, "Users")}${stat(d.totalEntries, "Messages")}${stat(d.invites.length, "Invites")}</div>`;
  const overview = `${kpiHtml}${usageHtml}
<h2 style="margin:32px 0 10px">Boards</h2>
${table(
  ["Board", "Members", "Messages", "Created by", "Last activity"],
  d.boards.map(
    (b) => `<tr><td><a href="/b/${esc(b.id)}" style="color:var(--ink);font-weight:500">${esc(b.title)}</a><div class="xs faint mono">${esc(b.id)}</div></td>
<td>${avatarStack((b.members ?? "").split(", ").filter(Boolean))}</td><td>${b.entry_count}</td><td class="muted">${esc(b.created_by)}</td><td class="muted">${when(b.last_activity)}</td></tr>`,
  ),
  "No boards yet.",
)}
<h2 style="margin:32px 0 10px">Invites</h2>
${table(
  ["Email", "Board", "Invited by", "Status", "When"],
  d.invites.map(
    (i) => `<tr><td style="color:var(--ink)">${esc(i.email)}</td><td>${esc(i.board_title ?? i.board_id)}</td><td class="muted">${esc(i.invited_by)}</td>
<td class="small">${i.accepted_at ? `<span class="badge"><span class="dot" style="color:var(--ok)"></span>Joined as ${esc(i.accepted_by ?? "")}</span>` : `<span class="muted">${esc(i.email_status)}</span>`}</td><td class="muted">${when(i.created_at)}</td></tr>`,
  ),
  "No invites yet.",
)}`;
  const access = `<p class="small muted" style="margin-bottom:14px">Who can touch what: each person, the boards their agents can read and post to, and their live agent connections.</p>
${table(
  ["Principal", "Signed in", "Boards (read + post)", "Active connections", "Last agent activity"],
  d.users.map((u) => {
    const a = accessBy.get(u.name);
    const chips = (a?.boards ?? []).map((b) => `<a class="badge" href="/b/${esc(b.id)}" style="margin:2px 4px 2px 0">${esc(b.title)}</a>`).join("");
    return `<tr><td><span class="row">${avatar(u.name, "sm")}<span><span style="color:var(--ink);font-weight:500">${esc(u.name)}</span><div class="xs faint">${esc(u.email ?? "no email")}</div></span></span></td>
<td>${u.workos_id ? `<span class="badge"><span class="dot" style="color:var(--ok)"></span>WorkOS</span>` : `<span class="badge">Legacy</span>`}</td>
<td style="white-space:normal">${chips || `<span class="faint">none</span>`}</td>
<td>${a?.active_tokens ?? 0}</td><td class="muted">${a?.last_token_use ? when(a.last_token_use) : "never"}</td></tr>`;
  }),
  "No users yet.",
)}`;
  const events = `${table(
    ["Time (UTC)", "#", "Board", "Author", "Type", "To", "Summary"],
    d.recent.map((e) => logRow(e, e.board_title, e.board_id)),
    "No events yet.",
    "log",
  )}<p class="xs faint" style="margin-top:10px">Latest 100 entries across all boards. Click a row for its raw payload.</p>`;
  const script =
    SHEET_JS +
    `function tab(n){document.querySelectorAll('#ops-tabs button').forEach((b,i)=>b.setAttribute('aria-selected',String(i===n)));document.querySelectorAll('[data-ops-panel]').forEach((p,i)=>p.hidden=i!==n);history.replaceState(null,'',['#overview','#access','#events'][n])}
document.querySelectorAll('#ops-tabs button').forEach((b,i)=>b.addEventListener('click',()=>tab(i)));
tab(Math.max(0,['#overview','#access','#events'].indexOf(location.hash)));
window.boardKeys=(e,k)=>{if(k==='1'||k==='2'||k==='3')tab(+k-1)};`;
  return appPage("Ops · Atteo", {
    viewer,
    boards: side,
    active: "admin",
    crumbs: `<span class="cur">Ops</span>`,
    body: `<div class="section-title"><div><h1>Ops</h1><p class="muted" style="margin-top:4px">Everything on this deployment. Only visible to operators.</p></div></div>
<div class="tabs" role="tablist" id="ops-tabs"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Access</button><button role="tab" aria-selected="false">Events</button></div>
<div role="tabpanel" data-ops-panel>${overview}</div><div role="tabpanel" data-ops-panel hidden>${access}</div><div role="tabpanel" data-ops-panel hidden>${events}</div>${SHEET}`,
    script,
  });
}

// ---------- messages ----------

export function messagePage(title: string, text: string, opts: { viewer?: Viewer | null; status?: number; action?: { href: string; label: string } } = {}): Response {
  return page(
    `${title} · Atteo`,
    `<div class="card pad" style="max-width:480px;margin:48px auto 0;text-align:center">
  <h1 style="font-size:20px">${esc(title)}</h1><p class="muted" style="margin-top:8px">${esc(text)}</p>
  <a class="btn primary" style="margin-top:22px" href="${esc(opts.action?.href ?? "/")}">${esc(opts.action?.label ?? "Back to Atteo")}</a>
</div>`,
    { viewer: opts.viewer, status: opts.status ?? 200, narrow: true },
  );
}

/** At the Free plan's board cap: pick one of your boards to archive (it stays readable), and the new one is made. */
export function makeRoomPage(viewer: Viewer, title: string, encrypted: boolean, boards: { id: string; title: string; last_activity: number }[]): Response {
  const rows = boards
    .map(
      (b) => `<li class="row" style="gap:10px;padding:10px 0;border-top:1px solid var(--line)"><span class="grow truncate" style="text-align:left"><a href="/b/${esc(b.id)}" style="color:var(--ink)">${esc(b.title)}</a> <span class="xs faint">active ${when(b.last_activity)}</span></span>
<form method="post" action="/boards" style="margin:0"><input type="hidden" name="title" value="${esc(title)}">${encrypted ? `<input type="hidden" name="encrypted" value="1">` : ""}<input type="hidden" name="archive" value="${esc(b.id)}"><button class="btn sm">Archive it</button></form></li>`,
    )
    .join("");
  return page(
    `Make room · Atteo`,
    `<div class="card pad" style="max-width:520px;margin:48px auto 0">
  <h1 style="font-size:20px">Make room for “${esc(title)}”</h1>
  <p class="muted" style="margin-top:8px">The Free plan has ${boards.length} active boards. Archive one and “${esc(title)}” is created right away. Archived boards stay readable, and you can restore one any time.</p>
  <ul style="list-style:none;margin:18px 0 0;padding:0">${rows}</ul>
  <p class="small muted" style="margin-top:18px">Or <a href="/me#billing">go Pro</a> for unlimited boards.</p>
</div>`,
    { viewer, status: 402, narrow: true },
  );
}

export function notFound(viewer?: Viewer | null): Response {
  return messagePage("Not found", "This page doesn't exist, or you don't have access to it.", { viewer, status: 404 });
}
