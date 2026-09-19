/**
 * 首次运行向导的页面脚本（纯静态，不需要打包步骤）。
 * 通过 preload 暴露的 wizard API 与主进程通信：选目录 → 导入 → 显示进度 → 自动进桌宠。
 */
export {}; // 让本文件成为模块，下面的 declare global 才能合法增强 Window

declare global {
  interface Window {
    wizard: {
      pickModel: () => Promise<{ canceled?: boolean; ok?: boolean; message?: string }>;
      onProgress: (cb: (p: { stage: string; detail?: string }) => void) => void;
      quit: () => void;
    };
  }
}

const pickBtn = document.getElementById('pick') as HTMLButtonElement | null;
const quitBtn = document.getElementById('quit') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLDivElement | null;

function setStatus(text: string, kind?: 'ok' | 'err'): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

window.wizard.onProgress(({ stage, detail }) => {
  setStatus(`${stage}${detail ? '\n' + detail : ''}`);
});

pickBtn?.addEventListener('click', async () => {
  pickBtn.disabled = true;
  setStatus('请在弹出的对话框里选择模型文件夹…');
  try {
    const res = await window.wizard.pickModel();
    if (res.canceled) {
      setStatus('已取消，可以再试一次。');
    } else if (res.ok) {
      setStatus(`${res.message}\n正在启动桌宠…`, 'ok');
    } else {
      setStatus(`导入失败：${res.message}`, 'err');
    }
  } catch (e) {
    setStatus(`导入失败：${String(e)}`, 'err');
  } finally {
    pickBtn.disabled = false;
  }
});

quitBtn?.addEventListener('click', () => window.wizard.quit());
