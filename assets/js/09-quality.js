(()=>{
const levels=[360,480,720,1080,1440,2160];
function start(){
 const bar=document.querySelector('.amx-bar'),q=document.querySelector('#quality');
 if(!bar||!q)return;
 let select=document.getElementById('previewQuality');
 if(!select){select=document.createElement('select');select.id='previewQuality';select.setAttribute('aria-label','Resolusi pratinjau');select.title='Kualitas pratinjau (tinggi kanvas); bukan ukuran ekspor';select.innerHTML=levels.map(n=>`<option value="${n}">${n}p${n===720?' · Default':''}</option>`).join('')+'<option value="auto">Otomatis</option>';bar.append(select);
 select.addEventListener('change',()=>{const c=document.querySelector('[data-comp="render"]');if(c){c.value=select.value;c.dispatchEvent(new Event('change',{bubbles:true}));}else{q.value=select.value;q.dispatchEvent(new Event('change',{bubbles:true}));}});
 q.addEventListener('change',()=>{select.value=q.value});
 }
 select.value=q.value;
 const comp=document.querySelector('[data-comp="render"]');if(comp&&!comp.dataset.m29){const value=comp.value;comp.innerHTML=levels.map(n=>`<option value="${n}">${n}p${n===720?' · Default':''}</option>`).join('')+'<option value="auto">Otomatis</option>';comp.value=value||q.value;comp.dataset.m29='1';}
 const l=document.querySelector('#tl-fit');if(l)l.textContent='Pas';
 const g=document.querySelector('#tl-groups');if(g)g.textContent='Grup';
 const b=document.querySelector('#tl-bm');if(b)b.textContent='Penanda';
}
start();const ob=new MutationObserver(start);ob.observe(document.querySelector('#stage'),{childList:true});
// Hide empty inspector, not populated layer details.
const info=document.getElementById('layer-info');if(info){const check=()=>info.classList.toggle('m29-empty',!info.querySelector('.amx-sec,.amx-inspector,.layer-info-name')&&info.textContent.trim().startsWith('Ketuk blok'));new MutationObserver(check).observe(info,{childList:true,subtree:true});check();}
})();
