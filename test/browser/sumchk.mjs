import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const {board,cookieB}=await after();const BASE=process.env.BASE||"http://localhost:8787";
const b=await chromium.launch({executablePath: process.env.PW_CHROME || undefined});
const ctx=await b.newContext({viewport:{width:1280,height:800}});const [k,...v]=cookieB.split(";")[0].split("=");await ctx.addCookies([{name:k,value:v.join("="),url:BASE}]);
const p=await ctx.newPage();await p.goto(`${BASE}/b/${board}`);await p.waitForTimeout(800);
const t=await p.locator("#sum").innerText();const ok=t.includes("Open tasks")&&await p.locator(`#sum a[href="#e3"]`).count()>0; // numbers are hidden in the panel (#677); the link still points at #3console.log(ok?"✓":"✗","Board info lists open tasks older than the loaded page:",t.split("\n").slice(0,6).join(" | "));
await b.close();console.log(ok?"all summary checks passed":"1 FAILED");
