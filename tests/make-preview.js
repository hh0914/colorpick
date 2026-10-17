/**
 * 生成 tests/gallery-preview.html（开发用）
 *
 * 用法：node tests/make-preview.js
 * 作用：把根目录的 color-gallery.html 复制为预览页，并注入 mock.js 模拟扩展 API，
 *       这样不安装扩展也能在普通浏览器里查看色板页效果。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'color-gallery.html'), 'utf8');

// 修正相对路径：预览页位于 tests/ 子目录
html = html
  .replace('href="color-gallery.css"', 'href="../color-gallery.css"')
  .replace(
    '<script src="color-gallery.js"></script>',
    '<script src="mock.js"></script>\n    <script src="../color-gallery.js"></script>'
  );

fs.writeFileSync(path.join(__dirname, 'gallery-preview.html'), html);
console.log('preview ready:', html.includes('mock.js'));
