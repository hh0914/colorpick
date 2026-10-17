/**
 * ColorPick 拾色助手 —— 后台 Service Worker（Manifest V3）
 *
 * 职责：
 *   1. 接收内容脚本上报的页面颜色，存入 chrome.storage.session；
 *   2. 打开 / 复用色板页（color-gallery.html）；
 *   3. 根据勾选结果生成 CSS / SCSS / JSON / TXT 文件，用 chrome.downloads 下载；
 *   4. 点击工具栏图标时，对当前标签页触发一次扫描；
 *   5. 转发下载状态，供色板页展示提示。
 */
'use strict';

/* ------------------------------ 常量定义 ------------------------------ */

const GALLERY_PAGE = 'color-gallery.html';
const COLORS_KEY = 'cpk_colors'; // 色板数据
const SETTINGS_KEY = 'cpk_settings'; // 用户设置
const SEQ_KEY = 'cpk_export_seq'; // 导出序号（文件名 page_color_001）
const GALLERY_TAB_KEY = 'cpk_gallery_tab'; // 已打开的色板页标签 ID

const DEFAULT_SETTINGS = { showFab: true };

// 存储区域：优先使用 storage.session（内存级、不落盘），旧版本降级到 local
const store = chrome.storage.session || chrome.storage.local;

/** 已发起但尚未完成的下载：downloadId -> 文件名 */
const pendingDownloads = new Map();

/** 色板页标签 ID 的内存缓存 */
let galleryTabId = null;

/* ------------------------------ 工具函数 ------------------------------ */

/** 保存到存储 */
function storeSet(items) {
  return new Promise((resolve) => {
    store.set(items, () => {
      // 忽略 lastError（例如页面卸载时），保证流程不中断
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/** 读取存储 */
function storeGet(keys) {
  return new Promise((resolve) => {
    store.get(keys, (res) => {
      void chrome.runtime.lastError;
      resolve(res || {});
    });
  });
}

/** 数字补零：1 -> '001' */
function pad3(num) {
  return String(num).padStart(3, '0');
}

/** 格式化为 2026-10-17 12:48:00 */
function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 清理写进 CSS / SCSS 注释里的文本，避免注释被提前闭合或换行 */
function sanitizeComment(text) {
  return String(text || '')
    .replace(/\*\//g, '* /')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
}

/** 颜色的最终输出值：半透明颜色输出 rgba()，不透明输出 HEX */
function colorValue(color) {
  const alpha = typeof color.a === 'number' ? color.a : 1;
  return alpha < 1 ? color.rgb : color.hex;
}

/** 字符串 -> UTF-8 的 Base64（Service Worker 中无法使用 URL.createObjectURL） */
function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** 生成可直接下载的 data URL */
function toDataUrl(content, mime) {
  return `data:${mime};charset=utf-8;base64,${toBase64Utf8(content)}`;
}

/** 向所有扩展页面广播消息（没有接收方时静默失败） */
function broadcast(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    // 无接收方时忽略
  }
}

/* ------------------------------ 文件生成 ------------------------------ */

/**
 * 根据格式生成文件内容
 * @param {'css'|'scss'|'json'|'txt'} format
 * @param {Array} colors 选中的颜色
 * @param {Object} meta 页面信息
 * @returns {{content:string, ext:string, mime:string}}
 */
function buildExportFile(format, colors, meta) {
  const exportedAt = formatTime(new Date());
  const title = sanitizeComment(meta && meta.title ? meta.title : '未命名页面');
  const url = sanitizeComment(meta && meta.url ? meta.url : '');
  const total = colors.length;

  if (format === 'scss') {
    const lines = [
      '// ColorPick 拾色助手 · 页面色板',
      `// 页面：${title}`,
      `// 链接：${url}`,
      `// 导出：${exportedAt}`,
      `// 共 ${total} 种颜色`,
      ''
    ];
    colors.forEach((color, index) => {
      lines.push(
        `$color-${pad3(index + 1)}: ${colorValue(color)}; // ${color.rgb} · 出现 ${color.count} 次`
      );
    });
    lines.push('');
    return { content: lines.join('\n'), ext: 'scss', mime: 'text/plain' };
  }

  if (format === 'json') {
    const data = {
      generator: 'ColorPick 拾色助手',
      version: '1.0.0',
      page: {
        title: title,
        url: url,
        scannedAt: meta && meta.updatedAt ? formatTime(new Date(meta.updatedAt)) : ''
      },
      exportedAt: exportedAt,
      total: total,
      colors: colors.map((color, index) => ({
        index: index + 1,
        hex: color.hex,
        rgb: color.rgb,
        r: color.r,
        g: color.g,
        b: color.b,
        alpha: typeof color.a === 'number' ? color.a : 1,
        count: color.count,
        sources: {
          text: color.text || 0,
          background: color.bg || 0,
          border: color.border || 0
        },
        manual: !!color.manual
      }))
    };
    return {
      content: JSON.stringify(data, null, 2),
      ext: 'json',
      mime: 'application/json'
    };
  }

  if (format === 'txt') {
    const lines = [
      'ColorPick 拾色助手 · 页面色板',
      `页面：${title}`,
      `链接：${url}`,
      `导出：${exportedAt}`,
      `共 ${total} 种颜色`,
      '',
      '序号   HEX        RGB                          次数',
      '----   --------   --------------------------   ----'
    ];
    colors.forEach((color, index) => {
      const rgb = String(color.rgb);
      lines.push(
        `${pad3(index + 1)}    ${color.hex.padEnd(10)} ${rgb.padEnd(28)} ${color.count}`
      );
    });
    lines.push('');
    return { content: lines.join('\n'), ext: 'txt', mime: 'text/plain' };
  }

  // 默认：CSS 变量
  const lines = [
    '/* ColorPick 拾色助手 · 页面色板 */',
    `/* 页面：${title} */`,
    `/* 链接：${url} */`,
    `/* 导出：${exportedAt} */`,
    `/* 共 ${total} 种颜色 */`,
    '',
    ':root {'
  ];
  colors.forEach((color, index) => {
    lines.push(
      `  --color-${pad3(index + 1)}: ${colorValue(color)}; /* ${color.rgb} · 出现 ${
        color.count
      } 次 */`
    );
  });
  lines.push('}', '');
  return { content: lines.join('\n'), ext: 'css', mime: 'text/css' };
}

/** 读取并自增导出序号 */
async function nextExportSeq() {
  const res = await new Promise((resolve) => {
    chrome.storage.local.get(SEQ_KEY, (data) => {
      void chrome.runtime.lastError;
      resolve(data || {});
    });
  });
  const next = Number(res[SEQ_KEY] || 0) + 1;
  await new Promise((resolve) => {
    chrome.storage.local.set({ [SEQ_KEY]: next }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  return next;
}

/* ------------------------------ 下载处理 ------------------------------ */

/**
 * 生成并下载色值文件
 * @param {'css'|'scss'|'json'|'txt'} format
 * @param {Array} colors
 * @param {Object} meta
 */
async function handleDownload(format, colors, meta) {
  if (!Array.isArray(colors) || colors.length === 0) {
    return { ok: false, error: '没有选中任何颜色' };
  }

  const validFormats = ['css', 'scss', 'json', 'txt'];
  const safeFormat = validFormats.includes(format) ? format : 'css';

  const { content, ext, mime } = buildExportFile(safeFormat, colors, meta || {});
  const seq = await nextExportSeq();
  // 文件名规则：page_color_序号（序号补零到 3 位）
  const filename = `page_color_${pad3(seq)}.${ext}`;
  const url = toDataUrl(content, mime);

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: 'uniquify' },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || '下载失败'));
        } else {
          resolve(id);
        }
      }
    );
  });

  pendingDownloads.set(downloadId, filename);
  broadcast({ type: 'DOWNLOAD_STATUS', status: 'started', filename, downloadId });

  return { ok: true, filename, downloadId, size: content.length };
}

/* ------------------------------ 色板页管理 ------------------------------ */

/** 读取已保存的色板页标签 ID */
async function resolveGalleryTabId() {
  if (galleryTabId !== null) return galleryTabId;
  const res = await storeGet(GALLERY_TAB_KEY);
  galleryTabId = typeof res[GALLERY_TAB_KEY] === 'number' ? res[GALLERY_TAB_KEY] : null;
  return galleryTabId;
}

/** 打开或复用色板页 */
async function openGallery() {
  const url = chrome.runtime.getURL(GALLERY_PAGE);
  const tabId = await resolveGalleryTabId();

  if (tabId !== null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.id === tabId) {
        await chrome.tabs.update(tabId, { active: true });
        if (typeof tab.windowId === 'number') {
          try {
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch (err) {
            // 窗口可能已关闭，忽略
          }
        }
        // 重新加载以读取最新色板数据
        try {
          await chrome.tabs.reload(tabId);
        } catch (err) {
          // 忽略
        }
        return { ok: true, tabId };
      }
    } catch (err) {
      // 标签页已被关闭，走新建流程
      galleryTabId = null;
      await storeSet({ [GALLERY_TAB_KEY]: null });
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  galleryTabId = typeof tab.id === 'number' ? tab.id : null;
  await storeSet({ [GALLERY_TAB_KEY]: galleryTabId });
  return { ok: true, tabId: galleryTabId };
}

/* ------------------------------ 消息处理 ------------------------------ */

/**
 * 保存扫描结果
 * @param {Array} colors
 * @param {Object} meta
 */
async function handleScanResult(colors, meta) {
  if (!Array.isArray(colors)) {
    return { ok: false, error: '颜色数据格式错误' };
  }
  const payload = {
    colors,
    meta: meta || {},
    updatedAt: Date.now()
  };
  await storeSet({ [COLORS_KEY]: payload });
  const opened = await openGallery();
  return { ok: true, count: colors.length, tabId: opened.tabId };
}

/** 手动吸管取色：合并进当前色板数据 */
async function handleAddColor(color, meta) {
  if (!color || !color.hex) return { ok: false, error: '颜色数据为空' };

  const res = await storeGet(COLORS_KEY);
  const payload = res[COLORS_KEY] || { colors: [], meta: meta || {}, updatedAt: Date.now() };
  const colors = Array.isArray(payload.colors) ? payload.colors.slice() : [];
  const key = color.key || `${color.hex}|1`;
  const existing = colors.find((item) => (item.key || `${item.hex}|1`) === key);

  if (existing) {
    existing.count = Number(existing.count || 0) + 1;
    existing.manual = true;
  } else {
    colors.unshift({ ...color, manual: true });
  }

  payload.colors = colors;
  payload.meta = payload.meta && payload.meta.url ? payload.meta : meta || payload.meta || {};
  payload.updatedAt = Date.now();

  await storeSet({ [COLORS_KEY]: payload });
  return { ok: true, count: colors.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  // 只处理已知的消息类型，其余交给其它监听者
  const supported = ['SCAN_RESULT', 'ADD_COLOR', 'OPEN_GALLERY', 'DOWNLOAD'];
  if (!supported.includes(message.type)) return undefined;

  const task =
    message.type === 'SCAN_RESULT'
      ? handleScanResult(message.colors, message.meta)
      : message.type === 'ADD_COLOR'
        ? handleAddColor(message.color, message.meta)
        : message.type === 'OPEN_GALLERY'
          ? openGallery()
          : handleDownload(message.format, message.colors, message.meta);

  task
    .then((result) => {
      if (result) sendResponse(result);
    })
    .catch((error) => {
      console.error('[ColorPick] 后台处理失败：', error);
      sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
    });

  // 异步响应，保持消息通道开启
  return true;
});

/* ------------------------------ 下载状态 ------------------------------ */

chrome.downloads.onChanged.addListener((delta) => {
  const filename = pendingDownloads.get(delta.id);
  if (!filename) return;

  const state = delta.state && delta.state.current;
  if (state === 'complete') {
    pendingDownloads.delete(delta.id);
    broadcast({ type: 'DOWNLOAD_STATUS', status: 'complete', filename, downloadId: delta.id });
  } else if (state === 'interrupted') {
    pendingDownloads.delete(delta.id);
    broadcast({
      type: 'DOWNLOAD_STATUS',
      status: 'error',
      filename,
      downloadId: delta.id,
      reason: delta.error && delta.error.current ? delta.error.current : '下载被中断'
    });
  }
});

/* ------------------------------ 工具栏图标 ------------------------------ */

/** 确保目标页面已注入内容脚本，然后触发扫描 */
async function triggerScanOnTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'CPK_TRIGGER_SCAN' });
    if (res && res.ok) return true;
  } catch (err) {
    // 该标签页尚未注入内容脚本（例如安装插件前就已打开），继续尝试注入
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    // 等待脚本初始化后再发送触发消息
    await new Promise((resolve) => setTimeout(resolve, 120));
    const res = await chrome.tabs.sendMessage(tabId, { type: 'CPK_TRIGGER_SCAN' });
    return !!(res && res.ok);
  } catch (err) {
    console.warn('[ColorPick] 无法在当前页面注入脚本：', err);
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || typeof tab.id !== 'number') return;
  const triggered = await triggerScanOnTab(tab.id);
  if (!triggered) {
    // 受限页面（edge://、扩展商店等）无法注入，直接打开色板页
    await openGallery();
  }
});

/* ------------------------------ 生命周期 ------------------------------ */

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === galleryTabId) {
    galleryTabId = null;
    await storeSet({ [GALLERY_TAB_KEY]: null });
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    const res = await chrome.storage.sync.get(SETTINGS_KEY);
    if (!res || !res[SETTINGS_KEY]) {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    }
  } catch (err) {
    // 忽略
  }

  // 安装后首次打开色板页，方便用户了解功能
  if (details && details.reason === 'install') {
    await openGallery();
  }
});

// Service Worker 冷启动时恢复标签页缓存
resolveGalleryTabId();
