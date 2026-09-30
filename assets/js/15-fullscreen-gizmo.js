(()=>{
const st=document.querySelector('#stage'),b=document.createElement('button');b.id='m33GizmoFS';b.type='button';b.textContent='Gizmo';b.setAttribute('aria-label','Tampilkan gizmo fullscreen');b.setAttribute('aria-pressed',String(!window.__AMGizmoOff));st.append(b);
b.onclick=e=>{e.preventDefault();e.stopPropagation();const old=document.querySelector('#m30Gizmo');if(old)old.click();if(window.AMX)AMX.state.dirty=true;const r=window.__AMRenderer;if(!window.__AMGizmoOff&&r?.scene)r.renderAt(r.timeMs);sync();};
function sync(){b.setAttribute('aria-pressed',String(!window.__AMGizmoOff));}
document.addEventListener('fullscreenchange',()=>{sync();if(window.AMX){AMX.state.dirty=true;AMX.state.lastPass=-1;}});document.addEventListener('click',e=>{if(e.target.id==='m30Gizmo')sync();});
const box=document.createElement('div');box.id='m33MediaSummary';const pane=document.querySelector('#pane-media .card');pane.querySelector('#mediaRows').before(box);let last='';
setInterval(()=>{const a=window.__AMMediaAudit;if(!a)return;const text=a.imageLayers+' layer gambar · '+a.identifiedImageSlots+' gambar'+(a.unresolvedImageLayers?' · '+a.unresolvedImageLayers+' belum teridentifikasi':'');if(text!==last){box.textContent=text;last=text;}},500);
})();