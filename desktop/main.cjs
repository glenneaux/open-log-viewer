const { app, BrowserWindow, Menu, dialog, ipcMain, protocol } = require("electron");
const path = require("node:path");
const fs=require('node:fs');
let mainWindow;
protocol.registerSchemesAsPrivileged([{scheme:'logviewer',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
let ready=false,pending=[];
const accepted=/\.(csv|tsv|txt|log|msl|vbo|gz|hlgzip|mlg|ld)$/i;
function queueArgs(args){pending.push(...args.filter(p=>accepted.test(p)&&path.isAbsolute(p)));flush();}
async function flush(){
 if(!ready||!mainWindow||!pending.length)return;
 const paths=pending.splice(0),files=[];
 for(const filename of paths)try{const stat=await fs.promises.stat(filename);if(!stat.isFile())continue;files.push({name:path.basename(filename),lastModified:stat.mtimeMs,bytes:await fs.promises.readFile(filename)});}catch(error){await dialog.showMessageBox(mainWindow,{type:'error',message:'Cannot open log',detail:error.message});}
 if(files.length)mainWindow.webContents.send('open-log-files',files);
}
app.setName("Open Log Viewer");
if(!app.requestSingleInstanceLock())app.quit();
else {
app.on('second-instance',(_event,args)=>{queueArgs(args);mainWindow?.restore();mainWindow?.focus();});
app.on('open-file',(event,file)=>{event.preventDefault();pending.push(file);flush();});
app.whenReady().then(async () => {
  const origin = 'logviewer://app';
  const webRoot=path.resolve(__dirname,'../web');
  protocol.handle('logviewer',async request=>{
    try{
      const url=new URL(request.url);
      if(url.hostname!=='app')return new Response('Not found',{status:404});
      const filename=path.resolve(webRoot,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!filename.startsWith(webRoot+path.sep))return new Response('Forbidden',{status:403});
      const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png'};
      return new Response(await fs.promises.readFile(filename),{headers:{'Content-Type':types[path.extname(filename)]||'application/octet-stream'}});
    }catch{return new Response('Not found',{status:404});}
  });
  let saved={};const statePath=path.join(app.getPath('userData'),'window-state.json');
  try{saved=JSON.parse(fs.readFileSync(statePath,'utf8'));}catch{}
  mainWindow = new BrowserWindow({
    show: process.env.OPEN_LOG_VIEWER_TEST !== "1",
    width: Number.isFinite(saved.width)?Math.max(800,saved.width):1440,
    height: Number.isFinite(saved.height)?Math.max(600,saved.height):960,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload:path.join(__dirname,'preload.cjs'),
    },
  });
  mainWindow.on('close',()=>{try{fs.writeFileSync(statePath,JSON.stringify({...mainWindow.getNormalBounds(),maximized:mainWindow.isMaximized()}));}catch{}});
  mainWindow.webContents.on('did-start-loading',()=>{ready=false;});
  ipcMain.on('viewer-ready',event=>{if(event.sender!==mainWindow.webContents||event.senderFrame!==mainWindow.webContents.mainFrame)return;ready=true;flush();});
  queueArgs(process.argv.slice(app.isPackaged?1:2));
  if(saved.maximized)mainWindow.maximize();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(origin+'/')) event.preventDefault();
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Open log…",
            accelerator: "CmdOrCtrl+O",
            click: () =>
              mainWindow.webContents.executeJavaScript(
                "document.getElementById('file-input').click()",
              ),
          },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "togglefullscreen" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "resetZoom" },
        ],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "About",
            click: () =>
              dialog.showMessageBox(mainWindow, {
                message: "Open Log Viewer",
                detail:
                  "GPL-3.0 port. See README.md for verified features and remaining work.",
              }),
          },
        ],
      },
    ]),
  );
  await mainWindow.loadURL(origin+'/index.html');
});
app.on("window-all-closed", () => app.quit());
}
