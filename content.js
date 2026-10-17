/**
 * ColorPick 拾色助手 —— 内容脚本（content script）
 *
 * 职责：
 *   1. 在页面右下角注入悬浮按钮「拾取颜色」与操作面板；
 *   2. 点击按钮后扫描当前页面 DOM 的计算样式，收集文字色 / 背景色 / 边框色，
 *      过滤透明色并统计每种颜色的出现次数；
 *   3. 调用浏览器 EyeDropper API 做手动吸管取色（含兼容性判断）；
 *   4. 通过 chrome.runtime.sendMessage 把颜色列表交给 Service Worker，
 *      由后台统一存储并打开色板页。
 *
 * SPA 兼容：挂载到 document.documentElement，使用 MutationObserver 监听被移除的情况并自动重新挂载。
 */
(() => {
  'use strict';

  /* 防止重复注入：manifest 声明注入 + 后台 executeScript 兜底注入共用一个入口 */
  if (window.__CPK_CONTENT_LOADED__) return;
  window.__CPK_CONTENT_LOADED__ = true;

  /* ------------------------------ 常量配置 ------------------------------ */

  const ROOT_ID = 'cpk-root';
  const SETTINGS_KEY = 'cpk_settings';
  const DEFAULT_SETTINGS = { showFab: true };

  const MAX_ELEMENTS = 12000; // 单个页面最多扫描的元素数量，避免超大页面卡顿
  const CHUNK_SIZE = 400; // 每批扫描元素数量，分批让出主线程
  const STRIP_LIMIT = 18; // 面板中预览的色块数量

  // 这些标签不会产生有意义的可见颜色，直接跳过
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'LINK',
    'META',
    'HEAD',
    'TITLE',
    'BASE',
    'NOSCRIPT',
    'TEMPLATE',
    'BR',
    'WBR'
  ]);

  /* ------------------------------ 运行状态 ------------------------------ */

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    mounted: false,
    panelOpen: false,
    scanning: false,
    progress: 0,
    colors: [], // 最近一次扫描 / 手动取色得到的颜色
    meta: null, // 页面信息
    rootEl: null,
    observer: null
  };

  /** 面板与按钮的 DOM 引用 */
  const ui = {
    root: null,
    fab: null,
    panel: null,
    status: null,
    progress: null,
    progressBar: null,
    strip: null,
    galleryBtn: null,
    toast: null
  };

  let toastTimer = null;

  /* ------------------------------ 基础工具 ------------------------------ */

  const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 把 RGB 转成大写 #RRGGBB */
  function toHex(r, g, b) {
    return (
      '#' +
      [r, g, b]
        .map((v) => {
          const n = Math.max(0, Math.min(255, Math.round(v)));
          return n.toString(16).padStart(2, '0');
        })
        .join('')
        .toUpperCase()
    );
  }

  /* --------------------------- 颜色解析（带缓存） -------------------------- */

  const colorCache = new Map();
  let canvasCtx = null;

  /** 1x1 离屏画布，用于解析 rgb()/hsl()/oklch() 等任意合法颜色值 */
  function getCanvasCtx() {
    if (!canvasCtx) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
    }
    return canvasCtx;
  }

  /** 解析 #rgb / #rgba / #rrggbb / #rrggbbaa */
  function parseHexColor(str) {
    let hex = str.slice(1);
    if (!/^[0-9a-f]+$/i.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  /** 借助画布把任意合法颜色字符串解析成 RGBA（兼容 color()/lab()/oklch() 等新语法） */
  function parseViaCanvas(str) {
    const ctx = getCanvasCtx();
    if (!ctx) return null;
    // 先用哨兵值占位：如果浏览器不识别该颜色，fillStyle 会保持哨兵值不变
    ctx.fillStyle = '#010203';
    ctx.fillStyle = str;
    if (ctx.fillStyle === '#010203') return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    if (data[3] === 0) return null;
    return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
  }

  /**
   * 把计算样式中的颜色字符串解析为 { r, g, b, a }
   * @returns {{r:number,g:number,b:number,a:number}|null}
   */
  function parseCssColor(input) {
    if (!input) return null;
    if (colorCache.has(input)) return colorCache.get(input);

    let result = null;
    const str = String(input).trim().toLowerCase();

    if (str === 'transparent' || str === 'none' || str === '') {
      result = null;
    } else if (str.startsWith('#')) {
      result = parseHexColor(str);
    } else if (str.startsWith('rgb')) {
      const match = str.match(/^rgba?\(([^)]+)\)$/);
      if (match) {
        // 兼容 rgb(1, 2, 3) / rgb(1 2 3) / rgb(1 2 3 / 0.5) / rgb(10% 20% 30%)
        const parts = match[1].split(/[\s,/]+/).filter(Boolean);
        if (parts.length >= 3) {
          const parseChannel = (v) =>
            v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v);
          const r = parseChannel(parts[0]);
          const g = parseChannel(parts[1]);
          const b = parseChannel(parts[2]);
          if ([r, g, b].every((n) => !Number.isNaN(n))) {
            let a = 1;
            if (parts.length >= 4) {
              const raw = parts[3];
              a = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
              if (Number.isNaN(a)) a = 1;
            }
            result = { r, g, b, a };
          }
        }
      }
    }

    // 其它格式（hsl()、hwb()、color()、lab()、oklch() 等）交给浏览器解析
    if (!result && str !== 'transparent' && str !== 'none') {
      result = parseViaCanvas(str);
    }

    colorCache.set(input, result);
    return result;
  }

  /* ------------------------------ 颜色收集 ------------------------------ */

  /**
   * 把一条颜色计入统计表
   * @param {Map} map  颜色统计表
   * @param {string} raw 原始颜色字符串
   * @param {'text'|'bg'|'border'} source 颜色来源
   */
  function addColor(map, raw, source) {
    if (!raw) return;
    const rgba = parseCssColor(raw);
    if (!rgba) return;
    if (!Number.isFinite(rgba.a) || rgba.a < 0.05) return; // 过滤完全透明 / 几乎透明的颜色

    const hex = toHex(rgba.r, rgba.g, rgba.b);
    const alpha = Math.round(Math.min(1, rgba.a) * 100) / 100;
    const key = `${hex}|${alpha}`;

    let item = map.get(key);
    if (!item) {
      item = {
        key,
        hex,
        r: rgba.r,
        g: rgba.g,
        b: rgba.b,
        a: alpha,
        rgb:
          alpha < 1
            ? `rgba(${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(
                rgba.b
              )}, ${alpha})`
            : `rgb(${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(rgba.b)})`,
        count: 0,
        text: 0,
        bg: 0,
        border: 0,
        manual: false
      };
      map.set(key, item);
    }

    item.count += 1;
    item[source] += 1;
  }

  /** 判断元素是否需要跳过（脚本/样式标签、插件自身 UI） */
  function shouldSkip(el, rootEl) {
    if (!el || !el.tagName) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (rootEl && (el === rootEl || rootEl.contains(el))) return true;
    return false;
  }

  /** 收集单个元素的文字色、背景色、可见边框色 */
  function collectElementColors(el, map) {
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (err) {
      return;
    }
    // 完全不渲染的元素不会在页面上产生可见颜色
    if (!cs || cs.display === 'none') return;

    addColor(map, cs.color, 'text');
    addColor(map, cs.backgroundColor, 'bg');

    // 只有边框实际可见（有宽度且有样式）才统计边框色
    const sides = [
      ['borderTopWidth', 'borderTopStyle', 'borderTopColor'],
      ['borderRightWidth', 'borderRightStyle', 'borderRightColor'],
      ['borderBottomWidth', 'borderBottomStyle', 'borderBottomColor'],
      ['borderLeftWidth', 'borderLeftStyle', 'borderLeftColor']
    ];
    for (let i = 0; i < sides.length; i += 1) {
      const [widthProp, styleProp, colorProp] = sides[i];
      const width = parseFloat(cs[widthProp]);
      if (width > 0 && cs[styleProp] !== 'none') {
        addColor(map, cs[colorProp], 'border');
      }
    }
  }

  /**
   * 扫描整页颜色
   * @param {(done:number,total:number)=>void} onProgress 进度回调
   * @returns {Promise<{colors:Array,meta:Object}>}
   */
  async function scanPageColors(onProgress) {
    const map = new Map();
    const rootEl = document.getElementById(ROOT_ID);
    const allElements = document.querySelectorAll('*');
    const total = Math.min(allElements.length, MAX_ELEMENTS);

    for (let i = 0; i < total; i += 1) {
      const el = allElements[i];
      if (!shouldSkip(el, rootEl)) {
        collectElementColors(el, map);
      }
      // 分批让出主线程，避免长任务阻塞页面滚动 / 动画
      if (i % CHUNK_SIZE === 0) {
        if (onProgress) onProgress(i, total);
        await sleep(0);
      }
    }

    // 按出现次数倒序，次数相同则按色值排序，保证每次结果稳定
    const colors = Array.from(map.values()).sort(
      (a, b) => b.count - a.count || a.hex.localeCompare(b.hex)
    );

    if (onProgress) onProgress(total, total);

    const meta = {
      title: document.title || location.hostname || '未命名页面',
      url: location.href,
      elementCount: allElements.length,
      scannedCount: total,
      truncated: allElements.length > MAX_ELEMENTS,
      updatedAt: Date.now()
    };

    return { colors, meta };
  }

  /* ------------------------------ 消息通信 ------------------------------ */

  /** 封装 chrome.runtime.sendMessage 为 Promise，并吞掉「扩展上下文失效」等异常 */
  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || {});
        });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message ? err.message : err) });
      }
    });
  }

  /* ------------------------------ 界面构建 ------------------------------ */

  const FAB_ICON = `
    <svg class="cpk-fab__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.5 3.5a2.12 2.12 0 0 1 3 3l-1.6 1.6 1.1 1.1-1.9 1.9-1.1-1.1-6.3 6.3-3.2.9.9-3.2 6.3-6.3-1.1-1.1 1.9-1.9 1.1 1.1 1.6-1.6z"
        stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;

  const PANEL_ICON = `
    <svg class="cpk-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.6"/>
      <rect x="13" y="3" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.6" opacity=".55"/>
      <rect x="3" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.6" opacity=".55"/>
      <rect x="13" y="13" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.6"/>
    </svg>`;

  const PICK_ICON = `
    <svg class="cpk-btn__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20l1.3-4.4L15.6 5.3a2.1 2.1 0 0 1 3 3L8.4 18.7 4 20z"
        stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M13.6 7.4l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;

  /** 创建界面（只执行一次） */
  function mount() {
    if (state.mounted && ui.root && ui.root.isConnected) return;

    // 若上次被页面移除，先清理残留节点
    const old = document.getElementById(ROOT_ID);
    if (old) old.remove();

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('data-cpk', 'root');

    const panel = document.createElement('div');
    panel.className = 'cpk-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'ColorPick 拾色助手');
    panel.innerHTML = `
      <div class="cpk-panel__bar"></div>
      <div class="cpk-panel__head">
        <span class="cpk-panel__title"><span class="cpk-dot"></span>ColorPick 拾色助手</span>
        <button type="button" class="cpk-close" aria-label="关闭面板">✕</button>
      </div>
      <div class="cpk-panel__body">
        <p class="cpk-status" aria-live="polite">准备扫描页面颜色…</p>
        <div class="cpk-progress" hidden><span></span></div>
        <div class="cpk-strip" hidden></div>
        <div class="cpk-actions">
          <button type="button" class="cpk-btn cpk-btn--primary" data-act="gallery" disabled>
            ${PANEL_ICON}<span class="cpk-gallery-label">查看色板</span>
          </button>
          <button type="button" class="cpk-btn" data-act="pick">
            ${PICK_ICON}<span>吸管取色</span>
          </button>
        </div>
        <div class="cpk-links">
          <button type="button" data-act="rescan">重新扫描</button>
          <button type="button" data-act="hide">隐藏悬浮按钮</button>
        </div>
      </div>`;

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'cpk-fab';
    fab.setAttribute('aria-label', '拾取颜色');
    fab.innerHTML = `${FAB_ICON}<span>拾取颜色</span>`;

    const toast = document.createElement('div');
    toast.className = 'cpk-toast';
    toast.setAttribute('role', 'status');

    root.appendChild(panel);
    root.appendChild(fab);
    root.appendChild(toast);

    // 挂到 <html> 上：即使 SPA 整体替换 body 也不会丢失；也避免 body transform 影响 fixed 定位
    document.documentElement.appendChild(root);

    state.rootEl = root;
    state.mounted = true;
    ui.root = root;
    ui.fab = fab;
    ui.panel = panel;
    ui.status = panel.querySelector('.cpk-status');
    ui.progress = panel.querySelector('.cpk-progress');
    ui.progressBar = panel.querySelector('.cpk-progress span');
    ui.strip = panel.querySelector('.cpk-strip');
    ui.galleryBtn = panel.querySelector('[data-act="gallery"]');
    ui.toast = toast;

    // ---------------- 事件绑定 ----------------
    fab.addEventListener('click', onFabClick);
    panel.querySelector('.cpk-close').addEventListener('click', () => setPanelOpen(false));
    panel.querySelector('[data-act="gallery"]').addEventListener('click', openGallery);
    panel.querySelector('[data-act="pick"]').addEventListener('click', pickColorByEyeDropper);
    panel.querySelector('[data-act="rescan"]').addEventListener('click', runScan);
    panel.querySelector('[data-act="hide"]').addEventListener('click', hideFab);

    // Esc 关闭面板
    document.addEventListener('keydown', onKeyDown, true);

    // 监听自身被页面框架移除（部分 SPA / 极端样式会清空 html 节点）
    if (!state.observer) {
      state.observer = new MutationObserver(() => {
        if (
          state.settings.showFab !== false &&
          state.mounted &&
          state.rootEl &&
          !state.rootEl.isConnected
        ) {
          document.documentElement.appendChild(state.rootEl);
        }
      });
      state.observer.observe(document.documentElement, { childList: true });
    }

    renderPanel();
  }

  /** 卸载界面 */
  function unmount() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    document.removeEventListener('keydown', onKeyDown, true);
    if (state.rootEl) state.rootEl.remove();
    state.rootEl = null;
    state.mounted = false;
    state.panelOpen = false;
    ui.root = null;
    ui.fab = null;
    ui.panel = null;
    ui.status = null;
    ui.progress = null;
    ui.progressBar = null;
    ui.strip = null;
    ui.galleryBtn = null;
    ui.toast = null;
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state.panelOpen) {
      event.stopPropagation();
      setPanelOpen(false);
    }
  }

  /* ------------------------------ 面板渲染 ------------------------------ */

  /** 显示 / 隐藏面板 */
  function setPanelOpen(open) {
    if (!ui.panel) return;
    state.panelOpen = open;
    ui.panel.hidden = !open;
  }

  /** 把轻提示摆在整个插件 UI 上方（用 offsetHeight 计算，避免受面板动画影响） */
  function positionToast() {
    if (!ui.root || !ui.toast) return;
    const rootRect = ui.root.getBoundingClientRect();
    const baseBottom = Math.max(12, window.innerHeight - rootRect.bottom);
    let stackHeight = ui.fab ? ui.fab.offsetHeight : 0;
    if (ui.panel && !ui.panel.hidden) {
      stackHeight += 12 + ui.panel.offsetHeight;
    }
    const bottom = Math.min(baseBottom + stackHeight + 10, window.innerHeight - 60);
    const right = Math.max(12, window.innerWidth - rootRect.right);

    ui.toast.style.right = `${right}px`;
    ui.toast.style.bottom = `${bottom}px`;
    ui.toast.style.maxWidth = `${Math.max(180, window.innerWidth - right - 16)}px`;
  }

  /** 轻提示 */
  function showToast(text, type = 'info') {
    if (!ui.toast) return;
    ui.toast.textContent = text;
    positionToast();

    ui.toast.className = `cpk-toast is-show${type === 'warn' ? ' is-warn' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (ui.toast) ui.toast.className = 'cpk-toast';
    }, 2800);
  }

  /** 更新面板文案、进度、色块预览 */
  function renderPanel() {
    if (!state.mounted || !ui.panel) return;
    const count = state.colors.length;

    // 按钮忙碌态
    ui.fab.classList.toggle('is-busy', state.scanning);

    // 状态文案
    if (state.scanning) {
      ui.status.textContent = `正在扫描页面颜色… ${state.progress}%`;
    } else if (count > 0) {
      const truncated = state.meta && state.meta.truncated
        ? `（页面元素较多，已扫描前 ${MAX_ELEMENTS} 个）`
        : '';
      ui.status.textContent = `共发现 ${count} 种颜色，数据已发送到色板页。${truncated}`;
    } else {
      ui.status.textContent = '准备扫描页面颜色…';
    }

    // 进度条
    ui.progress.hidden = !state.scanning;
    if (state.scanning) {
      ui.progressBar.style.width = `${Math.max(4, state.progress)}%`;
    }

    // 色块预览
    const showStrip = !state.scanning && count > 0;
    ui.strip.hidden = !showStrip;
    if (showStrip) {
      ui.strip.textContent = '';
      state.colors.slice(0, STRIP_LIMIT).forEach((color) => {
        const dot = document.createElement('span');
        dot.className = 'cpk-strip__dot';
        dot.style.background = color.rgb;
        dot.title = `${color.hex} · 出现 ${color.count} 次`;
        ui.strip.appendChild(dot);
      });
      if (count > STRIP_LIMIT) {
        const more = document.createElement('span');
        more.className = 'cpk-strip__dot';
        more.style.background = '#e9e5f5';
        more.style.color = '#6e6a85';
        more.style.fontSize = '9px';
        more.style.lineHeight = '14px';
        more.style.textAlign = 'center';
        more.style.fontWeight = '700';
        more.textContent = `+${count - STRIP_LIMIT}`;
        ui.strip.appendChild(more);
      }
    }

    // 查看色板按钮
    ui.galleryBtn.disabled = count === 0;
    const label = ui.galleryBtn.querySelector('.cpk-gallery-label');
    if (label) label.textContent = count > 0 ? `查看色板 (${count})` : '查看色板';
  }

  /* ------------------------------ 业务逻辑 ------------------------------ */

  function onFabClick(event) {
    event.preventDefault();
    event.stopPropagation();
    setPanelOpen(true);
    runScan();
  }

  /** 扫描当前页面并上报 */
  async function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    state.progress = 0;
    setPanelOpen(true);
    renderPanel();

    try {
      const { colors, meta } = await scanPageColors((done, total) => {
        state.progress = total ? Math.round((done / total) * 100) : 0;
        renderPanel();
      });

      state.colors = colors;
      state.meta = meta;
      state.progress = 100;
      // 先切到「扫描完成」状态并渲染，保证后续提示的位置计算准确
      state.scanning = false;
      renderPanel();

      const res = await sendMessage({ type: 'SCAN_RESULT', colors, meta });
      if (res && res.ok) {
        showToast(`已拾取 ${colors.length} 种颜色，正在打开色板页…`);
      } else if (res && res.error) {
        showToast(`颜色已拾取，但打开色板页失败：${res.error}`, 'warn');
      }
    } catch (err) {
      console.error('[ColorPick] 扫描页面颜色失败：', err);
      showToast('扫描失败，请刷新页面后重试', 'warn');
    } finally {
      // 异常路径兜底：确保按钮和进度条回到正常状态
      if (state.scanning) {
        state.scanning = false;
        renderPanel();
      }
    }
  }

  /** 打开色板页 */
  async function openGallery() {
    const res = await sendMessage({ type: 'OPEN_GALLERY' });
    if (res && res.ok) {
      setPanelOpen(false);
    } else {
      showToast('无法打开色板页，请点击浏览器工具栏中的插件图标', 'warn');
    }
  }

  /** 把剪贴板写入封装成 Promise（失败时降级为 execCommand） */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.documentElement.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  /** 吸管取色（EyeDropper） */
  async function pickColorByEyeDropper() {
    // 兼容性判断：EyeDropper 需要 Edge 95+
    if (typeof window.EyeDropper !== 'function') {
      showToast('当前浏览器不支持吸管取色，请升级到 Edge 95 及以上版本', 'warn');
      return;
    }

    try {
      const picker = new window.EyeDropper();
      const result = await picker.open();
      const hex = (result && result.sRGBHex ? result.sRGBHex : '').toUpperCase();
      if (!hex) return;

      const rgba = parseCssColor(hex);
      if (!rgba) {
        showToast('未能识别取到的颜色，请重试', 'warn');
        return;
      }

      // 合并到本地列表，面板会立即展示
      const item = {
        key: `${hex}|1`,
        hex,
        r: rgba.r,
        g: rgba.g,
        b: rgba.b,
        a: 1,
        rgb: `rgb(${Math.round(rgba.r)}, ${Math.round(rgba.g)}, ${Math.round(rgba.b)})`,
        count: 1,
        text: 0,
        bg: 0,
        border: 0,
        manual: true
      };
      const existing = state.colors.find((c) => c.key === item.key);
      if (existing) {
        existing.count += 1;
        existing.manual = true;
      } else {
        state.colors.unshift(item);
      }
      renderPanel();

      // 色值写入剪贴板，方便立刻粘贴使用
      const copied = await copyText(hex);
      showToast(copied ? `已拾取 ${hex}，色值已复制` : `已拾取 ${hex}`);

      // 同步给后台，色板页会实时更新
      await sendMessage({ type: 'ADD_COLOR', color: item, meta: state.meta });
    } catch (err) {
      // 用户按 Esc 取消属于正常操作，不提示
      if (err && err.name === 'AbortError') return;
      console.warn('[ColorPick] 吸管取色失败：', err);
      showToast('取色失败，请重试', 'warn');
    }
  }

  /** 隐藏悬浮按钮（写入设置，色板页可重新开启） */
  function hideFab() {
    chrome.storage.sync.set({ [SETTINGS_KEY]: { ...state.settings, showFab: false } }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        showToast('设置保存失败，请重试', 'warn');
        return;
      }
      showToast('悬浮按钮已隐藏，可在色板页底部重新开启');
    });
  }

  /* ------------------------------ 消息监听 ------------------------------ */

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    if (message.type === 'CPK_TRIGGER_SCAN') {
      // 来自工具栏图标点击
      if (!state.mounted) mount();
      setPanelOpen(true);
      runScan();
      sendResponse({ ok: true });
      return undefined;
    }

    if (message.type === 'CPK_PING') {
      sendResponse({ ok: true });
      return undefined;
    }

    return undefined;
  });

  /* ------------------------------ 设置同步 ------------------------------ */

  function handleStorageChange(changes, areaName) {
    if (areaName !== 'sync' || !changes[SETTINGS_KEY]) return;
    const next = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
    state.settings = next;
    if (next.showFab === false) {
      unmount();
    } else if (!state.mounted) {
      mount();
    }
  }

  /* ------------------------------ 启动 ------------------------------ */

  function init() {
    try {
      chrome.storage.sync.get(SETTINGS_KEY, (res) => {
        if (chrome.runtime.lastError) {
          // 读不到设置时按默认显示，保证功能可用
          mount();
          return;
        }
        state.settings = { ...DEFAULT_SETTINGS, ...((res && res[SETTINGS_KEY]) || {}) };
        if (state.settings.showFab !== false) mount();
      });
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (err) {
      console.warn('[ColorPick] 初始化失败：', err);
      mount();
    }
  }

  init();
})();
