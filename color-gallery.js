/**
 * ColorPick 拾色助手 —— 色板页逻辑
 *
 * 功能：读取后台保存的颜色数据 → 网格渲染 → 勾选 / 复制 / 排序 →
 *       选择格式后调用 chrome.downloads 批量导出。
 */
(() => {
  'use strict';

  /* ------------------------------ 常量与状态 ------------------------------ */

  const COLORS_KEY = 'cpk_colors';
  const SETTINGS_KEY = 'cpk_settings';
  const FORMAT_PREF = 'cpk_last_format';
  const SORT_PREF = 'cpk_last_sort';

  const state = {
    colors: [],
    meta: {},
    selected: new Set(), // 已勾选颜色的 key
    sort: 'count',
    format: 'css',
    selectionTouched: false, // 用户是否手动改过勾选状态
    nodes: new Map() // key -> { article, checkbox }
  };

  let toastTimer = null;

  /* ------------------------------ DOM 引用 ------------------------------ */

  const el = {
    grid: document.getElementById('grid'),
    empty: document.getElementById('empty'),
    banner: document.getElementById('banner'),
    countTotal: document.getElementById('countTotal'),
    countSelected: document.getElementById('countSelected'),
    selectAll: document.getElementById('selectAll'),
    invert: document.getElementById('invert'),
    clear: document.getElementById('clear'),
    sortSelect: document.getElementById('sortSelect'),
    formatSelect: document.getElementById('formatSelect'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadLabel: document.getElementById('downloadLabel'),
    controlsBar: document.getElementById('controlsBar'),
    sourceBox: document.getElementById('sourceBox'),
    sourceTitle: document.getElementById('sourceTitle'),
    sourceTime: document.getElementById('sourceTime'),
    fabToggle: document.getElementById('fabToggle'),
    toast: document.getElementById('toast')
  };

  /* ------------------------------ 工具函数 ------------------------------ */

  const keyOf = (color) => color.key || `${color.hex}|${color.a}`;

  function rgbToHex(r, g, b) {
    return (
      '#' +
      [r, g, b]
        .map((v) => {
          const n = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
          return n.toString(16).padStart(2, '0');
        })
        .join('')
        .toUpperCase()
    );
  }

  /** 计算色相（0~360），无彩色返回 400 方便排在末尾 */
  function hueOf(color) {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (delta === 0) return 400;
    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
  }

  /** 格式化为 10-17 12:48 */
  function formatShort(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  /** 轻提示 */
  function toast(text, type = 'info') {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.className = `toast is-show${type === 'success' ? ' is-success' : ''}${
      type === 'error' ? ' is-error' : ''
    }`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (el.toast) el.toast.className = 'toast';
    }, 2600);
  }

  /** 顶部错误提示条 */
  function showBanner(text) {
    if (!el.banner) return;
    el.banner.textContent = text;
    el.banner.hidden = !text;
  }

  /** 复制文本（clipboardWrite 权限 + execCommand 兜底） */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  /** 存储区域：优先 session（与后台保持一致） */
  function getStorageArea() {
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    return chrome.storage.session || chrome.storage.local;
  }

  /** chrome.runtime.sendMessage 的 Promise 封装 */
  function sendMessage(message) {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ ok: false, error: '当前页面不在扩展环境中' });
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || {});
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  /* ------------------------------ 数据处理 ------------------------------ */

  /** 兜底规范化一条颜色数据，避免旧数据缺字段导致渲染报错 */
  function normalizeColor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const r = Number(raw.r) || 0;
    const g = Number(raw.g) || 0;
    const b = Number(raw.b) || 0;
    const a = typeof raw.a === 'number' ? raw.a : 1;
    let hex = typeof raw.hex === 'string' ? raw.hex.toUpperCase() : '';
    if (!/^#[0-9A-F]{6}$/.test(hex)) hex = rgbToHex(r, g, b);

    return {
      key: typeof raw.key === 'string' && raw.key ? raw.key : `${hex}|${a}`,
      hex,
      r,
      g,
      b,
      a,
      rgb:
        typeof raw.rgb === 'string' && raw.rgb
          ? raw.rgb
          : a < 1
            ? `rgba(${r}, ${g}, ${b}, ${a})`
            : `rgb(${r}, ${g}, ${b})`,
      count: Number(raw.count) || 1,
      text: Number(raw.text) || 0,
      bg: Number(raw.bg) || 0,
      border: Number(raw.border) || 0,
      manual: !!raw.manual
    };
  }

  /** 读取色板数据 */
  function readColors() {
    return new Promise((resolve, reject) => {
      const area = getStorageArea();
      if (!area) {
        reject(new Error('当前页面无法访问扩展存储'));
        return;
      }
      area.get(COLORS_KEY, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res ? res[COLORS_KEY] : null);
      });
    });
  }

  /** 应用数据（保留仍然存在的勾选项） */
  function applyData(data) {
    if (!data || !Array.isArray(data.colors)) {
      state.colors = [];
      state.meta = {};
      return;
    }
    state.colors = data.colors.map(normalizeColor).filter(Boolean);
    state.meta = data.meta && typeof data.meta === 'object' ? data.meta : {};

    const available = new Set(state.colors.map(keyOf));
    state.selected = new Set([...state.selected].filter((key) => available.has(key)));

    // 首次加载且用户没手动改过勾选时，默认全选，方便直接导出
    if (!state.selectionTouched && state.selected.size === 0) {
      state.colors.forEach((color) => state.selected.add(keyOf(color)));
    }
  }

  /* ------------------------------ 渲染 ------------------------------ */

  /** 按当前排序规则返回颜色数组 */
  function sortedColors() {
    const list = state.colors.slice();
    if (state.sort === 'hue') {
      list.sort((a, b) => hueOf(a) - hueOf(b) || b.count - a.count);
    } else if (state.sort === 'hex') {
      list.sort((a, b) => a.hex.localeCompare(b.hex));
    } else {
      list.sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));
    }
    return list;
  }

  /** 渲染来源页面信息 */
  function renderMeta() {
    const title = state.meta.title || '未命名页面';
    const hasSource = !!(state.meta.url || state.meta.title || state.colors.length);
    if (el.sourceBox) el.sourceBox.hidden = !hasSource;
    if (el.sourceTitle) {
      el.sourceTitle.textContent = title;
      if (state.meta.url) {
        el.sourceTitle.href = state.meta.url;
        el.sourceTitle.title = state.meta.url;
      } else {
        el.sourceTitle.removeAttribute('href');
        el.sourceTitle.removeAttribute('title');
      }
    }
    if (el.sourceTime) {
      el.sourceTime.textContent = state.meta.updatedAt
        ? `扫描于 ${formatShort(state.meta.updatedAt)}`
        : '';
    }
    document.title = state.colors.length
      ? `${state.colors.length} 种颜色 · ColorPick 拾色助手`
      : '页面色板 · ColorPick 拾色助手';
  }

  /** 创建单个色板卡片 */
  function createSwatch(color) {
    const key = keyOf(color);
    const selected = state.selected.has(key);

    const article = document.createElement('article');
    article.className = `swatch${selected ? ' is-selected' : ''}`;
    article.dataset.key = key;

    // ---- 颜色预览 ----
    const chip = document.createElement('div');
    chip.className = 'chip';

    const fill = document.createElement('span');
    fill.className = 'chip__fill';
    fill.style.background = color.rgb; // 半透明颜色显示为 rgba，可以看到棋盘格
    chip.appendChild(fill);

    // 覆盖整块颜色的复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chip__copy';
    copyBtn.setAttribute('aria-label', `复制色值 ${color.hex}`);
    copyBtn.title = `点击复制 ${color.hex}`;
    copyBtn.addEventListener('click', () => copyColor(color));
    chip.appendChild(copyBtn);

    const hint = document.createElement('span');
    hint.className = 'chip__hint';
    hint.textContent = '点击复制';
    chip.appendChild(hint);

    // ---- 复选框 ----
    const label = document.createElement('label');
    label.className = 'chip__select';
    label.title = '勾选该颜色';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'chip__checkbox';
    checkbox.checked = selected;
    checkbox.setAttribute('aria-label', `选择颜色 ${color.hex}`);

    const box = document.createElement('span');
    box.className = 'chip__box';

    label.appendChild(checkbox);
    label.appendChild(box);
    chip.appendChild(label);

    // ---- 出现次数 ----
    const count = document.createElement('span');
    count.className = 'chip__count';
    count.textContent = `${color.count}×`;
    count.title = `在页面中出现 ${color.count} 次`;
    chip.appendChild(count);

    // ---- 色值信息 ----
    const info = document.createElement('div');
    info.className = 'swatch__info';

    const line = document.createElement('div');
    line.className = 'swatch__line';

    const hexBtn = document.createElement('button');
    hexBtn.type = 'button';
    hexBtn.className = 'swatch__hex';
    hexBtn.textContent = color.hex;
    hexBtn.title = `点击复制 ${color.hex}`;
    hexBtn.addEventListener('click', () => copyColor(color));
    line.appendChild(hexBtn);

    if (color.manual) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '吸管';
      tag.title = '通过吸管取色器手动拾取';
      line.appendChild(tag);
    }

    const rgbText = document.createElement('span');
    rgbText.className = 'swatch__rgb';
    rgbText.textContent = color.rgb;
    rgbText.title = color.rgb;

    info.appendChild(line);
    info.appendChild(rgbText);

    article.appendChild(chip);
    article.appendChild(info);

    // 勾选事件
    checkbox.addEventListener('change', () => {
      state.selectionTouched = true;
      if (checkbox.checked) state.selected.add(key);
      else state.selected.delete(key);
      article.classList.toggle('is-selected', checkbox.checked);
      updateStats();
    });

    state.nodes.set(key, { article, checkbox });
    return article;
  }

  /** 完整渲染 */
  function render() {
    const colors = sortedColors();
    state.nodes.clear();

    if (el.grid) {
      el.grid.textContent = '';
      const fragment = document.createDocumentFragment();
      colors.forEach((color) => fragment.appendChild(createSwatch(color)));
      el.grid.appendChild(fragment);
      el.grid.hidden = colors.length === 0;
    }

    if (el.empty) el.empty.hidden = colors.length > 0;
    if (el.controlsBar) el.controlsBar.hidden = colors.length === 0;
    if (el.downloadBtn) el.downloadBtn.disabled = colors.length === 0;

    renderMeta();
    updateStats();
  }

  /** 更新统计数字 */
  function updateStats() {
    if (el.countTotal) el.countTotal.textContent = String(state.colors.length);
    if (el.countSelected) el.countSelected.textContent = String(state.selected.size);
  }

  /* ------------------------------ 交互逻辑 ------------------------------ */

  /** 点击色板复制色值 */
  async function copyColor(color) {
    const ok = await copyText(color.hex);
    toast(ok ? `已复制 ${color.hex}` : '复制失败，请手动选择复制', ok ? 'success' : 'error');
  }

  /** 同步所有卡片的勾选状态到界面 */
  function syncSelectionUI() {
    state.nodes.forEach(({ article, checkbox }, key) => {
      const checked = state.selected.has(key);
      checkbox.checked = checked;
      article.classList.toggle('is-selected', checked);
    });
    updateStats();
  }

  function selectAll() {
    state.selectionTouched = true;
    state.selected = new Set(state.colors.map(keyOf));
    syncSelectionUI();
    toast(`已选中全部 ${state.selected.size} 种颜色`);
  }

  function invertSelection() {
    state.selectionTouched = true;
    const next = new Set();
    state.colors.forEach((color) => {
      const key = keyOf(color);
      if (!state.selected.has(key)) next.add(key);
    });
    state.selected = next;
    syncSelectionUI();
    toast(`已反选，当前选中 ${state.selected.size} 种颜色`);
  }

  function clearSelection() {
    state.selectionTouched = true;
    state.selected.clear();
    syncSelectionUI();
    toast('已清空勾选');
  }

  /** 批量下载选中颜色 */
  async function downloadSelected() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      toast('请在扩展环境中使用下载功能', 'error');
      return;
    }

    const chosen = sortedColors().filter((color) => state.selected.has(keyOf(color)));
    if (chosen.length === 0) {
      toast('请先勾选要导出的颜色', 'error');
      return;
    }

    const originLabel = el.downloadLabel.textContent;
    el.downloadBtn.disabled = true;
    el.downloadLabel.textContent = '生成中…';

    const result = await sendMessage({
      type: 'DOWNLOAD',
      format: state.format,
      meta: state.meta,
      colors: chosen.map((color) => ({
        key: color.key,
        hex: color.hex,
        rgb: color.rgb,
        r: color.r,
        g: color.g,
        b: color.b,
        a: color.a,
        count: color.count,
        text: color.text,
        bg: color.bg,
        border: color.border,
        manual: color.manual
      }))
    });

    el.downloadBtn.disabled = false;
    el.downloadLabel.textContent = originLabel;

    if (result && result.ok) {
      toast(`已开始下载：${result.filename}（${chosen.length} 种颜色）`, 'success');
    } else {
      toast(`下载失败：${(result && result.error) || '未知错误'}`, 'error');
    }
  }

  /* ------------------------------ 设置与偏好 ------------------------------ */

  /** 读取「悬浮按钮」开关状态 */
  function loadSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage) return;
    try {
      chrome.storage.sync.get(SETTINGS_KEY, (res) => {
        if (chrome.runtime.lastError) return;
        const settings = (res && res[SETTINGS_KEY]) || {};
        el.fabToggle.checked = settings.showFab !== false;
      });
    } catch (err) {
      // 忽略
    }
  }

  /** 保存「悬浮按钮」开关（内容脚本会通过 storage.onChanged 实时响应） */
  function saveSettings() {
    const showFab = el.fabToggle.checked;
    if (typeof chrome === 'undefined' || !chrome.storage) {
      toast('当前环境无法保存设置', 'error');
      return;
    }
    chrome.storage.sync.set({ [SETTINGS_KEY]: { showFab } }, () => {
      if (chrome.runtime.lastError) {
        toast('设置保存失败，请重试', 'error');
        return;
      }
      toast(showFab ? '已开启悬浮按钮，返回网页即可看到' : '已关闭悬浮按钮', 'success');
    });
  }

  /** 读取上次使用的格式 / 排序 */
  function restorePrefs() {
    try {
      const format = localStorage.getItem(FORMAT_PREF);
      const sort = localStorage.getItem(SORT_PREF);
      if (['css', 'scss', 'json', 'txt'].includes(format)) state.format = format;
      if (['count', 'hue', 'hex'].includes(sort)) state.sort = sort;
    } catch (err) {
      // 隐私模式下 localStorage 可能不可用，忽略即可
    }
    el.formatSelect.value = state.format;
    el.sortSelect.value = state.sort;
  }

  /** 事件绑定 */
  function bindEvents() {
    el.selectAll.addEventListener('click', selectAll);
    el.invert.addEventListener('click', invertSelection);
    el.clear.addEventListener('click', clearSelection);
    el.downloadBtn.addEventListener('click', downloadSelected);

    el.sortSelect.addEventListener('change', () => {
      state.sort = el.sortSelect.value;
      try {
        localStorage.setItem(SORT_PREF, state.sort);
      } catch (err) {
        // 忽略
      }
      render();
    });

    el.formatSelect.addEventListener('change', () => {
      state.format = el.formatSelect.value;
      try {
        localStorage.setItem(FORMAT_PREF, state.format);
      } catch (err) {
        // 忽略
      }
    });

    el.fabToggle.addEventListener('change', saveSettings);
  }

  /** 监听色板数据变化：网页重新扫描 / 吸管新增时实时刷新 */
  function watchStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage) return;

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (!changes[COLORS_KEY]) return;
      applyData(changes[COLORS_KEY].newValue);
      render();
      toast('色板数据已更新', 'success');
    });

    // 下载状态回调
    try {
      chrome.runtime.onMessage.addListener((message) => {
        if (!message || message.type !== 'DOWNLOAD_STATUS') return undefined;
        if (message.status === 'complete') {
          toast(`下载完成：${message.filename}`, 'success');
        } else if (message.status === 'error') {
          toast(`下载失败：${message.filename}（${message.reason || '未知原因'}）`, 'error');
        }
        return undefined;
      });
    } catch (err) {
      // 忽略
    }
  }

  /* ------------------------------ 启动 ------------------------------ */

  async function init() {
    bindEvents();
    restorePrefs();
    loadSettings();

    try {
      const data = await readColors();
      applyData(data);
      showBanner('');
    } catch (err) {
      applyData(null);
      showBanner(
        '读取色板数据失败：请在扩展中打开本页（点击工具栏插件图标 → 查看色板），不要直接双击 HTML 文件。'
      );
    }

    render();
    watchStorage();
  }

  init();
})();
