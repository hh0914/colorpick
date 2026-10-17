# ColorPick 拾色助手

一款 Edge 浏览器扩展（Manifest V3）：一键拾取网页中的**文字色、背景色、边框色**，也支持吸管手动取色，在独立色板页勾选后批量导出 **CSS 变量 / SCSS 变量 / JSON / TXT** 色值文件。

> 官网（GitHub Pages）：<https://hh0914.github.io/colorpick/>
> 源码仓库：<https://github.com/hh0914/colorpick>

---

## 一、文件结构

```
day3/
├── manifest.json            # 扩展清单（MV3）
├── background.js            # Service Worker：消息转发、文件生成、下载、标签页管理
├── content.js               # 内容脚本：悬浮按钮、页面颜色扫描、吸管取色
├── content.css              # 悬浮按钮与面板样式（#cpk-root 作用域隔离）
├── color-gallery.html       # 色板页（新标签页展示）
├── color-gallery.css        # 色板页样式
├── color-gallery.js         # 色板页逻辑：勾选、复制、排序、导出
├── icons/                   # 扩展图标 16 / 32 / 48 / 128
├── docs/                    # 官方宣传网站（纯静态，含插件 zip）
├── tests/                   # 开发自测页面（非扩展运行文件，详见 tests/README.md）
└── README.md
```

---

## 二、安装（edge://extensions/ 加载已解压的扩展）

1. 准备好本项目文件夹（或解压下载的 zip）。
2. 打开 Edge，地址栏输入 `edge://extensions/` 并回车。
3. 打开页面侧边栏（或右下角）的 **「开发人员模式」** 开关。
4. 点击 **「加载解压缩的扩展」**，选择包含 `manifest.json` 的文件夹。
5. 安装完成后，可在工具栏的扩展菜单中把 ColorPick 固定到地址栏右侧。

> 修改代码后，回到 `edge://extensions/` 点击该扩展卡片上的「重新加载」即可生效，然后刷新测试页面。

---

## 三、使用说明

### 1. 扫描页面颜色

- 打开任意网页，右下角会出现悬浮按钮 **「拾取颜色」**。
- 点击按钮即开始扫描：文字色（`color`）、背景色（`background-color`）、可见边框色（`border-*-color`）。
- 扫描完成后自动打开**色板页**新标签页，并把汇总结果通过 `chrome.runtime.sendMessage` 交给后台保存。

### 2. 手动吸管取色

- 在悬浮面板点击 **「吸管取色」**，移动鼠标到页面任意位置单击即可取色，按 `Esc` 取消。
- 取到的色值会自动复制到剪贴板，并追加到色板数据中（卡片上会带「吸管」标记）。
- 吸管功能需要 Edge 95 及以上版本；不支持时会给出提示。

### 3. 色板页操作

| 操作 | 说明 |
| --- | --- |
| 点击色块 / HEX | 复制该颜色 HEX 到剪贴板 |
| 勾选框 | 选择需要导出的颜色 |
| 全选 / 反选 / 清空 | 批量调整勾选 |
| 排序 | 按出现频次 / 按色相 / 按色值 |
| 格式 | CSS 变量、SCSS 变量、JSON、TXT |
| 下载选中 | 生成文件并通过 `chrome.downloads` 保存到默认下载目录 |

- 文件名规则：`page_color_序号.扩展名`，序号补零到 3 位（如 `page_color_001.css`），每次导出递增。
- 下载开始与完成（或被中断）都会在色板页底部给出提示。

### 4. 关闭 / 恢复悬浮按钮

- 悬浮面板底部点击 **「隐藏悬浮按钮」**；
- 或打开色板页，在页脚开关「在网页右下角显示悬浮按钮」重新开启。
- 设置保存在 `chrome.storage.sync`，内容脚本通过 `storage.onChanged` 实时响应，刷新页面后依然生效。

---

## 四、实现要点

- **权限**：`activeTab`、`scripting`、`downloads`、`storage`、`clipboardWrite`；`host_permissions: <all_urls>`。
- **颜色解析**：`getComputedStyle` 读取计算样式；`rgb()/rgba()` 直接解析，`hsl()/lab()/oklch()` 等新语法借助 1×1 画布归一化为 RGBA（带缓存，避免重复解析）。
- **过滤与去重**：丢弃 `transparent` 与 `alpha < 0.05` 的无效颜色；按「HEX + 透明度」合并，统计出现次数以及文字 / 背景 / 边框来源。
- **性能**：单页最多扫描 12000 个元素，每 400 个让出一次主线程，超大页面不卡死。
- **SPA 兼容**：悬浮 UI 挂载在 `<html>` 上，并用 `MutationObserver` 监听被移除后自动重新挂载；扫描始终读取当前 DOM，动态渲染的内容同样能取到。
- **下载实现**：Service Worker 中无法使用 `URL.createObjectURL`，因此用 `TextEncoder + btoa` 生成 Base64 data URL，再交给 `chrome.downloads.download`。
- **状态存储**：色板数据存放在 `chrome.storage.session`（不落盘，浏览器重启即清空），设置存放在 `chrome.storage.sync`。

---

## 五、常见问题

**Q：网页右下角没有出现「拾取颜色」？**
A：① 检查色板页页脚的悬浮按钮开关；② 刷新页面（插件安装前已打开的标签页不会自动注入）；③ `edge://`、扩展商店等受限页面无法注入内容脚本。

**Q：点击工具栏图标没反应？**
A：会尝试对当前标签页注入内容脚本并触发扫描；若页面受限，则直接打开色板页。

**Q：色板页提示「读取色板数据失败」？**
A：请通过扩展打开（扫描后自动打开，或点击工具栏图标），不要直接双击 `color-gallery.html`，后者没有扩展 API。

**Q：颜色数量和预期不一致？**
A：只统计**实际渲染**的元素（`display: none` 会被跳过），且边框色仅在该边框有宽度、有样式时统计；渐变背景（`background-image`）不参与统计。

---

## 六、官网（docs）

`docs/index.html` 是插件的静态宣传网站，纯 HTML + CSS + 原生 JS，无构建步骤、无 CDN、无外部图片：

- 双击 `docs/index.html` 即可在浏览器中预览（`file://` 下功能正常）；
- 主色调在 `docs/css/style.css` 顶部的 `:root` 中修改 `--primary`、`--accent`、`--gradient`；
- 文案直接改 `docs/index.html` 对应区块即可；
- 「下载插件」按钮指向 `docs/download/ColorPick-1.0.0.zip`，可替换为最新打包文件。
