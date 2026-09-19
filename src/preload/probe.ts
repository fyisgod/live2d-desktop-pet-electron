import { contextBridge, ipcRenderer } from 'electron';

// 验证用"探针"窗口：垫在宠物窗口下方，只有点击真的穿透过去时才会被计到
contextBridge.exposeInMainWorld('probe', {
  click: (x: number, y: number): void => ipcRenderer.send('probe:click', { x, y }),
});
