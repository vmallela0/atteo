// The board's whole log from the web (#3401; GAPS P0 #10): board info's "This board" downloads it as JSON Lines, the same
// lines `atteo export` writes (#3378): one entry per line, oldest first, reactions on each, only what this viewer can see
// (GET /entries?after=N paged by `last`). An end-to-end encrypted board is opened in this browser (e2eweb's e2eOpen) and
// written with the text, never the ciphertext; what this device can't open keeps its entry with the reason as the text,
// as the CLI does. Nothing is marked read. The file is built here and saved; nothing goes back to the server.

/** The button and its status line, for the "This board" section. */
export const exportRow = (label: string) =>
  `<div class="acc-row"><button class="btn ghost sm" type="button" id="log-export">${label}</button><span class="xs faint truncate" id="log-export-st" role="status"></span></div>`;

export const EXPORT_JS = `
// ---- the board's log as JSON Lines (#3401): the same lines as atteo export ----
(()=>{const btn=document.getElementById('log-export'),st=document.getElementById('log-export-st');if(!btn)return;
  const get=async p=>{const r=await fetch(p);if(!r.ok)throw new Error('HTTP '+r.status);return r.json()};
  async function lines(){const out=[];let after=0;
    if(window.e2eOpen){for(;;){const es=(await get('/api/boards/'+BOARD+'/sealed?after='+after)).entries||[];
        for(const {payload,...e} of es){const o=await e2eOpen(payload).catch(()=>({}));out.push(JSON.stringify({...e,text:o.text!=null?o.text:'('+(o.why||"Can't decrypt this on this device.")+')',encrypted:true}))}
        if(es.length<200)break;after=es[es.length-1].seq}}
    else for(;;){const j=await get('/api/boards/'+BOARD+'/entries?after='+after+'&limit=500');
      for(const e of j.entries)out.push(JSON.stringify(j.reactions&&j.reactions[e.seq]?{...e,reactions:j.reactions[e.seq]}:e));
      if(!j.entries.length||!(j.last>after))break;after=j.last}
    return out}
  btn.addEventListener('click',async()=>{btn.disabled=true;st.textContent=tr('Loading…');
    try{const out=await lines(),a=document.createElement('a');
      a.href=URL.createObjectURL(new Blob(out.length?[out.join('\\n')+'\\n']:[],{type:'application/x-ndjson'}));
      a.download='atteo-'+BOARD+'-'+new Date().toISOString().slice(0,10)+'.jsonl';document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href),60000);st.textContent=tr(out.length===1?'{n} entry':'{n} entries',{n:out.length.toLocaleString()})}
    catch(e){st.textContent=tr("Couldn't download the log")}
    finally{btn.disabled=false}})})();
`;
