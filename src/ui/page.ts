/**
 * ブラウザの画面 — **構造が見えること**を優先する
 *
 * 数字を並べる dashboard にしない。中心は「1 つの資源を選ぶと、両 runtime からどう見えているかが並ぶ」。
 * **総合点（Health Score）は作らない。** 雑な点数は思想を壊す。
 *
 * 色の規律:
 *   - severity には色を使う（症状だから）
 *   - **大きさには色を使わない**。大きい数字を赤くしない
 *   - protected はグレー（提案しない、の意味）
 *   - 内容の一致 / 不一致には色を使う（drift は症状だから）
 *
 * 外部依存を持たない。CDN も使わない。オフラインで開く。
 */

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Environment Doctor</title>
<style>
:root{
  --bg:#0e1013; --panel:#15181d; --panel2:#1b1f26; --line:#262b33;
  --fg:#e6e8eb; --dim:#9aa3ad; --dim2:#6b7480;
  --err:#ff6b6b; --warn:#e3a008; --info:#5a9fd4; --ok:#4caf7d;
  --claude:#c98a5b; --codex:#7aa2c8; --prot:#5f6873;
  --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
a{color:inherit}
code,.mono{font-family:var(--mono);font-size:12px}
.hdr{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;background:var(--panel)}
.hdr h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.02em}
.hdr .sub{color:var(--dim);font-size:11.5px}
.scope{padding:9px 20px;background:#12161c;border-bottom:1px solid var(--line);color:var(--dim);font-size:11.5px}
.scope b{color:var(--fg);font-weight:600}
.tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel);overflow-x:auto}
.tab{padding:9px 13px;color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;font-size:12.5px}
.tab:hover{color:var(--fg)}
.tab.on{color:var(--fg);border-bottom-color:var(--fg)}
.tab .n{color:var(--dim2);margin-left:5px;font-family:var(--mono);font-size:11px}
.wrap{padding:16px 20px 60px}
.view{display:none}
.view.on{display:block}

/* 構造ブラウザ */
.split{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:16px;align-items:start}
@media(max-width:900px){.split{grid-template-columns:1fr}}
.side{background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden;position:sticky;top:8px;max-height:calc(100vh - 40px);display:flex;flex-direction:column}
.side .f{padding:9px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:7px}
.side input,.side select{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--fg);padding:6px 8px;border-radius:4px;font-size:12px;font-family:inherit}
.chips{display:flex;gap:4px;flex-wrap:wrap}
.chip{padding:2px 7px;border:1px solid var(--line);border-radius:10px;color:var(--dim);cursor:pointer;font-size:11px}
.chip.on{background:var(--panel2);color:var(--fg);border-color:var(--dim2)}
.rlist{overflow-y:auto;flex:1}
.ritem{padding:6px 10px;border-bottom:1px solid #1d2128;cursor:pointer;display:flex;gap:7px;align-items:baseline}
.ritem:hover{background:var(--panel2)}
.ritem.on{background:#20262f}
.ritem .k{color:var(--dim2);font-size:10px;font-family:var(--mono);min-width:74px}
.ritem .k:last-child{min-width:0;text-align:right}
.ritem .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ritem .dot{width:6px;height:6px;border-radius:50%;flex:none}
.main{min-width:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin-bottom:14px}
.card h3{margin:0 0 10px;font-size:12px;color:var(--dim);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.kv{display:grid;grid-template-columns:130px 1fr;gap:3px 12px;font-size:12px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;word-break:break-all}

/* runtime 2 列 */
.rt2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:820px){.rt2{grid-template-columns:1fr}}
.rtbox{border:1px solid var(--line);border-radius:5px;overflow:hidden}
.rtbox>.h{padding:7px 11px;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line)}
.rtbox.claude>.h{background:#2a1f18;color:var(--claude)}
.rtbox.codex>.h{background:#181f28;color:var(--codex)}
.rtbox.none>.h{background:#191b1f;color:var(--dim2)}
.rtbox .b{padding:9px 11px;font-size:12px}
.pill{display:inline-block;padding:1px 7px;border-radius:9px;font-size:10.5px;font-family:var(--mono)}
.pill.yes{background:#12301f;color:var(--ok)}
.pill.no{background:#2c1c1c;color:var(--err)}
.pill.neutral{background:var(--panel2);color:var(--dim)}
.pill.prot{background:#22262b;color:var(--prot)}
.chain{margin:7px 0 0;padding:0;list-style:none;font-size:11.5px;color:var(--dim)}
.chain li{padding:3px 0 3px 14px;position:relative}
.chain li:before{content:"→";position:absolute;left:0;color:var(--dim2)}
.chain b{color:var(--fg);font-weight:500}

table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--dim);font-weight:600;padding:5px 8px;border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.03em}
td{padding:5px 8px;border-bottom:1px solid #1d2128;vertical-align:top}
tr.clickable{cursor:pointer}
tr.clickable:hover td{background:var(--panel2)}
.num{font-family:var(--mono);text-align:right;white-space:nowrap}

.sev{font-family:var(--mono);font-size:10.5px;padding:1px 6px;border-radius:3px}
.sev.error{background:#301618;color:var(--err)}
.sev.warn{background:#2c2410;color:var(--warn)}
.sev.info{background:#15222c;color:var(--info)}
.fnd{border:1px solid var(--line);border-radius:5px;margin-bottom:9px;overflow:hidden}
.fnd>.h{padding:8px 11px;display:flex;gap:9px;align-items:center;cursor:pointer;background:var(--panel2);flex-wrap:wrap}
.fnd>.h .t{flex:1;min-width:200px}
.fnd>.b{padding:11px;display:none;border-top:1px solid var(--line)}
.fnd.open>.b{display:block}
.ev{margin:0;padding:0;list-style:none;font-size:11.5px}
.ev li{padding:4px 0 4px 76px;position:relative;border-bottom:1px solid #1a1e24}
.ev li:last-child{border:0}
.ev li .ty{position:absolute;left:0;color:var(--dim2);font-family:var(--mono);font-size:10px}
.ev .sub{color:var(--dim);padding-left:12px;font-size:11px}
.note{color:var(--dim);font-size:11.5px;margin:8px 0 0;padding-left:11px;border-left:2px solid var(--line)}
.bar{height:9px;border-radius:2px;display:flex;overflow:hidden;background:var(--panel2);margin:5px 0}
.bar span{display:block;height:100%}
.legend{display:flex;gap:12px;flex-wrap:wrap;color:var(--dim);font-size:11px;margin-top:5px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.tl{margin:0;padding:0;list-style:none}
.tl li{padding:5px 0 5px 16px;border-left:1px solid var(--line);position:relative;margin-left:5px}
.tl li:before{content:"";position:absolute;left:-4px;top:11px;width:7px;height:7px;border-radius:50%;background:var(--dim2)}
.tl li.added:before{background:var(--ok)}
.tl li.removed:before{background:var(--err)}
.tl li.changed:before{background:var(--warn)}
.tl .t{color:var(--dim2);font-family:var(--mono);font-size:10.5px}
.muted{color:var(--dim)}
.empty{color:var(--dim2);padding:14px;text-align:center;font-size:12px}
.warnbox{border:1px solid #3a2f16;background:#1d1a11;border-radius:5px;padding:10px 12px;color:#d8c48c;font-size:11.5px;margin-bottom:14px}
.hint{color:var(--dim2);font-size:11px;margin-top:4px}
h2.sec{font-size:13px;margin:20px 0 9px;color:var(--fg);font-weight:600}
h2.sec:first-child{margin-top:0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
@media(max-width:900px){.two{grid-template-columns:1fr}}
ul.plain{margin:0;padding-left:17px;font-size:11.5px;color:var(--dim)}
ul.plain li{margin:2px 0}

/* 人間向け要約層 */
.hero{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:15px 18px;margin-bottom:14px}
.hero .n{font-size:21px;font-weight:600;letter-spacing:.01em}
.hero .note{color:var(--dim);font-size:12px;margin-top:5px}
.cl{display:grid;grid-template-columns:auto 1fr auto;gap:11px;align-items:start;padding:11px 0;border-bottom:1px solid #1d2128;cursor:pointer}
.cl:last-child{border-bottom:0}
.cl:hover .hl{text-decoration:underline}
.cl .hl{font-size:13.5px;line-height:1.5}
.cl .fx{color:var(--dim);font-size:11.5px;margin-top:3px}
.cl .gb{color:var(--dim2);font-size:11px;margin-top:4px}
.cl .cnt{font-family:var(--mono);font-size:11.5px;color:var(--dim);white-space:nowrap;text-align:right}
.cbarw{max-width:240px;margin-top:7px}
.cbar{height:4px;border-radius:2px;min-width:8px}
.np{padding:8px 0;border-bottom:1px solid #1d2128;font-size:12.5px}
.np:last-child{border-bottom:0}
.np .go{color:var(--dim2);font-size:11px;cursor:pointer;text-decoration:underline;margin-left:7px;white-space:nowrap}
.np .dt{display:none;color:var(--dim);font-size:11px;margin-top:5px;padding-left:11px;border-left:2px solid var(--line)}
.np.open .dt{display:block}
.sumline{background:#12161c;border-left:3px solid var(--dim2);padding:10px 13px;border-radius:0 5px 5px 0;margin-bottom:13px;font-size:13.5px;line-height:1.6}
.sumline .s2{color:var(--dim);font-size:12px;margin-top:4px}
.scope .more{color:var(--dim2);cursor:pointer;text-decoration:underline;margin-left:9px;font-size:11px}
.scope .full{display:none;margin-top:5px}
.scope.open .full{display:block}
.internals{color:var(--dim2);font-size:11px;margin-top:16px;padding-top:10px;border-top:1px solid var(--line)}
.internals span{margin-right:14px;font-family:var(--mono)}
.filterbar{background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:8px 11px;margin-bottom:11px;font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.filterbar .x{cursor:pointer;text-decoration:underline;color:var(--dim)}
.legendline{color:var(--dim2);font-size:10.5px;padding:0 1px}
</style>
</head>
<body>
<div class="hdr">
  <h1>Agent Environment Doctor</h1>
  <span class="sub" id="hdrsub"></span>
</div>
<div class="scope" id="scope"></div>
<div class="tabs" id="tabs"></div>
<div class="wrap">
  <div class="view" id="v-overview"></div>
  <div class="view" id="v-structure"></div>
  <div class="view" id="v-findings"></div>
  <div class="view" id="v-cost"></div>
  <div class="view" id="v-hooks"></div>
  <div class="view" id="v-history"></div>
  <div class="view" id="v-notfindings"></div>
  <div class="view" id="v-coverage"></div>
</div>
<script>
const $ = (s,r)=> (r||document).querySelector(s);
const el = (t,c,x)=>{const e=document.createElement(t); if(c)e.className=c; if(x!==undefined)e.textContent=x; return e;};
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const n = v => (v==null?'—':Number(v).toLocaleString());
const short = (s,k)=> s && s.length>k ? s.slice(0,k)+'…' : s;
/* データ由来の文字列は innerHTML を通さない。textContent と DOM 構築だけで組む
   （プラグイン由来の SKILL.md や settings.json の command をそのまま描くため） */
const frag=(...xs)=>{const f=document.createDocumentFragment(); xs.forEach(x=>f.append(typeof x==='string'?document.createTextNode(x):x)); return f;};
const b_=(t)=>el('b',null,t);
const sp_=(c,t)=>el('span',c,t);
const listOf=(title,items)=>{const d=el('div','note'); d.append(b_(title)); const ul=el('ul','plain'); items.forEach(x=>ul.append(el('li',null,x))); d.append(ul); return d;};
let D=null, sel=null, filters={q:'',kind:'',runtime:'',only:''};
let GO=null;            /* タブ切替（boot で入る） */
let findingFilter=null; /* Overview から潜った時の cluster 絞り込み */

const TABS=[
  ['overview','Overview', d=>d.overview.attention_count],
  ['structure','Structure', d=>d.resources.length],
  ['findings','Findings', d=>d.findings.length],
  ['cost','Context cost', d=>null],
  ['hooks','Hooks', d=>d.hooks.length],
  ['history','History', d=>d.history.events.length],
  ['notfindings','Not findings', d=>d.not_findings.suppressed.length+d.not_findings.protected.length],
  ['coverage','Coverage', d=>null],
];

fetch('./api/data').then(r=>r.json()).then(d=>{D=d;boot();}).catch(e=>{
  document.querySelector('.wrap').replaceChildren(el('div','empty','Could not load data: '+e.message));
});

function boot(){
  $('#hdrsub').textContent = D.tool_version+' · snapshot '+D.snapshot_id+' · schema '+D.schema_version;
  const sc=$('#scope');
  const more=el('span','more','Details');
  const full=el('div','full'); full.textContent=D.overview.observing.full;
  more.onclick=()=>sc.classList.toggle('open');
  sc.replaceChildren(frag(b_('Observed Scope:'),' '+D.overview.observing.short, more, full));
  const tabs=$('#tabs');
  TABS.forEach(([id,label,cnt],i)=>{
    const t=el('div','tab'+(i===0?' on':''));
    t.dataset.v=id; t.append(document.createTextNode(label));
    const c=cnt(D); if(c!==null&&c!==undefined){const s=el('span','n',String(c)); t.append(s);}
    t.onclick=()=>{show(id); history.replaceState(null,'','#'+id);};
    tabs.append(t);
  });
  // #findings のような hash でタブを直接開ける（スクショや共有のため）
  const show=(id)=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x.dataset.v===id));
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('on',v.id==='v-'+id));
  };
  window.addEventListener('hashchange',()=>{const h=location.hash.slice(1); if(TABS.some(([x])=>x===h)) show(h);});
  renderOverview(); renderStructure(); renderFindings(); renderCost(); renderHooks(); renderHistory(); renderNotFindings(); renderCoverage();
  const h0=location.hash.slice(1);
  show(TABS.some(([x])=>x===h0)?h0:'overview');
  GO=show;
}

/* ─────────── Overview: 人間向け要約層 ───────────
   ここは診断しない。既に出ている Finding を、観測された共有条件だけで束ねて人間語に訳した入口。
   Health Score は作らない。大きさに色を使わない。severity にだけ色を使う。 */
function goTab(id){ if(GO){ GO(id); history.replaceState(null,'','#'+id); window.scrollTo(0,0);} }
function openCluster(cl){
  findingFilter={id:cl.id,headline:cl.headline,members:cl.members};
  renderFindings();
  goTab('findings');
}
function renderOverview(){
  const v=$('#v-overview'); v.innerHTML='';
  const ov=D.overview;

  const hero=el('div','hero');
  hero.append(el('div','n',ov.headline));
  hero.append(el('div','note',ov.headline_note));
  v.append(hero);

  /* Needs attention — root cause cluster 単位 */
  const c1=el('div','card'); c1.append(el('h3',null,'Needs Attention'));
  if(!ov.clusters.length){
    c1.append(el('div','muted','No findings. That does not mean unseen areas are clean — see Coverage.'));
  } else {
    const max=Math.max.apply(null,ov.clusters.map(c=>c.members.length));
    ov.clusters.forEach(cl=>{
      const row=el('div','cl');
      row.append(el('span','sev '+cl.severity,cl.severity));
      const mid=el('div');
      mid.append(el('div','hl',cl.headline));
      if(cl.facts.length) mid.append(el('div','fx',cl.facts.join(' · ')));
      const gb=el('div','gb'); gb.textContent='Grouped by: '+cl.grouped_by; mid.append(gb);
      const bw=el('div','cbarw');
      const bar=el('div','cbar');
      bar.style.width=Math.round(cl.members.length/max*100)+'%';
      /* 色は severity。長さは件数。**大きさに色を使わない** */
      bar.style.background=cl.severity==='error'?'var(--err)':cl.severity==='warn'?'var(--warn)':'var(--info)';
      bar.style.opacity='.55';
      bw.append(bar); mid.append(bw);
      row.append(mid);
      const right=el('div','cnt');
      right.append(el('div',null,cl.count_label));
      const go=el('div'); go.style.color='var(--dim2)'; go.style.fontSize='11px'; go.textContent='Details →'; right.append(go);
      if(cl.touches_protected){const p=el('div'); p.append(el('span','pill prot','touches protected')); right.append(p);}
      row.append(right);
      row.onclick=()=>openCluster(cl);
      c1.append(row);
    });
  }
  v.append(c1);

  /* Not diagnosed as a problem */
  const c2=el('div','card'); c2.append(el('h3',null,'Not Diagnosed'));
  ov.not_problems.forEach(x=>{
    const d=el('div','np');
    const head=el('div');
    head.append(document.createTextNode(x.label));
    const go=el('span','go','→ '+x.goto);
    go.onclick=(e)=>{e.stopPropagation(); goTab(x.goto);};
    head.append(go);
    d.append(head);
    const dt=el('div','dt'); dt.textContent=x.detail; d.append(dt);
    d.onclick=()=>d.classList.toggle('open');
    c2.append(d);
  });
  c2.append(el('div','hint','Reviewed, not flagged. Click a row for the reasoning.'));
  v.append(c2);

  const two=el('div','two');

  /* Claude ↔ Codex */
  const c3=el('div','card'); c3.append(el('h3',null,'Runtime Comparison'));
  const cmp=ov.comparison;
  const t=el('table');
  t.innerHTML='<thead><tr><th>runtime</th><th>version</th><th class="num">resources found</th><th class="num">bindings</th></tr></thead>';
  const tb=el('tbody');
  cmp.runtimes.forEach(r=>{
    const tr=el('tr');
    tr.append(el('td',null,r.label+(r.present?'':' (not present)')),tdm(r.version||'?'),el('td','num',n(r.resources_discovered)),el('td','num',n(r.discovered)));
    tb.append(tr);
  });
  t.append(tb); c3.append(t);
  const sn=el('div'); sn.style.marginTop='9px'; sn.style.fontSize='12px';
  sn.append(frag(String(cmp.same_name_skills.pairs)+' pair'+(cmp.same_name_skills.pairs===1?'':'s')+' share the same skill name — ',
    sp_('pill yes',cmp.same_name_skills.identical+' identical'),' ',
    sp_('pill no',cmp.same_name_skills.drifted+' drifted')));
  c3.append(sn);
  const sp=el('div','hint');
  sp.textContent='Resources seen by both, same path: '+n(cmp.same_path_both)+' · '+cmp.only.map(o=>o.label+' only: '+n(o.count)).join(' · ');
  c3.append(sp);
  c3.append(el('div','hint',cmp.note));
  two.append(c3);

  /* Recent changes */
  const c4=el('div','card'); c4.append(el('h3',null,'Recent Changes'));
  if(ov.recent.events.length){
    const ul=el('ul','tl');
    ov.recent.events.forEach(e=>{
      const li=el('li',e.direction);
      li.append(el('div','t',e.observed_at.slice(0,16).replace('T',' ')+'  ·  '+e.kind));
      li.append(el('div',null,e.summary));
      ul.append(li);
    });
    c4.append(ul);
    if(ov.recent.total_events>ov.recent.events.length){
      const more=el('div','hint'); const lk=el('span',null,'→ View all '+ov.recent.total_events+' in History');
      lk.style.cursor='pointer'; lk.style.textDecoration='underline'; lk.onclick=()=>goTab('history');
      more.append(lk); c4.append(more);
    }
  }
  const nu=el('ul','plain'); nu.style.marginTop='8px';
  ov.recent.note.forEach(x=>nu.append(el('li',null,x)));
  c4.append(nu);
  const hl=el('div','hint'); const lk2=el('span',null,'→ History');
  lk2.style.cursor='pointer'; lk2.style.textDecoration='underline'; lk2.onclick=()=>goTab('history');
  hl.append(document.createTextNode('Based on '+ov.recent.snapshots+' snapshot(s). ')); hl.append(lk2);
  c4.append(hl);
  two.append(c4);
  v.append(two);

  /* 内部の数は主役にしない */
  const inte=el('div','internals');
  [['resources',ov.internals.resources],['bindings',ov.internals.bindings],['observations',ov.internals.observations],['sessions',ov.internals.sessions],['processes',ov.internals.processes]].forEach(([k,val])=>{
    inte.append(el('span',null,k+' '+n(val)));
  });
  const lk3=el('span',null,'→ Coverage'); lk3.style.cursor='pointer'; lk3.style.textDecoration='underline'; lk3.onclick=()=>goTab('coverage');
  inte.append(lk3);
  v.append(inte);

  const foot=el('div','hint'); foot.style.marginTop='14px';
  const flk=el('span',null,'View full evidence →'); flk.style.cursor='pointer'; flk.style.textDecoration='underline';
  flk.onclick=()=>goTab('findings');
  foot.append(flk);
  v.append(foot);
}

/* ─────────── Structure: 1 資源の全貌 ─────────── */
function renderStructure(){
  const v=$('#v-structure'); v.innerHTML='';
  const split=el('div','split');
  const side=el('div','side');
  const f=el('div','f');
  const q=el('input'); q.placeholder='Search resources (name / path)'; q.oninput=()=>{filters.q=q.value.toLowerCase();paintList();};
  const kinds=[...new Set(D.resources.map(r=>r.kind))].sort();
  const ks=el('select'); ks.append(new Option('All kinds',''));
  kinds.forEach(k=>ks.append(new Option(k+' ('+D.resources.filter(r=>r.kind===k).length+')',k)));
  ks.onchange=()=>{filters.kind=ks.value;paintList();};
  const chips=el('div','chips');
  [['','All'],['findings','Has finding'],['drift','Same name, different content'],['undiscovered','Not discovered'],['protected','protected']].forEach(([k,label])=>{
    const c=el('div','chip'+(k===''?' on':''),label); c.onclick=()=>{filters.only=k;chips.querySelectorAll('.chip').forEach(x=>x.classList.toggle('on',x===c));paintList();};
    chips.append(c);
  });
  f.append(q,ks,chips);
  const lg=el('div','legendline');
  lg.textContent='Right: C = Claude Code / X = Codex (runtime that discovered the file) · Left dot: red = finding / yellow = same name, different content / gray = not discovered';
  f.append(lg);
  const list=el('div','rlist'); list.id='rlist';
  side.append(f,list);
  const main=el('div','main'); main.id='rmain';
  split.append(side,main); v.append(split);
  paintList();
  if(D.resources.length) selectResource(pickDefault());
}
function pickDefault(){
  // 一番「見て面白い」もの: drift しているもの → Finding があるもの → 先頭
  const drift=D.resources.find(r=>r.siblings.some(s=>!s.content_matches));
  if(drift) return drift;
  const f=D.resources.find(r=>r.finding_ids.length);
  return f||D.resources[0];
}
function matches(r){
  if(filters.kind && r.kind!==filters.kind) return false;
  if(filters.q && !(r.name.toLowerCase().includes(filters.q)||r.display_path.toLowerCase().includes(filters.q))) return false;
  if(filters.only==='findings' && !r.finding_ids.length) return false;
  if(filters.only==='drift' && !r.siblings.some(s=>!s.content_matches)) return false;
  if(filters.only==='undiscovered' && !Object.values(r.by_runtime).flat().some(b=>!b.discovered)) return false;
  if(filters.only==='protected' && !r.protected) return false;
  return true;
}
function paintList(){
  const list=$('#rlist'); list.innerHTML='';
  const rs=D.resources.filter(matches);
  if(!rs.length){list.append(el('div','empty','No matches'));return;}
  rs.sort((a,b)=> a.kind===b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind));
  rs.forEach(r=>{
    const it=el('div','ritem'+(sel&&sel.path===r.path?' on':''));
    const dot=el('span','dot');
    const drift=r.siblings.some(s=>!s.content_matches);
    const und=Object.values(r.by_runtime).flat().some(b=>!b.discovered);
    dot.style.background = r.finding_ids.length ? 'var(--err)' : drift ? 'var(--warn)' : und ? 'var(--dim2)' : 'transparent';
    it.append(dot, el('span','k',r.kind), el('span','nm',r.name));
    // 同名が複数ある時に区別できるように、どの runtime 領域のものかを添える
    const disc=[...new Set(Object.entries(r.by_runtime).filter(([,bs])=>bs.some(b=>b.discovered)).map(([rt])=>rt))];
    const owners=disc.map(rt=>rt==='claude-code'?'C':rt==='codex'?'X':rt.slice(0,1).toUpperCase());
    const ow=sp_('k',owners.length?owners.join(''):'—');
    ow.title=disc.length?('Discovered by runtime: '+disc.join(', ')):'Not discovered by any runtime';
    it.append(ow);
    it.onclick=()=>{selectResource(r);paintList();};
    list.append(it);
  });
}
function selectResource(r){
  sel=r;
  const m=$('#rmain'); m.innerHTML='';

  // ★ つまり何？ — 事実の人間語訳（1〜2 行）。修正案は書かない
  if(r.human_summary && r.human_summary.length){
    const sm=el('div','sumline');
    sm.append(el('div',null,r.human_summary[0]));
    if(r.human_summary[1]) sm.append(el('div','s2',r.human_summary[1]));
    m.append(sm);
  }

  // 見出し
  const head=el('div','card');
  head.append(el('h3',null,r.kind+' · '+r.owner));
  const t=el('div'); t.style.fontSize='15px'; t.style.marginBottom='8px'; t.textContent=r.name;
  if(r.protected){const p=el('span','pill prot','protected'); p.style.marginLeft='8px'; t.append(p);}
  head.append(t);
  const kv=el('dl','kv');
  const rows=[['path',r.display_path],['real path',r.real_path||'—'],['size',n(r.size_bytes)+' B'],['last modified',r.mtime],
    ['normalized hash',r.normalized_hash.slice(0,26)+'…'],['description',r.description?short(r.description,220):'—']];
  rows.forEach(([k,val])=>{kv.append(el('dt',null,k)); const dd=el('dd','mono'); dd.textContent=val; kv.append(dd);});
  head.append(kv);
  m.append(head);

  // ★ 両 runtime からの見え方
  const box=el('div','card');
  box.append(el('h3',null,'How each runtime sees it'));
  const rt2=el('div','rt2');
  D.runtimes.forEach(rt=>{
    const bs=r.by_runtime[rt.runtime]||[];
    const b=el('div','rtbox '+(bs.length?(rt.runtime==='codex'?'codex':'claude'):'none'));
    const h=el('div','h'); h.append(el('span',null,rt.runtime));
    if(!bs.length) h.append(el('span','pill neutral','no binding'));
    else {
      const anyD=bs.some(x=>x.discovered);
      h.append(el('span','pill '+(anyD?'yes':'no'), anyD?'discovered':'not discovered'));
    }
    b.append(h);
    const body=el('div','b');
    if(!bs.length){
      body.append(el('div','muted','This runtime does not collect this path (no bindings)'));
    } else bs.forEach(x=>{
      const ul=el('ul','chain');
      const li0=el('li'); li0.append(frag(b_(x.mechanism),' · load_mode ',b_(x.load_mode),x.scope_condition?' · condition '+JSON.stringify(x.scope_condition):''));
      const li1=el('li',null); li1.textContent=x.source;
      const li2=el('li'); li2.append(frag('rule ',b_(x.rule_id),' ',sp_('muted','('+x.rule_source+', confidence '+x.confidence+')')));
      const li3=el('li'); li3.append(frag('applies to '+(x.applies_to.join(', ')||'—')+(x.precedence!=null?' · precedence '+x.precedence:'')));
      ul.append(li0,li1,li2,li3);
      body.append(ul);
      if(bs.length>1) body.append(el('div','hint','Multiple bindings on the same file. Different mechanisms mean different paths.'));
    });
    b.append(body); rt2.append(b);
  });
  box.append(rt2);
  m.append(box);

  // 同名の他資源（内容一致）
  if(r.siblings.length){
    const c=el('div','card');
    c.append(el('h3',null,'Other files with the same name'));
    const tb=el('table');
    tb.innerHTML='<thead><tr><th>path</th><th>content</th><th>discovered by runtime</th><th class="num">size</th><th>mtime</th></tr></thead>';
    const tb2=el('tbody');
    r.siblings.forEach(s=>{
      const tr=el('tr');
      tr.append(tdm(s.path));
      const td=el('td');
      td.append(el('span','pill '+(s.content_matches?'yes':'no'), s.content_matches?'match':'differs'+(s.lines_differ!=null?' ('+s.lines_differ+' lines)':'')));
      tr.append(td);
      tr.append(el('td',null,s.runtime_discovered.join(', ')||'—'));
      const n1=el('td','num',n(s.size_bytes)); tr.append(n1);
      tr.append(tdm(s.mtime));
      tb2.append(tr);
    });
    tb.append(tb2); c.append(tb);
    c.append(el('div','hint','If the content matches, the same name is not drift.'));
    m.append(c);
  }

  // 起動時のコスト
  if(r.cost.length){
    const c=el('div','card');
    c.append(el('h3',null,'What loads at startup'));
    const tb=el('table');
    tb.innerHTML='<thead><tr><th>runtime</th><th>load_mode</th><th>measured part</th><th class="num">bytes</th><th class="num">token</th><th>method</th></tr></thead>';
    const b2=el('tbody');
    r.cost.forEach(x=>{
      const tr=el('tr');
      tr.append(el('td',null,x.runtime),el('td',null,x.load_mode),el('td',null,x.measured_part.replace(/_/g,' ')));
      tr.append(el('td','num',n(x.bytes)),el('td','num',x.token_estimate?n(x.token_estimate):'—'),tdm(x.method));
      b2.append(tr);
    });
    tb.append(b2); c.append(tb);
    c.append(el('div','hint','Size is a fact. Appearing here is not itself a symptom.'));
    m.append(c);
  }

  // 参照
  if(r.references.length){
    const c=el('div','card');
    c.append(el('h3',null,'References found in this file (raw, unresolved)'));
    const tb=el('table'); tb.innerHTML='<thead><tr><th>line</th><th>raw</th><th>syntax</th><th>confidence</th></tr></thead>';
    const b2=el('tbody');
    r.references.slice(0,40).forEach(x=>{
      const tr=el('tr');
      tr.append(el('td','num',String(x.line)),tdm(x.raw),el('td',null,x.syntax),el('td',null,x.confidence));
      b2.append(tr);
    });
    tb.append(b2); c.append(tb);
    if(r.references.length>40) c.append(el('div','hint','First 40 shown.'));
    m.append(c);
  }

  // 出来事
  if(r.events.length){
    const c=el('div','card'); c.append(el('h3',null,'What happened to this file'));
    const ul=el('ul','tl');
    r.events.forEach(e=>{const li=el('li','changed'); li.append(el('div','t',e.observed_at+'  '+e.kind)); li.append(el('div',null,e.summary)); ul.append(li);});
    c.append(ul); m.append(c);
  }

  // Finding
  const fs=D.findings.filter(f=>r.finding_ids.includes(f.id));
  const c=el('div','card');
  c.append(el('h3',null,'Findings for this resource'));
  if(!fs.length) c.append(el('div','muted','None.'));
  else fs.forEach(f=>c.append(findingCard(f,true)));
  m.append(c);
}
function tdm(s){const td=el('td','mono'); td.textContent=s==null?'—':s; return td;}

/* ─────────── Findings ─────────── */
function findingCard(f,compact){
  const d=el('div','fnd'+(compact?'':''));
  const h=el('div','h');
  h.append(el('span','sev '+f.severity,f.severity));
  const t=el('div','t');
  t.append(frag(b_(f.id),' '+f.finding_id+(f.subtype?' / '+f.subtype:'')));
  const sub=el('div','muted'); sub.style.fontSize='11.5px'; sub.textContent=f.subject_display; t.append(sub);
  h.append(t);
  h.append(el('span','pill neutral','confidence '+f.confidence));
  if(f.scope==='active_runtime') h.append(el('span','pill neutral','active runtime'));
  if(f.protected) h.append(el('span','pill prot','protected'));
  else if(f.touches_protected) h.append(el('span','pill prot','touches protected resource'));
  if(f.cluster) h.append(el('span','pill neutral',f.cluster));
  h.onclick=()=>d.classList.toggle('open');
  d.append(h);
  const b=el('div','b');
  const sm=el('div',null,f.summary); sm.style.marginBottom='9px'; b.append(sm);
  if(f.evidence.length){
    b.append(el('h3',null,'Evidence'));
    const ul=el('ul','ev');
    f.evidence.forEach(e=>{
      const li=el('li'); li.append(el('span','ty',e.type));
      li.append(document.createTextNode(e.text));
      if(e.extra&&e.extra.length){const s=el('div','sub','Searched: '+e.extra.join(' · ')); li.append(s);}
      ul.append(li);
    });
    b.append(ul);
  }
  if(f.unknowns.length) b.append(listOf('Not yet determined',f.unknowns));
  if(f.did_not_conclude.length) b.append(listOf('What Doctor did not conclude',f.did_not_conclude));
  if(f.human_decision.length) b.append(listOf('Ask a human',f.human_decision));
  if(f.protected_note){const p=el('div','note'); p.textContent=f.protected_note; b.append(p);}
  if(f.subject_path){
    const a=el('div','hint'); const link=el('span',null,'→ Open this resource in Structure view'); link.style.cursor='pointer'; link.style.textDecoration='underline';
    link.onclick=()=>{const r=D.resources.find(x=>x.display_path===f.subject_path); if(r){document.querySelector('.tab[data-v=structure]').click(); selectResource(r); paintList(); window.scrollTo(0,0);}};
    a.append(link); b.append(a);
  }
  d.append(b);
  return d;
}
function renderFindings(){
  const v=$('#v-findings'); v.innerHTML='';
  if(!D.findings.length){v.append(el('div','empty','No findings.')); return;}
  /* Overview の cluster から潜ってきた時は、その束だけを出す（戻れるようにバーを置く） */
  if(findingFilter){
    const fb=el('div','filterbar');
    fb.append(b_(findingFilter.headline));
    fb.append(sp_('muted',findingFilter.members.length+' item(s)'));
    const x=el('span','x','Clear filter');
    x.onclick=()=>{findingFilter=null; renderFindings();};
    fb.append(x);
    const back=el('span','x','← Back to Overview');
    back.onclick=()=>{findingFilter=null; renderFindings(); goTab('overview');};
    fb.append(back);
    v.append(fb);
    const fs=D.findings.filter(f=>findingFilter.members.indexOf(f.id)>=0);
    fs.forEach(f=>{const card=findingCard(f); card.classList.add('open'); v.append(card);});
    return;
  }
  if(D.clusters.length){
    const c=el('div','card'); c.append(el('h3',null,'Grouped by shared cause (one question each)'));
    D.clusters.forEach(cl=>{
      const d=el('div'); d.style.marginBottom='9px';
      d.append(frag(b_(cl.title),' ',sp_('muted mono',cl.members.join(', '))));
      const qd=el('div','muted'); qd.style.fontSize='11.5px'; qd.textContent=cl.question; d.append(qd);
      c.append(d);
    });
    v.append(c);
  }
  ['error','warn','info'].forEach(sev=>{
    const fs=D.findings.filter(f=>f.severity===sev);
    if(!fs.length) return;
    v.append(el('h2','sec',sev.toUpperCase()+' — '+fs.length));
    fs.forEach(f=>v.append(findingCard(f)));
  });
  const w=el('div','warnbox');
  w.append(frag('Doctor goes ',b_('observation → evidence → symptom'),' and stops there. It does not treat. The fix is decided by a human, or the LLM a human uses (',sp_('mono','report --llm'),').'));
  v.append(w);
}

/* ─────────── Context cost ─────────── */
function renderCost(){
  const v=$('#v-cost'); v.innerHTML='';
  const c=D.cost;
  const w=el('div','warnbox');
  w.append(frag(b_('Big is not bad.'),' This shows size as a fact. Whether it is a symptom is decided separately in Findings. Big numbers are not colored red.'));
  const mn=el('div','hint'); mn.style.marginTop='5px'; mn.textContent=c.method_note; w.append(mn);
  v.append(w);

  const modes=Object.entries(c.by_load_mode).sort((a,b)=>b[1].bytes-a[1].bytes);
  const total=modes.reduce((n2,[,x])=>n2+x.bytes,0)||1;
  const card=el('div','card'); card.append(el('h3',null,'What loads at startup (by load_mode)'));
  const bar=el('div','bar');
  const COL={always:'#4a5568',on_demand:'#3d4a5c',deferred:'#2f3945',never:'#242a32',unknown:'#2a2f38',path_conditional:'#354052'};
  modes.forEach(([k,x])=>{const sp=el('span'); sp.style.width=(x.bytes/total*100)+'%'; sp.style.background=COL[k]||'#333'; sp.title=k+': '+n(x.bytes)+' B'; bar.append(sp);});
  card.append(bar);
  const lg=el('div','legend');
  modes.forEach(([k,x])=>{
    const s=el('span'); const i=el('i'); i.style.background=COL[k]||'#333';
    s.append(i,document.createTextNode(k+' · '+n(x.items)+' item(s) · '+n(x.bytes)+' B'+(x.token_estimate?' · '+n(x.token_estimate)+' tok':'')));
    lg.append(s);
  });
  card.append(lg);
  const hint=el('div','hint');
  hint.textContent='always = loads every time. on_demand = only the description loads, body loads when invoked. deferred = name only (near-zero fixed cost).';
  card.append(hint);
  v.append(card);

  const two=el('div','two');
  const p=el('div','card'); p.append(el('h3',null,'protected vs. everything else'));
  const tb=el('table'); tb.innerHTML='<thead><tr><th></th><th class="num">items</th><th class="num">bytes</th><th class="num">token</th></tr></thead>';
  const tb2=el('tbody');
  [['protected (no suggestions)',c.protected_total],['other',c.unprotected_total]].forEach(([label,x])=>{
    const tr=el('tr'); tr.append(el('td',null,label),el('td','num',n(x.items)),el('td','num',n(x.bytes)),el('td','num',n(x.token_estimate))); tb2.append(tr);
  });
  tb.append(tb2); p.append(tb);
  p.append(el('div','hint','protected = memory / identity / instruction. No suggestions are made about their size. Shown separately from the total.'));
  two.append(p);

  const rc=el('div','card'); rc.append(el('h3',null,'Fixed startup cost by runtime'));
  const t2=el('table'); t2.innerHTML='<thead><tr><th>runtime</th><th class="num">always (tok)</th><th class="num">description (tok)</th><th class="num">deferred items</th></tr></thead>';
  const t2b=el('tbody');
  Object.entries(c.by_runtime).forEach(([rt,x])=>{
    const tr=el('tr'); tr.append(el('td',null,rt),el('td','num',n(x.always_token_estimate)),el('td','num',n(x.on_demand_description_token_estimate)),el('td','num',n(x.deferred_items))); t2b.append(tr);
  });
  t2.append(t2b); rc.append(t2);
  rc.append(el('div','hint','always tokens are 0 for items whose body is not read (see the table below for bytes). No conversion is applied.'));
  two.append(rc);
  v.append(two);

  const lc=el('div','card'); lc.append(el('h3',null,'Largest first (20 items)'));
  const t3=el('table'); t3.innerHTML='<thead><tr><th>path</th><th>runtime</th><th>load_mode</th><th>measured part</th><th class="num">context bytes</th><th class="num">token</th><th class="num">file itself</th></tr></thead>';
  const t3b=el('tbody');
  c.largest.slice().sort((a,b)=>(b.bytes-a.bytes)||(b.declared_bytes-a.declared_bytes)).forEach(x=>{
    const tr=el('tr','clickable');
    tr.append(tdm(x.path),el('td',null,x.runtime),el('td',null,x.load_mode),el('td',null,x.measured_part.replace(/_/g,' ')),el('td','num',x.bytes?n(x.bytes):'0'),el('td','num',x.token_estimate?n(x.token_estimate):'—'),el('td','num',n(x.declared_bytes)));
    if(x.protected) tr.children[0].append(el('span','pill prot','protected'));
    if(x.duplicate_paths>1) tr.children[0].append(sp_('pill neutral','+'+(x.duplicate_paths-1)+' same content'));
    tr.onclick=()=>{const r=D.resources.find(y=>y.display_path===x.path); if(r){document.querySelector('.tab[data-v=structure]').click(); selectResource(r); paintList(); window.scrollTo(0,0);}};
    t3b.append(tr);
  });
  t3.append(t3b); lc.append(t3);
  v.append(lc);

  const nm=el('div','card'); nm.append(el('h3',null,'What is not measured'));
  const ul=el('ul','plain'); c.not_measured.forEach(x=>ul.append(el('li',null,x))); nm.append(ul);
  v.append(nm);
}

/* ─────────── Hooks ─────────── */
function renderHooks(){
  const v=$('#v-hooks'); v.innerHTML='';
  const w=el('div','warnbox');
  w.append(frag(b_('Many hooks is not bad.'),' Reported as a symptom only when: the same thing takes effect through multiple paths, the same body is injected repeatedly, or it amplifies beyond its intended scope. A hook that injects 0 bytes is not a symptom no matter how often it fires.'));
  v.append(w);
  if(!D.hooks.length){v.append(el('div','empty','No hooks registered.')); return;}
  const byEvent={};
  D.hooks.forEach(h=>{(byEvent[h.event]??=[]).push(h);});
  Object.entries(byEvent).sort().forEach(([ev,hs])=>{
    const c=el('div','card'); c.append(el('h3',null,ev+' — '+hs.length+' item(s)'));
    const tb=el('table'); tb.innerHTML='<thead><tr><th>registered at</th><th>runtime</th><th>applies to</th><th>command</th></tr></thead>';
    const tb2=el('tbody');
    hs.forEach(h=>{
      const tr=el('tr');
      tr.append(tdm(h.display_path.split('#')[1]||h.display_path),el('td',null,h.runtime),el('td',null,h.applies_to.join(', ')||'—'),tdm(short(h.command||'—',110)));
      tb2.append(tr);
    });
    tb.append(tb2); c.append(tb); v.append(c);
  });
  const fs=D.findings.filter(f=>f.finding_id==='HOOK_AMPLIFICATION');
  const c=el('div','card'); c.append(el('h3',null,'Reported as amplification'));
  if(!fs.length) c.append(el('div','muted','None.'));
  else fs.forEach(f=>c.append(findingCard(f,true)));
  v.append(c);
  const q=D.not_findings.not_evaluated.filter(x=>x.detector.includes('HOOK'));
  if(q.length){const nc=el('div','card'); nc.append(el('h3',null,'Not reported as amplification'));
    const ul=el('ul','plain'); q.forEach(x=>ul.append(el('li',null,x.reason))); nc.append(ul); v.append(nc);}
}

/* ─────────── History ─────────── */
function renderHistory(){
  const v=$('#v-history'); v.innerHTML='';
  const h=D.history;
  if(h.snapshots<2){
    const w=el('div','warnbox');
    w.append(frag('Only '+h.snapshots+' comparable snapshot(s), so no events can be derived yet. Taking a few more with ',sp_('mono','agent-doctor snapshot --out snapshots/<name>.json'),' over time builds a history.'));
    v.append(w);
  }
  const nc=el('div','card'); nc.append(el('h3',null,'How to read this history'));
  const ul=el('ul','plain'); h.notes.forEach(x=>ul.append(el('li',null,x))); nc.append(ul);
  v.append(nc);
  if(h.gaps.length){
    const c=el('div','card'); c.append(el('h3',null,'Unobserved gaps (whatever happened here is not visible)'));
    const tb=el('table'); tb.innerHTML='<thead><tr><th>from</th><th>to</th><th class="num">hours</th></tr></thead>';
    const b=el('tbody'); h.gaps.forEach(g=>{const tr=el('tr'); tr.append(tdm(g.from),tdm(g.to),el('td','num',g.hours+' h')); b.append(tr);});
    tb.append(b); c.append(tb); v.append(c);
  }
  if(h.trend.length){
    const c=el('div','card'); c.append(el('h3',null,'Trend (a list of facts, not a score)'));
    const tb=el('table'); tb.innerHTML='<thead><tr><th>snapshot</th><th class="num">resources</th><th class="num">bindings</th><th class="num">discovered</th><th class="num">same name, different content</th><th class="num">sessions</th></tr></thead>';
    const b=el('tbody');
    h.trend.forEach(t=>{const tr=el('tr'); tr.append(tdm(t.at),el('td','num',n(t.resources)),el('td','num',n(t.bindings)),el('td','num',n(t.discovered)),el('td','num',n(t.drifted_skills)),el('td','num',t.sessions===null?'not observed':n(t.sessions))); b.append(tr);});
    tb.append(b); c.append(tb);
    c.append(el('div','hint','A change in count by itself is not a defect.'));
    v.append(c);
  }
  const c=el('div','card'); c.append(el('h3',null,'What happened'));
  if(!h.events.length) c.append(el('div','muted','No events derived.'));
  else{
    const byKind={};
    h.events.forEach(e=>{(byKind[e.kind]??=[]).push(e);});
    const sum=el('div','legend');
    Object.entries(byKind).sort((a,b)=>b[1].length-a[1].length).forEach(([k,xs])=>sum.append(el('span',null,k+' · '+xs.length)));
    c.append(sum);
    const ul=el('ul','tl'); ul.style.marginTop='10px';
    h.events.slice(0,200).forEach(e=>{
      const li=el('li',e.direction);
      li.append(el('div','t',e.observed_at+'  ·  '+e.kind+'  ·  since '+e.since));
      li.append(el('div',null,e.summary));
      ul.append(li);
    });
    c.append(ul);
    if(h.events.length>200) c.append(el('div','hint','First 200 shown.'));
  }
  v.append(c);
}

/* ─────────── Not findings ─────────── */
function renderNotFindings(){
  const v=$('#v-notfindings'); v.innerHTML='';
  const w=el('div','warnbox');
  w.append(frag(b_('Just a large number / unused / invisible'),' is not treated as a symptom. This list shows every time that Doctor is not an Optimizer.'));
  v.append(w);
  const nf=D.not_findings;
  const c1=el('div','card'); c1.append(el('h3',null,'Not turned into a finding'));
  if(!nf.suppressed.length) c1.append(el('div','muted','None.'));
  nf.suppressed.forEach(x=>{
    const d=el('div'); d.style.marginBottom='8px';
    d.append(sp_('pill neutral',x.reason));
    if(x.count!=null){d.append(document.createTextNode(' ')); d.append(sp_('mono muted',n(x.count)));}
    const dt=el('div'); dt.style.fontSize='11.5px'; dt.style.marginTop='3px'; dt.textContent=x.detail; d.append(dt);
    c1.append(d);
  });
  v.append(c1);

  const c2=el('div','card'); c2.append(el('h3',null,'protected — no suggestions about size or existence ('+nf.protected.length+')'));
  const byGlob={}; nf.protected.forEach(p=>{(byGlob[p.glob]??=[]).push(p);});
  Object.entries(byGlob).forEach(([g,ps])=>{
    const d=el('div'); d.style.marginBottom='7px';
    d.append(el('code',null,g),document.createTextNode(' '),sp_('muted',ps.length+' item(s)'));
    const tb=el('table');
    const b=el('tbody');
    ps.slice(0,40).forEach(p=>{const tr=el('tr'); tr.append(tdm(p.display_path),el('td','num',n(p.size_bytes)+' B'),tdm(p.real_path?'→ '+p.real_path:'')); b.append(tr);});
    tb.append(b); d.append(tb);
    if(ps.length>40) d.append(el('div','hint','First 40 shown.'));
    c2.append(d);
  });
  v.append(c2);

  const c3=el('div','card'); c3.append(el('h3',null,'Not evaluated (missing input, not a pass)'));
  if(!nf.not_evaluated.length) c3.append(el('div','muted','None.'));
  const ul=el('ul','plain'); nf.not_evaluated.forEach(x=>ul.append(el('li',null,x.detector+': '+x.reason))); c3.append(ul);
  v.append(c3);
}

/* ─────────── Coverage / 環境 ─────────── */
function renderCoverage(){
  const v=$('#v-coverage'); v.innerHTML='';
  const c0=el('div','card'); c0.append(el('h3',null,'runtime'));
  const tb=el('table'); tb.innerHTML='<thead><tr><th>runtime</th><th>version</th><th>config home</th><th class="num">bindings</th><th class="num">discovered</th></tr></thead>';
  const b=el('tbody');
  D.runtimes.forEach(r=>{const tr=el('tr'); tr.append(el('td',null,r.runtime+(r.present?'':' (not present)')),tdm(r.version||'?'),tdm(r.config_home),el('td','num',n(r.resources)),el('td','num',n(r.discovered))); b.append(tr);});
  tb.append(b); c0.append(tb);
  const kv=el('dl','kv');
  [['project',D.env.project||'—'],['home',D.env.home],['launchers',D.env.launchers.join(', ')||'— (only collected when named via --launcher)'],['os',D.env.os]].forEach(([k,val])=>{kv.append(el('dt',null,k)); const dd=el('dd','mono'); dd.textContent=val; kv.append(dd);});
  c0.append(kv);
  v.append(c0);

  if(D.sessions.length){
    const c=el('div','card'); c.append(el('h3',null,'Currently running sessions (read from records)'));
    const t=el('table');
    t.innerHTML='<thead><tr><th>session</th><th>runtime</th><th>entrypoint</th><th>started</th><th>live</th><th>capability</th><th class="num">always files changed since start</th><th>compared</th></tr></thead>';
    const tb2=el('tbody');
    D.sessions.forEach(s=>{
      const tr=el('tr');
      tr.append(tdm(s.session_id.slice(0,8)),el('td',null,s.runtime),el('td',null,s.entrypoint||'?'),tdm(s.started_at||'?'));
      const lv=el('td'); lv.append(el('span','pill '+(s.live?'yes':'neutral'),s.live?'yes':'no')); tr.append(lv);
      const caps=Object.entries(s.capability_counts).filter(([,x])=>x!==null).map(([k,x])=>k.replace('_',' ')+' '+x).join(' · ')||'no records';
      tr.append(el('td','muted',caps));
      tr.append(el('td','num',s.stale_files?String(s.stale_files):'—'));
      const cm=el('td','muted'); cm.textContent=(s.compared_capabilities?'capability ✓':'capability —')+' / '+(s.compared_timestamps?'time ✓':'time —')+(s.not_compared_reason?' · '+short(s.not_compared_reason,70):'');
      tr.append(cm);
      tb2.append(tr);
    });
    t.append(tb2); c.append(t);
    if(D.probe_notes.length){const ul=el('ul','plain'); ul.style.marginTop='9px'; D.probe_notes.forEach(x=>ul.append(el('li',null,x))); c.append(ul);}
    v.append(c);
  }
  if(D.processes.length){
    const c=el('div','card'); c.append(el('h3',null,'Running processes (from argv)'));
    const t=el('table'); t.innerHTML='<thead><tr><th class="num">pid</th><th>runtime</th><th>started</th><th class="num">injected system prompt</th><th>flags</th></tr></thead>';
    const b2=el('tbody');
    D.processes.forEach(p=>{const tr=el('tr'); tr.append(el('td','num',String(p.pid)),el('td',null,p.runtime),tdm(p.started_at||'?'),el('td','num',p.injected_bytes!=null?n(p.injected_bytes)+' B':'—'),el('td','muted',short(p.flags.join(' '),90))); b2.append(tr);});
    t.append(b2); c.append(t); v.append(c);
  }

  // 見に行った結果（0 件と「読めなかった」を分ける）
  const ac=el('div','card'); ac.append(el('h3',null,'What we looked at'));
  const acw=el('div','hint'); acw.textContent=D.access.note; ac.append(acw);
  if(!D.access.records.length) ac.append(el('div','muted','No records.'));
  else{
    const t=el('table'); t.innerHTML='<thead><tr><th>what</th><th>where</th><th>result</th><th class="num">count</th><th>reason</th></tr></thead>';
    const tb=el('tbody');
    D.access.records.forEach(a=>{
      const tr=el('tr');
      tr.append(el('td',null,a.what),tdm(a.target),el('td',null,a.status+(a.error_code?' ('+a.error_code+')':'')));
      tr.append(el('td','num',a.status==='observed'?n(a.count):'—'));
      tr.append(el('td','muted',a.reason||''));
      tb.append(tr);
    });
    t.append(tb); ac.append(t);
    if(D.access.could_not_observe.length){
      const w=el('div','warnbox'); w.style.marginTop='10px';
      w.append(frag(b_(D.access.could_not_observe.length+' item(s) could not be read.'),' This is "unknown", not zero. No finding in this range does not mean there is no problem.'));
      ac.append(w);
    }
  }
  v.append(ac);

  const two=el('div','two');
  const c1=el('div','card'); c1.append(el('h3',null,'What is observed'));
  const u1=el('ul','plain'); D.coverage.collected.forEach(x=>u1.append(el('li',null,x))); c1.append(u1);
  const c2=el('div','card'); c2.append(el('h3',null,'What is not observed (no finding here does not mean there is no problem)'));
  const u2=el('ul','plain'); D.coverage.not_collected.forEach(x=>u2.append(el('li',null,x))); c2.append(u2);
  two.append(c1,c2); v.append(two);
}
</script>
</body>
</html>`;
}
