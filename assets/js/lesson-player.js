// Shared lesson player (kit "לילה וזהב"). Each lessons/<id>.html is a thin page with
// <body data-lesson="<id>">; the lesson's content lives in lessons/data/<id>.json and the
// lesson order (for previous/next) in lessons.json.
(function () {
const id = document.body.dataset.lesson;
const view0 = document.getElementById("view");
Promise.all([
  fetch("data/" + id + ".json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  fetch("../lessons.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
]).then(([L, site]) => {
  const order = site ? [].concat(...site.groups.map((g) => g.lessons.map((l) => l.id))) : [];
  const i = order.indexOf(id);
  L.prev = i > 0 ? order[i - 1] : "";
  L.next = i > -1 && i < order.length - 1 ? order[i + 1] : "";
  run(L);
}).catch(() => { view0.innerHTML = '<p style="padding:24px;text-align:center">לא הצלחתי לטעון את השיעור. נסו לרענן את הדף.</p>'; });

function run(LESSON) {
/* ===== ENGINE ===== */
const GATE_TITLE='תרגול מכפיל את הזיכרון',GATE_TEXT='להכפיל?';
const NONQ=['intro','read','summary','gate'];
function grp(s){const a=LESSON.screens,k=a.indexOf(s);if(NONQ.includes(s.type))return null;let b=k,e=k;while(b>0&&!NONQ.includes(a[b-1].type))b--;while(e<a.length-1&&!NONQ.includes(a[e+1].type))e++;return{i:k-b,n:e-b+1}}
const KIND={mc:'אמריקאית',tf:'נכון / לא נכון',fill:'השלמת מילה',build:'בניית משפט',match:'התאמת זוגות',order:'סדרו לפי הסדר',sort:'מיון לסלים',marker:'מרקר',flip:'קלפים הפוכים',judge:'אתה הדיין',open:'שאלה לחשיבה',read:'מהשיעור'};
const SCORED=['mc','tf','fill','build','match','order','sort','marker','judge'];
const view=document.getElementById('view');
let showText=false,noQ=false,mode='play',cur=0,R={};
function rnd(seed){return()=>{seed=(seed*9301+49297)%233280;return seed/233280}}
function shuf(arr,seed){const r=rnd(seed),a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[a[i],a[j]]=[a[j],a[i]]}if(a.join()===arr.join()&&a.length>1)a.push(a.shift());return a}
const screens=()=>LESSON.screens.filter(s=>(showText||!s.preview)&&(!noQ||['intro','read','summary'].includes(s.type)));
function st(s){const k=LESSON.screens.indexOf(s);return R[k]||(R[k]={done:false,ok:null,pick:null,seq:[],sel:null,matched:{},miss:0,sorted:{},open:{}})}
function pillify(t,s){const items=[].concat(...[...(s.before||[]),...(s.after||[])].filter(b=>b.k==='pills').map(b=>b.items));items.forEach(w=>{t=t.split(w).join('<span class="ipill">'+w+'</span>')});return t}
const ART={'איור: רבי עקיבא דואג ומביט בכוכבים':'<rect width="160" height="120" fill="#14213D"/><g fill="#F2B33D"><circle cx="20" cy="18" r="1.6"/><circle cx="44" cy="10" r="1.2"/><circle cx="62" cy="28" r="1.8"/><circle cx="96" cy="14" r="1.3"/><circle cx="112" cy="34" r="1.6"/><circle cx="140" cy="20" r="1.2"/><circle cx="30" cy="44" r="1.1"/><circle cx="80" cy="46" r="1.2"/><path d="M128 10a12 12 0 1 0 10 18a10 10 0 1 1-10-18z"/></g><path d="M0 104q40-18 80-10t80 6v20H0z" fill="#22335A"/><g><path d="M64 118q2-34 16-38q14 4 16 38z" fill="#F5EBD3"/><path d="M70 118q2-26 10-30q8 4 10 30z" fill="#E8DCC4"/><circle cx="80" cy="72" r="9" fill="#F5EBD3"/><path d="M71 70q9-10 18 0q-1-9-9-9t-9 9z" fill="#AEB9D6"/></g>','איור: נחש בין אבני הקיר':'<rect width="160" height="120" fill="#F5EBD3"/><g fill="#E8DCC4" stroke="#D8C39A" stroke-width="1.5"><rect x="-10" y="6" width="50" height="24" rx="4"/><rect x="44" y="6" width="56" height="24" rx="4"/><rect x="104" y="6" width="66" height="24" rx="4"/><rect x="10" y="34" width="54" height="24" rx="4"/><rect x="96" y="34" width="54" height="24" rx="4"/><rect x="-10" y="62" width="44" height="24" rx="4"/><rect x="38" y="62" width="58" height="24" rx="4"/><rect x="100" y="62" width="70" height="24" rx="4"/><rect x="14" y="90" width="60" height="24" rx="4"/><rect x="78" y="90" width="66" height="24" rx="4"/></g><rect x="66" y="35" width="28" height="22" rx="3" fill="#22335A"/><path d="M70 52q6-10 12-4t10-6" stroke="#2BB3A3" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="91" cy="41" r="4.5" fill="#2BB3A3"/><circle cx="92.5" cy="40" r="1.2" fill="#14213D"/>','איור: סיכה תקועה בין אבני הקיר':'<rect width="160" height="120" fill="#F5EBD3"/><g fill="#E8DCC4" stroke="#D8C39A" stroke-width="1.5"><rect x="-10" y="6" width="50" height="24" rx="4"/><rect x="44" y="6" width="56" height="24" rx="4"/><rect x="104" y="6" width="66" height="24" rx="4"/><rect x="10" y="34" width="54" height="24" rx="4"/><rect x="96" y="34" width="54" height="24" rx="4"/><rect x="-10" y="62" width="44" height="24" rx="4"/><rect x="38" y="62" width="58" height="24" rx="4"/><rect x="100" y="62" width="70" height="24" rx="4"/><rect x="14" y="90" width="60" height="24" rx="4"/><rect x="78" y="90" width="66" height="24" rx="4"/></g><rect x="66" y="35" width="28" height="22" rx="3" fill="#22335A"/><line x1="80" y1="46" x2="120" y2="20" stroke="#B9801A" stroke-width="2.5" stroke-linecap="round"/><circle cx="121" cy="19" r="5" fill="#F2B33D" stroke="#B9801A" stroke-width="1.5"/><g stroke="#F2B33D" stroke-width="2" stroke-linecap="round"><line x1="132" y1="12" x2="138" y2="8"/><line x1="134" y1="22" x2="141" y2="23"/><line x1="124" y1="6" x2="126" y2="0"/></g>','איור: עני מקבל מנה בסעודה':'<rect width="160" height="120" fill="#FFF8EC"/><rect x="0" y="92" width="160" height="28" fill="#F5EBD3"/><rect x="14" y="70" width="96" height="8" rx="3" fill="#B9801A"/><rect x="22" y="78" width="6" height="30" fill="#8A6A1F"/><rect x="96" y="78" width="6" height="30" fill="#8A6A1F"/><path d="M44 58h36q-2 14-18 14t-18-14z" fill="#FFFFFF" stroke="#14213D" stroke-width="2"/><ellipse cx="62" cy="58" rx="18" ry="3" fill="#F2B33D"/><g stroke="#AEB9D6" stroke-width="2" fill="none" stroke-linecap="round"><path d="M54 50q-3-5 0-10"/><path d="M62 48q-3-5 0-10"/><path d="M70 50q-3-5 0-10"/></g><path d="M118 112q2-30 14-34q12 4 14 34z" fill="#22335A"/><circle cx="132" cy="68" r="8" fill="#F5EBD3" stroke="#22335A" stroke-width="2"/><line x1="150" y1="60" x2="150" y2="112" stroke="#8A6A1F" stroke-width="3" stroke-linecap="round"/><path d="M118 88q-14-4-26-2" stroke="#22335A" stroke-width="5" fill="none" stroke-linecap="round"/>'};
function hl(t,words){words.forEach(w=>{const i=t.indexOf(w);if(i>-1)t=t.slice(0,i)+'<mark>'+w+'</mark>'+t.slice(i+w.length)});return t}
function blocks(arr){return (arr||[]).map(b=>{
 if(b.k==='cards')return `<div class="cmp">${b.items.map(c=>`<div class="${c.c||''}"><strong>${c.t}</strong><span>${c.s}</span></div>`).join('')}</div>`;
 if(b.k==='gloss')return `<div class="gloss">${b.items.map(g=>`<div class="tx">${g}</div>`).join('')}</div>`;
 if(b.k==='pills')return `<div class="pills">${b.items.map(p=>`<span>${p}</span>`).join('')}</div>`;
 if(b.k==='short')return `<div class="short"><b>בקיצור</b>${b.text}</div>`;
 if(b.k==='bars')return `<div class="bars">${b.rows.map(r=>`<div class="bar"><span class="bl">${r[0]}</span><div class="bt"><i class="${r[3]}" style="width:${r[2]}%"></i></div><span class="bv">${r[1]}</span></div>`).join('')}</div>`;
 if(b.k==='verses')return b.items.map(v=>`<div class="verse ${v.c}"><div class="v">${v.before}<span class="w">${v.word}</span>${v.after}</div><small>${v.src}</small></div>`).join('');
 return ''}).join('')}
const AB=['א','ב','ג'];
function whyBox(s,r){const w=s.why||s.din;if(!w)return `<div class="fbs ${r.ok?'ok':'no'}">${r.ok?'נכון!':'התשובה הנכונה מסומנת בירוק'}</div>`;const bad=r.ok===false;return `<div class="why ${bad?'bad':''}"><b>${r.ok===null?'הסבר':bad?'לא בדיוק':'נכון!'}</b>${w}</div>`}

function body(s){const r=st(s),k=LESSON.screens.indexOf(s);
 if(s.type==='intro')return `<div class="ihead"><span>פשיטא</span><span>${LESSON.ref}</span></div><h1 class="ititle">${LESSON.title}</h1><div class="iq"><div class="lbl2">השאלה של השיעור</div><p>${LESSON.intro.question}</p></div><div class="kinds">${LESSON.intro.kinds.map(k=>`<div class="kd ${k.c}">${k.icon}<strong>${k.t}</strong><small>${k.s}</small></div>`).join('')}</div><div class="slist">${LESSON.stations.map((n,i)=>`<div><span>${i+1}</span>${n}</div>`).join('')}</div>`;
 if(s.type==='read')return (s.kicker?`<div class="kicker">${s.kicker}</div>`:'')+(true?`<div class="flag"><span class="n">${s.st+1}</span><h2>${LESSON.stations[s.st]}</h2></div>`:'')+(s.comic?`<div class="comic">${s.comic.map(p=>`<div class="panel">${ART[p[0]]?`<svg class="cart" viewBox="0 0 160 120" role="img" aria-label="${p[0]}">${ART[p[0]]}</svg>`:`<div class="cph">[${p[0]}]</div>`}<div class="cap tx">${p[1]}</div></div>`).join('')}</div>`:'')+(()=>{const side=blocks(s.before)+blocks((s.after||[]).filter(x=>x.k==='short'));return `<div class="rcols ${side?'has-side':''}"><div class="rmain">`+s.text.map(t=>`<div class="ptext tx">${pillify(hl(t,s.hl||[]),s)}</div>`).join('')+(s.quote?`<div class="srcq">${s.quote}</div>`:'')+blocks((s.after||[]).filter(x=>x.k!=='short'&&x.k!=='pills'))+`</div>`+(side?`<div class="raside">${side}</div>`:'')+`</div>`})();
 if(s.type==='mc'||s.type==='judge'){let h='';
  if(s.type==='judge')h+=`<div class="q">אתה הדיין</div><div class="sides">${s.sides.map(x=>`<div class="side"><b>${x[0]}</b>${x[1]}</div>`).join('')}</div><div class="lbl">מי צודק?</div>`;else h+=`<div class="q">${s.q}</div>`;
  return h+`<div class="opts">${s.o.map((o,i)=>`<button class="opt ${r.done?(i===s.a?'ok':i===r.pick?'no':''):''}" data-a="${i}" ${r.done?'disabled':''}><i>${AB[i]}</i>${o}</button>`).join('')}</div>${r.done?whyBox(s,r):''}`}
 if(s.type==='tf')return `<div class="q">נכון או לא נכון?</div><div class="stmt">${s.s}</div><div class="tfrow">${[true,false].map(v=>`<button class="opt ${r.done?(v===s.a?'ok':v===r.pick?'no':''):''}" data-a="${v}" ${r.done?'disabled':''}>${v?'נכון':'לא נכון'}</button>`).join('')}</div>${r.done?whyBox(s,r):''}`;
 if(s.type==='fill')return `<div class="q">השלימו את המילה החסרה</div><div class="sent">${s.before}<span class="blank">${r.done?s.o[s.a]:'?'}</span>${s.after}</div><div class="opts">${s.o.map((o,i)=>`<button class="opt ${r.done?(i===s.a?'ok':i===r.pick?'no':''):''}" data-a="${i}" ${r.done?'disabled':''}><i>${AB[i]}</i>${o}</button>`).join('')}</div>${r.done?whyBox(s,r):''}`;
 if(s.type==='marker')return `<div class="q">${s.q}</div><div class="words">${s.words.map((w,i)=>`<button class="${r.done?(i===s.a?'ok':i===r.pick?'no':''):''}" data-a="${i}" ${r.done?'disabled':''}>${w}</button>`).join('')}</div>${r.done?whyBox(s,r):''}`;
 if(s.type==='build'||s.type==='order'){const pool=s.type==='build'?s.tiles:s.items;const order=shuf(pool.map((_,i)=>i),k+3);
  return `<div class="q">${s.q}</div><div class="line ${r.done?(r.ok?'ok':'no'):''}">${r.seq.map((i,n)=>`<button class="tile" data-rm="${n}" ${r.done?'disabled':''}>${pool[i]}</button>`).join('')||'<span class="lbl">לחצו על החלקים לפי הסדר</span>'}</div>
  <div class="tiles">${order.map(i=>`<button class="tile" data-add="${i}" ${r.seq.includes(i)||r.done?'disabled':''}>${pool[i]}</button>`).join('')}</div>
  ${r.done&&!r.ok?`<div class="lbl">התשובה: ${s.type==='build'?s.ans:s.items.join(' · ')}</div>`:''}${r.done?whyBox(s,r):''}`}
 if(s.type==='match'){const right=shuf(s.pairs.map((_,i)=>i),k+7);
  return `<div class="q">${s.q}</div><div class="lbl">לחצו על מילה ואחר כך על מה שמתאים לה</div><div class="mgrid"><div class="mcol">${s.pairs.map((p,i)=>`<button class="mitem ${r.matched[i]?'ok':''} ${r.sel===i?'sel':''}" data-l="${i}" ${r.matched[i]?'disabled':''}>${p[0]}</button>`).join('')}</div><div class="mcol">${right.map(i=>`<button class="mitem ${r.matched[i]?'ok':''} ${r.flash===i?'no':''}" data-r="${i}" ${r.matched[i]?'disabled':''}>${s.pairs[i][1]}</button>`).join('')}</div></div>${r.done?whyBox(s,r):''}`}
 if(s.type==='sort'){const order=shuf(s.items.map((_,i)=>i),k+5);
  return `<div class="q">${s.q}</div>${order.map(i=>{const it=s.items[i],v=r.sorted[i];return `<div class="sortitem"><span>${it[0]}</span><div class="bk">${s.baskets.map((b,bi)=>`<button data-it="${i}" data-b="${bi}" class="${v!==undefined?(bi===it[1]?(v===bi||r.done?'ok':''):(v===bi?'no':'')):''}" ${v!==undefined&&v===it[1]?'disabled':''}>${b}</button>`).join('')}</div></div>`}).join('')}${r.done?whyBox(s,r):''}`}
 if(s.type==='flip')return `<div class="q">הפכו את הקלפים</div><div class="flips">${(s.cards||[]).map((c,i)=>r.open[i]?`<button class="card open" data-f="${i}"><small>${c[1]}</small><strong>${c[2]}</strong><small>${c[3]}</small></button>`:`<button class="card" data-f="${i}"><big>${c[0]}</big><small>${c[1]}</small></button>`).join('')}</div>`;
 if(s.type==='open')return `<div class="q">${s.q}</div><div class="lbl">חשבו לבד, ואחר כך פתחו תשובה לדוגמה</div>${r.done?`<div class="open-a">${s.ans}</div>`:`<button class="ghost" id="reveal">הצג תשובה לדוגמה</button>`}`;
 if(s.type==='summary'){const sc=screens().filter(x=>SCORED.includes(x.type)&&st(x).done);const good=sc.filter(x=>st(x).ok===true).length;
  return `<div class="score"><h2>כל הכבוד!</h2>${sc.length?`<p>ענית נכון בפעם הראשונה על ${good} מתוך ${sc.length} שאלות</p>`:'<p>סיימת לעבור על השיעור</p>'}</div>
  ${s.table?`<div class="tbl"><table><tr>${s.table.cols.map(c=>`<th>${c}</th>`).join('')}</tr>${s.table.rows.map(rw=>`<tr>${rw.map((c,i)=>`<td>${i?c:'<b>'+c+'</b>'}</td>`).join('')}</tr>`).join('')}</table></div>`:''}
  <div class="links">${LESSON.prev?`<a href="${LESSON.prev}">לשיעור הקודם</a>`:''}${LESSON.next?`<a href="${LESSON.next}">לשיעור הבא</a>`:''}</div>`}
}
function isDone(s){const r=st(s);return s.type==='read'||s.type==='intro'||s.type==='summary'||r.done}
function wire(s){const r=st(s),q=sel=>view.querySelectorAll(sel);
 const answer=v=>{if(r.done)return;r.pick=v;r.ok=(v===s.a);r.done=true;draw()};
 q('[data-a]').forEach(b=>b.onclick=()=>{const v=b.dataset.a;answer(s.type==='tf'?v==='true':+v)});
 q('[data-add]').forEach(b=>b.onclick=()=>{r.seq.push(+b.dataset.add);const pool=s.type==='build'?s.tiles:s.items;
  if(r.seq.length===pool.length){const got=r.seq.map(i=>pool[i]).join(' ');r.ok=s.type==='build'?got===s.ans:r.seq.every((v,i)=>v===i);r.done=true}draw()});
 q('[data-rm]').forEach(b=>b.onclick=()=>{r.seq.splice(+b.dataset.rm,1);draw()});
 q('[data-l]').forEach(b=>b.onclick=()=>{r.sel=+b.dataset.l;r.flash=null;draw()});
 q('[data-r]').forEach(b=>b.onclick=()=>{if(r.sel===null)return;const i=+b.dataset.r;if(i===r.sel){r.matched[i]=1;r.sel=null;r.flash=null}else{r.miss++;r.flash=i}
  if(Object.keys(r.matched).length===s.pairs.length){r.done=true;r.ok=r.miss===0}draw()});
 q('[data-it]').forEach(b=>b.onclick=()=>{const i=+b.dataset.it,bi=+b.dataset.b;if(r.sorted[i]===s.items[i][1])return;r.sorted[i]=bi;if(bi!==s.items[i][1])r.miss++;
  if(s.items.every((it,j)=>r.sorted[j]===it[1])){r.done=true;r.ok=r.miss===0}draw()});
 q('[data-f]').forEach(b=>b.onclick=()=>{const i=+b.dataset.f;r.open[i]=!r.open[i];if(s.cards.every((_,j)=>r.open[j]))r.done=true;draw()});
 const rv=document.getElementById('reveal');if(rv)rv.onclick=()=>{r.done=true;draw()};
}
const ICONS={
 book:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M27 15c-5-4-13-4-19-2v28c6-2 14-2 19 2 5-4 13-4 19-2V13c-6-2-14-2-19 2z"/><path d="M27 15v28"/></svg>`,
 branch:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="27" cy="11" r="6"/><path d="M27 17v9M27 26l-13 9M27 26l13 9M27 26v9"/><circle cx="13" cy="41" r="5"/><circle cx="27" cy="41" r="5"/><circle cx="41" cy="41" r="5"/></svg>`,
 scroll:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 10h22a6 6 0 0 1 6 6v28H20a6 6 0 0 1-6-6V14"/><path d="M10 14a4 4 0 0 1 8 0v24"/><path d="M25 20h12M25 27h12M25 34h8"/></svg>`,
 spark:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="27" cy="27" r="8"/><path d="M27 6v7M27 41v7M6 27h7M41 27h7M12 12l5 5M37 37l5 5M42 12l-5 5M17 37l-5 5"/></svg>`,
 tooth:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 13c4-4 10-3 14 0 4-3 10-4 14 0 5 5 2 14-1 20-2 5-2 12-6 12-3 0-3-10-7-10s-4 10-7 10c-4 0-4-7-6-12-3-6-6-15-1-20z"/></svg>`,
 horn:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 46C12 28 24 12 44 8C34 18 28 30 26 46Z"/><path d="M15 38h12M19 28h11M25 19h10"/></svg>`,
 run:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M30 18c4-7 12-9 16-6-5 0-8 3-9 7"/><path d="M14 30c0-7 6-12 14-12h6l6 6-3 6h-6l-4 10H17l-3-10z"/><path d="M4 22h7M2 30h8M4 38h7"/></svg>`,
 push:c=>`<svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="30" y="14" width="16" height="26" rx="3"/><path d="M6 27h18M18 20l7 7-7 7"/></svg>`};
function introScreen(s){
 return `<div class="screen intro">
 <div class="iband"><div class="iline"><div>${s.daf}</div><div>${s.series}</div></div><div class="ititle">${LESSON.title}</div><div class="iq">${s.question}</div></div>
 <div class="ibody">
  <div class="icards">${s.cards.map(c=>`<div class="icard" style="border-color:${c.c}">${(ICONS[c.icon]||ICONS.book)(c.c)}<div class="it" style="color:${c.c}">${c.t}</div><div class="is">${c.s}</div><div class="iw" style="background:${c.c}">${c.w}</div></div>`).join('')}</div>
  <button class="go" id="go">יוצאים לדרך</button>
 </div></div>`}
function drawPlay(){const list=screens();if(cur>=list.length)cur=list.length-1;const s=list[cur];
 if(s.type==='intro'){view.innerHTML=introScreen(s);document.getElementById('go').onclick=()=>{cur++;draw();window.scrollTo(0,0)};return}
 const tabs=LESSON.stations.map((n,i)=>`<b class="${i===s.st&&s.type!=='summary'?'c':(s.type==='summary'||i<s.st?'d':'')}" title="${n}">${i+1}</b>`).join('');
 const label=(s.type==='summary'||s.type==='intro'||s.type==='gate')?'':s.type==='read'?'':`<div class="chiprow"><span class="chip">${s.final?'סיכום':LESSON.stations[s.st]}</span><span class="kind">${KIND[s.type]}</span></div>`+(grp(s)?`<div class="qcount">שאלה ${grp(s).i+1} מתוך ${grp(s).n}</div>`:'');
 const isQ=!NONQ.includes(s.type);
 const segs=list.map((x,i)=>['intro','read','summary'].includes(x.type)?`<button class="seg ${i<=cur?'f':''}" data-goto="${i}" ${i<=cur?'':'disabled'} aria-label="${x.type==='intro'?'פתיחה':x.type==='summary'?'סיכום':LESSON.stations[x.st]}"><i></i></button>`:'').join('');
 view.innerHTML=`<div class="screen"><div class="top"><div class="prog">${segs}</div></div>
 ${isQ?`<div class="qhead">${GATE_TITLE}</div>`:''}${label}<div class="body">${body(s)}${(()=>{const g=grp(s);return g&&g.i===g.n-1&&isDone(s)?'<div class="gdone">כל הכבוד!</div>':''})()}</div>
 <div class="foot ${isQ?'two':''}">${isQ?`<button class="skip" id="skipq">דלג על התרגול</button>`:''}<button class="go" id="go">${s.type==='summary'?'מתחילים מחדש':s.type==='intro'?'יוצאים לדרך':'המשך'}</button></div></div>`;
 view.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>{cur=+b.dataset.goto;draw();window.scrollTo(0,0)});
 const sk=document.getElementById('skipq');if(sk)sk.onclick=()=>{let i=cur+1;while(i<list.length&&!NONQ.includes(list[i].type))i++;cur=Math.min(i,list.length-1);draw();window.scrollTo(0,0)};
 document.getElementById('go').onclick=()=>{if(s.type==='summary'){cur=0;R={}}else cur++;draw();window.scrollTo(0,0)};
 wire(s)}
function drawList(){let h='',last=-1,n=0;
 LESSON.screens.forEach(s=>{if(s.type==='read'||s.type==='summary')return;n++;
  if(s.st!==last&&!s.final){h+=`<h3>${s.st+1}. ${LESSON.stations[s.st]}</h3>`;last=s.st}
  if(s.final)h+=`<h3>סיכום</h3>`;
  let q='',c='';
  if(s.type==='mc'||s.type==='fill'||s.type==='judge'){q=s.type==='fill'?`${s.before}___${s.after}`:s.type==='judge'?s.sides.map(x=>x[0]+': '+x[1]).join(' / '):s.q;c=s.o.map((o,i)=>i===s.a?`<span class="c">${AB[i]}. ${o} ✓</span>`:`${AB[i]}. ${o}`).join(' · ')}
  else if(s.type==='tf'){q=s.s;c=`<span class="c">${s.a?'נכון':'לא נכון'}</span>`}
  else if(s.type==='marker'){q=s.q+': '+s.words.join(' ');c=`<span class="c">${s.words[s.a]}</span>`}
  else if(s.type==='build'){q=s.q;c=`<span class="c">${s.ans}</span>`}
  else if(s.type==='order'){q=s.q;c=`<span class="c">${s.items.join(' ← ')}</span>`}
  else if(s.type==='match'){q=s.q;c=s.pairs.map(p=>`<span class="c">${p[0]} = ${p[1]}</span>`).join(' · ')}
  else if(s.type==='sort'){q=s.q;c=s.baskets.map((b,bi)=>`<b>${b}:</b> <span class="c">${s.items.filter(it=>it[1]===bi).map(it=>it[0]).join(', ')}</span>`).join(' · ')}
  else if(s.type==='flip'){q='קלפים';c=s.cards.map(x=>`${x[1]} <span class="c">${x[2]}</span>`).join(' · ')}
  else if(s.type==='open'){q=s.q;c=`<span class="c">${s.ans}</span>`}
  h+=`<div class="li"><div class="h">${n}. <span>${KIND[s.type]}</span></div><div>${q}</div><div>${c}</div>${s.why||s.din?`<div class="w">${s.why||s.din}</div>`:''}</div>`});
 view.innerHTML=`<div class="list">${h}</div>`}
// Tell the page (student.js) about each question answered correctly and about reaching the end.
const SENT={};let FIN=false;
function report(){Object.keys(R).forEach(k=>{const r=R[k],s=LESSON.screens[k];if(r.done&&r.ok===true&&SCORED.includes(s.type)&&!SENT[k]){SENT[k]=1;dispatchEvent(new CustomEvent('pshita:correct',{detail:{q:+k}}))}});
 const list=screens();if(!FIN&&list[cur]&&list[cur].type==='summary'){FIN=true;dispatchEvent(new CustomEvent('pshita:finished'))}}
function draw(){drawPlay();report()}
draw();
}
})();
