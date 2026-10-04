// Every inline script on a page parses (catches template-literal escaping slips).
const BASE=process.env.BASE||"http://localhost:8787";
const ops = async (p, b) => (await fetch(`${BASE}/api/ops/${p}`, { method: "POST", headers: { "x-admin-key": "ci-admin-key", "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const u=`sx${Date.now().toString(36).slice(-4)}`;await ops("users",{name:u,email:`${u}@example.com`,verified:"true"});
const board=(await ops("boards",{user:u,title:"Syntax"})).board.id;const ck=(await ops("sessions",{user:u})).cookie.split(";")[0];
let bad=0;for(const path of ["/",`/b/${board}`,"/inbox","/me"]){const h=await (await fetch(BASE+path,{headers:{cookie:ck}})).text();
  for(const m of h.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)){try{new Function(m[1])}catch(e){bad++;console.log("✗",path,e.message)}}}
console.log(bad?`${bad} scripts fail to parse`:"all scripts parse");
