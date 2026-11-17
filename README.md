# DrawGraph — 在 VS Code 中预览和编辑 Draw.io / Mermaid / PlantUML

[![CI](https://github.com/aimuch/vscode-DrawGraph/actions/workflows/ci.yml/badge.svg)](https://github.com/aimuch/vscode-DrawGraph/actions/workflows/ci.yml)

DrawGraph 是一个 VS Code 插件，把三种常用的图表格式放进同一个编辑器里：

| 格式 | 文件扩展名 | 编辑方式 |
| --- | --- | --- |
| **draw.io** | `.drawio` `.dio` `.drawio.xml` `.dio.xml` `.drawio.svg` `.dio.svg` `.drawio.png` `.dio.png` | 可视化编辑器（内嵌 draw.io），直接拖拽编辑 |
| **Mermaid** | `.mmd` `.mermaid`，以及 Markdown 中的 ```` ```mermaid ```` 代码块 | 文本编辑 + 实时预览 + 一键转 draw.io |
| **PlantUML** | `.puml` `.plantuml` `.pu` `.iuml` `.wsd`，以及 Markdown 中的 ```` ```plantuml ```` / ```` ```puml ```` 代码块 | 文本编辑 + 实时预览 |

## 安装

在 [Releases](https://github.com/aimuch/vscode-DrawGraph/releases) 页面下载 `.vsix` 安装包：

- **nightly**：`main` 分支每次推送后自动构建的最新版本（每次推送都会替换）。
- **vX.Y.Z**：正式版本。

然后在 VS Code 扩展视图右上角的 `…` 菜单中选择「从 VSIX 安装…」，或者在终端运行：

```bash
code --install-extension drawgraph-0.2.0.vsix
```

安装包是离线的（Mermaid 已打包在内），但 draw.io 编辑器默认仍从 embed.diagrams.net 加载，见下文“渲染方式与隐私”。

## 功能

### draw.io 可视化编辑器
- 打开 `.drawio` 文件时自动使用内嵌的 draw.io 编辑器。界面语言跟随 VS Code，亮/暗主题可自动匹配。
- 编辑内容实时同步到 VS Code 文档：未保存标记、保存、撤销文本改动、还原、热退出都按 VS Code 的原生方式工作。在 draw.io 里按 `Cmd/Ctrl+S` 会直接保存文件。
- 在外部修改文件（文本编辑器、`git checkout` 等）后，图表会自动重新加载。
- 编辑器标题栏菜单可以**导出为 SVG / PNG**，或直接**复制为 PNG / SVG** 到剪贴板。导出的文件内嵌了图表数据（`.drawio.svg` / `.drawio.png`），之后还能再用 draw.io 打开编辑。
- 点击“以文本方式打开”可查看或编辑原始 XML。
- **焦点在 draw.io 里时，常用 VS Code 快捷键照样可用**：F1 / `Cmd+Shift+P`（命令面板）、`Cmd+P`（快速打开）、`Cmd+W`、`Cmd+N`、`Cmd+O`、`Cmd+Shift+N/T/W/X`、`Cmd+\`、`Cmd+1…9`、`Ctrl+Tab`、``Ctrl+` ``（Windows/Linux 上把 `Cmd` 换成 `Ctrl`），你自定义的快捷键也会生效。其余组合键仍归 draw.io 使用（如 `Cmd+B` 加粗、`Cmd+C/V` 复制粘贴、`Cmd+Z` 撤销）。因此 `Cmd+Shift+P` 和 `Cmd+P` 不再触发 draw.io 的格式面板和打印（两者在 draw.io 的工具栏和菜单里都有入口）；如果你更想保留 draw.io 的行为，可以关闭 `drawGraph.drawio.vscodeShortcuts`。
- **`.drawio.svg` 与 `.drawio.png` 文件**：既是普通的 SVG / PNG 图片（可以直接放进 README、网页、文档里显示），又能在 VS Code 里双击直接用 draw.io 打开编辑。每次编辑保存后都会更新图像并保留内嵌图表数据。
  - SVG 配色：draw.io 默认写出“自适应”的 SVG，查看者（GitHub、浏览器、系统）处于深色模式时，图片会显示成深色。想让图片颜色固定，可以把 `drawGraph.drawio.svgColorScheme` 设为 `light`（或 `dark`），在下次编辑或导出时生效。
- **自定义图形库**：通过 `drawGraph.drawio.customLibraries` 配置工作区内的 `<mxlibrary>` `.xml` 文件或 HTTPS 地址，打开编辑器时自动挂载到左侧元件栏。
- **纯净界面（默认隐藏右下角 GitHub 图标）**：默认隐藏 draw.io 界面右下角的 GitHub 徽标小图标，需要时可在设置抽屉或 `drawGraph.drawio.hideGithubIcon` 中随时开关。
- **架构与代码双向链接（Code Links）**：在 draw.io 节点标签或链接中写入 `#类名`、`#函数名` 或 `src/path/file.ts:42`，即可通过状态栏 `$(link) 代码链接` 或 `DrawGraph: 跳转 Draw.io 代码链接…` 直接跳转到工作区源码定义；也可使用 `DrawGraph: 向 Draw.io 插入工作区代码符号…` 搜索并将工作区符号一键插入画布。

### Mermaid 与 PlantUML 实时预览与编辑智能
- 用 `Cmd/Ctrl+K V`、`Alt+D`（在侧边打开）或 `Cmd/Ctrl+Shift+V` 打开预览，也可以点击编辑器右上角按钮或图表上方的 **CodeLens 快捷操作**。
- **单面板动态跟随与固定（Pin）**：预览窗口默认自动跟随当前切换到的 Mermaid / PlantUML 文件；点击工具栏「固定（Pin）」按钮可将其锁定到当前文件以便并排对比。
- 边输入边刷新。语法错误时保留上一次成功渲染的图，并在编辑器对应行标出**红色波浪线诊断**（同步到「问题」面板）。
- 支持缩放（工具栏、`Ctrl/Cmd+滚轮`、触控板双指缩放、`+` / `-` / `0` 键）、拖拽平移、适应窗口（`f` 键），以及**背景切换**（自动 / 浅色 / 深色 / 透明棋盘格）。
- **交互式缩略图导航（Minimap）与图内文本搜索**：点击工具栏「缩略图」（或按 `m` 键）开启鹰眼缩略图拖拽定位大图；按 `Cmd/Ctrl+F` 或 `/` 在预览图内实时搜索高亮节点文字并自动居中定位匹配项。
- **双击反向跳转源码 & 代码链接跳转**：双击预览中的节点自动定位源码行；按住 `Cmd/Ctrl+单击` 节点（或双击 `#Symbol` / `path/file.ts:10` 标签）可直接跳转到工作区对应的类/函数定义或文件行。
- 可导出 **SVG / PNG**（支持配置缩放倍率与透明背景），或一键**复制 PNG 图片 / 复制 SVG** 到剪贴板，也可开启 `drawGraph.exportOnSave` 在保存时自动同步导出旁路图片。
- **批量导出与可分享链接**：支持一键批量导出多图 `.puml` 或 `.md` 文档中的所有图表（`DrawGraph: 批量导出文档中的所有图表…`），以及为 PlantUML 生成可分享的服务器 SVG/PNG URL 或 Markdown 图片代码（`DrawGraph: 生成可分享的 PlantUML 链接…`）；超长 PlantUML 图表在服务器模式下自动回退为 HTTP `POST` 避免 URL 长度限制。
- **从图片逆向提取源码**：在资源管理器右键 `.svg` / `.png` 图片（或通过右上角菜单）执行 `DrawGraph: 提取图片中内嵌的图表源码`，即可解码还原内嵌的 Draw.io XML 或 PlantUML 源码（`<!--SRC=[...]-->`）。
- 一个 PlantUML 文件包含多个 `@startuml … @enduml` 块或 `newpage` 多页时，预览自动跟随光标所在块，也可通过工具栏 `◀` / `▶`（或 `[` / `]` 键）翻页切换。
- 提供语法高亮、**上下文智能补全（IntelliSense：关键字、`!theme` 主题、`skinparam` 属性及当前已声明的节点/参与者 ID）**、**一键代码格式化（`Shift+Alt+F`）**、**代码片段补全（Snippets）**、**文档大纲（Outline / Breadcrumbs）**、注释切换、括号匹配和代码折叠。
- **Mermaid 转 Draw.io**：点击编辑器标题栏或 CodeLens 的「在 Draw.io 中打开」，可将 Mermaid 代码直接转换为可拖拽编辑的 draw.io 图表。
- 重新打开 VS Code 后，预览窗口会自动恢复。

### Markdown 中的 Mermaid 与 PlantUML
内置 Markdown 预览支持直接渲染 ```` ```mermaid ```` 以及 ```` ```plantuml ```` / ```` ```puml ```` 代码块，鼠标悬停图表右上角会浮现交互式缩放工具条（支持 `−` / `100%` / `+`、`Ctrl/Cmd/Alt+滚轮` 缩放与拖拽平移），编辑器里也有对应的语法高亮与 CodeLens 入口。可分别用 `drawGraph.markdown.mermaid` 和 `drawGraph.markdown.plantuml` 开关。

### 新建图表、设置抽屉与实时中英文切换
- **侧滑设置抽屉（`DrawGraph: 打开 DrawGraph 设置抽屉`）**：在 Draw.io 编辑器标题栏右上角点击齿轮图标 `⚙`、在图表预览工具栏最右侧点击 `⚙`，或在彩色 DrawGraph 快捷菜单中选择「DrawGraph 设置…」，即可从右侧滑出可视化设置抽屉，一站式调整 Draw.io 主题/布局/配色、Mermaid 主题、PNG 倍率、PlantUML 渲染方式与保存自动导出。
- **独立中英文实时切换（`中 / EN`）**：无需修改 VS Code 全局语言或重启编辑器，直接在设置抽屉顶部点击 `中 | EN`（或修改 `drawGraph.language` 为 `Auto` / `Simplified Chinese` / `English`），插件界面、CodeLens、预览工具栏以及内嵌 Draw.io 编辑器会立即同步切换中英文。
- 编辑器右上角标题栏默认常驻一个彩色的 **DrawGraph 图标**（可通过 `drawGraph.toolbar.showQuickMenu` 关闭），在任何页面点击都可快速新建图表、选择模板、打开设置抽屉，或将当前 `.svg` / `.png` / `.xml` 文件用 Draw.io 打开；打开图表页时右上角还会直接显示专属操作图标（预览、导出 SVG/PNG、复制 PNG、转 Draw.io、以文本打开、设置抽屉）。

命令面板（`Cmd/Ctrl+Shift+P`）里也有以下命令：
- `DrawGraph: 从模板新建图表…`（涵盖流程图、时序图、类图、状态图、ER 图、甘特图、思维导图、组件图等）
- `DrawGraph: 新建 Draw.io 图表`
- `DrawGraph: 新建 Mermaid 图表`
- `DrawGraph: 新建 PlantUML 图表`

## 渲染方式与隐私

| | 渲染位置 | 是否需要联网 |
| --- | --- | --- |
| Mermaid | 本地（Mermaid 库已打包进插件） | 否 |
| draw.io | 从 `drawGraph.drawio.url`（默认 `https://embed.diagrams.net/`）加载编辑器。**图表数据只在 VS Code 和编辑器页面之间传递，不会上传。** | 默认需要。可以[自建 draw.io](https://github.com/jgraph/docker-drawio) 后把地址指过去，即可离线使用 |
| PlantUML | 设置了 `drawGraph.plantuml.jar` 时用本地 Java 渲染，否则用 PlantUML 服务器渲染 | 服务器模式需要。**这种模式下图表源码会发送到该服务器**，私密图表请使用本地 jar 或自建服务器 |

### 本地渲染 PlantUML
1. 安装 Java，如需类图、用例图等还要装 [Graphviz](https://graphviz.org/)（例如 `brew install graphviz`）。
2. 下载 [plantuml.jar](https://plantuml.com/download)。
3. 在设置中填写 `"drawGraph.plantuml.jar": "/path/to/plantuml.jar"`。

本地模式下，`!include` 的相对路径以当前文件所在目录为基准。

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `drawGraph.language` | `"Auto"` | 插件界面、设置抽屉与内嵌 draw.io 的显示语言：`"Auto"`（跟随 VS Code）/ `"Simplified Chinese"` / `"English"` |
| `drawGraph.drawio.url` | `https://embed.diagrams.net/` | draw.io 嵌入应用地址 |
| `drawGraph.drawio.ui` | `kennedy` | draw.io 界面主题：`kennedy` / `min` / `atlas` / `sketch` / `simple` |
| `drawGraph.drawio.theme` | `auto` | `auto` / `light` / `dark` |
| `drawGraph.drawio.hideGithubIcon` | `true` | 隐藏内嵌 draw.io 界面右下角的 GitHub 小图标 |
| `drawGraph.drawio.config` | `{}` | 额外的 [draw.io 配置](https://www.drawio.com/doc/faq/configure-diagram-editor) |
| `drawGraph.drawio.customLibraries` | `[]` | 自动挂载到 draw.io 左侧面板的 `<mxlibrary>` 文件路径或 HTTPS 地址 |
| `drawGraph.drawio.svgColorScheme` | `auto` | `.drawio.svg` 和「导出为 SVG」的配色：`auto` 自适应查看者的深浅色模式（draw.io 默认），`light` / `dark` 固定配色 |
| `drawGraph.drawio.vscodeShortcuts` | `true` | 焦点在 draw.io 编辑器里时，把常用 VS Code 快捷键交给 VS Code 处理 |
| `drawGraph.mermaid.theme` | `auto` | `auto` / `default` / `dark` / `forest` / `neutral` / `base` |
| `drawGraph.markdown.mermaid` | `true` | 在 Markdown 预览中渲染 Mermaid |
| `drawGraph.markdown.plantuml` | `true` | 在 Markdown 预览中渲染 PlantUML（```` ```plantuml ```` / ```` ```puml ````） |
| `drawGraph.plantuml.render` | `auto` | `auto` / `local` / `server` |
| `drawGraph.plantuml.server` | `https://www.plantuml.com/plantuml` | PlantUML 服务器地址 |
| `drawGraph.plantuml.jar` | `""` | 本地 `plantuml.jar` 路径 |
| `drawGraph.plantuml.java` | `java` | Java 可执行文件 |
| `drawGraph.plantuml.dot` | `""` | Graphviz `dot` 路径（可选） |
| `drawGraph.preview.debounce` | `400` | 编辑后多久刷新预览（毫秒） |
| `drawGraph.preview.followActiveEditor` | `true` | 复用未锁定的预览窗口自动跟随当前活动图表编辑器 |
| `drawGraph.preview.pngScale` | `2` | 导出或复制 PNG 时的缩放倍率（`1` / `2` / `3` / `4`） |
| `drawGraph.preview.pngTransparent` | `false` | 导出或复制 PNG 时使用透明背景 |
| `drawGraph.editor.codeLens` | `true` | 在图表与 Markdown 图表代码块上方显示 CodeLens 快捷入口 |
| `drawGraph.toolbar.showQuickMenu` | `true` | 在编辑器右上角标题栏常驻显示彩色 DrawGraph 快捷菜单图标 |
| `drawGraph.exportOnSave` | `"off"` | 保存图表时自动导出图片：`"off"` / `"svg"` / `"png"` |
| `drawGraph.exportOnSaveOutDir` | `""` | 自动导出图片的输出目录（留空则保存在源文件同目录） |

## 开发

```bash
npm install
```

```bash
npm run build
```

按 `F5` 会启动一个加载了本插件的 VS Code 窗口，并自动打开 `examples/` 目录。

```bash
npm test
```

想同时测试 PlantUML 服务器渲染，就设置 `DRAWGRAPH_ONLINE=1` 再运行测试。

集成测试会在真实的 VS Code 中运行（使用独立的配置目录，不影响你自己的设置和插件；需要联网）：

```bash
npm run test:integration
```

打包为 `.vsix`：

```bash
npm run package
```

### 持续集成与发布

GitHub Actions（`.github/workflows/ci.yml`）在每次推送和 Pull Request 时运行：

1. 类型检查、单元测试，并打包 `.vsix`（作为构建产物上传）。
2. 在 Linux 上用真实 VS Code 跑集成测试（虚拟显示器，需要联网）。
3. 推送到 `main` 后，用新的 `.vsix` 替换 Releases 中的 **nightly** 预发布版本。
4. 推送 `v*` 标签后发布正式版本：标签必须与 `package.json` 的版本一致，发布说明取自 `CHANGELOG.md` 中对应版本的章节，且集成测试通过后才会发布。

发布新版本：

```bash
npm version 0.2.0 --no-git-tag-version
```

把 `CHANGELOG.md` 的 `Unreleased` 改为 `0.2.0` 并提交，然后：

```bash
git tag v0.2.0 && git push origin main v0.2.0
```

### 目录结构
```
src/
  extension.ts                  入口，注册命令
  drawio/drawioEditorProvider.ts  draw.io 自定义编辑器（CustomTextEditorProvider）
  preview/previewManager.ts     Mermaid / PlantUML 预览面板
  plantuml/encoder.ts           PlantUML URL 编码、多图拆分
  plantuml/renderer.ts          PlantUML 服务器 / 本地 jar 渲染
  markdown/markdownIt.ts        Markdown 预览的 markdown-it 插件
media/
  drawio/                       draw.io webview 桥接脚本
  preview/                      预览 webview（缩放、平移、导出）
  markdown/                     Markdown 预览脚本
syntaxes/                       TextMate 语法
```
