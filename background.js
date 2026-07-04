/* ============================================================
 * MarkPrompt — background service worker (v2)
 *
 * 职责:
 *  1. chrome.action.onClicked → 通知 content script(无 default_popup,点击直接触发)
 *  2. 通过 OffscreenCanvas + Path2D 在 service worker 内渲染 lucide 图标,
 *     根据 content script 的状态在 message-circle-plus(空闲) / circle-stop(注释中) 间切换
 *  3. captureVisibleTab 截图 + 下载
 * ============================================================ */

// ---- 颜色 ----
const COLOR_IDLE = '#2563eb';   // 空闲:蓝色 message-circle-plus
const COLOR_ACTIVE = '#ef4444'; // 注释中:红色 circle-stop

// ---- lucide 图标描述(24x24 viewBox) ----
const ICON_PLUS = {
  fill: false,
  shapes: [
    // 气泡轮廓
    { t: 'path', d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719' },
    // 气泡里的 +
    { t: 'path', d: 'M8 12h8' },
    { t: 'path', d: 'M12 8v8' },
  ],
};
const ICON_STOP = {
  fill: false,
  shapes: [
    { t: 'circle', cx: 12, cy: 12, r: 10 },
    { t: 'rect', x: 9, y: 9, w: 6, h: 6, rx: 1 },
  ],
};

// ---- 渲染单个尺寸的 ImageData ----
function renderIcon(spec, size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const scale = size / 24;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of spec.shapes) {
    ctx.beginPath();
    if (s.t === 'path') {
      const p = new Path2D(s.d);
      if (spec.fill) ctx.fill(p);
      ctx.stroke(p);
    } else if (s.t === 'circle') {
      ctx.arc(s.cx, s.cy, s.r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.t === 'rect') {
      const r = s.rx || 0;
      const { x, y, w, h } = s;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.stroke();
    }
  }
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

let iconCache = null;
function getIconCache() {
  if (!iconCache) {
    const sizes = [16, 32, 48, 128];
    const idle = {};
    const active = {};
    for (const s of sizes) {
      idle[s] = renderIcon(ICON_PLUS, s, COLOR_IDLE);
      active[s] = renderIcon(ICON_STOP, s, COLOR_ACTIVE);
    }
    iconCache = { idle, active };
  }
  return iconCache;
}

function setIconState(state) {
  try {
    const c = getIconCache();
    const map = state === 'annotating' ? c.active : c.idle;
    chrome.action.setIcon({ imageData: map });
  } catch (e) {
    // 渲染失败时静默(不影响核心功能)
  }
}

// 启动时复位为空闲图标
setIconState('idle');

// ---- 工具栏图标点击 → 通知 content script ----
// content script 仅在页面加载时(document_idle)自动注入;对于扩展重载前已打开、
// bfcache 恢复等未注入 content script 的 tab,sendMessage 会抛
// "Receiving end does not exist"。此时用 chrome.scripting 程序化注入后再发一次,
// 避免"有时候点图标没反应"。chrome:// 等内置页面仍无法注入,忽略。
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    return true;
  } catch (e) {
    return false; // 内置页面 / 无权限
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'wdbg-action-clicked' });
  } catch (e) {
    // content script 未注入 → 程序化注入后重试一次
    const ok = await ensureContentScript(tab.id);
    if (!ok) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'wdbg-action-clicked' });
    } catch (e2) {
      // 仍失败则放弃(注入竞态等极端情况)
    }
  }
});

// ---- content script 消息 ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'wdbg-set-icon') {
    setIconState(msg.state);
    return false;
  }

  if (msg.type === 'wdbg-capture-visible') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // 异步
  }

  if (msg.type === 'wdbg-download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true;
  }

  return false;
});
