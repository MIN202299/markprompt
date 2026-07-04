/* ============================================================
 * MarkPrompt — content script (v2)
 *
 * 交互模型(已移除悬浮气泡,改为工具栏图标触发):
 *  - 点击工具栏图标(空闲态 message-circle-plus)→ 页面右上角弹出下拉菜单:
 *      开始注释 / 历史记录 / 清空记录
 *  - 「开始注释」→ 图标切为 circle-stop,鼠标变为填充气泡光标;
 *      页面点击 → 在点击位置放置「填充气泡 + 序号」标记,标记右侧出现评论输入框
 *      (placeholder "添加评论...",单行,末尾 check 按钮,Enter 提交 / Esc 取消,空内容提交时摇晃)
 *  - 注释中再次点击工具栏图标 → 停止注释,生成全页截图 + Prompt,
 *      以右侧抽屉展示本次注释详情(复制 Prompt / 复制图片 / 下载 / 查看历史记录)
 *  - 「历史记录」→ 右侧抽屉展示历史(支持查看详情 / 删除单条)
 *  - 「清空记录」→ 弹窗确认后清空全部历史
 *  - 历史记录持久化到 chrome.storage.local
 * ============================================================ */

(function () {
  'use strict';

  // 防重复注入守卫:仅当已有实例且其扩展上下文仍然存活时才跳过。
  // 扩展更新/重载后,旧 content script 会变成"孤儿"(chrome.runtime 失效、
  // 收不到消息),但它留在 window 上的标记仍在;若像旧版那样只判断标记,
  // background 的补救注入会被挡住直接 return,导致该标签页永久失效
  // ("点图标没反应,重装才恢复")。因此由新实例接管:清掉残留 UI 后重新初始化。
  if (window.__wdbg_injected__ && typeof window.__wdbg_alive__ === 'function' && window.__wdbg_alive__()) return;
  window.__wdbg_injected__ = true;
  window.__wdbg_alive__ = () => {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  // 清理旧实例(孤儿脚本)残留的 DOM,避免重复 UI
  document.querySelectorAll(
    '.wdbg-menu, .wdbg-hover-box, .wdbg-marker, .wdbg-input-popup, .wdbg-drawer-mask,' +
    ' .wdbg-confirm-mask, .wdbg-loading, .wdbg-toast, .wdbg-lightbox, style[data-wdbg-cursor]'
  ).forEach((n) => n.remove());
  if (document.body) document.body.classList.remove('wdbg-annotating', 'wdbg-commenting');

  // ----------------------- 状态 -----------------------
  const state = {
    annotating: false,   // 注释模式
    pending: null,       // 待输入评论: { number, x, y, el, marker }
    annotations: [],     // 本次会话已完成的注释
  };

  const PAGE_W = () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
  const PAGE_H = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);

  // ----------------------- UI 引用 -----------------------
  let menu, hoverBox;
  let activeDrawer = null;
  let currentLoading = null;

  // ----------------------- lucide SVG(页面内 UI 用) -----------------------
  // 填充气泡(无 +):用于标记和光标
  const BUBBLE_PATH = 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719';
  const BUBBLE_SVG = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
    <path d="${BUBBLE_PATH}" fill="#3b82f6" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
  </svg>`;

  const SVG = {
    plus: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${BUBBLE_PATH}"/><path d="M8 12h8"/><path d="M12 8v8"/></svg>`,
    check: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    download: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`,
    history: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>`,
    x: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  };

  // ----------------------- 工具:消息 -----------------------
  function sendMsg(msg, timeout = 20000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; resolve({ error: 'timeout' }); }, timeout);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (done) return; done = true; clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) resolve({ error: err.message }); else resolve(resp || {});
        });
      } catch (e) { if (done) return; done = true; clearTimeout(timer); resolve({ error: String(e) }); }
    });
  }

  async function captureVisible() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const resp = await sendMsg({ type: 'wdbg-capture-visible' });
      if (resp && resp.dataUrl) return resp.dataUrl;
      await new Promise((r) => setTimeout(r, 600 + attempt * 300));
    }
    throw new Error('截图请求失败(可能触发浏览器限流,请重试)');
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // ----------------------- 工具:选择器 -----------------------
  function cssSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part += '#' + cur.id; parts.unshift(part); break; }
      const cls = Array.from(cur.classList || []).filter((c) => c && !c.startsWith('wdbg-')).join('.');
      if (cls) part += '.' + cls;
      const parent = cur.parentNode;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((s) => s.tagName === cur.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }

  function xPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      parts.unshift(cur.tagName.toLowerCase());
      cur = cur.parentNode;
    }
    return parts.join(' > ');
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ----------------------- 存储 -----------------------
  const STORAGE_KEY = 'wdbg_history_v1';

  async function getHistory() {
    const r = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(r[STORAGE_KEY]) ? r[STORAGE_KEY] : [];
  }
  async function saveHistory(arr) { await chrome.storage.local.set({ [STORAGE_KEY]: arr }); }
  async function addSession(session) { const h = await getHistory(); h.unshift(session); await saveHistory(h); }
  async function deleteSessionById(id) { const h = await getHistory(); await saveHistory(h.filter((s) => s.id !== id)); }
  async function clearAllHistory() { await saveHistory([]); }

  // ----------------------- 自定义光标(填充气泡 SVG) -----------------------
  // 直接使用 icons/icon-filled.svg 的内容作为光标,保持与图标资源一致
  const BUBBLE_CURSOR_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="#3b82f6" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/></svg>';

  function makeBubbleCursorDataUrl() {
    return 'data:image/svg+xml,' + encodeURIComponent(BUBBLE_CURSOR_SVG);
  }

  function injectCursorStyle() {
    let url;
    try { url = makeBubbleCursorDataUrl(); } catch (e) { return; }
    const style = document.createElement('style');
    style.setAttribute('data-wdbg-cursor', ''); // 供孤儿实例接管时清理
    // 注释模式:页面元素使用气泡光标(30x30,与标记同尺寸);
    // 正在输入评论时(wdbg-commenting)整页恢复正常光标;插件自身 UI 始终正常
    style.textContent = `
      body.wdbg-annotating, body.wdbg-annotating * { cursor: url(${url}) 15 15, crosshair !important; }
      body.wdbg-annotating.wdbg-commenting, body.wdbg-annotating.wdbg-commenting * { cursor: auto !important; }
      body.wdbg-annotating .wdbg-ui, body.wdbg-annotating .wdbg-ui * { cursor: auto !important; }
      body.wdbg-annotating .wdbg-ui .wdbg-input-field { cursor: text !important; }
      body.wdbg-annotating .wdbg-ui button, body.wdbg-annotating .wdbg-ui .wdbg-btn { cursor: pointer !important; }
    `;
    document.head.appendChild(style);
  }

  // 评论输入中:整页光标恢复正常;关闭输入框后恢复为气泡光标
  function setCommenting(on) {
    document.body.classList.toggle('wdbg-commenting', !!on);
  }

  // ----------------------- 悬停高亮 -----------------------
  function ensureHoverBox() {
    if (hoverBox) return;
    hoverBox = document.createElement('div');
    hoverBox.className = 'wdbg-hover-box';
    document.body.appendChild(hoverBox);
  }

  function positionHoverBox(el) {
    if (!el || el === document.body || el === document.documentElement) return;
    const r = el.getBoundingClientRect();
    hoverBox.style.top = (r.top + window.scrollY) + 'px';
    hoverBox.style.left = (r.left + window.scrollX) + 'px';
    hoverBox.style.width = r.width + 'px';
    hoverBox.style.height = r.height + 'px';
    hoverBox.style.display = 'block';
  }

  // ----------------------- 标记 -----------------------
  function createMarker(number, x, y) {
    const m = document.createElement('div');
    m.className = 'wdbg-marker';
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    m.innerHTML = `${BUBBLE_SVG}<span class="wdbg-marker-num">${number}</span>`;
    document.body.appendChild(m);
    return m;
  }

  // ----------------------- 注释模式切换 -----------------------
  function setAnnotating(on) {
    state.annotating = on;
    document.body.classList.toggle('wdbg-annotating', on);
    sendMsg({ type: 'wdbg-set-icon', state: on ? 'annotating' : 'idle' });

    if (on) {
      ensureHoverBox();
      closeMenu();
    } else {
      if (hoverBox) hoverBox.style.display = 'none';
      setCommenting(false);
      // 清理待输入状态(标记 + 输入框)
      if (state.pending) {
        if (state.pending.marker) state.pending.marker.remove();
        state.pending = null;
      }
      const pop = document.querySelector('.wdbg-input-popup');
      if (pop) pop.remove();
    }
  }

  function startAnnotation() {
    // 清理上一次会话残留的标记
    clearMarkers();
    setAnnotating(true);
  }

  // ----------------------- 鼠标事件 -----------------------
  function isOurUI(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('.wdbg-ui, .wdbg-marker, .wdbg-hover-box');
  }

  function onMouseMove(e) {
    if (!state.annotating || state.pending) return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    if (isOurUI(el)) return;
    positionHoverBox(el);
  }

  function onAnnotationClick(e) {
    if (!state.annotating || state.pending) return;
    const el = e.target;
    if (!el || el === document.body || el === document.documentElement) return;
    if (isOurUI(el)) return;

    e.preventDefault();
    e.stopPropagation();

    const number = state.annotations.length + 1;
    const x = Math.round(e.clientX + window.scrollX);
    const y = Math.round(e.clientY + window.scrollY);
    const marker = createMarker(number, x, y);
    state.pending = { number, x, y, el, marker };

    if (hoverBox) hoverBox.style.display = 'none';
    showInputPopup(number, e.clientX, e.clientY);
  }

  // ----------------------- 评论输入框(标记右侧,浮动) -----------------------
  function showInputPopup(markerNum, clientX, clientY) {
    const wrap = document.createElement('div');
    wrap.className = 'wdbg-ui wdbg-input-popup';
    wrap.innerHTML = `
      <span class="wdbg-input-num">${markerNum}</span>
      <input class="wdbg-input-field" type="text" placeholder="添加评论..." autocomplete="off" />
      <button class="wdbg-input-confirm" title="确认(Enter)">${SVG.check}</button>
    `;
    document.body.appendChild(wrap);
    wrap.classList.add('wdbg-pop');
    setTimeout(() => wrap.classList.remove('wdbg-pop'), 200);
    setCommenting(true);

    const input = wrap.querySelector('.wdbg-input-field');
    const confirm = wrap.querySelector('.wdbg-input-confirm');

    // 定位:默认在标记右侧,垂直居中;贴边则翻到左侧
    const w = wrap.offsetWidth || 280;
    const h = wrap.offsetHeight || 40;
    let left = clientX + 22;
    let top = clientY - h / 2;
    if (left + w > window.innerWidth - 8) left = clientX - w - 22;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';

    setTimeout(() => input.focus(), 0);

    const submit = () => {
      const v = input.value.trim();
      if (!v) { shake(wrap); input.focus(); return; }
      finalizePending(v);
    };
    const cancel = () => cancelPending();

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    confirm.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
    wrap.addEventListener('click', (e) => e.stopPropagation());
    wrap.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  function shake(el) {
    el.classList.remove('animate__animated', 'animate__swing');
    // 触发重绘以重新播放动画
    void el.offsetWidth;
    el.classList.add('animate__animated', 'animate__swing');
    setTimeout(() => el.classList.remove('animate__animated', 'animate__swing'), 1000);
  }

  function finalizePending(comment) {
    if (!state.pending) return;
    const { number, x, y, el, marker } = state.pending;
    state.annotations.push({
      number,
      selector: cssSelector(el),
      xpath: xPath(el),
      x, y,
      pageW: PAGE_W(),
      pageH: PAGE_H(),
      url: location.href,
      comment,
      el,
      marker,
    });
    state.pending = null;
    const pop = document.querySelector('.wdbg-input-popup');
    if (pop) pop.remove();
    setCommenting(false);
  }

  function cancelPending() {
    if (state.pending) {
      if (state.pending.marker) state.pending.marker.remove();
      state.pending = null;
    }
    const pop = document.querySelector('.wdbg-input-popup');
    if (pop) pop.remove();
    setCommenting(false);
  }

  // ----------------------- Prompt 生成 -----------------------
  function buildPrompt(list) {
    const lines = [];
    (list || state.annotations).forEach((a, i) => {
      if (i > 0) lines.push('');
      lines.push(`# Comment ${a.number}`);
      lines.push(`Node position: (${a.x}, ${a.y}) in ${a.pageW}x${a.pageH}`);
      lines.push(`Viewport Page URL: ${a.url}`);
      lines.push(`Target selector: ${a.selector}`);
      lines.push(`Target path: ${a.xpath}`);
      lines.push(`Saved marker screenshot: attached as a labeled image for Comment ${a.number}`);
      lines.push(`Comment: ${a.comment}`);
    });
    return lines.join('\n');
  }

  // ----------------------- 可视区截图(不滚动;蓝色选区在截图上后绘,避免可见闪烁) -----------------------
  async function captureViewport() {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // 截图时隐藏插件 UI(保留编号标记),避免入镜;不滚动、不在页面上加蓝色高亮
    const hidden = [];
    document.querySelectorAll('.wdbg-menu, .wdbg-drawer-mask, .wdbg-input-popup, .wdbg-hover-box, .wdbg-confirm-mask, .wdbg-loading, .wdbg-toast')
      .forEach((n) => { hidden.push([n, n.style.display]); n.style.display = 'none'; });

    // 记录可视区内被注释元素的矩形,稍后在截图上绘制蓝色选区(不修改页面 DOM,杜绝闪烁)
    const rects = [];
    state.annotations.forEach((ann) => {
      if (!ann.el || ann.el.nodeType !== 1) return;
      const r = ann.el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return; // 完全在可视区外则跳过
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    });

    try {
      const dataUrl = await captureVisible();
      if (!rects.length) return dataUrl;
      // 将蓝色选区叠绘到截图上
      const img = await loadImage(dataUrl);
      const scaleX = img.naturalWidth / vw;
      const scaleY = img.naturalHeight / vh;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      ctx.lineWidth = Math.max(2, Math.round(2 * scaleX));
      ctx.strokeStyle = '#3b82f6';
      ctx.fillStyle = 'rgba(59, 130, 246, 0.08)';
      rects.forEach((r) => {
        const x = r.x * scaleX, y = r.y * scaleY, w = r.w * scaleX, h = r.h * scaleY;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      });
      return canvas.toDataURL('image/png');
    } finally {
      hidden.forEach(([n, d]) => { n.style.display = d; });
    }
  }

  // ----------------------- 停止注释 → 立即展示详情 + 异步生成截图 -----------------------
  async function finalizeSession() {
    if (state.annotations.length === 0) { setAnnotating(false); return; }
    setAnnotating(false);

    const promptText = buildPrompt(state.annotations);
    const session = {
      id: 's' + Date.now() + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      count: state.annotations.length,
      annotations: state.annotations.map((a) => ({
        number: a.number, selector: a.selector, xpath: a.xpath,
        x: a.x, y: a.y, pageW: a.pageW, pageH: a.pageH, url: a.url, comment: a.comment,
      })),
      prompt: promptText,
      screenshot: null, // 截图异步生成中
    };

    // 立即展示详情抽屉:Prompt 可立即复制,截图区域显示 loading
    openSessionDetailDrawer(session);

    // 异步生成可视区截图,完成后回填到抽屉(截图期间抽屉会被 captureViewport 临时隐藏,避免入镜)
    try {
      const shot = await captureViewport();
      session.screenshot = shot;
      fillDetailScreenshot(session);
    } catch (err) {
      fillDetailScreenshotError(session, err.message);
    } finally {
      // 截图已生成(或失败),清空页面上的注释标记
      clearMarkers();
      // 无论成功失败都保存到历史(失败时 screenshot 为 null,历史里显示"无图")
      await addSession(session);
    }
  }

  // 清空页面上所有注释标记并重置当前会话
  function clearMarkers() {
    state.annotations.forEach((a) => { if (a.marker) a.marker.remove(); });
    state.annotations = [];
    if (state.pending) {
      if (state.pending.marker) state.pending.marker.remove();
      state.pending = null;
      const pop = document.querySelector('.wdbg-input-popup'); if (pop) pop.remove();
    }
  }

  // 把生成好的截图回填到当前详情抽屉(若抽屉仍打开且是同一条 session)
  function fillDetailScreenshot(session) {
    if (!activeDrawer || detailDrawerSession !== session || !session.screenshot) return;
    const aside = activeDrawer.aside;
    const wrap = aside.querySelector('.wdbg-detail-imgwrap');
    if (wrap) wrap.innerHTML = `<img class="wdbg-detail-img" alt="screenshot" src="${session.screenshot}" />`;
    aside.querySelectorAll('.wdbg-img-action').forEach((b) => { b.disabled = false; });
  }

  function fillDetailScreenshotError(session, message) {
    if (!activeDrawer || detailDrawerSession !== session) return;
    const aside = activeDrawer.aside;
    const wrap = aside.querySelector('.wdbg-detail-imgwrap');
    if (wrap) wrap.innerHTML = `<div class="wdbg-detail-img-error">截图生成失败:${escapeHtml(message)}</div>`;
  }

  // ----------------------- 图片大图预览 -----------------------
  function openImageLightbox(src) {
    const mask = document.createElement('div');
    mask.className = 'wdbg-ui wdbg-lightbox';
    mask.innerHTML = `<img class="wdbg-lightbox-img" src="${src}" alt="screenshot" draggable="false" />`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('wdbg-open'));
    const close = () => {
      mask.classList.remove('wdbg-open');
      setTimeout(() => mask.remove(), 200);
    };
    mask.addEventListener('click', close);
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  // ----------------------- 抽屉通用 -----------------------
  function openDrawer({ title, bodyHTML, onMount }) {
    closeDrawer();
    const mask = document.createElement('div');
    mask.className = 'wdbg-ui wdbg-drawer-mask';
    const aside = document.createElement('aside');
    aside.className = 'wdbg-drawer';
    aside.innerHTML = `
      <header class="wdbg-drawer-head">
        <span class="wdbg-drawer-title">${title}</span>
        <button class="wdbg-drawer-close" title="关闭">${SVG.x}</button>
      </header>
      <div class="wdbg-drawer-body">${bodyHTML}</div>
    `;
    mask.appendChild(aside);
    document.body.appendChild(mask);
    activeDrawer = { mask, aside };
    requestAnimationFrame(() => mask.classList.add('wdbg-open'));
    const close = () => closeDrawer();
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    aside.querySelector('.wdbg-drawer-close').addEventListener('click', close);
    if (onMount) onMount(aside);
    return aside;
  }

  function closeDrawer() {
    if (!activeDrawer) return;
    const { mask } = activeDrawer;
    activeDrawer = null;
    mask.classList.remove('wdbg-open');
    setTimeout(() => mask.remove(), 260);
  }

  function flashBtn(btn, text) {
    const old = btn.innerHTML;
    btn.innerHTML = text;
    setTimeout(() => { btn.innerHTML = old; }, 1200);
  }

  // clipboard API 不可用时的回退:用隐藏 textarea 复制,不选中可见文本框
  function copyTextFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ----------------------- 注释详情抽屉 -----------------------
  // 跟踪当前详情抽屉对应的 session,供异步回填截图使用
  let detailDrawerSession = null;

  function openSessionDetailDrawer(session) {
    detailDrawerSession = session;
    const hasShot = !!session.screenshot;
    const imgArea = hasShot
      ? `<img class="wdbg-detail-img" alt="screenshot" src="${session.screenshot}" />`
      : `<div class="wdbg-detail-img-loading"><div class="wdbg-loading-spin"></div><span>正在生成截图...</span></div>`;
    const imgBtnAttr = hasShot ? '' : 'disabled';
    const body = `
      <div class="wdbg-detail-info">
        <span class="wdbg-detail-time">${formatTime(session.ts)}</span>
        <span class="wdbg-chip">${session.count} 条注释</span>
      </div>
      <div class="wdbg-detail-section">
        <div class="wdbg-detail-label">
          <span>注释 Prompt</span>
          <div class="wdbg-detail-actions">
            <button class="wdbg-btn wdbg-copy-prompt">${SVG.copy}<span>复制</span></button>
            <button class="wdbg-btn wdbg-dl-prompt">${SVG.download}<span>下载</span></button>
          </div>
        </div>
        <textarea class="wdbg-detail-text" readonly></textarea>
      </div>
      <div class="wdbg-detail-section">
        <div class="wdbg-detail-label">
          <span>标记截图</span>
          <div class="wdbg-detail-actions">
            <button class="wdbg-btn wdbg-img-action wdbg-copy-img" ${imgBtnAttr}>${SVG.copy}<span>复制图片</span></button>
            <button class="wdbg-btn wdbg-img-action wdbg-dl-img" ${imgBtnAttr}>${SVG.download}<span>下载图片</span></button>
          </div>
        </div>
        <div class="wdbg-detail-imgwrap">${imgArea}</div>
      </div>
      <div class="wdbg-detail-foot">
        <button class="wdbg-btn wdbg-btn-primary wdbg-view-history">${SVG.history}<span>查看历史记录</span></button>
      </div>
    `;
    openDrawer({
      title: '注释详情',
      bodyHTML: body,
      onMount: (el) => {
        el.querySelector('.wdbg-detail-text').value = session.prompt;

        // 点击截图查看大图
        const imgwrap = el.querySelector('.wdbg-detail-imgwrap');
        if (imgwrap) {
          imgwrap.style.cursor = 'zoom-in';
          imgwrap.addEventListener('click', (e) => {
            const img = e.target.closest('.wdbg-detail-img');
            if (img && img.src) openImageLightbox(img.src);
          });
        }

        el.querySelector('.wdbg-copy-prompt').onclick = async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          try { await navigator.clipboard.writeText(session.prompt); }
          catch { copyTextFallback(session.prompt); }
          flashBtn(btn, '已复制');
        };
        el.querySelector('.wdbg-dl-prompt').onclick = (e) => {
          e.stopPropagation();
          const b = new Blob([session.prompt], { type: 'text/plain;charset=utf-8' });
          const u = URL.createObjectURL(b);
          const a = document.createElement('a'); a.href = u; a.download = `annotations-prompt-${stamp()}.txt`; a.click();
          setTimeout(() => URL.revokeObjectURL(u), 1000);
        };
        el.querySelector('.wdbg-copy-img').onclick = async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          if (!session.screenshot) { showToast('截图还在生成中...'); return; }
          try {
            const blob = await (await fetch(session.screenshot)).blob();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            flashBtn(btn, '已复制');
          } catch (err) { alert('复制图片失败:(' + err.message + ')。可改用"下载图片"。'); }
        };
        el.querySelector('.wdbg-dl-img').onclick = (e) => {
          e.stopPropagation();
          if (!session.screenshot) { showToast('截图还在生成中...'); return; }
          const a = document.createElement('a'); a.href = session.screenshot; a.download = `annotations-screenshot-${stamp()}.png`; a.click();
        };
        el.querySelector('.wdbg-view-history').onclick = (e) => {
          e.stopPropagation(); closeDrawer(); openHistoryDrawer();
        };
      },
    });
  }

  // ----------------------- 历史记录抽屉 -----------------------
  async function openHistoryDrawer() {
    const history = await getHistory();
    let body;
    if (history.length === 0) {
      body = `<div class="wdbg-empty">暂无历史记录</div>`;
    } else {
      body = history.map((s) => {
        const firstUrl = (s.annotations && s.annotations[0] && s.annotations[0].url) || '';
        return `
          <div class="wdbg-history-item" data-id="${escapeHtml(s.id)}">
            <div class="wdbg-history-thumb">${s.screenshot ? `<img src="${s.screenshot}" alt="thumb" />` : '<div class="wdbg-history-noimg">无图</div>'}</div>
            <div class="wdbg-history-meta">
              <div class="wdbg-history-time">${formatTime(s.ts)}</div>
              <div class="wdbg-history-count">${s.count} 条注释</div>
              <div class="wdbg-history-url" title="${escapeHtml(firstUrl)}">${escapeHtml(firstUrl)}</div>
            </div>
            <div class="wdbg-history-ops">
              <button class="wdbg-btn wdbg-view" data-id="${escapeHtml(s.id)}">查看</button>
              <button class="wdbg-btn wdbg-btn-ghost-danger wdbg-del" data-id="${escapeHtml(s.id)}" title="删除">${SVG.trash}</button>
            </div>
          </div>`;
      }).join('');
    }
    openDrawer({
      title: '历史记录',
      bodyHTML: body,
      onMount: (el) => {
        el.querySelectorAll('.wdbg-view').forEach((b) => {
          b.onclick = async (e) => {
            e.stopPropagation();
            const id = b.dataset.id;
            const h = await getHistory();
            const s = h.find((x) => x.id === id);
            if (s) { closeDrawer(); openSessionDetailDrawer(s); }
          };
        });
        el.querySelectorAll('.wdbg-del').forEach((b) => {
          b.onclick = async (e) => {
            e.stopPropagation();
            await deleteSessionById(b.dataset.id);
            openHistoryDrawer();
          };
        });
      },
    });
  }

  // ----------------------- 确认弹窗 -----------------------
  function openConfirm(message, onConfirm) {
    const mask = document.createElement('div');
    mask.className = 'wdbg-ui wdbg-confirm-mask';
    mask.innerHTML = `
      <div class="wdbg-confirm">
        <div class="wdbg-confirm-msg">${escapeHtml(message)}</div>
        <div class="wdbg-confirm-ops">
          <button class="wdbg-btn wdbg-confirm-cancel">取消</button>
          <button class="wdbg-btn wdbg-btn-danger wdbg-confirm-ok">确认</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('wdbg-open'));
    const close = () => { mask.classList.remove('wdbg-open'); setTimeout(() => mask.remove(), 200); };
    mask.querySelector('.wdbg-confirm-cancel').onclick = close;
    mask.querySelector('.wdbg-confirm-ok').onclick = () => { close(); onConfirm(); };
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  }

  // ----------------------- Toast / Loading -----------------------
  function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'wdbg-ui wdbg-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('wdbg-show'));
    setTimeout(() => { t.classList.remove('wdbg-show'); setTimeout(() => t.remove(), 300); }, 1600);
  }

  function showLoading(msg) {
    closeLoading();
    const l = document.createElement('div');
    l.className = 'wdbg-ui wdbg-loading';
    l.innerHTML = `<div class="wdbg-loading-spin"></div><div>${escapeHtml(msg)}</div>`;
    document.body.appendChild(l);
    currentLoading = l;
  }
  function closeLoading() { if (currentLoading) { currentLoading.remove(); currentLoading = null; } }

  // ----------------------- 下拉菜单 -----------------------
  function buildMenu() {
    menu = document.createElement('div');
    menu.className = 'wdbg-ui wdbg-menu';
    menu.innerHTML = `
      <button class="wdbg-menu-item" data-act="start">${SVG.plus}<span>开始注释</span></button>
      <button class="wdbg-menu-item" data-act="history">${SVG.history}<span>历史记录</span></button>
      <button class="wdbg-menu-item" data-act="clear">${SVG.trash}<span>清空记录</span></button>
    `;
    document.body.appendChild(menu);
    menu.querySelectorAll('.wdbg-menu-item').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        closeMenu();
        if (act === 'start') startAnnotation();
        else if (act === 'history') openHistoryDrawer();
        else if (act === 'clear') actionClearAll();
      });
      b.addEventListener('mousedown', (e) => e.stopPropagation());
    });
  }
  function toggleMenu() { menu.classList.contains('wdbg-open') ? closeMenu() : openMenu(); }
  function openMenu() { menu.classList.add('wdbg-open'); }
  function closeMenu() { menu.classList.remove('wdbg-open'); }

  function actionClearAll() {
    openConfirm('确认清空所有历史记录吗?此操作不可恢复。', async () => {
      await clearAllHistory();
      // 同时清掉页面上的当前标记
      state.annotations.forEach((a) => { if (a.marker) a.marker.remove(); });
      state.annotations = [];
      if (state.pending) { if (state.pending.marker) state.pending.marker.remove(); state.pending = null; }
      const pop = document.querySelector('.wdbg-input-popup'); if (pop) pop.remove();
      showToast('已清空所有记录');
    });
  }

  // ----------------------- 工具栏图标点击 -----------------------
  function handleActionClick() {
    if (!document.body) return; // 页面尚无 body(XML 等),无法展示 UI
    if (!uiBuilt) buildUI();
    // SPA 整页替换 body 等场景会把我们的 UI 节点冲出 DOM,
    // 此时消息链路仍正常(background 不会补救注入),需在点击时自愈重建
    if (!menu || !menu.isConnected) buildMenu();
    if (hoverBox && !hoverBox.isConnected) { hoverBox = null; ensureHoverBox(); hoverBox.style.display = 'none'; }
    if (state.annotating) {
      finalizeSession();
    } else {
      toggleMenu();
    }
  }

  // ----------------------- 构建 UI -----------------------
  let uiBuilt = false;

  function buildUI() {
    if (uiBuilt) return;
    uiBuilt = true;
    injectCursorStyle();
    buildMenu();
    ensureHoverBox();
    hoverBox.style.display = 'none';

    // 页面事件
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onAnnotationClick, true);

    // 点击菜单外部关闭菜单(气泡阶段)
    document.addEventListener('click', (e) => {
      if (!menu.classList.contains('wdbg-open')) return;
      if (menu.contains(e.target)) return;
      closeMenu();
    });

    // 全局 Esc
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (state.pending) { e.preventDefault(); cancelPending(); return; }
      const confirmOpen = document.querySelector('.wdbg-confirm-mask.wdbg-open');
      if (confirmOpen) { return; } // 确认弹窗有自己的关闭逻辑(点遮罩),不强制
      if (activeDrawer) { closeDrawer(); return; }
      if (menu.classList.contains('wdbg-open')) { closeMenu(); return; }
    }, true);

    // 复位工具栏图标为空闲态
    sendMsg({ type: 'wdbg-set-icon', state: 'idle' });
  }

  // ----------------------- 启动 -----------------------
  // 消息监听器必须在注入后立即注册(不依赖 body 是否就绪),
  // 否则 background 的 sendMessage 会一直报 "Receiving end does not exist",
  // 而补救注入又被守卫挡住,标签页就永久失效了
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'wdbg-action-clicked') handleActionClick();
  });

  if (document.body) {
    buildUI();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => buildUI(), { once: true });
  } else {
    // DOMContentLoaded 已错过但 body 尚不存在(XML 文档、异常注入时机等):
    // 观察 DOM,body 出现后再构建,避免旧版"永远等不到 DOMContentLoaded"的死锁
    const mo = new MutationObserver(() => {
      if (document.body) { mo.disconnect(); buildUI(); }
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  }
})();
