# DrawGraph — 在 VS Code 中预览和编辑 Draw.io / Mermaid / PlantUML

[![CI](https://github.com/aimuch/vscode-DrawGraph/actions/workflows/ci.yml/badge.svg)](https://github.com/aimuch/vscode-DrawGraph/actions/workflows/ci.yml)

DrawGraph 是一个 VS Code 插件，把三种常用的图表格式放进同一个编辑器里：

| 格式 | 文件扩展名 | 编辑方式 |
| --- | --- | --- |
| **draw.io** | `.drawio` `.dio` `.drawio.xml` `.drawio.svg` | 可视化编辑器（内嵌 draw.io），直接拖拽编辑 |
| **Mermaid** | `.mmd` `.mermaid`，以及 Markdown 中的 ```` ```mermaid ```` 代码块 | 文本编辑 + 实时预览 |
| **PlantUML** | `.puml` `.plantuml` `.pu` `.iuml` `.wsd` | 文本编辑 + 实时预览 |

## 安装

在 [Releases](https://github.com/aimuch/vscode-DrawGraph/releases) 页面下载 `.vsix` 安装包：

- **nightly**：`main` 分支每次推送后自动构建的最新版本（每次推送都会替换）。
- **vX.Y.Z**：正式版本。

然后在 VS Code 扩展视图右上角的 `…` 菜单中选择「从 VSIX 安装…」，或者在终端运行：

```bash
code --install-extension drawgraph-0.1.0.vsix
```

安装包是离线的（Mermaid 已打包在内），但 draw.io 编辑器默认仍从 embed.diagrams.net 加载，见下文“渲染方式与隐私”。

## 功能

### draw.io 可视化编辑器
- 打开 `.drawio` 文件时自动使用内嵌的 draw.io 编辑器。界面语言跟随 VS Code，亮/暗主题可自动匹配。
- 编辑内容实时同步到 VS Code 文档：未保存标记、保存、撤销文本改动、还原、热退出都按 VS Code 的原生方式工作。在 draw.io 里按 `Cmd/Ctrl+S` 会直接保存文件。
- 在外部修改文件（文本编辑器、`git checkout` 等）后，图表会自动重新加载。
- 编辑器标题栏菜单可以**导出为 SVG / PNG**。导出的文件内嵌了图表数据（`.drawio.svg` / `.drawio.png`），之后还能再用 draw.io 打开编辑。
- 点击“以文本方式打开”可查看或编辑原始 XML。
- **焦点在 draw.io 里时，常用 VS Code 快捷键照样可用**：F1 / `Cmd+Shift+P`（命令面板）、`Cmd+P`（快速打开）、`Cmd+W`、`Cmd+N`、`Cmd+O`、`Cmd+Shift+N/T/W/X`、`Cmd+\`、`Cmd+1…9`、`Ctrl+Tab`、``Ctrl+` ``（Windows/Linux 上把 `Cmd` 换成 `Ctrl`），你自定义的快捷键也会生效。其余组合键仍归 draw.io 使用（如 `Cmd+B` 加粗、`Cmd+C/V` 复制粘贴、`Cmd+Z` 撤销）。因此 `Cmd+Shift+P` 和 `Cmd+P` 不再触发 draw.io 的格式面板和打印（两者在 draw.io 的工具栏和菜单里都有入口）；如果你更想保留 draw.io 的行为，可以关闭 `drawGraph.drawio.vscodeShortcuts`。
- **`.drawio.svg` 文件**：既是普通的 SVG 图片（可以直接放进 README、网页、文档里显示），又能在 VS Code 里用 draw.io 打开编辑。每次编辑后，文件都会更新为最新的 SVG 图片，图表数据仍然内嵌在其中。新建图表时把文件名设为 `xxx.drawio.svg` 即可。
  - 配色：draw.io 默认写出“自适应”的 SVG，查看者（GitHub、浏览器、系统）处于深色模式时，图片会显示成深色。想让图片颜色固定，可以把 `drawGraph.drawio.svgColorScheme` 设为 `light`（或 `dark`），在下次编辑或导出时生效。

### Mermaid 与 PlantUML 实时预览
- 用 `Cmd/Ctrl+K V`（在侧边打开）或 `Cmd/Ctrl+Shift+V` 打开预览，也可以点击编辑器右上角的预览按钮。
- 边输入边刷新。有语法错误时保留上一次成功渲染的图，并在下方显示错误信息。
- 支持缩放（工具栏、`Ctrl/Cmd+滚轮`、触控板双指缩放、`+` / `-` / `0` 键）、拖拽平移、适应窗口（`f` 键）。
- 可导出 **SVG / PNG**，或把 SVG 复制到剪贴板。
- 一个 PlantUML 文件里有多个 `@startuml … @enduml` 块时，预览显示光标所在的那一个。
- 提供语法高亮、注释切换、括号匹配和代码折叠。
- 重新打开 VS Code 后，预览窗口会自动恢复。

### Markdown 中的 Mermaid
内置 Markdown 预览会直接渲染 ```` ```mermaid ```` 代码块，编辑器里也有对应的语法高亮。不需要时可以用 `drawGraph.markdown.mermaid` 关闭。

### 新建图表
命令面板（`Cmd/Ctrl+Shift+P`）里有以下命令：
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
| `drawGraph.drawio.url` | `https://embed.diagrams.net/` | draw.io 嵌入应用地址 |
| `drawGraph.drawio.ui` | `kennedy` | draw.io 界面主题：`kennedy` / `min` / `atlas` / `sketch` / `simple` |
| `drawGraph.drawio.theme` | `auto` | `auto` / `light` / `dark` |
| `drawGraph.drawio.config` | `{}` | 额外的 [draw.io 配置](https://www.drawio.com/doc/faq/configure-diagram-editor) |
| `drawGraph.drawio.svgColorScheme` | `auto` | `.drawio.svg` 和「导出为 SVG」的配色：`auto` 自适应查看者的深浅色模式（draw.io 默认），`light` / `dark` 固定配色 |
| `drawGraph.drawio.vscodeShortcuts` | `true` | 焦点在 draw.io 编辑器里时，把常用 VS Code 快捷键交给 VS Code 处理（修改后需重新打开图表） |
| `drawGraph.mermaid.theme` | `auto` | `auto` / `default` / `dark` / `forest` / `neutral` / `base` |
| `drawGraph.markdown.mermaid` | `true` | 在 Markdown 预览中渲染 Mermaid |
| `drawGraph.plantuml.render` | `auto` | `auto` / `local` / `server` |
| `drawGraph.plantuml.server` | `https://www.plantuml.com/plantuml` | PlantUML 服务器地址 |
| `drawGraph.plantuml.jar` | `""` | 本地 `plantuml.jar` 路径 |
| `drawGraph.plantuml.java` | `java` | Java 可执行文件 |
| `drawGraph.plantuml.dot` | `""` | Graphviz `dot` 路径（可选） |
| `drawGraph.preview.debounce` | `400` | 编辑后多久刷新预览（毫秒） |

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
