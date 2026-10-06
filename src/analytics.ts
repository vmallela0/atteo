// Product analytics (web). PostHog when POSTHOG_KEY is set; a no-op otherwise.
// The project API key is public (it can only record events). Nothing here sends message text,
// emails, or names. Do Not Track and Global Privacy Control turn the loader off in the browser.

import { AsyncLocalStorage } from "node:async_hooks";

/** Events the web may record. The client loader refuses anything else. */
export const ANALYTICS_EVENTS = [
  "page_view",
  "sign_up",
  "sign_in",
  "board_created",
  "invite_sent",
  "invite_accepted",
  "first_message",
  "agent_connected",
  "agent_posted",
  "voice_used",
  "pro_started",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/** Full-page navigations: the server sets a short cookie and the next page's loader records it. */
export const NAV_EVENTS = ["sign_up", "sign_in", "board_created"] as const;
export type NavEvent = (typeof NAV_EVENTS)[number];

/** Property names a caller may attach. Values are short tokens (no free text, no addresses). */
export const PROP_KEYS = ["surface", "role", "interval", "via"] as const;

export const POSTHOG_HOSTS = {
  eu: "https://eu.i.posthog.com",
  us: "https://us.i.posthog.com",
} as const;

/** The PostHog app (not the ingest host). */
export const POSTHOG_APP = {
  eu: "https://eu.posthog.com",
  us: "https://us.posthog.com",
} as const;

/** Atteo's PostHog project on US Cloud. Not a secret; the project API key is the POSTHOG_KEY var. */
export const ATTEO_POSTHOG_PROJECT = "647810";

/** Where an operator opens PostHog. US is Atteo's project; EU has no project id in this repo, so the link is the EU app. */
export function posthogDashboardUrl(cfg: AnalyticsPublic): string {
  if (cfg.region === "us") return `${POSTHOG_APP.us}/project/${ATTEO_POSTHOG_PROJECT}`;
  return POSTHOG_APP.eu;
}

const KEY_RE = /^phc_[A-Za-z0-9_]{8,200}$/;
const PROP_VALUE = /^[a-z0-9_]{1,32}$/;
const TRACK_COOKIE = "ab_track";

export interface AnalyticsPublic {
  key: string;
  host: string;
  region: "eu" | "us";
}

export function posthogRegion(raw: string | undefined): "eu" | "us" | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (s === "" || s === "eu" || s === POSTHOG_HOSTS.eu) return "eu";
  if (s === "us" || s === POSTHOG_HOSTS.us) return "us";
  return null;
}

/** Public config for the browser. Null when the key is missing, malformed, or the host isn't eu/us. */
export function analyticsConfig(env: { POSTHOG_KEY?: string; POSTHOG_HOST?: string }): AnalyticsPublic | null {
  const key = (env.POSTHOG_KEY ?? "").trim();
  if (!KEY_RE.test(key)) return null;
  const region = posthogRegion(env.POSTHOG_HOST);
  if (!region) return null;
  return { key, host: POSTHOG_HOSTS[region], region };
}

const analyticsStore = new AsyncLocalStorage<AnalyticsPublic | null>();

/** Bind the request's analytics config so page rendering can see it after an await. */
export function withAnalytics<T>(env: { POSTHOG_KEY?: string; POSTHOG_HOST?: string }, fn: () => T): T {
  return analyticsStore.run(analyticsConfig(env), fn);
}

/** The config for the request currently rendering a page, or null when analytics is off. */
export function currentAnalytics(): AnalyticsPublic | null {
  return analyticsStore.getStore() ?? null;
}

/** Keep only allowlisted token properties. Emails, message text, and unknown keys are dropped. */
export function sanitizeProps(props: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!props || typeof props !== "object") return out;
  const bag = props as Record<string, unknown>;
  for (const key of PROP_KEYS) {
    const v = bag[key];
    if (typeof v === "string" && PROP_VALUE.test(v)) out[key] = v;
  }
  return out;
}

/**
 * One capture call. Null when the name isn't in the plan or the distinct id isn't an anonymous token.
 * Distinct ids are random browser ids, never an email or a handle.
 */
export function captureBody(cfg: AnalyticsPublic, event: string, distinctId: string, props?: unknown, now = new Date()): Record<string, unknown> | null {
  if (!(ANALYTICS_EVENTS as readonly string[]).includes(event)) return null;
  if (!/^[A-Za-z0-9-]{8,80}$/.test(distinctId)) return null;
  return {
    api_key: cfg.key,
    event,
    distinct_id: distinctId,
    properties: { $lib: "atteo-web", ...sanitizeProps(props) },
    timestamp: now.toISOString(),
  };
}

/** Short cookie the next HTML page reads. Not HttpOnly, so the loader can clear it. No user data. */
export function trackCookieHeader(url: URL, event: NavEvent): string {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${TRACK_COOKIE}=${event}; Path=/;${secure} SameSite=Lax; Max-Age=120`;
}

/** The inline loader. Empty when analytics is off, so pages don't mention PostHog at all. */
export function analyticsBoot(cfg: AnalyticsPublic | null): string {
  if (!cfg) return "";
  const key = JSON.stringify(cfg.key);
  const host = JSON.stringify(cfg.host);
  const events = JSON.stringify(ANALYTICS_EVENTS);
  const nav = JSON.stringify(NAV_EVENTS);
  const props = JSON.stringify(PROP_KEYS);
  return `(()=>{const KEY=${key},HOST=${host},EV=${events},NAV=${nav},PROP=${props};const ev=new Set(EV),prop=new Set(PROP),val=/^[a-z0-9_]{1,32}$/;
function dnt(){try{const d=navigator.doNotTrack||window.doNotTrack||navigator.msDoNotTrack;if(d==="1"||d==="yes")return true;return navigator.globalPrivacyControl===true}catch(e){return true}}
function id(){try{const k="atteo.phid";let v=localStorage.getItem(k);if(!v||!/^[A-Za-z0-9-]{8,80}$/.test(v)){v=(crypto.randomUUID&&crypto.randomUUID())||("p"+Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem(k,v)}return v}catch(e){return""}}
function clean(p){const o={};if(!p||typeof p!=="object")return o;for(const k of prop){const v=p[k];if(typeof v==="string"&&val.test(v))o[k]=v}return o}
window.atteoTrack=function(name,props){if(dnt()||!ev.has(name))return;const distinct=id();if(!distinct)return;const body=JSON.stringify({api_key:KEY,event:name,distinct_id:distinct,properties:Object.assign({"$lib":"atteo-web"},clean(props)),timestamp:new Date().toISOString()});try{fetch(HOST+"/capture/",{method:"POST",headers:{"content-type":"application/json"},body:body,keepalive:true,credentials:"omit",mode:"cors"}).catch(function(){})}catch(e){}};
document.addEventListener("reset",e=>{const t=e.target&&e.target.dataset&&e.target.dataset.track;if(t)atteoTrack(t)}); // a data-api form resets only after it succeeded (data-reset), e.g. invite_sent
try{const seg=(location.pathname.split("/")[1]||"home").toLowerCase(),r=seg==="b"?"board":/^[a-z0-9_]{1,32}$/.test(seg)?seg:"other";atteoTrack("page_view",{surface:r})}catch(e){} // the route only, never ids or the query
try{const m=document.cookie.match(new RegExp("(?:^|; )ab_track=("+NAV.join("|")+")(?:;|$)"));if(m){document.cookie="ab_track=; Path=/; Max-Age=0";document.cookie="ab_track=; Path=/; Max-Age=0; Secure";atteoTrack(m[1])}}catch(e){}
})();`;
}

/** A nonce'd script tag, or "" when the loader is off. */
export function analyticsScriptTag(nonce: string): string {
  const js = analyticsBoot(currentAnalytics());
  if (!js) return "";
  return `<script nonce="${nonce}">${js}</script>`;
}
