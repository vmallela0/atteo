// Task board drags vs live reloads (vedu #6564 follow-up): a reload replaces the board's HTML, so one that lands while a
// card is being dragged pulls the card out from under the drag and the drop never happens (Chromium's drag can then stick).
// While any drag holds the gate, reloads wait; when the last hold is released the board reloads once, however many asked.
// Each drag takes its own hold, so a drop still saving can't release a newer drag's. Client side, in the board page's
// script (BOARD_JS); test/dragGate.test.ts runs it as is.
//   dragGate(run, ms)  run: the reload; ms: a hold that's never released lets go by itself after this (default 30 s)
//   .hold()            from dragstart: returns its release (once only; later calls do nothing)
//   .ask()             true: reload now; false: one is queued for when the holds are gone · .defer(): queue one
export const DRAG_GATE_JS = `
function dragGate(run,ms){let n=0,queued=false;
  return{hold(){n++;let done=false;const rel=()=>{if(done)return;done=true;clearTimeout(t);n--;if(!n&&queued){queued=false;run()}},t=setTimeout(rel,ms||30000);return rel},
    ask(){if(n)queued=true;return!n},defer(){queued=true},get busy(){return n>0}}}
`;
