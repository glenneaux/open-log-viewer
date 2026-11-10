window.openLogDesktop?.onFiles(files=>{
 const input=document.getElementById('file-input'),transfer=new DataTransfer();
 for(const file of files)transfer.items.add(new File([file.bytes],file.name,{lastModified:file.lastModified}));
 input.files=transfer.files;
 input.dispatchEvent(new Event('change',{bubbles:true}));
});
