# 开发自测页面（不属于扩展运行文件）

这些页面用于在没有安装扩展的情况下验证各个模块，可直接双击用浏览器打开，也可以放到任意静态服务器下访问。
它们不会被 `docs/download/ColorPick-1.0.0.zip` 打包。

| 文件 | 用途 | 打开方式 |
| --- | --- | --- |
| `content-test.html` | 模拟扩展 API，验证悬浮按钮、颜色扫描、透明色过滤、oklch 解析、面板交互 | 双击打开，点击右下角「拾取颜色」 |
| `content-large.html` | 生成 3000 个元素，验证大页面扫描性能与分批让出主线程 | 双击打开，页面顶部会显示扫描耗时 |
| `background-test.html` | 加载真实 `background.js`，用假的 `chrome.*` 验证消息处理、四种文件生成、下载序号递增、标签页复用 | 双击打开，自动执行并输出结果 |
| `gallery-preview.html` | 用 `mock.js` 提供 14 条模拟色板数据，预览色板页的布局与交互 | 双击打开（`gallery-preview.html?empty` 查看空状态） |
| `mock.js` | 色板预览页的扩展 API 模拟与示例数据 | 被 `gallery-preview.html` 引入 |
| `make-preview.js` | 由根目录 `color-gallery.html` 重新生成预览页：`node tests/make-preview.js` | 命令行 |
| `make-icons.py` | 重新生成 `icons/` 下的扩展图标（需要 Pillow + numpy） | 命令行 |
