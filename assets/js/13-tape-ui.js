(()=>{
const $=s=>document.querySelector(s),rate=$('#rate');
const card=rate.closest('.card');document.querySelector('#audioRows').closest('.card').after(card);card.classList.add('tape-card');card.querySelector('h2').textContent='Tape speed';
$('#rateAuto').hidden=true;$('#pitchKeep').closest('label').hidden=true;$('#syncState').hidden=true;
const num=document.createElement('input');num.type='text';num.setAttribute('role','spinbutton');num.setAttribute('aria-valuemin','0.5');num.setAttribute('aria-valuemax','1.5');num.autocomplete='off';num.id='tapeNumber';num.min='.5';num.max='1.5';num.step='.01';num.value='1.00';num.inputMode='decimal';num.setAttribute('aria-label','Kecepatan tape');rate.closest('.range-row').append(num);
const stepper=document.createElement('div');stepper.className='tape-stepper';num.before(stepper);stepper.append(num);for(const [text,delta] of [['−',-.01],['+',.01]]){const b=document.createElement('button');b.type='button';b.className='tape-step';b.textContent=text;b.setAttribute('aria-label',delta<0?'Kurangi kecepatan 0,01':'Tambah kecepatan 0,01');b.onclick=()=>{if(!num.disabled)set(Math.round((Number(rate.value)+delta)*100)/100);};if(delta<0)stepper.prepend(b);else stepper.append(b);}num.addEventListener('keydown',e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();set(Number(rate.value)+(e.key==='ArrowUp'?.01:-.01));num.value=Number(rate.value).toFixed(2);}if(e.key==='Enter')num.blur();if(e.key==='Escape'){num.value=Number(rate.value).toFixed(2);num.blur();}});
const badge=document.createElement('span');badge.className='tape-mode';card.querySelector('.card-head').append(badge);

const presets=document.createElement('div');presets.className='tape-presets';for(const n of [.5,.75,1,1.25,1.5]){const b=document.createElement('button');b.type='button';b.className='btn sm';b.textContent=n+'×';b.onclick=()=>set(n);presets.append(b);}rate.closest('label').after(presets);
function set(n){if(!Number.isFinite(n))return;rate.value=String(Math.min(1.5,Math.max(.5,n)));rate.dispatchEvent(new Event('input',{bubbles:true}));sync();}
num.addEventListener('input',()=>{const n=Number(num.value.replace(',','.'));if(n>=.5&&n<=1.5)set(n);});num.addEventListener('change',()=>{const n=Number(num.value.replace(',','.'));set(Number.isFinite(n)&&num.value.trim()?n:Number(rate.value));num.value=Number(rate.value).toFixed(2);});
rate.addEventListener('input',sync);document.addEventListener('am-tape-change',sync);
const summary=document.createElement('div');summary.id='exportSummary';summary.setAttribute('aria-live','polite');$('#pane-ekspor .card-head').after(summary);
let summaryLast='';function sync(){if(document.activeElement!==num)num.value=Number(rate.value).toFixed(2);num.setAttribute('aria-valuenow',rate.value);badge.textContent=Number(rate.value)<1?'Slowed':Number(rate.value)>1?'Sped up':'Normal';const r=Number(rate.value)||1,d=window.__AMRenderer?.scene?.totalTime||0;const summaryHTML='<span class="eyebrow">HASIL EKSPOR</span><strong>'+ (d/1000/r).toFixed(2)+' detik <small>· '+r.toFixed(2)+'× tape</small></strong><span>'+$('#expRes').selectedOptions[0]?.textContent+' · '+$('#expFps').selectedOptions[0]?.textContent+' fps</span>';if(summaryHTML!==summaryLast){summary.innerHTML=summaryHTML;summaryLast=summaryHTML;}presets.querySelectorAll('button').forEach(b=>b.classList.toggle('selected',parseFloat(b.textContent)===r));}
$('#pane-ekspor').addEventListener('change',sync);setInterval(()=>{const busy=$('#expStart').disabled;rate.disabled=busy;num.disabled=busy;stepper.querySelectorAll('button').forEach(b=>b.disabled=busy);presets.querySelectorAll('button').forEach(b=>b.disabled=busy);sync();},500);
const body=$('#settingsDlg .dlg-body'),cards=[...body.querySelectorAll(':scope>.card')];
for(const card of cards.slice(2)){const d=document.createElement('details');d.className='settings-details';const title=document.createElement('summary');title.textContent=card.querySelector('h2').textContent;card.before(d);d.append(title,card);card.querySelector('.card-head').hidden=true;}

$('#fpsTarget').querySelectorAll('option').forEach(o=>{if(o.value==='60')o.textContent='60 fps · gerakan halus';if(o.value==='30')o.textContent='30 fps · seimbang';});
const exp=$('#pane-ekspor');exp.querySelector('.card-head h2').textContent='Ekspor video';
window.AMTape={set,get:()=>Number(rate.value)||1};sync();
})();
