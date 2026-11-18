localStorage.setItem('deas.locale.v1', LOCALE);
window.isTauri=true;window.__calls=[];
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,convertFileSrc:()=>'/fixture.png',invoke:async(c,a)=>{
 __calls.push(c);
 if(c==='plugin:event|listen')return 1;
 if(c==='plugin:event|unlisten')return null;
 if(c==='native_media_list')return {path:a.path,parent:null,entries:[...Array.from({length:40},(_,i)=>({name:'Folder '+i,path:a.path+'/folder'+i,kind:'directory',symlink:false})),...Array.from({length:40},(_,i)=>({name:'Picture '+i+'.png',path:a.path+'/picture'+i+'.png',kind:'file',media:'image',size:100,modified:1,symlink:false}))],truncated:false};
 if(c==='native_media_thumbnail'||c==='native_media_reference_thumbnail')return '/fixture.png';
 throw Error('Unexpected fixture IPC: '+c);
}};
