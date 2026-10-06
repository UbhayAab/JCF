// ============================================================
// Patient Navigator: Data room, the patient canvas (styles)
//
// One block, injected on first use. Every colour is a theme token, so the
// canvas follows light, dark, colourful and Classic without a stylesheet of
// its own, and nothing here touches css/components.css.
// ============================================================

const CSS = `
.pc{display:grid;gap:var(--s4);min-width:0}
.pc [hidden]{display:none!important}
.pc-fam{display:grid;gap:var(--s4);min-width:0}
.pc>*,.pc-fam>*,.pc-cols>*{min-width:0}
.pc-h{font:var(--t-body-strong);color:var(--ink);margin:0}
.pc-note{font:var(--t-xs);color:var(--ink-3);margin:0}
.pc-gap{margin-top:6px}
.pc-grow{flex:1}
.pc-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pc-row-between{display:flex;justify-content:space-between;align-items:flex-start;gap:10px 16px;flex-wrap:wrap}
.pc-intro{display:grid;gap:12px}
.pc-intro-text{display:grid;gap:4px;max-width:760px}
.pc-search{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pc-search .form-input{flex:1 1 240px;max-width:380px}
.pc-list-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-bottom:12px}
.pc-filter{flex:1 1 180px;max-width:260px}
.pc-sort{flex:0 1 210px;width:auto}
.pc-tablewrap{overflow-x:auto;max-width:100%}
.pc-table{width:100%;border-collapse:collapse;font:var(--t-xs)}
.pc-table th{text-align:left;font-weight:600;color:var(--ink-3);padding:8px 10px;border-bottom:1px solid var(--line-2);white-space:nowrap}
.pc-table td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-2)}
.pc-table tr.pc-row{cursor:pointer}
.pc-table tr.pc-row:hover td{background:var(--surface-2)}
.pc-says{min-width:240px;max-width:520px}
.pc-linkbtn{background:none;border:0;padding:2px 0;min-height:24px;font:inherit;font-weight:700;color:var(--ink);text-align:left;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.pc-linkbtn:focus-visible,.pc-chip:focus-visible,.pc-mk:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.pc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;flex-wrap:wrap}
.pc-head-main{display:grid;gap:6px;min-width:0}
.pc-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pc-code{margin:0;font-size:22px;line-height:1.2;color:var(--ink);overflow-wrap:anywhere}
.pc-sub{margin:0;font:var(--t-sm);color:var(--ink-2)}
.pc-actions{display:flex;flex-wrap:wrap;gap:8px}
.pc-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:var(--s4)}
.pc-changes{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px}
.pc-changes li{display:flex;gap:10px;align-items:flex-start;font:var(--t-sm);color:var(--ink-2)}
.pc-dot{width:10px;height:10px;border-radius:50%;flex:none;margin-top:6px;background:var(--line-strong)}
.pc-changes .t-bad .pc-dot{background:var(--danger)}
.pc-changes .t-warn .pc-dot{background:var(--warn)}
.pc-changes .t-good .pc-dot{background:var(--ok)}
.pc-dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:10px 0 0;font:var(--t-sm)}
.pc-dl dt{color:var(--ink-3);font-weight:600}
.pc-dl dd{margin:0;color:var(--ink-2);overflow-wrap:anywhere}
.pc-legend{display:flex;flex-wrap:wrap;gap:6px 12px;font:var(--t-xs);color:var(--ink-3)}
.pc-legend span{display:inline-flex;align-items:center;gap:6px}
.pc-key{width:12px;height:12px;border-radius:4px;display:inline-block}
.pc-tl{display:flex;margin-top:12px;border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
.pc-tl-labels{flex:none;border-right:1px solid var(--line);background:var(--surface)}
.pc-tl-labels[hidden]{display:none}
.pc-scroll{flex:1 1 auto;min-width:0;overflow-x:auto}
.pc-empty{padding:16px}
.pc-ai{display:grid;gap:10px;border-left:4px solid var(--info)}
.pc-ai-head{margin:0;font:var(--t-body-strong);color:var(--ink)}
.pc-ai-points{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.pc-ai-points li{display:grid;grid-template-columns:96px minmax(0,1fr);gap:2px 12px;font:var(--t-sm);color:var(--ink-2)}
.pc-ai-kind{font:700 11px/1.7 var(--font-ui);letter-spacing:.04em;text-transform:uppercase;color:var(--ink-3)}
.pc-ref{display:inline-flex;align-items:center;min-height:24px;min-width:24px;padding:0 8px;margin-left:6px;border-radius:999px;border:1px solid var(--line-2);background:var(--surface-2);color:var(--ink-2);font:700 11px/1 var(--font-ui);cursor:pointer;vertical-align:baseline}
.pc-ref.is-record{cursor:help;font-weight:600}
.pc-ref:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.pc-ai-gaps{font:var(--t-sm);color:var(--ink-2)}
.pc-ai-gaps ul{margin:4px 0 0;padding-left:18px}
.pc-ai-foot{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;border-top:1px solid var(--line);padding-top:10px}
.pc-ai-foot .pc-note{flex:1 1 320px}
@media (max-width:600px){.pc-ai-points li{grid-template-columns:minmax(0,1fr)}}
.pc-loading{display:flex;align-items:center;gap:12px}
.pc-loading .spinner{margin:0;flex:none}
.pc-track{position:relative}
.pc-lab{box-sizing:border-box;height:42px;display:flex;align-items:center;padding:0 10px;font:var(--t-xs);line-height:1.25;color:var(--ink-2);border-bottom:1px solid var(--line)}
.pc-axis-lab{height:58px;color:var(--ink-3);border-bottom-color:var(--line-2)}
.pc-axis{box-sizing:border-box;height:58px;position:relative;border-bottom:1px solid var(--line-2);z-index:2}
.pc-lane{box-sizing:border-box;height:42px;position:relative;border-bottom:1px solid var(--line);z-index:2}
.pc-lab:last-child,.pc-lane:last-child{border-bottom:0}
.pc-bands{position:absolute;inset:0;z-index:1;pointer-events:none}
.pc-key.pc-key-dx{background:color-mix(in srgb,var(--info-soft) 55%,transparent);border:1px solid var(--line-2);vertical-align:-1px}
.pc-key.pc-key-tx{background:color-mix(in srgb,var(--ok-soft) 50%,transparent);border:1px solid var(--line-2);vertical-align:-1px}
.pc-band{position:absolute;top:0;bottom:0}
.pc-band.dx{background:color-mix(in srgb,var(--info-soft) 55%,transparent)}
.pc-band.tx{background:color-mix(in srgb,var(--ok-soft) 50%,transparent)}
.pc-band span{position:absolute;top:6px;left:6px;font:700 10.5px/1 var(--font-ui);letter-spacing:.05em;text-transform:uppercase;color:var(--ink-2);white-space:nowrap}
.pc-gridline{position:absolute;top:0;bottom:0;width:1px;background:var(--line)}
.pc-line{position:absolute;top:58px;bottom:0;width:0;border-left:2px dashed var(--line-strong)}
.pc-nowrap{white-space:nowrap}
.pc-tick{position:absolute;bottom:6px;font:var(--t-xs);color:var(--ink-3);padding-left:4px;white-space:nowrap}
.pc-tag{position:absolute;top:21px;transform:translateX(-50%);font:600 10.5px/1.2 var(--font-ui);color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:999px;padding:1px 6px;white-space:nowrap;z-index:3}
.pc-mk{position:absolute;top:50%;transform:translate(-50%,-50%);min-width:28px;height:26px;padding:0 7px;border-radius:13px;border:1.5px solid var(--line-strong);background:var(--surface);color:var(--ink);font:700 11px/1 var(--font-ui);white-space:nowrap;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.pc-mk.is-dot{min-width:26px;padding:0;background:transparent;border-color:transparent}
.pc-mk.is-dot::after{content:'';width:10px;height:10px;border-radius:50%;background:var(--ink-3)}
.pc-mk.is-sel{box-shadow:0 0 0 3px var(--surface),0 0 0 5px var(--ink)}
.pc-mk-inline{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:20px;padding:0 6px;margin-right:6px;border-radius:10px;border:1.5px solid var(--line-strong);background:var(--surface);color:var(--ink);font:700 10.5px/1 var(--font-ui);vertical-align:middle}
.pc-key.t-plain{background:var(--surface);border:1.5px solid var(--line-strong)}
:is(.pc-mk,.pc-mk-inline,.pc-key).t-bad{background:var(--danger-soft);border:1.5px solid var(--danger);color:var(--danger)}
:is(.pc-mk,.pc-mk-inline,.pc-key).t-warn{background:var(--warn-soft);border:1.5px solid var(--warn);color:var(--warn)}
:is(.pc-mk,.pc-mk-inline,.pc-key).t-good{background:var(--ok-soft);border:1.5px solid var(--ok);color:var(--ok)}
:is(.pc-mk,.pc-mk-inline,.pc-key).t-info{background:var(--info-soft);border:1.5px solid var(--info);color:var(--info)}
.pc-undated{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:12px}
.pc-chips{display:flex;flex-wrap:wrap;gap:6px}
.pc-chip{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:4px 10px;border-radius:999px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);font:var(--t-xs);cursor:pointer}
.pc-chip.is-on{background:var(--ink);border-color:var(--ink);color:var(--surface)}
.pc-chip-note{color:var(--ink-3)}
.pc-detail{display:grid;gap:12px}
.pc-item{display:grid;gap:8px;padding-top:12px;border-top:1px solid var(--line)}
.pc-item header{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px}
.pc-tags{display:flex;flex-wrap:wrap;gap:6px}
.pc-tagchip{font:var(--t-xs);color:var(--ink-2);background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.pc-tagchip.is-warn{background:var(--warn-soft);border-color:var(--warn);color:var(--warn)}
.pc-finding{margin:0;font:var(--t-sm);color:var(--ink)}
.pc-block{display:grid;gap:6px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);min-width:0}
.pc-block-h{font:var(--t-body-strong);font-size:14px;color:var(--ink);display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.pc-pre{margin:0;white-space:pre-line;font:var(--t-sm);color:var(--ink-2);overflow-wrap:anywhere}
.pc-trends{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:var(--s3);margin-top:12px}
.pc-trend{margin:0;border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:grid;grid-template-columns:minmax(0,1fr);gap:4px;min-width:0}
.pc-trend figcaption{font:var(--t-xs);color:var(--ink-2);display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;min-width:0}
.pc-trend-box{position:relative;height:120px;min-width:0}
.pc-trend-box canvas{display:block;max-width:100%}
.pc-item-j{gap:2px;padding-top:8px}
@media (max-width:600px){
  .pc-dl{grid-template-columns:minmax(0,1fr)}
  .pc-dl dd{margin-bottom:6px}
  .pc-code{font-size:19px}
  .pc-actions .btn{flex:1 1 auto}
}`;

export function injectCanvasStyles() {
  if (document.getElementById('pc-styles')) return;
  const el = document.createElement('style');
  el.id = 'pc-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}
