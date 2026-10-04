import { SHOTS_DIR } from "./lib/shots.mjs";
import { after } from "./seed.mjs";
import { chromium } from "playwright-core";
const { board, A, cookieB } = await after();
const BASE=process.env.BASE||"http://localhost:8787";
let fails=0;const check=(ok,m)=>{console.log(`${ok?"✓":"✗"} ${m}`);if(!ok)fails++};
const b = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined });
for (const [scheme,w,h] of [["light",1280,800],["dark",390,844]]) {
const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
const [k, ...v] = cookieB.split(";")[0].split("=");
await ctx.addCookies([{ name: k, value: v.join("="), url: BASE }]);
const p = await ctx.newPage(); const errors=[]; p.on("pageerror",e=>errors.push(e.message));
await p.goto(`${BASE}/b/${board}`); await p.waitForTimeout(500);
const val=()=>p.inputValue("#composer-text"), caret=()=>p.evaluate(()=>document.getElementById("composer-text").selectionStart);
const chips=()=>p.evaluate(()=>[...document.querySelectorAll("#composer-mirror .chip")].map(c=>c.className+"|"+c.textContent));
await p.click("#composer-text");
await p.keyboard.type("hey @" + A.slice(0,3)); await p.waitForSelector("#mention-menu:not([hidden])");
await p.keyboard.press("Enter");
check((await val())===`hey @${A} `, `pick person → "${await val()}"`);
check(JSON.stringify(await chips())===JSON.stringify([`chip|@${A}`]), `person chip drawn: ${await chips()}`);
check(await p.evaluate(()=>document.getElementById("composer-mirror").textContent===document.getElementById("composer-text").value+"\n"), "mirror text matches the textarea");
await p.keyboard.press("Backspace"); await p.keyboard.press("Backspace");
check((await val())==="hey ", `one Backspace removes the whole chip → "${await val()}"`);
await p.keyboard.press("Control+z");
check((await val()).startsWith(`hey @${A}`), `undo brings it back → "${await val()}"`);
await p.keyboard.press("End");
await p.keyboard.type(" and @" + A.slice(0,3)); await p.waitForSelector("#mention-menu:not([hidden])");
await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter");
const v2=await val(); const agentChip=`@${A}'s agent`;
check(v2.endsWith(`${agentChip} `), `pick agent → "${v2}"`);
check((await chips()).includes(`chip agent|${agentChip}`), "agent chip drawn (dashed)");
await p.screenshot({ path: `${SHOTS_DIR}/after-chips-${scheme}.png`, clip: await p.locator(".composer").boundingBox() });
// caret can't land inside a chip
await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft");
const startAgent=v2.lastIndexOf("@");
check((await caret())===startAgent, `ArrowLeft steps over the chip (caret ${await caret()} = ${startAgent})`);
await p.keyboard.press("ArrowRight");
check((await caret())===startAgent+agentChip.length, `ArrowRight steps over it too (caret ${await caret()})`);
await p.keyboard.press("ArrowLeft");
await p.keyboard.press("Delete");
check(!(await val()).includes("'s agent"), `Delete at a chip's start removes it whole → "${await val()}"`);
// selection cutting into a chip takes all of it
await p.evaluate(()=>{const t=document.getElementById("composer-text");const i=t.value.indexOf("@")+2;t.setSelectionRange(1,i)});
await p.keyboard.type("i ");
check(!(await val()).includes("@"), `typing over a selection that cuts a chip replaces the whole chip → "${await val()}"`);
// clicking inside a chip puts the caret at an edge
await p.fill("#composer-text", ""); await p.keyboard.type(`ping @${A} ok`); await p.keyboard.press("Escape");
const box=await p.locator("#composer-mirror .chip").boundingBox();
await p.mouse.click(box.x+box.width/2, box.y+box.height/2);
await p.waitForTimeout(150);const c=await caret(); check(c===5||c===5+1+A.length, `click inside a chip snaps to its edge (caret ${c})`);
// posting still works; the post shows the mention
await p.fill("#composer-text", `final @${A} check ${scheme}`);
await p.keyboard.press("End"); await p.keyboard.press("Enter");
await p.waitForFunction((t)=>document.getElementById("thread").textContent.includes(t), `check ${scheme}`, {timeout:5000});
await p.waitForFunction(()=>document.getElementById("composer-text").value==="",null,{timeout:5000}).catch(()=>{});await p.waitForTimeout(100);
check((await val())==="" && (await chips()).length===0, "posted; composer and chips cleared");
check(errors.length===0, `no page errors ${errors.join(" | ")}`);
await ctx.close();
}
await b.close(); console.log(fails?`${fails} FAILED`:"all chip checks passed"); process.exit(fails?1:0);
