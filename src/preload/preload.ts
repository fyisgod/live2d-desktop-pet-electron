import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pet', {
  /** 自检时把渲染指标交给主进程 */
  reportMetrics: (m: unknown): void => ipcRenderer.send('pet:metrics', m),
  log: (msg: unknown): void => ipcRenderer.send('pet:log', typeof msg === 'string' ? msg : JSON.stringify(msg)),
  /** 点击穿透开关（整窗级别；逐像素由 renderer 的命中网格决定何时切换） */
  setIgnoreMouse: (v: boolean): Promise<boolean> => ipcRenderer.invoke('pet:set-ignore-mouse', v),
  dragStart: (): void => ipcRenderer.send('pet:drag-start'),
  dragEnd: (): void => ipcRenderer.send('pet:drag-end'),
  /** 指针按下/抬起交给主进程判定"拖拽还是点击"（不依赖 mousemove，实测注入/异常情况下 mousemove 可能不到达） */
  pointerDown: (): void => ipcRenderer.send('pet:pointer-down'),
  pointerUp: (): void => ipcRenderer.send('pet:pointer-up'),
  /** 主进程判定为"点击"后回调（用于播放互动动作） */
  onClicked: (cb: (p: { x: number; y: number }) => void): void => {
    ipcRenderer.on('pet:clicked', (_e, p) => cb(p));
  },
  /** M2：设置下发（帧率上限 / 互斥组 / 缩放 / 遮挡层） */
  onSettings: (cb: (s: unknown) => void): void => {
    ipcRenderer.on('pet:settings', (_e, s) => cb(s));
  },
  /** M2：把当前外观存成预设（渲染进程导出参数 → 主进程落盘） */
  savePreset: (name: string, preset: Record<string, number>): void =>
    ipcRenderer.send('pet:save-preset', { name, preset }),
  /** M2：回报当前外观/已开开关（供"复制当前外观"用） */
  reportPreset: (p: { preset: Record<string, number>; activeSwitches: string[]; restore: unknown }): void =>
    ipcRenderer.send('pet:preset-report', p),
  /** 右键：弹出原生菜单（动作/表情/退出），选择结果通过 onAction 回传 */
  openMenu: (): void => ipcRenderer.send('pet:open-menu'),
  onAction: (cb: (a: { kind: string; id: string }) => void): void => {
    ipcRenderer.on('pet:action', (_e, a) => cb(a));
  },
  /** 自检用：打开穿透决策（交互模式下本来就是开的） */
  onEnablePassthrough: (cb: () => void): void => {
    ipcRenderer.on('pet:enable-passthrough', () => cb());
  },
  /** 把像素级命中掩码交给主进程（主进程按光标轮询决定是否穿透，不依赖 forwarded mousemove） */
  sendHitMask: (m: { cols: number; rows: number; bits: Uint8Array }): void =>
    ipcRenderer.send('pet:hit-mask', m),
  /** 报告一次模型上的真实点击（用于验证"模型处点击不被穿透"） */
  reportClick: (x: number, y: number): void => ipcRenderer.send('pet:click', { x, y }),
  quit: (): void => ipcRenderer.send('pet:quit'),
});

// 首次运行向导 / 导入模型
contextBridge.exposeInMainWorld('wizard', {
  pickModel: (): Promise<{ canceled?: boolean; ok?: boolean; message?: string }> =>
    ipcRenderer.invoke('wizard:pick-model'),
  onProgress: (cb: (p: { stage: string; detail?: string }) => void): void => {
    ipcRenderer.on('wizard:progress', (_e, p) => cb(p));
  },
  quit: (): void => ipcRenderer.send('wizard:quit'),
});
