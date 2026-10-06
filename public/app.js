// Inventory Stocks — data is stored in the shared Netlify Database through /api.
// The previous browser-only data (localStorage) is left untouched and can be imported once.
const LOCAL_KEY='stock-desk-inventory-v2',LOCAL_HISTORY_KEY='stock-desk-inventory-history-v1',IMPORT_KEY='stock-desk-import-v1';
const categories=['Bags','Tops','Bottoms','Accessories'],sizedCategories=['Tops','Bottoms'],returnStatuses=['Not returned','Returned','Kept by KOL'],genders=['Men','Women','Unisex'],sizes=['S','M','L','XL'];
let items=[],history=[],seeding=[];let view='inventory';let genderFilter='All',categoryFilter='All';let sortMode='newest';let loaded=false,pending=0,renderQueued=false;
const grid=document.getElementById('grid'),filters=document.getElementById('filters');
const $=id=>document.getElementById(id);

function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function money(n){return 'RM '+(Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
// Dates are stored as YYYY-MM-DD and shown as DD/MM/YY; an empty date stays empty.
function fmtDate(iso){const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso??''));return m?`${m[3]}/${m[2]}/${m[1].slice(2)}`:''}
function parseDate(text){const t=String(text??'').trim();if(!t)return '';const m=/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(t);if(!m)return null;const d=+m[1],mo=+m[2],y=m[3].length===2?2000+ +m[3]:+m[3];const dt=new Date(Date.UTC(y,mo-1,d));if(dt.getUTCFullYear()!==y||dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return null;return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`}
function readLocal(key){try{const v=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(v)?v:[]}catch{return[]}}
function byId(id){return items.find(x=>x.id===id)}
// Tops and Bottoms keep a quantity per size; the product's quantity is their sum.
function sized(x){return !!x&&sizedCategories.includes(x.category)}
function sizeMap(x){return x&&x.sizeQuantities&&typeof x.sizeQuantities==='object'?x.sizeQuantities:{}}
function hasSizeQty(x){return Object.values(sizeMap(x)).some(n=>Number(n)>0)}
function sizesText(x){const m=sizeMap(x);return sizes.filter(s=>Number(m[s])>0).map(s=>`${s}: ${m[s]}`).join(', ')}
function parseSizes(t){const m={};String(t||'').split(',').forEach(p=>{const [k,v]=p.split(':').map(s=>s.trim());if(k&&v)m[k]=v});return m}

// ---- API ----
class AuthError extends Error{}
async function api(path,{method='GET',body}={}){
  pending++;setSync('Saving…',method!=='GET');
  try{
    const res=await fetch(path,{method,credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await res.json().catch(()=>({}));
    if(res.status===401){showLogin();throw new AuthError(data.error||'Please log in')}
    if(!res.ok){const err=new Error(data.error||'Request failed');err.status=res.status;throw err}
    return data;
  }finally{pending--;if(!pending)setSync('All changes saved')}
}
function setSync(text,show=true){if(show)$('syncStatus').textContent=text}
function fail(e){if(!(e instanceof AuthError))notify(e.message||'Could not save. Please try again.')}

// ---- Login ----
function showLogin(msg=''){ $('app').hidden=true;$('login').hidden=false;$('loginError').textContent=msg;$('passwordInput').focus() }
$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=$('loginBtn');btn.disabled=true;$('loginError').textContent='';
  try{
    const res=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('passwordInput').value})});
    const data=await res.json().catch(()=>({}));
    if(!res.ok){$('loginError').textContent=res.status===429?'Too many attempts. Please wait a minute and try again.':(data.error||'Login failed');return}
    $('passwordInput').value='';await start();
    // The password was right but the browser didn't keep the login cookie (e.g. third-party cookies blocked in an embedded view).
    if(!loaded&&!$('loginError').textContent)$('loginError').innerHTML=`Password accepted, but this browser blocked the login cookie. <a href="${esc(location.href)}" target="_blank" rel="noopener">Open the inventory in a new tab</a> and log in there.`;
  }catch{$('loginError').textContent='Could not reach the server. Please try again.'}
  finally{btn.disabled=false}
});
$('logoutBtn').onclick=async()=>{await fetch('/api/logout',{method:'POST'}).catch(()=>{});items=[];history=[];seeding=[];canvaUrl='';canvaEditing=false;renderCanva();loaded=false;grid.innerHTML='';$('seedingGrid').innerHTML='';showLogin()};

async function start(){
  try{
    const res=await fetch('/api/state',{credentials:'same-origin',cache:'no-store'});
    const data=await res.json().catch(()=>({}));
    if(res.status===401){showLogin();return}
    if(!res.ok){showLogin(data.error||'Could not load the inventory.');return}
    items=data.products;history=data.history;seeding=data.seeding||[];setCanva(data.canvaUrl);loaded=true;
    $('login').hidden=true;$('app').hidden=false;setSync('All changes saved');render();checkImport();
  }catch{showLogin('Could not reach the server. Please try again.')}
}

// Pull changes made by other people, without disturbing someone mid-edit.
async function refresh(){
  if(!loaded||pending||document.hidden||isEditing())return;
  try{const data=await api('/api/state');if(pending||isEditing())return;items=data.products;history=data.history;seeding=data.seeding||[];setCanva(data.canvaUrl);render();checkImport()}catch{}
}
setInterval(refresh,20000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
function isEditing(){const a=document.activeElement;return !!(a&&(grid.contains(a)||$('seedingGrid').contains(a))&&a.matches('input,select,textarea'))}
// Re-render once no field is focused so typing in the next field isn't interrupted.
function scheduleRender(){if(renderQueued)return;renderQueued=true;const tryRender=()=>{if(isEditing()){setTimeout(tryRender,400);return}renderQueued=false;render()};setTimeout(tryRender,0)}

// ---- Rendering ----
function updateSummary(){
  $('productCount').textContent=items.length.toLocaleString('en-US');
  $('totalQty').textContent=items.reduce((sum,x)=>sum+(Number(x.quantity)||0),0).toLocaleString('en-US');
  $('totalValue').textContent=money(items.reduce((sum,x)=>sum+(Number(x.quantity)||0)*(Number(x.price)||0),0));
}
function addHistory(entry){if(entry){history.unshift(entry);history=history.slice(0,500)}renderHistory()}
// ---- History: one compact row per event; before/after details only when expanded ----
const FIELD_LABELS={name:'Name',price:'Price',sku:'SKU',quantity:'Quantity',date:'Date',gender:'Gender',category:'Category',size:'Size',description:'Description',sizes:'Size quantities',canvaUrl:'Canva link',kolName:'KOL name',product:'Product',dateSent:'Date sent',returnStatus:'Return status',returnDate:'Return date',notes:'Notes'};
const openHistory=new Set();
function fieldVal(k,v){return ['date','dateSent','returnDate'].includes(k)?(fmtDate(v)||v):v}
function fieldLabel(k){return FIELD_LABELS[k]||String(k).replace(/^./,c=>c.toUpperCase())}
function short(v,max=28){const t=String(v??'').trim()||'—';return t.length>max?t.slice(0,max-1)+'…':t}
function historyWhen(at){const d=new Date(at);if(isNaN(d))return '';const date=d.toLocaleDateString('en-US',{month:'short',day:'numeric',...(d.getFullYear()!==new Date().getFullYear()?{year:'numeric'}:{})});return `${date}, ${d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`}
function changedKeys(h){if(!h.before||!h.after||typeof h.before!=='object'||typeof h.after!=='object')return[];return [...new Set([...Object.keys(h.before),...Object.keys(h.after)])].filter(k=>String(h.before[k]??'')!==String(h.after[k]??''))}
function historySummary(h){
  const action=String(h.action||'');const keys=changedKeys(h);
  const sm=action.match(/^Updated size (\w+) quantity$/);if(sm&&h.before&&h.after){const s=sm[1];return `Size ${s} ${parseSizes(h.before.sizes)[s]||0} → ${parseSizes(h.after.sizes)[s]||0}`}
  if(keys.length===1){const k=keys[0];return `${fieldLabel(k)} ${short(fieldVal(k,h.before[k]))} → ${short(fieldVal(k,h.after[k]))}`}
  if(keys.length>1)return `${keys.map(fieldLabel).join(', ')} changed`;
  if(/^added/i.test(action))return 'Added';
  if(/^deleted/i.test(action))return 'Deleted';
  if(/image/i.test(action))return 'Image updated';
  const m=action.match(/^Updated\s+(\w+)$/);if(m)return `${fieldLabel(m[1])} updated`;
  return action||'Changed';
}
function historyDetails(h){
  const b=h.before&&typeof h.before==='object'?h.before:null,a=h.after&&typeof h.after==='object'?h.after:null;
  const keys=[...new Set([...Object.keys(b||{}),...Object.keys(a||{})])];
  const head=`<div class="history-meta">${esc(new Date(h.at).toLocaleString('en-US'))} · ${esc(h.action||'')}</div>`;
  if(!keys.length)return head+'<div class="history-none">No version details recorded.</div>';
  const changed=new Set(changedKeys(h));
  const rows=keys.map(k=>`<tr class="${changed.has(k)?'changed':''}"><th>${esc(fieldLabel(k))}</th>${b?`<td>${esc(fieldVal(k,b[k]??''))||'—'}</td>`:''}${a?`<td>${esc(fieldVal(k,a[k]??''))||'—'}</td>`:''}</tr>`).join('');
  return `${head}<table class="history-table"><thead><tr><th>Field</th>${b?'<th>Before</th>':''}${a?'<th>After</th>':''}</tr></thead><tbody>${rows}</tbody></table>`;
}
function renderHistory(){const list=$('historyList');document.querySelectorAll('.history-count').forEach(el=>el.textContent=history.length?`(${history.length})`:'');if(!history.length){list.innerHTML='<div class="history-empty">No changes recorded yet. Product and KOL Seeding changes will appear here.</div>';return}
  list.innerHTML=history.map(h=>{const key=String(h.id??h.at);return `<details class="history-row" data-hid="${esc(key)}"${openHistory.has(key)?' open':''}><summary><span class="history-time">${esc(historyWhen(h.at))}</span><span class="history-dot">·</span><span class="history-name">${esc(h.name||'Untitled product')}</span><span class="history-dot">·</span><span class="history-change">${esc(historySummary(h))}</span></summary><div class="history-body">${historyDetails(h)}</div></details>`}).join('')}
document.addEventListener('toggle',e=>{const d=e.target;if(d instanceof HTMLDetailsElement&&d.matches('.history-row')){d.open?openHistory.add(d.dataset.hid):openHistory.delete(d.dataset.hid)}},true);
function render(){filters.innerHTML='';const genderRow=document.createElement('div');genderRow.className='filter-row';genderRow.innerHTML='<span class="filter-label">GENDER</span>';['All',...genders].forEach(g=>{const b=document.createElement('button');b.className='filter'+(genderFilter===g?' active':'');b.textContent=g;b.onclick=()=>{genderFilter=g;render()};genderRow.appendChild(b)});const categoryRow=document.createElement('div');categoryRow.className='filter-row';categoryRow.innerHTML='<span class="filter-label">CATEGORY</span>';['All',...categories].forEach(c=>{const b=document.createElement('button');b.className='filter'+(categoryFilter===c?' active':'');b.textContent=c;b.onclick=()=>{categoryFilter=c;render()};categoryRow.appendChild(b)});filters.append(genderRow,categoryRow);
 const q=$('searchInput').value.trim().toLowerCase();const shown=items.filter(x=>(genderFilter==='All'||x.gender===genderFilter)&&(categoryFilter==='All'||x.category===categoryFilter)&&(!q||(['name','price','sku','quantity','date','gender','category','size','description'].some(k=>String(x[k]??'').toLowerCase().includes(q))||(sized(x)&&sizesText(x).toLowerCase().includes(q)))));const sorters={'newest':(a,b)=>(!a.date-!b.date)||String(b.date||'').localeCompare(String(a.date||'')),'oldest':(a,b)=>(!a.date-!b.date)||String(a.date||'').localeCompare(String(b.date||'')),'price-desc':(a,b)=>(Number(b.price)||0)-(Number(a.price)||0),'price-asc':(a,b)=>(Number(a.price)||0)-(Number(b.price)||0),'name-asc':(a,b)=>String(a.name||'').localeCompare(String(b.name||'')),'name-desc':(a,b)=>String(b.name||'').localeCompare(String(a.name||'')),'quantity-desc':(a,b)=>(Number(b.quantity)||0)-(Number(a.quantity)||0),'quantity-asc':(a,b)=>(Number(a.quantity)||0)-(Number(b.quantity)||0)};shown.sort(sorters[sortMode]);
 $('visibleCount').textContent=`${shown.length} ${shown.length===1?'product':'products'}`;updateSummary();renderHistory();renderSeeding();
 if(!shown.length){grid.innerHTML=`<div class="empty">${items.length?'No matching products found.':'No products yet. Click “Add Product” to get started.'}</div>`;return}
 grid.innerHTML=`<div class="table-scroll"><table class="inventory-table"><thead><tr><th>Picture</th><th>Name</th><th>Price</th><th>SKU</th><th>Quantity</th><th>Date</th><th>Gender</th><th>Category</th><th>Size</th><th>Description</th><th></th></tr></thead><tbody>${shown.map(x=>{const id=esc(x.id);return `<tr><td>${x.image?`<div class="table-photo has-image"><button class="photo-view" type="button" data-view="${id}" title="View larger photo" aria-label="View larger photo"><img src="${esc(x.image)}" alt="${esc(x.name||'Product image')}" loading="lazy"></button><label class="photo-change" title="Change photo">Change<input type="file" accept="image/*" data-image="${id}" aria-label="Change product image"></label></div>`:`<div class="table-photo"><div class="photo-placeholder"><b>＋</b>Image</div><input class="upload" type="file" accept="image/*" data-image="${id}" aria-label="Upload product image"></div>`}</td><td><textarea class="table-input table-name" rows="1" data-id="${id}" data-k="name" placeholder="Product name" aria-label="Product name">${esc(x.name)}</textarea></td><td><input class="table-input" data-id="${id}" data-k="price" type="number" min="0" step="0.01" placeholder="0.00" value="${esc(x.price)}"></td><td><input class="table-input" data-id="${id}" data-k="sku" placeholder="SKU" value="${esc(x.sku)}"></td><td>${sized(x)&&(hasSizeQty(x)||!Number(x.quantity))?`<div class="qty-total" title="Calculated from the size quantities"><b data-total="${id}">${esc(x.quantity)}</b><span>total of sizes</span></div>`:`<input class="table-input" data-id="${id}" data-k="quantity" type="number" step="1" placeholder="0" value="${esc(x.quantity)}">${sized(x)?'<div class="qty-hint">Not split by size yet</div>':''}`}</td><td><input class="table-input date-input" data-date="${id}" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yy" aria-label="Date (DD/MM/YY)" value="${esc(fmtDate(x.date))}"></td><td><select class="table-select" data-id="${id}" data-k="gender"><option value="">Select</option>${genders.map(g=>`<option ${x.gender===g?'selected':''}>${g}</option>`).join('')}</select></td><td><select class="table-select" data-id="${id}" data-k="category"><option value="">Select</option>${categories.map(c=>`<option ${x.category===c?'selected':''}>${c}</option>`).join('')}</select></td><td>${sized(x)?`<div class="size-grid">${sizes.map(size=>{const n=Number(sizeMap(x)[size])||0;return `<label class="size-qty${n>0?' in-stock':''}"><span>${size}</span><input type="number" min="0" step="1" inputmode="numeric" placeholder="0" data-sq="${id}" data-size="${size}" value="${n||''}" aria-label="Quantity in size ${size}"></label>`}).join('')}</div>`:'—'}</td><td><textarea class="table-description" data-id="${id}" data-k="description" placeholder="Product details">${esc(x.description)}</textarea></td><td><button class="delete" data-delete="${id}" aria-label="Delete product" title="Delete">×</button></td></tr>`}).join('')}</tbody></table></div>`
 grid.querySelectorAll('.table-name').forEach(fitName)
}

// Grow the name box to fit its content so long names wrap instead of clipping
function fitName(el){el.style.height='auto';if(el.scrollHeight)el.style.height=el.scrollHeight+'px'}
addEventListener('resize',()=>grid.querySelectorAll('.table-name').forEach(fitName));
// Names are single-line values: Enter finishes editing instead of adding a line break
grid.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('.table-name')){e.preventDefault();e.target.blur()}});

// ---- Editing ----
grid.addEventListener('focusin',e=>{const el=e.target;if(el.matches('[data-sq]'))el.dataset.beforeValue=String(Number(sizeMap(byId(el.dataset.sq))[el.dataset.size])||0);if(el.matches('[data-id][data-k]'))el.dataset.beforeValue=byId(el.dataset.id)?.[el.dataset.k]??''});
// Mirrors the server: once any size has stock (or had it), quantity is the sum of sizes.
function applySizeQty(item,size,value){const before=hasSizeQty(item);const m={...sizeMap(item)};const n=Math.max(0,Math.floor(Number(value)||0));if(n>0)m[size]=n;else delete m[size];item.sizeQuantities=m;if(before||hasSizeQty(item))item.quantity=Object.values(m).reduce((a,b)=>a+(Number(b)||0),0)}
grid.addEventListener('input',e=>{const el=e.target;if(el.matches('[data-sq]')){const item=byId(el.dataset.sq);if(!item)return;applySizeQty(item,el.dataset.size,el.value);const t=grid.querySelector(`[data-total="${CSS.escape(item.id)}"]`);if(t)t.textContent=item.quantity;el.closest('.size-qty')?.classList.toggle('in-stock',Number(el.value)>0);updateSummary();return}if(!el.matches('[data-id][data-k]'))return;const item=byId(el.dataset.id);if(!item)return;if(el.classList.contains('table-name')){if(/[\r\n]/.test(el.value))el.value=el.value.replace(/[\r\n]+/g,' ');fitName(el)}item[el.dataset.k]=el.value;if(el.dataset.k==='quantity'||el.dataset.k==='price')updateSummary()});
grid.addEventListener('change',async e=>{const el=e.target;
  if(el.matches('[data-image]')&&el.files?.[0]){readImage(el.files[0],el.dataset.image);return}
  if(el.matches('[data-sq]')){saveSizeQty(el);return}
  if(el.matches('[data-date]')){saveDate(el);return}
  if(!el.matches('[data-id][data-k]'))return;
  const id=el.dataset.id,k=el.dataset.k,old=el.dataset.beforeValue??'',value=el.value,item=byId(id);if(!item)return;
  el.dataset.beforeValue=value;if(String(old)===String(value))return;
  item[k]=value;if(k==='category')render();
  try{const {product,entry}=await api(`/api/products/${encodeURIComponent(id)}`,{method:'PATCH',body:{field:k,value}});const cur=byId(id);if(cur)Object.assign(cur,product);addHistory(entry);updateSummary();scheduleRender()}
  catch(err){const cur=byId(id);if(cur)cur[k]=old;fail(err);scheduleRender()}
});
async function saveDate(el){
  const id=el.dataset.date,item=byId(id);if(!item)return;
  const old=item.date||'',value=parseDate(el.value);
  if(value===null){notify('Enter the date as DD/MM/YY');el.value=fmtDate(old);return}
  el.value=fmtDate(value);if(value===old)return;
  item.date=value;
  try{const {product,entry}=await api(`/api/products/${encodeURIComponent(id)}`,{method:'PATCH',body:{field:'date',value}});const cur=byId(id);if(cur)Object.assign(cur,product);addHistory(entry);scheduleRender()}
  catch(err){const cur=byId(id);if(cur)cur.date=old;fail(err);scheduleRender()}
}
async function saveSizeQty(el){
  const id=el.dataset.sq,size=el.dataset.size,item=byId(id);if(!item)return;
  const old=el.dataset.beforeValue??'0',value=String(Math.max(0,Math.floor(Number(el.value)||0)));el.dataset.beforeValue=value;if(old===value){scheduleRender();return}
  const prev={sizeQuantities:{...sizeMap(item)},quantity:item.quantity};applySizeQty(item,size,value);
  try{const {product,entry}=await api(`/api/products/${encodeURIComponent(id)}`,{method:'PATCH',body:{field:'sizeQuantity',size,value}});const cur=byId(id);if(cur)Object.assign(cur,product);addHistory(entry);updateSummary();scheduleRender()}
  catch(err){const cur=byId(id);if(cur){applySizeQty(cur,size,old);if(!hasSizeQty(cur))Object.assign(cur,prev)}fail(err);updateSummary();scheduleRender()}
}
grid.addEventListener('click',async e=>{const v=e.target.closest('[data-view]');if(v){openViewer(v.dataset.view);return}const b=e.target.closest('[data-delete]');if(!b)return;const id=b.dataset.delete,item=byId(id);if(!item)return;
  if(!confirm(`Delete “${item.name||item.sku||'Untitled product'}” for everyone?`))return;
  try{const {entry}=await api(`/api/products/${encodeURIComponent(id)}`,{method:'DELETE'});items=items.filter(x=>x.id!==id);seeding.forEach(r=>{if(r.productId===id)r.productId=''});addHistory(entry);render();notify('Product deleted')}catch(err){fail(err)}
});
function resizeImage(file){return new Promise((resolve,reject)=>{if(!file.type.startsWith('image/')){reject(new Error('Please choose an image file'));return}const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read that image'));reader.onload=()=>{const img=new Image();img.onerror=()=>reject(new Error('Could not read that image'));img.onload=()=>{const max=1200,scale=Math.min(1,max/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',.85))};img.src=reader.result};reader.readAsDataURL(file)})}
async function readImage(file,id){try{const image=await resizeImage(file);const {product,entry}=await api(`/api/products/${encodeURIComponent(id)}/image`,{method:'PUT',body:{image}});const cur=byId(id);if(cur)Object.assign(cur,product);addHistory(entry);scheduleRender();notify('Image saved')}catch(err){fail(err)}}

$('searchInput').addEventListener('input',render);$('sortSelect').addEventListener('change',e=>{sortMode=e.target.value;render()});
$('refreshBtn').onclick=async()=>{const btn=$('refreshBtn');if(btn.disabled)return;btn.disabled=true;btn.textContent='Refreshing…';try{const data=await api('/api/state');items=data.products;history=data.history;seeding=data.seeding||[];setCanva(data.canvaUrl);scheduleRender();checkImport();notify('Inventory, KOL Seeding and History refreshed')}catch(err){fail(err)}finally{btn.disabled=false;btn.textContent='Refresh'}};
document.querySelectorAll('[data-history-toggle]').forEach(b=>b.onclick=()=>{$('historyPanel').hidden=!$('historyPanel').hidden;renderHistory()});$('closeHistory').onclick=()=>$('historyPanel').hidden=true;
$('addBtn').onclick=async()=>{const btn=$('addBtn');btn.disabled=true;try{const {product,entry}=await api('/api/products',{method:'POST',body:{gender:genderFilter==='All'?'':genderFilter,category:categoryFilter==='All'?'':categoryFilter}});items.push(product);addHistory(entry);render();grid.querySelector(`input[data-id="${CSS.escape(product.id)}"][data-k="name"]`)?.focus()}catch(err){fail(err)}finally{btn.disabled=false}};
$('exportBtn').onclick=()=>{if(!items.length){notify('No products to export');return}const data=[['Name','Price','SKU','Quantity','Date','Gender','Category','Size',...sizes.map(s=>`Qty ${s}`),'Description'],...items.map(x=>{const styling=sized(x),m=sizeMap(x),split=styling&&hasSizeQty(x);return [x.name,x.price,x.sku,x.quantity,x.date,x.gender,x.category,split?sizes.filter(s=>Number(m[s])>0).join(', '):(styling?x.size:''),...sizes.map(s=>split?Number(m[s])||0:''),x.description]})];const csv='﻿'+data.map(r=>r.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='inventory.csv';a.click();URL.revokeObjectURL(url);notify('CSV exported')};

// ---- One-time import of this browser's saved inventory ----
// Local data is never deleted; IMPORT_KEY only remembers that the import happened (or was declined).
function importState(){try{return JSON.parse(localStorage.getItem(IMPORT_KEY)||'null')}catch{return null}}
function setImportState(v){try{localStorage.setItem(IMPORT_KEY,JSON.stringify(v))}catch{}}
let importDismissed=false;
function checkImport(){
  const banner=$('importBanner'),local=readLocal(LOCAL_KEY),state=importState();
  if(state?.pendingImages?.length){retryImages(state);return}
  const show=!importDismissed&&!state?.done&&local.length>0&&items.length===0&&history.length===0;
  banner.hidden=!show;if(!show)return;
  $('importTitle').textContent='Import inventory from this browser';
  $('importText').textContent=`This browser has ${local.length} saved ${local.length===1?'product':'products'}. The shared database is empty, so you can copy them in once. Existing database records are never overwritten.`;
}
$('importDismiss').onclick=()=>{importDismissed=true;$('importBanner').hidden=true};
$('importBtn').onclick=async()=>{
  const local=readLocal(LOCAL_KEY),localHistory=readLocal(LOCAL_HISTORY_KEY);if(!local.length)return;
  if(!confirm(`Import ${local.length} ${local.length===1?'product':'products'} from this browser into the shared database?`))return;
  const btn=$('importBtn');btn.disabled=true;$('importText').textContent='Importing…';
  const withIds=local.map(x=>({...x,id:x.id||(Date.now().toString(36)+Math.random().toString(36).slice(2,8))}));
  try{
    const {imported,ids}=await api('/api/import',{method:'POST',body:{products:withIds.map(({image,...rest})=>rest),history:localHistory}});
    const pendingImages=withIds.map((x,i)=>x.image?{id:ids[i],src:i}:null).filter(Boolean);
    setImportState({done:true,at:new Date().toISOString(),pendingImages});
    $('importBanner').hidden=true;notify(`Imported ${imported} ${imported===1?'product':'products'}`);
    await refreshNow();await retryImages(importState());
  }catch(err){
    if(err.status===409){setImportState({done:true,skipped:true,at:new Date().toISOString()});$('importBanner').hidden=true;notify(err.message);await refreshNow()}
    else{fail(err);checkImport()}
  }finally{btn.disabled=false}
};
async function refreshNow(){try{const data=await api('/api/state');items=data.products;history=data.history;seeding=data.seeding||[];setCanva(data.canvaUrl);render()}catch{}}
let retrying=false;
async function retryImages(state){
  if(retrying||!state?.pendingImages?.length)return;retrying=true;
  const local=readLocal(LOCAL_KEY);const left=[];
  for(const p of state.pendingImages){
    const image=local[p.src]?.image;if(!image||!byId(p.id))continue;
    try{await api(`/api/products/${encodeURIComponent(p.id)}/image`,{method:'PUT',body:{image,source:'import'}})}catch(e){if(e.status!==404&&e.status!==400&&e.status!==413)left.push(p)}
  }
  setImportState({...state,pendingImages:left});retrying=false;
  if(left.length)notify(`${left.length} product ${left.length===1?'image':'images'} could not be uploaded yet. Retrying later.`);
  await refreshNow();
}

// ---- Tabs ----
function setView(v){view=v;const inv=v==='inventory';
  $('inventoryView').hidden=!inv;$('inventoryGrid').hidden=!inv;$('seedingView').hidden=inv;$('seedingGridWrap').hidden=inv;
  $('addBtn').hidden=!inv;$('addSeedingBtn').hidden=inv;
  document.querySelectorAll('[data-view-tab]').forEach(t=>{const on=t.dataset.viewTab===v;t.classList.toggle('active',on);t.setAttribute('aria-selected',String(on))});
  if(inv)render();else renderSeeding()}
document.querySelectorAll('[data-view-tab]').forEach(t=>t.onclick=()=>setView(t.dataset.viewTab));

// ---- Larger photo viewer (for showing products to KOLs) ----
let viewerReturnFocus=null;
function openViewer(id){const x=byId(id);if(!x||!x.image)return;viewerReturnFocus=document.activeElement;
  $('viewerImg').src=x.image;$('viewerImg').alt=x.name||'Product image';$('viewerTitle').textContent=x.name||'Untitled product';
  $('viewerSub').textContent=[x.sku&&`SKU ${x.sku}`,x.category,x.gender,x.price!==''&&x.price!=null?money(x.price):'',sized(x)&&sizesText(x)?`Sizes ${sizesText(x)}`:''].filter(Boolean).join(' · ');
  $('viewer').hidden=false;$('viewerClose').focus()}
function closeViewer(){if($('viewer').hidden)return;$('viewer').hidden=true;$('viewerImg').removeAttribute('src');viewerReturnFocus?.focus?.()}
$('viewerClose').onclick=closeViewer;$('viewer').addEventListener('click',e=>{if(e.target===$('viewer'))closeViewer()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeViewer()});

// ---- KOL Seeding ----
const seedingGrid=$('seedingGrid');let seedingStatus='All',seedingSort='sent-desc';
function seedById(id){return seeding.find(r=>r.id===id)}
// Show the product's current name when it still exists; otherwise the name saved when it was sent.
function seedProduct(r){return r.productId?byId(r.productId):null}
function seedProductLabel(r){const p=seedProduct(r);const name=p?p.name:r.productName,sku=p?p.sku:r.productSku;return [name||'Untitled product',sku&&`(${sku})`].filter(Boolean).join(' ')}
function productOptionLabel(p){return [p.name||'Untitled product',p.sku&&`(${p.sku})`].filter(Boolean).join(' ')}
function statusClass(s){return s==='Returned'?'status-returned':s==='Kept by KOL'?'status-kept':'status-out'}
function renderSeeding(){
  $('seedingTabCount').textContent=seeding.length?`(${seeding.length})`:'';
  const qty=r=>Number(r.quantity)||0;
  $('seedingCount').textContent=seeding.length.toLocaleString('en-US');
  $('seedingOut').textContent=seeding.filter(r=>r.returnStatus==='Not returned').reduce((a,r)=>a+qty(r),0).toLocaleString('en-US');
  $('seedingReturned').textContent=seeding.filter(r=>r.returnStatus==='Returned').reduce((a,r)=>a+qty(r),0).toLocaleString('en-US');
  const f=$('seedingFilters');f.innerHTML='';const row=document.createElement('div');row.className='filter-row';row.innerHTML='<span class="filter-label">RETURN</span>';
  ['All',...returnStatuses].forEach(st=>{const b=document.createElement('button');b.className='filter'+(seedingStatus===st?' active':'');b.textContent=st;b.onclick=()=>{seedingStatus=st;renderSeeding()};row.appendChild(b)});f.appendChild(row);
  if(view!=='seeding')return;
  const q=$('seedingSearch').value.trim().toLowerCase();
  const shown=seeding.filter(r=>(seedingStatus==='All'||r.returnStatus===seedingStatus)&&(!q||[r.kolName,seedProductLabel(r),r.productName,r.size,r.notes,r.returnStatus,fmtDate(r.dateSent),fmtDate(r.returnDate)].some(v=>String(v??'').toLowerCase().includes(q))));
  const byDate=(a,b)=>(!a.dateSent-!b.dateSent)||String(b.dateSent||'').localeCompare(String(a.dateSent||''));
  const sorters={'sent-desc':byDate,'sent-asc':(a,b)=>(!a.dateSent-!b.dateSent)||String(a.dateSent||'').localeCompare(String(b.dateSent||'')),'kol-asc':(a,b)=>String(a.kolName||'').localeCompare(String(b.kolName||'')),'kol-desc':(a,b)=>String(b.kolName||'').localeCompare(String(a.kolName||''))};
  shown.sort(sorters[seedingSort]);
  $('seedingVisibleCount').textContent=`${shown.length} ${shown.length===1?'record':'records'}`;
  if(!shown.length){seedingGrid.innerHTML=`<div class="empty">${seeding.length?'No matching KOL Seeding records found.':'No KOL Seeding records yet. Click “Add Seeding Record” to log a product sent to a creator.'}</div>`;return}
  const productList=[...items].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
  seedingGrid.innerHTML=`<div class="table-scroll"><table class="inventory-table seeding-table"><thead><tr><th>Photo</th><th>KOL / Creator</th><th>Product</th><th>Size</th><th>Qty Sent</th><th>Date Sent</th><th>Return Status</th><th>Return Date</th><th>Notes</th><th></th></tr></thead><tbody>${shown.map(r=>{const id=esc(r.id),p=seedProduct(r);
    const missing=!p&&r.productName?`<option value="" selected>${esc(seedProductLabel(r))} — deleted</option>`:'';
    return `<tr><td><div class="table-photo seeding-photo">${p&&p.image?`<button class="photo-view" type="button" data-view="${esc(p.id)}" title="View larger photo" aria-label="View larger photo"><img src="${esc(p.image)}" alt="${esc(p.name||'Product image')}" loading="lazy"></button>`:'<div class="photo-placeholder">—</div>'}</div></td>
<td><input class="table-input" data-sid="${id}" data-sk="kolName" placeholder="KOL / creator name" aria-label="KOL or creator name" value="${esc(r.kolName)}"></td>
<td><select class="table-select seeding-product" data-sid="${id}" data-sk="productId" aria-label="Product">${missing||'<option value="">Select product</option>'}${productList.map(x=>`<option value="${esc(x.id)}" ${r.productId===x.id?'selected':''}>${esc(productOptionLabel(x))}</option>`).join('')}</select>${missing?'<div class="deleted-tag">Product no longer in inventory</div>':''}</td>
<td>${sized(p)||r.size?`<select class="table-select" data-sid="${id}" data-sk="size" aria-label="Size"><option value="">—</option>${sizes.map(z=>`<option ${r.size===z?'selected':''}>${z}</option>`).join('')}</select>`:'<span class="muted">—</span>'}</td>
<td><input class="table-input" data-sid="${id}" data-sk="quantity" type="number" min="0" step="1" placeholder="0" aria-label="Quantity sent" value="${esc(r.quantity)}"></td>
<td><input class="table-input date-input" data-sdate="${id}" data-sk="dateSent" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yy" aria-label="Date sent (DD/MM/YY)" value="${esc(fmtDate(r.dateSent))}"></td>
<td><select class="table-select status-select ${statusClass(r.returnStatus)}" data-sid="${id}" data-sk="returnStatus" aria-label="Return status">${returnStatuses.map(st=>`<option ${r.returnStatus===st?'selected':''}>${st}</option>`).join('')}</select></td>
<td><input class="table-input date-input" data-sdate="${id}" data-sk="returnDate" type="text" inputmode="numeric" maxlength="10" placeholder="dd/mm/yy" aria-label="Return date (DD/MM/YY)" value="${esc(fmtDate(r.returnDate))}"></td>
<td><textarea class="table-description" data-sid="${id}" data-sk="notes" placeholder="Notes" aria-label="Notes">${esc(r.notes)}</textarea></td>
<td><div class="row-actions">${r.returnStatus==='Not returned'?`<button class="mark-returned" data-return="${id}" title="Mark as returned today">Mark returned</button>`:''}<button class="delete" data-sdelete="${id}" aria-label="Delete seeding record" title="Delete">×</button></div></td></tr>`}).join('')}</tbody></table></div>`;
}
async function saveSeeding(id,field,value,old){
  const r=seedById(id);if(!r)return;
  try{const {record,entry}=await api(`/api/seeding/${encodeURIComponent(id)}`,{method:'PATCH',body:{field,value}});const cur=seedById(id);if(cur)Object.assign(cur,record);addHistory(entry);scheduleRender()}
  catch(err){const cur=seedById(id);if(cur)Object.assign(cur,old);fail(err);scheduleRender()}
}
seedingGrid.addEventListener('focusin',e=>{const el=e.target;if(el.matches('[data-sid][data-sk]'))el.dataset.beforeValue=String(seedById(el.dataset.sid)?.[el.dataset.sk]??'')});
seedingGrid.addEventListener('input',e=>{const el=e.target;if(!el.matches('[data-sid][data-sk]')||el.tagName==='SELECT')return;const r=seedById(el.dataset.sid);if(r)r[el.dataset.sk]=el.value});
seedingGrid.addEventListener('change',e=>{const el=e.target;
  if(el.matches('[data-sdate]')){const id=el.dataset.sdate,k=el.dataset.sk,r=seedById(id);if(!r)return;const old=r[k]||'',value=parseDate(el.value);
    if(value===null){notify('Enter the date as DD/MM/YY');el.value=fmtDate(old);return}el.value=fmtDate(value);if(value===old)return;r[k]=value;saveSeeding(id,k,value,{[k]:old});return}
  if(!el.matches('[data-sid][data-sk]'))return;
  const id=el.dataset.sid,k=el.dataset.sk,r=seedById(id);if(!r)return;const old=el.dataset.beforeValue??String(r[k]??''),value=el.value;el.dataset.beforeValue=value;
  if(String(old)===String(value)&&el.tagName!=='SELECT')return;
  const prev={...r};r[k]=value;if(el.tagName==='SELECT')scheduleRender();saveSeeding(id,k,value,prev);
});
seedingGrid.addEventListener('click',async e=>{
  const v=e.target.closest('[data-view]');if(v){openViewer(v.dataset.view);return}
  const ret=e.target.closest('[data-return]');if(ret){const id=ret.dataset.return,r=seedById(id);if(!r)return;const prev={...r};r.returnStatus='Returned';renderSeeding();saveSeeding(id,'returnStatus','Returned',prev);notify('Marked as returned');return}
  const d=e.target.closest('[data-sdelete]');if(!d)return;const id=d.dataset.sdelete,r=seedById(id);if(!r)return;
  if(!confirm(`Delete the seeding record for “${r.kolName||'Unnamed KOL'}” for everyone?`))return;
  try{const {entry}=await api(`/api/seeding/${encodeURIComponent(id)}`,{method:'DELETE'});seeding=seeding.filter(x=>x.id!==id);addHistory(entry);renderSeeding();notify('Seeding record deleted')}catch(err){fail(err)}
});
$('seedingSearch').addEventListener('input',renderSeeding);$('seedingSort').addEventListener('change',e=>{seedingSort=e.target.value;renderSeeding()});
$('addSeedingBtn').onclick=async()=>{const btn=$('addSeedingBtn');btn.disabled=true;
  try{const {record,entry}=await api('/api/seeding',{method:'POST',body:{quantity:1}});seeding.unshift(record);addHistory(entry);
    if(seedingSort!=='sent-desc'){seedingSort='sent-desc';$('seedingSort').value='sent-desc'}$('seedingSearch').value='';renderSeeding();seedingGrid.querySelector(`[data-sid="${CSS.escape(record.id)}"][data-sk="kolName"]`)?.focus()}
  catch(err){fail(err)}finally{btn.disabled=false}};

// ---- Shared Canva link under the heading ----
let canvaUrl='',canvaEditing=false;
function setCanva(url){if(canvaEditing)return;canvaUrl=String(url||'');renderCanva()}
function renderCanva(){const bar=$('canvaBar');
  if(canvaEditing){bar.innerHTML=`<form class="canva-form" id="canvaForm"><input id="canvaInput" type="url" inputmode="url" autocomplete="off" placeholder="Paste the Canva link (https://www.canva.com/…)" aria-label="Canva link" value="${esc(canvaUrl)}"><button class="button primary" type="submit">Save</button><button class="button" type="button" id="canvaCancel">Cancel</button></form>`;
    const input=$('canvaInput');input.focus();input.select();
    input.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();canvaEditing=false;renderCanva()}});
    $('canvaCancel').onclick=()=>{canvaEditing=false;renderCanva()};
    $('canvaForm').onsubmit=async e=>{e.preventDefault();const btn=e.target.querySelector('[type=submit]');btn.disabled=true;
      try{const {canvaUrl:saved,entry}=await api('/api/settings/canva',{method:'PUT',body:{value:input.value}});canvaUrl=saved;canvaEditing=false;addHistory(entry);renderCanva();notify(saved?'Canva link saved':'Canva link removed')}
      catch(err){fail(err);btn.disabled=false;input.focus()}};
    return}
  bar.innerHTML=canvaUrl?`<a class="canva-link" href="${esc(canvaUrl)}" target="_blank" rel="noopener noreferrer" title="${esc(canvaUrl)}">Canva ↗</a><button class="canva-edit" type="button" id="canvaEdit" aria-label="Edit Canva link">Edit</button>`:`<button class="canva-edit" type="button" id="canvaEdit">＋ Add Canva link</button>`;
  $('canvaEdit').onclick=()=>{canvaEditing=true;renderCanva()}}
renderCanva();

let timer;function notify(m){const t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(timer);timer=setTimeout(()=>t.classList.remove('show'),2600)}
start();
