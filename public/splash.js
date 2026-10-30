// Startup splash: shows the real phase the native shell reports via window.deasPhase(key).
(function(){
 var text={
  en:{shell:'Starting DEAS…',interface:'Loading the interface…',restore:'Restoring your workspace…'},
  de:{shell:'DEAS startet…',interface:'Oberfläche wird geladen…',restore:'Arbeitsbereich wird wiederhergestellt…'},
  fr:{shell:'Démarrage de DEAS…',interface:'Chargement de l’interface…',restore:'Restauration de votre espace de travail…'},
  ja:{shell:'DEAS を起動しています…',interface:'インターフェースを読み込んでいます…',restore:'ワークスペースを復元しています…'},
  tr:{shell:'DEAS başlatılıyor…',interface:'Arayüz yükleniyor…',restore:'Çalışma alanınız geri yükleniyor…'},
  zh:{shell:'正在启动 DEAS…',interface:'正在加载界面…',restore:'正在恢复工作区…'}
 };
 var saved='';try{saved=localStorage.getItem('deas.locale.v1')||'';}catch(e){}
 var lang=(saved||navigator.language||'en').slice(0,2);if(!text[lang])lang='en';
 document.documentElement.lang=lang;
 var phase=document.getElementById('phase');
 window.deasPhase=function(key){if(text[lang][key])phase.textContent=text[lang][key];};
 window.deasPhase('shell');
 // Owner artwork slot: animated APNG, then WebP, then static PNG; reduced motion uses the PNG only. Missing files stay hidden.
 var still=matchMedia('(prefers-reduced-motion: reduce)').matches;
 var files=still?['splash/catgirl.png']:['splash/catgirl.apng','splash/catgirl.webp','splash/catgirl.png'];
 var art=document.getElementById('art');
 art.onload=function(){art.hidden=false;};
 art.onerror=function(){files.shift();if(files.length)art.src=files[0];};
 art.src=files[0];
})();
