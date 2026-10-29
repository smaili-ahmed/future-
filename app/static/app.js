const titles={
  overview:['Vue générale','Les 45 établissements suivis, vérifiés sur les deux catalogues'],
  trackedDetail:['Vue générale · Détails','Vérification de présence sur les deux catalogues'],
  restaurantCompare:['Comparaison des restaurants','Établissements présents sur Glovo et Mooup'],
  restaurantDetail:['Comparaison détaillée','Menus, produits et prix côte à côte'],
  history:['Historique','Analyses, imports et prix enregistrés']
};
const TRACKED_STATUS={
  glovo_only:'Absent de Mooup (vérifié)',
  to_verify:'À vérifier',
  both:'Présent sur les deux plateformes',
  insufficient:'Données insuffisantes',
  mooup_only:'Présent uniquement sur Mooup'
};
const PLATFORM_STATUS={found:'Trouvé',uncertain:'Incertain',not_found:'Non retrouvé',inaccessible:'Non vérifié'};
const NAV_PARENT={trackedDetail:'overview',restaurantDetail:'restaurantCompare'};
let data={},view='overview',pollTimer,selectedTracked=null,selectedCommon=null;
const $=s=>document.querySelector(s),fmtDate=s=>s?new Date(s).toLocaleString('fr-FR'):'Non disponible';
const money=(n,c='MAD')=>n===null||n===undefined?'Non disponible':`${Number(n).toFixed(2)} ${c||'Devise inconnue'}`;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=s=>`<span class="badge ${esc(s)}">${esc(TRACKED_STATUS[s]||s||'Non disponible')}</span>`;
const sourceLink=(url,label='Voir la fiche ↗')=>url?`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`:'<span class="muted">Non disponible</span>';
const openLabel=v=>v===true?'Ouvert':v===false?'Fermé':'Non disponible';
const fact=(label,value)=>`<div class="fact"><dt>${esc(label)}</dt><dd>${value||'<span class="muted">Non disponible</span>'}</dd></div>`;
function coverageLine(){
  const q=data.quality||{},meta=(data.restaurants||{})._meta||{},g=meta.glovo||{};
  const parts=[`Glovo ${q.restaurants_glovo||0}/${q.glovo_export_reported??'—'} fiches`];
  parts.push(g.scraped_at?`export du ${fmtDate(g.scraped_at)}`:'export local non daté');
  parts.push(data.mooup_catalog_available?`Mooup ${q.restaurants_mooup||0} restaurants · catalogue du ${fmtDate(data.mooup_last_sync)}`:'catalogue Mooup non chargé');
  return parts.join(' · ');
}
async function load(){try{const r=await fetch('/api/report');data=await r.json()}catch(e){toast('API indisponible. Vérifiez le serveur local.')}render()}
function render(){
  const t=titles[view]||titles.overview;
  $('#page-title').textContent=t[0];
  $('#page-sub').textContent=t[1];
  $('#page-date').textContent=`Dernière analyse : ${fmtDate(data.run?.finished_at)} · ${coverageLine()}`;
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('active',(NAV_PARENT[view]||view)===a.dataset.view));
  if(view==='overview')renderOverview();
  else if(view==='trackedDetail')renderTrackedDetail();
  else if(view==='restaurantCompare')renderComparison();
  else if(view==='restaurantDetail')renderComparisonDetail();
  else renderHistory();
}

/* ---------- Vue générale : les 45 établissements suivis ---------- */
function renderOverview(){
  const rows=data.tracked_restaurants||[];
  const statuses=[...new Set(rows.map(r=>r.status))];
  const categories=[...new Set(rows.map(r=>r.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));
  const manualCount=rows.filter(r=>r.manual).length;
  $('#content').innerHTML=`
  <section class="panel">
    <div class="panel-head"><div>
      <h2>Établissements suivis</h2>
      <p class="hint">${rows.length} établissements suivis dont ${manualCount} signalés manuellement. Chaque statut est vérifié sur les catalogues réellement collectés ; les doublons de la liste sont conservés comme lignes séparées.</p>
    </div></div>
    <div class="toolbar">
      <input id="trSearch" type="search" placeholder="Rechercher un restaurant…">
      <select id="trStatus"><option value="">Tous les statuts</option>${statuses.map(s=>`<option value="${esc(s)}">${esc(TRACKED_STATUS[s])}</option>`).join('')}</select>
      <select id="trCategory"><option value="">Toutes les catégories</option>${categories.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
      <select id="trSort"><option value="position">Ordre de la liste</option><option value="name">Nom (A → Z)</option><option value="products">Produits Glovo (décroissant)</option><option value="status">Statut</option></select>
      <button id="trCsv" class="btn">Exporter CSV</button>
    </div>
    <div class="tablewrap"><table class="table">
      <thead><tr><th>Restaurant</th><th>Catégorie</th><th class="num">Produits Glovo</th><th>Statut</th><th>Dernière vérification</th><th>Action</th></tr></thead>
      <tbody id="trBody"></tbody>
    </table></div>
    <div id="trEmpty" class="empty" hidden>Aucun restaurant ne correspond à ces filtres.</div>
  </section>
  <section class="panel">
    <div class="panel-head"><div><h2>Sources, dates de collecte et limites</h2>
      <p class="hint">Une donnée non collectée n’est jamais présentée comme une preuve d’absence.</p></div></div>
    <div class="grid-2">
      <dl class="facts">
        <div><dt>Analyse</dt><dd>${esc(data.run?.status||'aucune analyse')} · ${fmtDate(data.run?.finished_at)}${data.errors?.length?` · ${data.errors.length} limitation(s)`:' · aucune erreur de collecte'}</dd></div>
        <div><dt>Glovo</dt><dd>${data.quality?.restaurants_glovo||0} restaurants · ${data.quality?.products_glovo||0} produits · export local (${data.quality?.glovo_export_reported??'—'} fiches annoncées)</dd></div>
        <div><dt>Mooup</dt><dd>${data.mooup_catalog_available?`${data.quality?.restaurants_mooup||0} restaurants · ${data.quality?.products_mooup||0} produits · synchronisé le ${fmtDate(data.mooup_last_sync)} · source : ${esc(data.mooup_source||'inconnue')}`:'Catalogue non chargé : aucune absence sur Mooup n’est vérifiable.'}</dd></div>
        <div><dt>Couverture</dt><dd>${esc(data.quality?.coverage_note||'Non calculable.')}</dd></div>
      </dl>
      <div class="importbox">
        <h3>Accès au catalogue Mooup</h3>
        <p class="hint">${data.mooup_catalog_available?'Le catalogue est chargé. Une nouvelle synchronisation ou un import remplace le catalogue utilisé pour les statuts.':'Aucun catalogue Mooup en base : importe un export CSV/JSON ou configure MOOUP_CATALOG_API_KEY (.env) puis synchronise.'}</p>
        <div class="toolbar">
          <input id="mooupFile" type="file" accept=".csv,.json,application/json,text/csv">
          <button id="importMooup" class="btn">Importer CSV / JSON</button>
          ${data.mooup_api_configured?'<button id="syncMooup" class="primary">Synchroniser l’API</button>':'<span class="hint">MOOUP_CATALOG_API_KEY non configurée.</span>'}
          <span id="importState" class="hint">${data.mooup_catalog_available?`Catalogue du ${fmtDate(data.mooup_last_sync)}`:'Mooup non synchronisé'}</span>
        </div>
        <details><summary>Structure d’import CSV</summary><p class="hint">restaurant, restaurant_url, restaurant_image, restaurant_category, address, phone, delivery_zone, product, price, regular_price, currency, category, description, size, image, available, options, product_url</p></details>
      </div>
    </div>
  </section>`;
  let shown=[];
  const draw=()=>{
    const q=$('#trSearch').value.trim().toLowerCase(),st=$('#trStatus').value,cat=$('#trCategory').value,sort=$('#trSort').value;
    shown=rows.filter(r=>(!q||r.name.toLowerCase().includes(q))&&(!st||r.status===st)&&(!cat||r.category===cat));
    const order={glovo_only:0,both:1,to_verify:2,mooup_only:3,insufficient:4};
    if(sort==='name')shown.sort((a,b)=>a.name.localeCompare(b.name,'fr'));
    else if(sort==='products')shown.sort((a,b)=>(b.products_count??-1)-(a.products_count??-1));
    else if(sort==='status')shown.sort((a,b)=>(order[a.status]??9)-(order[b.status]??9)||a.position-b.position);
    else shown.sort((a,b)=>a.position-b.position);
    $('#trBody').innerHTML=shown.map(r=>{
      const img=r.image?`<img class="avatar" src="${esc(r.image)}" alt="" loading="lazy">`:'';
      const tags=`${r.manual?'<span class="tag">Signalé manuellement</span>':''}${r.duplicate_warning?`<span class="tag ghost">Doublon conservé (${r.duplicate_count})</span>`:''}`;
      return `<tr><td class="cell-name">${img}<div><b>${esc(r.name)}</b>${tags}</div></td>
        <td>${esc(r.category||'Non disponible')}</td>
        <td class="num">${r.products_count??'<span class="muted">Non collecté</span>'}</td>
        <td class="cell-status">${badge(r.status)}${r.reason?`<div class="hint reason" title="${esc(r.reason)}">${esc(r.reason)}</div>`:''}</td>
        <td>${fmtDate(r.last_verified_at)}</td>
        <td class="cell-actions">${sourceLink(r.glovo_url)}<button class="btn small" data-tracked="${r.position}">Voir les détails</button></td></tr>`;
    }).join('')||'<tr><td colspan="6">Aucun restaurant ne correspond à ces filtres.</td></tr>';
    $('#trEmpty').hidden=!!shown.length;
  };
  ['trSearch','trStatus','trCategory','trSort'].forEach(id=>$('#'+id).addEventListener('input',draw));
  $('#trCsv').onclick=()=>downloadCsv(shown.map(r=>({restaurant:r.name,categorie:r.category||'Non disponible',produits_glovo:r.products_count??'',statut:TRACKED_STATUS[r.status],motif:r.reason,derniere_verification:r.last_verified_at||'',signale_manuellement:r.manual?'oui':'non',source_glovo:r.glovo_url||''})),'restaurants-suivis-mooup.csv');
  $('#content').onclick=async event=>{
    const detail=event.target.closest('[data-tracked]');
    if(detail){selectedTracked=Number(detail.dataset.tracked);view='trackedDetail';render();return}
    if(event.target.id==='importMooup')await importMooup();
    if(event.target.id==='syncMooup')await syncMooup();
  };
  draw();
}
/* ---------- Détail d'un établissement suivi ---------- */
function renderTrackedDetail(){
  const row=(data.tracked_restaurants||[]).find(r=>r.position===selectedTracked);
  if(!row){view='overview';render();return}
  const info=row.glovo_info||{},products=row.glovo?.products||[];
  const history=(data.manual_missing_history||[]).filter(h=>h.restaurant_name===row.name);
  const mooupProducts=row.mooup?.products?.length??0;
  $('#content').innerHTML=`<section class="panel detail">
    <div class="detail-head">
      <div><div class="eyebrow">ÉTABLISSEMENT SUIVI</div><h2>${esc(row.name)}</h2></div>
      <div class="detail-actions">${badge(row.status)}${row.manual?'<span class="tag">Signalé manuellement</span>':''}<button id="backOverview" class="btn">← Retour à la liste</button></div>
    </div>
    <p class="hint">${esc(row.reason)}${row.duplicate_warning?` · Doublon possible dans la liste (${row.duplicate_count}) : conservé séparément, non fusionné.`:''}</p>
    <div class="grid-2">
      <div><h3>Vérification des présences</h3><dl class="facts">
        ${fact('Présence sur Glovo',`${PLATFORM_STATUS[row.glovo_status]} · score ${Math.round(row.glovo_confidence*100)} %${row.glovo_ambiguous?' · candidats multiples':''}`)}
        ${fact('Meilleur candidat Glovo',row.glovo_candidate?`${esc(row.glovo_candidate)} (${Math.round(row.glovo_candidate_score*100)} %)`:'Aucun')}
        ${fact('Présence sur Mooup',data.mooup_catalog_available?`${PLATFORM_STATUS[row.mooup_status]} · score ${Math.round(row.mooup_confidence*100)} %${row.mooup_ambiguous?' · candidats multiples':''}`:'Catalogue Mooup non chargé')}
        ${fact('Meilleur candidat Mooup',row.mooup_candidate?`${esc(row.mooup_candidate)} (${Math.round(row.mooup_candidate_score*100)} %)${row.mooup?' — fiche trouvée, identité non confirmée':' — sous le seuil de reconnaissance'}`:'Aucun candidat')}
        ${fact('Catalogue Mooup',data.mooup_catalog_available?`${data.quality?.restaurants_mooup||0} restaurants · ${esc(data.mooup_source||'')} · ${fmtDate(data.mooup_last_sync)}`:'Indisponible')}
        ${fact('Dernière vérification',fmtDate(row.last_verified_at))}
        ${row.manual&&row.manual_status?fact('Statut enregistré (manuel)',esc(row.manual_status)):''}
      </dl></div>
      <div><h3>Fiche Glovo</h3><dl class="facts">
        ${fact('Catégorie',esc(info.category))}
        ${fact('Note / avis',info.rating?`${esc(info.rating)} · ${esc(info.reviews||'')} avis`:'Non disponible')}
        ${fact('Adresse',esc(info.address))}
        ${fact('État',openLabel(info.open))}
        ${fact('Produits collectés',products.length?`${products.length} produits`:'Non collecté')}
        ${fact('Collecté le',fmtDate(info.collected_at))}
        ${fact('Source',sourceLink(row.glovo_url,'Ouvrir la fiche Glovo ↗'))}
      </dl></div>
    </div>
    ${row.status==='both'?`<div class="notice"><b>Présent sur les deux plateformes</b><span>Ce restaurant figure aussi dans « Comparaison des restaurants ». <button class="linkish" data-goto-compare="${esc(row.name)}">Ouvrir la comparaison →</button></span></div>`:''}
    ${row.mooup?`<div class="notice"><b>Candidat Mooup non confirmé</b><span>${esc(row.mooup.name)} · ${mooupProducts} produits · score ${Math.round(row.mooup_confidence*100)} %. L’identité n’est pas confirmée : ce restaurant n’est donc pas placé en comparaison.</span></div>`:''}
    ${!data.mooup_catalog_available?`<div class="notice"><b>Limite de collecte</b><span>Catalogue Mooup absent : ni écart de prix ni absence ne peuvent être conclus pour cet établissement. Importe un export CSV/JSON depuis la Vue générale.</span></div>`:''}
    ${row.manual&&history.length?`<h3>Historique des validations manuelles</h3><div class="runlist">${history.map(h=>`<div class="runitem"><span>${esc(h.status)}</span><span>${fmtDate(h.checked_at)}</span></div>`).join('')}</div>`:''}
    <h3>Produits collectés sur Glovo${products.length?` (${products.length})`:''}</h3>
    ${products.length?`<div class="tablewrap"><table class="table"><thead><tr><th>Produit</th><th>Catégorie</th><th class="num">Prix</th><th>Disponibilité</th></tr></thead><tbody>${products.map(p=>`<tr><td class="cell-name">${p.image?`<img class="avatar sm" src="${esc(p.image)}" alt="" loading="lazy">`:''}<div><b>${esc(p.name)}</b>${p.description?`<div class="hint reason">${esc(p.description)}</div>`:''}</div></td><td>${esc(p.category||'Non disponible')}</td><td class="num">${money(p.price,p.currency)}${p.regular_price&&p.regular_price!==p.price?`<div class="hint">Prix régulier ${money(p.regular_price,p.currency)}</div>`:''}</td><td>${p.available===true?'Disponible':p.available===false?'Indisponible':'Non disponible'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Aucun produit collecté pour cette fiche.</div>'}
  </section>`;
  $('#backOverview').onclick=()=>{view='overview';selectedTracked=null;render()};
  $('#content').onclick=event=>{
    const go=event.target.closest('[data-goto-compare]');
    if(go){selectedCommon=go.dataset.gotoCompare;view='restaurantDetail';render()}
  };
}
/* ---------- Comparaison : établissements présents sur les deux plateformes ---------- */
function renderComparison(){
  const rows=data.common_restaurants||[],excluded=data.common_restaurants_excluded||0;
  const categories=[...new Set(rows.map(r=>r.category).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));
  $('#content').innerHTML=`<section class="panel">
    <div class="panel-head"><div>
      <h2>Comparaison des restaurants (${rows.length})</h2>
      <p class="hint">Uniquement les établissements identifiés sur Glovo et sur Mooup avec une correspondance suffisamment fiable. ${excluded?`${excluded} correspondance(s) incertaine(s) exclues de cette liste (score trop faible) : elles restent à valider depuis la fiche détaillée.`:'Aucune correspondance exclue.'}</p>
    </div></div>
    <div class="toolbar">
      <input id="cmSearch" type="search" placeholder="Rechercher un restaurant…">
      <select id="cmCategory"><option value="">Toutes les catégories</option>${categories.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
      <select id="cmSort"><option value="gaps">Écarts de prix (décroissant)</option><option value="products">Produits (décroissant)</option><option value="name">Nom (A → Z)</option></select>
      <button id="cmCsv" class="btn">Exporter CSV</button>
    </div>
    <div class="tablewrap"><table class="table">
      <thead><tr><th>Restaurant</th><th>Catégorie</th><th class="num">Produits Mooup</th><th class="num">Produits Glovo</th><th class="num">Produits comparables</th><th class="num">Écarts de prix</th><th>Action</th></tr></thead>
      <tbody id="cmBody"></tbody>
    </table></div>
    <div id="cmEmpty" class="empty" hidden>Aucun restaurant ne correspond à ces filtres.</div>
  </section>`;
  let shown=[];
  const draw=()=>{
    const q=$('#cmSearch').value.trim().toLowerCase(),cat=$('#cmCategory').value,sort=$('#cmSort').value;
    shown=rows.filter(r=>(!q||`${r.name} ${r.mooup_name}`.toLowerCase().includes(q))&&(!cat||r.category===cat));
    if(sort==='name')shown.sort((a,b)=>a.name.localeCompare(b.name,'fr'));
    else if(sort==='products')shown.sort((a,b)=>(b.glovo_products+b.mooup_products)-(a.glovo_products+a.mooup_products));
    else shown.sort((a,b)=>b.price_gaps-a.price_gaps||b.comparable_products-a.comparable_products);
    $('#cmBody').innerHTML=shown.map(r=>{
      const img=r.image?`<img class="avatar" src="${esc(r.image)}" alt="" loading="lazy">`:'';
      const confirmed=r.match_status==='confirmed';
      return `<tr><td class="cell-name">${img}<div><b>${esc(r.name)}</b><div class="hint reason">↔ ${esc(r.mooup_name)} · confiance ${Math.round((r.confidence||0)*100)} %</div><span class="tag${confirmed?'':' ghost'}">${confirmed?'Correspondance confirmée':'Correspondance à vérifier'}</span></div></td>
      <td>${esc(r.category||'Non disponible')}</td>
      <td class="num">${r.mooup_products}</td>
      <td class="num">${r.glovo_products}</td>
      <td class="num">${r.comparable_products}</td>
      <td class="num">${r.price_gaps}${r.price_anomalies?`<div class="hint">${r.price_anomalies} prix atypique(s) exclus</div>`:''}</td>
      <td class="cell-actions"><button class="btn small" data-common="${esc(r.name)}">Voir le contenu →</button></td></tr>`;
    }).join('')||'<tr><td colspan="7">Aucun restaurant ne correspond à ces filtres.</td></tr>';
    $('#cmEmpty').hidden=!!shown.length;
  };
  ['cmSearch','cmCategory','cmSort'].forEach(id=>$('#'+id).addEventListener('input',draw));
  $('#cmCsv').onclick=()=>downloadCsv(shown.map(r=>({restaurant:r.name,restaurant_mooup:r.mooup_name,categorie:r.category||'',produits_mooup:r.mooup_products,produits_glovo:r.glovo_products,produits_comparables:r.comparable_products,ecarts_prix:r.price_gaps,confiance:r.confidence})),'restaurants-communs.csv');
  $('#content').onclick=event=>{
    const target=event.target.closest('[data-common]');
    if(target){selectedCommon=target.dataset.common;view='restaurantDetail';render()}
  };
  draw();
}
/* ---------- Colonnes côte à côte : catalogue Glovo | catalogue Mooup ---------- */
function normalizeBrowser(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()}
function catKey(v){return normalizeBrowser(v)||'non classe'}
function variantEntries(p){
  if(!p)return[];
  const list=Array.isArray(p.variants)&&p.variants.length?p.variants
    :(Array.isArray(p.options)&&p.options.length?p.options:[]);
  return list.filter(v=>v&&typeof v==='object')
    .map((v,i)=>({label:String(v.sku||v.name||'').trim()||`Variante ${i+1}`,price:v.price,available:v.available,quantity:v.quantity,options:v.options&&typeof v.options==='object'?v.options:null}))
    .filter(v=>v.price!==undefined||v.available!==undefined||v.options&&Object.keys(v.options).length);
}
function optionEntries(p){
  if(!p||!p.options||Array.isArray(p.options))return[];
  return Object.entries(p.options).map(([label,value])=>({label,value}));
}
function renderEntries(title,items,fmt){
  if(!items.length)return'';
  return `<details><summary>${esc(title)} (${items.length})</summary><pre>${esc(items.map(fmt).join('\n'))}</pre></details>`;
}
function availabilityLabel(p){
  if(!p)return'Non disponible';
  if(p.availability_status==='in_stock')return'Disponible';
  if(p.availability_status==='out_of_stock')return'Indisponible';
  if(p.available===true)return'Disponible';
  if(p.available===false)return'Indisponible';
  return'Non disponible';
}
function promoInfo(p){
  if(!p||p.price==null||p.price===undefined)return{pct:0,strike:null};
  let pct=Number(p.promotion_percent)||0,strike=null;
  if(p.regular_price!=null&&Number(p.regular_price)>Number(p.price)){
    strike=Number(p.regular_price);
    if(!pct)pct=Math.round((1-Number(p.price)/strike)*100);
  }
  return{pct,strike};
}
function productCard(p){
  const media=p.image?`<img class="pcard-img" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">`:'<div class="pcard-noimg">Image indisponible</div>';
  const promo=promoInfo(p);
  const price=p.price!=null&&p.price!==undefined?money(p.price,p.currency):'<span class="muted">Non disponible</span>';
  const old=promo.strike!=null&&promo.strike!==Number(p.price)?`<s>${money(promo.strike,p.currency)}</s>`:'';
  const meta=[p.category||'Non classé',p.size?`Format ${esc(p.size)}`:null].filter(Boolean).map(esc).join(' · ');
  const desc=String(p.description||'').trim();
  const variants=variantEntries(p),dictOpts=optionEntries(p);
  const varOpts=variants.flatMap(v=>Object.entries(v.options||{}).map(([k,val])=>({label:`${v.label} — ${k}`,value:val})));
  const opts=dictOpts.length?dictOpts:varOpts;
  const extras=[
    variants.length?renderEntries('Variantes',variants,v=>`${v.label} : ${v.price!==undefined&&v.price!==null?money(v.price,p.currency):'prix non collecté'}${v.available===false?' — indisponible':''}${v.quantity!==undefined&&v.quantity!==null&&v.quantity<10?` — stock ${v.quantity}`:''}`):'',
    opts.length?renderEntries('Options et suppléments',opts,o=>`${o.label}${o.value!==undefined&&o.value!==null&&o.value!==''?` : ${o.value}`:''}`):''
  ].join('');
  return `<article class="pcard">
    <div class="pcard-media">${media}</div>
    <div class="pcard-body">
      <div class="pcard-name">${esc(p.name)}</div>
      <div class="pcard-price">${old}${price}${promo.pct?`<span class="pcard-promo">−${promo.pct} %</span>`:''}</div>
      <div class="hint">${meta}</div>
      <p class="pcard-desc">${desc?esc(desc):'<span class="muted">Description non disponible</span>'}</p>
      <div class="hint">Disponibilité : ${availabilityLabel(p)}</div>
      ${extras||'<div class="hint">Variantes et options : Non disponible</div>'}
      <div class="pcard-link">${sourceLink(p.url,'Voir la fiche ↗')}</div>
    </div>
  </article>`;
}
function emptyCell(row,side,meta){
  const unavailable=side==='m'?!meta.mooup_catalog_available:!meta.glovo_available;
  const label=side==='m'?'Aucun produit correspondant sur Mooup':'Aucun produit correspondant sur Glovo';
  const text=unavailable?(side==='m'?'Catalogue Mooup non collecté : absence non vérifiable.':'Catalogue Glovo non collecté : comparaison impossible.'):label;
  const note=(row.reasons||[])[0];
  return `<div class="pcard-empty"><span>${esc(text)}</span>${note&&!unavailable?`<span class="hint">${esc(note)}</span>`:''}<span class="hint">Côté ${side==='m'?'Mooup':'Glovo'} : Non disponible</span></div>`;
}
function pairFlags(row){
  const out=[];
  if(!row.glovo_product||!row.mooup_product){
    out.push({tone:'missing',text:row.glovo_product?'Absent de Mooup':'Absent de Glovo'});
    return out;
  }
  if(row.price_anomaly)out.push({tone:'warn',text:'Prix source atypique — écart non comparable'});
  else if(row.delta===null||row.delta===undefined)out.push({tone:'na',text:'Écart non calculable'});
  else if(row.delta===0)out.push({tone:'flat',text:'Prix identiques'});
  else if(row.delta>0)out.push({tone:'up',text:`Glovo plus cher de ${Number(row.delta).toFixed(2)} MAD (${row.percent===null||row.percent===undefined?'% non calculable':`+${Number(row.percent).toFixed(2)} %`})`});
  else out.push({tone:'down',text:`Mooup plus cher de ${Math.abs(Number(row.delta)).toFixed(2)} MAD (${row.percent===null||row.percent===undefined?'% non calculable':`${Number(row.percent).toFixed(2)} %`})`});
  if(row.size_mismatch)out.push({tone:'warn',text:'Tailles différentes — non comparées'});
  if(row.content_different)out.push({tone:'warn',text:'Composition différente'});
  if(row.uncertain)out.push({tone:'review',text:`Correspondance à vérifier · confiance ${Math.round((row.confidence||0)*100)} %`});
  return out;
}
const flagHtml=f=>`<span class="flag ${esc(f.tone)}">${esc(f.text)}</span>`;
function catalogHeader(info,side,counts){
  const label=side==='g'?'GLOVO':'MOOUP';
  if(!info)return `<div class="cmp-catalog side-${side}"><div class="cmp-catalog-head"><div class="cmp-logo noimg">Image indisponible</div><div><div class="eyebrow">CATALOGUE ${label}</div><b class="cmp-catalog-name">Non disponible</b></div></div><div class="empty">Catalogue ${label} non collecté : aucune donnée à afficher.</div></div>`;
  const logo=info.image?`<img class="cmp-logo" src="${esc(info.image)}" alt="">`:'<div class="cmp-logo noimg">Image indisponible</div>';
  const rows=side==='g'
    ? [fact('Catégorie',esc(info.category)),fact('Adresse',esc(info.address)),
       fact('Note / avis',info.rating?`${esc(info.rating)}${info.reviews?` · ${esc(info.reviews)} avis`:''}`:null),
       fact('État',info.open===null||info.open===undefined?null:openLabel(info.open)),
       fact('Description',info.description?esc(info.description):null)]
    : [fact('Catégorie',esc(info.category)),fact('Adresse',esc(info.address)),
       fact('Horaires',info.hours?esc(info.hours):null),
       fact('État',info.open===null||info.open===undefined?null:openLabel(info.open)),
       fact('Description',info.description?esc(info.description):null)];
  return `<div class="cmp-catalog side-${side}">
    <div class="cmp-catalog-head">${logo}<div><div class="eyebrow">CATALOGUE ${label}</div><b class="cmp-catalog-name">${esc(info.name)}</b><div class="hint">${esc(info.source||'Source non renseignée')}</div></div></div>
    <dl class="facts cmp-facts">${rows.join('')}${fact('Produits',`${counts} produits`)}${fact('Collecté le',fmtDate(info.collected_at))}${fact('Fiche',info.url?sourceLink(info.url,'Ouvrir la fiche ↗'):null)}</dl>
  </div>`;
}
/* ---------- Comparaison détaillée ---------- */
let cmpStamp=0;
async function renderComparisonDetail(){
  const row=(data.common_restaurants||[]).find(r=>r.name===selectedCommon);
  if(!row){view='restaurantCompare';render();return}
  const stamp=Date.now();cmpStamp=stamp;
  $('#content').innerHTML=`<section class="panel detail">
    <div class="detail-head"><div><div class="eyebrow">COMPARAISON DÉTAILLÉE</div><h2>${esc(row.name)}</h2>
      <p class="hint">Chargement des deux catalogues…</p></div>
      <div class="detail-actions"><button id="backList" class="btn">← Retour à la liste</button></div></div>
    <div class="empty">Chargement du catalogue Glovo et du catalogue Mooup…</div></section>`;
  $('#backList').onclick=()=>{view='restaurantCompare';selectedCommon=null;render()};
  let cmp;
  try{
    const params=new URLSearchParams({restaurant:row.name});
    if(row.mooup_name)params.set('mooup',row.mooup_name);
    const res=await fetch(`/api/catalog-comparison?${params}`);
    if(!res.ok){const err=await res.json().catch(()=>({}));throw Error(err.detail||`Erreur ${res.status}`)}
    cmp=await res.json();
  }catch(e){
    if(cmpStamp!==stamp||view!=='restaurantDetail')return;
    $('#content').innerHTML=`<section class="panel detail">
      <div class="detail-head"><div><div class="eyebrow">COMPARAISON DÉTAILLÉE</div><h2>${esc(row.name)}</h2>
        <p class="hint">${esc(e.message)}</p></div>
        <div class="detail-actions"><button id="backList" class="btn">← Retour à la liste</button><button id="retryCmp" class="btn">Réessayer</button></div></div>
      <div class="empty">Impossible de charger les deux catalogues.</div></section>`;
    $('#backList').onclick=()=>{view='restaurantCompare';selectedCommon=null;render()};
    $('#retryCmp').onclick=()=>renderComparisonDetail();
    return;
  }
  if(cmpStamp!==stamp||view!=='restaurantDetail')return;
  document.body.dataset.cmpTab='g';
  const s=cmp.summary,metaG=cmp.glovo,metaM=cmp.mooup,meta=cmp.meta;
  const confirmed=cmp.match.status==='confirmed';
  const counts={all:cmp.rows.length,
    different:cmp.rows.filter(r=>r.delta!==null&&r.delta!==undefined&&r.delta!==0).length,
    identical:cmp.rows.filter(r=>r.delta===0).length,
    missing_mooup:cmp.rows.filter(r=>r.kind==='glovo_only').length,
    missing_glovo:cmp.rows.filter(r=>r.kind==='mooup_only').length,
    review:cmp.rows.filter(r=>r.uncertain).length};
  const chips=new Map();
  cmp.rows.forEach(r=>{
    const keys=new Set();
    if(r.glovo_product)keys.add(catKey(r.glovo_product.category));
    if(r.mooup_product)keys.add(catKey(r.mooup_product.category));
    [...keys].forEach(k=>{
      if(!chips.has(k)){
        const original=r.glovo_product&&catKey(r.glovo_product.category)===k?r.glovo_product.category
          :(r.mooup_product?r.mooup_product.category:r.category);
        chips.set(k,{key:k,label:String(original||'Non classé').trim()||'Non classé',n:0});
      }
      chips.get(k).n++;
    });
  });
  $('#content').innerHTML=`<section class="panel detail cmp-page">
    <div class="detail-head">
      <div><div class="eyebrow">COMPARAISON DÉTAILLÉE</div>
        <h2>${esc(row.name)} <span class="muted cmp-vs">↔ ${esc(cmp.match.mooup_name||row.mooup_name)}</span></h2>
        <p class="hint">Glovo collecté le ${fmtDate(meta.glovo_scraped_at||(metaG||{}).collected_at)} · Mooup synchronisé le ${fmtDate(meta.mooup_last_sync||(metaM||{}).collected_at)} · confiance ${Math.round((cmp.match.confidence||0)*100)} %${(cmp.match.reasons||[]).length?` · ${esc(cmp.match.reasons.join(' · '))}`:''}</p></div>
      <div class="detail-actions"><span class="badge ${confirmed?'both':'review'}">${confirmed?'Correspondance confirmée':'Correspondance à vérifier'}</span><button id="backList" class="btn">← Retour à la liste</button></div>
    </div>
    <div class="statline">
      <span><b>${s.paired}</b> produits rapprochés</span>
      <span><b>${s.glovo_products}</b> produits Glovo</span>
      <span><b>${s.mooup_products}</b> produits Mooup</span>
      <span><b>${s.missing_mooup}</b> absents de Mooup</span>
      <span><b>${s.missing_glovo}</b> absents de Glovo</span>
      <span><b>${s.price_gaps}</b> prix différents</span>
      <span><b>${s.price_identical}</b> prix identiques</span>
      <span><b>${s.uncertain}</b> correspondances à vérifier</span>
      ${s.anomalies?`<span class="warn"><b>${s.anomalies}</b> prix source atypique(s)</span>`:''}
    </div>
    <div class="notice"><b>Lecture des écarts</b><span>Écart MAD = Prix Glovo − Prix Mooup · Écart % = ((Prix Glovo − Prix Mooup) / Prix Mooup) × 100. Écart positif : Glovo plus cher. Écart négatif : Mooup plus cher. Écart nul : prix identiques. Pas de pourcentage si le prix Mooup est nul ou absent. Les produits de tailles, compositions ou options différentes ne sont pas comparés.</span></div>
    <div class="toolbar">
      <input id="cmpSearch" type="search" placeholder="Rechercher un produit…">
      <select id="cmpFilter">
        <option value="all">Tous les produits (${counts.all})</option>
        <option value="different">Prix différents (${counts.different})</option>
        <option value="identical">Prix identiques (${counts.identical})</option>
        <option value="missing_mooup">Absents de Mooup (${counts.missing_mooup})</option>
        <option value="missing_glovo">Absents de Glovo (${counts.missing_glovo})</option>
        <option value="review">Correspondances à vérifier (${counts.review})</option>
      </select>
      <button id="cmpCsv" class="btn">Exporter CSV</button>
      <span id="cmpCount" class="hint"></span>
    </div>
    <div class="cmp-tabs"><button data-tab="g" class="active">GLOVO (${s.glovo_products})</button><button data-tab="m">MOOUP (${s.mooup_products})</button></div>
    <div class="cmp-board">
      <div class="cmp-topbar">
        <div class="cmp-topgrid">
          <div class="cmp-colhead side-g"><b>GLOVO</b><span class="hint">${s.glovo_products} produits · ${esc((metaG||{}).source||'Source non renseignée')}</span></div>
          <div class="cmp-colhead side-m"><b>MOOUP</b><span class="hint">${s.mooup_products} produits · ${esc(meta.mooup_source||(metaM||{}).source||'Source non renseignée')}</span></div>
        </div>
        <div id="cmpCatbar" class="cmp-catbar"></div>
      </div>
      <div class="cmp-catalogs">${catalogHeader(metaG,'g',s.glovo_products)}${catalogHeader(metaM,'m',s.mooup_products)}</div>
      <div id="cmpRows" class="cmp-rows"></div>
      <div id="cmpEmpty" class="empty" hidden>Aucun produit ne correspond à ces filtres.</div>
    </div>
    <div id="matchValidation"></div>
  </section>`;
  const state={q:'',f:'all',cat:''};
  const renderChips=()=>{
    const items=[{key:'',label:'Toutes les catégories',n:cmp.rows.length},...chips.values()];
    $('#cmpCatbar').innerHTML=items.map(c=>`<button class="chip${state.cat===c.key?' active':''}" data-cat="${esc(c.key)}">${esc(c.label)} <span>${c.n}</span></button>`).join('');
  };
  const draw=()=>{
    const q=normalizeBrowser(state.q);
    const shown=cmp.rows.filter(r=>{
      if(state.f==='different'&&!(r.delta!==null&&r.delta!==undefined&&r.delta!==0))return false;
      if(state.f==='identical'&&r.delta!==0)return false;
      if(state.f==='missing_mooup'&&r.kind!=='glovo_only')return false;
      if(state.f==='missing_glovo'&&r.kind!=='mooup_only')return false;
      if(state.f==='review'&&!r.uncertain)return false;
      if(state.cat){
        const gk=r.glovo_product?catKey(r.glovo_product.category):'__none__';
        const mk=r.mooup_product?catKey(r.mooup_product.category):'__none__';
        if(gk!==state.cat&&mk!==state.cat)return false;
      }
      if(q){
        const hay=[r.glovo_product&&r.glovo_product.name,r.mooup_product&&r.mooup_product.name,
          r.glovo_product&&r.glovo_product.category,r.mooup_product&&r.mooup_product.category]
          .filter(Boolean).map(normalizeBrowser).join(' ');
        if(!hay.includes(q))return false;
      }
      return true;
    });
    const groups=new Map();
    shown.forEach(r=>{
      const gk=r.glovo_product?catKey(r.glovo_product.category):'__none__';
      const mk=r.mooup_product?catKey(r.mooup_product.category):'__none__';
      const key=`${gk}\u0001${mk}`;
      if(!groups.has(key))groups.set(key,{gk,mk,rows:[]});
      groups.get(key).rows.push(r);
    });
    $('#cmpRows').innerHTML=[...groups.values()].map(g=>{
      const left=g.rows.filter(r=>r.glovo_product),right=g.rows.filter(r=>r.mooup_product);
      const leftLabel=left.length?String(left[0].glovo_product.category||'Non classé').trim()||'Non classé':'—';
      const rightLabel=right.length?String(right[0].mooup_product.category||'Non classé').trim()||'Non classé':'—';
      return `<div class="cmp-group"><div class="cmp-groupgrid">
        <div class="side-g">${left.length?`<b>${esc(leftLabel)}</b><span class="hint">${left.length} produit(s) Glovo</span>`:'<span class="muted">—</span>'}</div>
        <div class="side-m">${right.length?`<b>${esc(rightLabel)}</b><span class="hint">${right.length} produit(s) Mooup</span>`:'<span class="muted">—</span>'}</div>
      </div></div>`+g.rows.map(r=>{
        const gCard=r.glovo_product?productCard(r.glovo_product):emptyCell(r,'g',meta);
        const mCard=r.mooup_product?productCard(r.mooup_product):emptyCell(r,'m',meta);
        return `<div class="cmp-row"><div class="cmp-pair"><div class="side-g">${gCard}</div><div class="side-m">${mCard}</div></div>
          <div class="cmp-flag">${pairFlags(r).map(flagHtml).join('')}</div></div>`;
      }).join('');
    }).join('');
    $('#cmpEmpty').hidden=!!shown.length;
    $('#cmpCount').textContent=`${shown.length} ligne(s) affichée(s) sur ${cmp.rows.length}`;
    return shown;
  };
  let shownRows=[];
  const redraw=()=>{shownRows=draw()};
  renderChips();redraw();
  $('#cmpSearch').oninput=e=>{state.q=e.target.value;redraw()};
  $('#cmpFilter').onchange=e=>{state.f=e.target.value;redraw()};
  $('#cmpCatbar').onclick=e=>{
    const b=e.target.closest('[data-cat]');if(!b)return;
    state.cat=b.dataset.cat;renderChips();redraw();
  };
  $('.cmp-tabs').onclick=e=>{
    const b=e.target.closest('[data-tab]');if(!b)return;
    document.body.dataset.cmpTab=b.dataset.tab;
    document.querySelectorAll('.cmp-tabs button').forEach(x=>x.classList.toggle('active',x.dataset.tab===b.dataset.tab));
  };
  $('#cmpCsv').onclick=()=>downloadCsv(shownRows.map(r=>({
    categorie:(r.glovo_product||r.mooup_product||{}).category||'Non classé',
    produit_glovo:(r.glovo_product||{}).name||'Non disponible',
    prix_glovo:r.glovo_product?(r.glovo_product.price??''):'',
    produit_mooup:(r.mooup_product||{}).name||'Non disponible',
    prix_mooup:r.mooup_product?(r.mooup_product.price??''):'',
    ecart_mad:r.delta===null||r.delta===undefined?'Non calculable':r.delta,
    ecart_percent:r.percent===null||r.percent===undefined?'Non calculable':r.percent,
    comparaison:pairFlags(r).map(f=>f.text).join(' · '),
    confiance:r.confidence,statut:r.kind,incertain:r.uncertain?'oui':'non'
  })),'comparaison-catalogues.csv');
  $('#backList').onclick=()=>{view='restaurantCompare';selectedCommon=null;render()};
  if(data.mooup_catalog_available&&(metaG||{}).name&&metaM){
    const controls=document.createElement('div');
    controls.className='toolbar match-validation';
    controls.innerHTML=`<label>Valider la correspondance Mooup <select class="mooup-match-choice">${(data.restaurants.mooup||[]).map(l=>`<option value="${esc(l.name)}" ${l.name===(cmp.match.mooup_name||row.mooup_name)?'selected':''}>${esc(l.name)}</option>`).join('')}</select></label><button class="validate-restaurant primary">Confirmer le rapprochement</button><button class="reject-restaurant btn">Marquer comme non-correspondant</button>`;
    $('#matchValidation').append(controls);
  }
  $('#content').onclick=async event=>{
    const validate=event.target.closest('.validate-restaurant'),reject=event.target.closest('.reject-restaurant'),button=validate||reject;
    if(!button)return;
    const payload={glovo_name:row.name,decision:validate?'confirm':'missing',mooup_name:validate?$('.mooup-match-choice').value:null};
    try{
      const response=await fetch('/api/matches/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),result=await response.json();
      if(!response.ok)throw Error(result.detail||'Validation impossible');
      toast('Décision de rapprochement enregistrée.');
      view='restaurantCompare';
      await load();
    }catch(e){toast(e.message)}
  };
}
/* ---------- Historique ---------- */
function renderHistory(){
  const imports=data.catalog_history||[];
  $('#content').innerHTML=`<section class="panel">
    <div class="panel-head"><div><h2>Analyses</h2><p class="hint">Runs de collecte enregistrés en base.</p></div></div>
    <div class="runlist">${(data.history||[]).map(r=>`<div class="runitem"><span>Analyse #${r.id} · ${fmtDate(r.started_at)}${r.finished_at?` → ${fmtDate(r.finished_at)}`:''}</span><span class="badge ${esc(r.status)}">${esc(r.status)}</span></div>`).join('')||'<div class="empty">Aucune analyse sauvegardée.</div>'}</div>
    <h3>Imports catalogue Mooup</h3>
    <div class="runlist">${imports.map(x=>`<div class="runitem"><span>${x.restaurant_count} restaurants · ${x.product_count} produits</span><span>${fmtDate(x.imported_at)}</span></div>`).join('')||'<div class="hint">Aucun import Mooup.</div>'}</div>
    <h3>Validations manuelles (${(data.tracked_restaurants||[]).filter(r=>r.manual).length} restaurants)</h3>
    <div class="runlist">${(data.manual_missing_history||[]).map(x=>`<div class="runitem"><span>${esc(x.restaurant_name)} — ${esc(x.status)}</span><span>${fmtDate(x.checked_at)}</span></div>`).join('')||'<div class="hint">Historique non disponible.</div>'}</div>
    <h3>Historique des prix (${(data.price_history||[]).length} enregistrements)</h3>
    <div class="runlist">${(data.price_history||[]).slice(0,100).map(x=>`<div class="runitem"><span>${esc(x.restaurant_name)} — ${esc(x.product_name)} : ${money(x.mooup_price,x.currency)} / ${money(x.glovo_price,x.currency)}</span><span>${fmtDate(x.recorded_at)}</span></div>`).join('')||'<div class="hint">Aucun prix comparé enregistré.</div>'}</div>
    <h3>Collecte active / dernière</h3>
    <div id="progressArea">${progressMarkup()}</div>
  </section>`;
}

/* ---------- Utilitaires ---------- */
function downloadCsv(rows,filename='comparaison-mooup-glovo.csv'){
  const cols=rows.length?Object.keys(rows[0]):['restaurant','statut'];
  const csv=[cols.join(';'),...rows.map(r=>cols.map(k=>`"${String(Array.isArray(r[k])?r[k].join(' | '):r[k]??'').replaceAll('"','""')}"`).join(';'))].join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
  a.download=filename;a.click();URL.revokeObjectURL(a.href);
}
function progressMarkup(){
  const r=data.current_run||{};
  if(r.status==='running')return `<b>${esc(r.stage||'Collecte en cours')}</b><p>${r.restaurants_processed||0} restaurants · ${r.products_processed||0} produits</p><progress max="100" value="${r.total_restaurants?Math.min(99,Math.round(r.restaurants_processed/r.total_restaurants*100)):5}"></progress>`;
  return `<span class="badge">${esc(r.status==='failed'?'Échec':r.status==='partial'?'Partielle':r.status==='completed'?'Terminée':'En attente')}</span><p class="hint">${esc(r.stage||'Lance une analyse pour actualiser les sources.')}</p>`;
}
async function pollRun(){
  try{
    const r=await fetch('/api/runs/current');data.current_run=await r.json();
    if(view==='history'&&$('#progressArea'))$('#progressArea').innerHTML=progressMarkup();
    if(data.current_run.status!=='running'){clearInterval(pollTimer);await load()}
  }catch(e){clearInterval(pollTimer)}
}
async function importMooup(){
  const file=$('#mooupFile')&&$('#mooupFile').files[0];
  if(!file){toast('Sélectionne un fichier CSV ou JSON.');return}
  const format=file.name.toLowerCase().endsWith('.csv')?'csv':'json';
  $('#importState').textContent='Import en cours…';
  try{
    const r=await fetch(`/api/import/mooup?format=${format}`,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:await file.text()}),result=await r.json();
    if(!r.ok)throw Error(result.detail||'Import refusé');
    toast(`${result.restaurants} restaurants · ${result.products} produits importés`);
    await load();
  }catch(e){$('#importState').textContent=e.message;toast(e.message)}
}
async function syncMooup(){
  const button=$('#syncMooup');
  if(button){button.disabled=true;button.textContent='Synchronisation…'}
  try{
    const response=await fetch('/api/sync/mooup',{method:'POST'}),result=await response.json();
    if(!response.ok)throw Error(result.detail||'Synchronisation refusée');
    toast(`${result.restaurants} restaurants · ${result.products} produits récupérés via API Mooup`);
    await load();
  }catch(error){toast(error.message)}
  finally{if(button){button.disabled=false;button.textContent='Synchroniser l’API Mooup'}}
}
function toast(text){
  const el=$('#toast');el.textContent=text;el.style.display='block';
  setTimeout(()=>{el.style.display='none'},5000);
}

/* ---------- Navigation et démarrage ---------- */
document.querySelectorAll('#nav a').forEach(a=>a.onclick=()=>{
  view=a.dataset.view;selectedTracked=null;
  if(view==='overview'||view==='restaurantCompare')selectedCommon=null;
  render();
});
$('#run').onclick=async()=>{
  const button=$('#run');button.disabled=true;button.querySelector('span').textContent='Analyse lancée…';
  try{
    const r=await fetch('/api/runs',{method:'POST'}),result=await r.json();
    if(!r.ok)throw Error(result.detail||'Échec');
    data.current_run=result;clearInterval(pollTimer);pollTimer=setInterval(pollRun,1200);
    render();toast('Analyse lancée; la progression est visible dans l’Historique.');
  }catch(e){toast(e.message)}
  finally{button.disabled=false;button.querySelector('span').textContent='Lancer la comparaison'};
};
load();

