const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('openLogDesktop',{
 onFiles(callback){
  const listener=(_event,files)=>callback(files);
  ipcRenderer.on('open-log-files',listener);
  ipcRenderer.send('viewer-ready');
  return ()=>ipcRenderer.removeListener('open-log-files',listener);
 }
});
