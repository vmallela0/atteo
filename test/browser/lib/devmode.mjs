// Preloaded into the older browser checks (NODE_OPTIONS=--import): people they create start in Developer mode, the UI those
// checks were written for. Checks that test Everyday pass their own display mode.
const f0=globalThis.fetch;
globalThis.fetch=async(url,opts={})=>{try{if(String(url).endsWith('/api/ops/users')&&opts&&opts.body&&(opts.method||'GET').toUpperCase()==='POST'){const b=JSON.parse(opts.body);if(!b.display){b.display={mode:'developer'};opts={...opts,body:JSON.stringify(b)}}}}catch{}return f0(url,opts)};
