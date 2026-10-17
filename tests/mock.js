// 临时预览脚本：模拟扩展环境（不随扩展发布）
const raw = [
  ['#FFFFFF', 255, 255, 255, 1, 412, 0, 300, 112],
  ['#1B1830', 27, 24, 48, 1, 208, 190, 4, 14],
  ['#7C5CFF', 124, 92, 255, 1, 96, 18, 22, 56],
  ['#F5F4FA', 245, 244, 250, 1, 88, 0, 88, 0],
  ['#FF6BCB', 255, 107, 203, 1, 41, 6, 20, 15],
  ['#6E6A85', 110, 106, 133, 1, 37, 35, 2, 0],
  ['#E9E6F2', 233, 230, 242, 1, 30, 0, 30, 0],
  ['#33D6A6', 51, 214, 166, 1, 12, 3, 6, 3],
  ['#FFB86B', 255, 184, 107, 1, 9, 2, 4, 3],
  ['#7C5CFF', 124, 92, 255, 0.12, 8, 0, 8, 0],
  ['#FFFFFF', 255, 255, 255, 0.72, 6, 0, 6, 0],
  ['#0F172A', 15, 23, 42, 1, 5, 5, 0, 0],
  ['#94A3B8', 148, 163, 184, 1, 4, 4, 0, 0],
  ['#EF4444', 239, 68, 68, 1, 3, 1, 1, 1]
];
const colors = raw.map(([hex, r, g, b, a, count, text, bg, border]) => ({
  key: hex + '|' + a,
  hex, r, g, b, a,
  rgb: a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : `rgb(${r}, ${g}, ${b})`,
  count, text, bg, border, manual: hex === '#FF6BCB'
}));
const data = location.search.includes('empty')
  ? null
  : {
      colors,
      meta: {
        title: '设计系统 · 色彩规范 Design Tokens',
        url: 'https://example.com/design/tokens',
        updatedAt: Date.now()
      }
    };

window.chrome = {
  storage: {
    session: { get(keys, cb) { cb({ cpk_colors: data }); } },
    local: { get(keys, cb) { cb({}); }, set(obj, cb) { cb && cb(); } },
    sync: {
      get(k, cb) { cb({ cpk_settings: { showFab: true } }); },
      set(o, cb) { cb && cb(); }
    },
    onChanged: { addListener() {} }
  },
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) { cb({ ok: true, filename: 'page_color_001.css' }); },
    onMessage: { addListener() {} }
  }
};
