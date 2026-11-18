# Changelog

## 0.3.0

- **Git Visual Diagram Diff (`DrawGraph: Visual Diagram Diff vs Git HEAD` & `Compare Two Diagram Files Visually…`)**: Interactive visual diff viewer for `.drawio`, `.drawio.svg`, `.drawio.png`, `.mmd`, and `.puml` files from the Source Control (SCM) context menu or editor toolbar, featuring baseline Git commit/ref switching (`HEAD`, `HEAD~1`, history log), multi-page Draw.io selector with unified coordinate bounding-box alignment, cursor-anchored **Side-by-Side** pan/zoom, keyboard-accessible **Swipe** curtain, and **Onion-Skin + RGBA Pixel Diff** highlighting.
- **Code & Data-to-Diagram Generators (`Generate Class Diagram…`, `Generate Module Dependency Diagram…`, `Generate Diagram from SQL / JSON…`)**: Reverse-engineer workspace source files/folders, SQL `CREATE TABLE` DDL schemas, and JSON structures into **Mermaid**, **PlantUML**, or editable **Draw.io** class, dependency, ER, and mindmap diagrams.
- **Workspace Diagram Explorer (`drawGraph.diagramExplorer`)**: Dedicated Explorer sidebar tree with empty-state welcome actions, contextual actions, debounced dual-glob discovery, and expandable Draw.io pages, PlantUML blocks, and Markdown fences.
- **On-Demand Offline Draw.io Engine Pack (`drawGraph.drawio.offlineMode`)**: Keep the default VSIX lightweight while allowing streaming download (with live MB/% progress) or `.war`/`.zip` import of the Draw.io webapp into `globalStorageUri`, served via an ephemeral `127.0.0.1` loopback server for 100% air-gapped editing.
- **Multi-Page Export & Zero-Dependency PDF 1.4 Export**: Export Draw.io, Mermaid, and PlantUML diagrams (including 1/2/4/8-bit PLTE indexed, grayscale, and RGBA PNGs) directly to `.pdf` (also supported in `drawGraph.exportOnSave: "pdf"`), and batch-export multi-page Draw.io `<diagram>` tabs even when unopened.
- **Expanded Diagram Conversions**: Structured `classDiagram`, `erDiagram`, and `mindmap` layout engines in Mermaid-to-Draw.io conversion, plus bidirectional **PlantUML ↔ Mermaid** converters (`DrawGraph: Convert PlantUML to Mermaid` / `Convert Mermaid to PlantUML`).
- **Markdown Diagram Workflows & Offscreen Mermaid Export**: Enriched Markdown fence CodeLens (`Export as SVG`, `Export as PNG`, `Open in Draw.io`, `Extract to .drawio.svg`), local `baseDir` + HTTP `POST` fallback for large Markdown PlantUML fences, and serialized background Mermaid worker rendering.
- **Presentation & Spotlight Mode + Compact Single-Row Toolbar**: Compact `Export ▾` popover menu for narrow split panes, plus distraction-free presentation view (`p` / `Present`) with multi-diagram spotlight highlighting and **Laser Pointer**.
- **Deep Language Intelligence & Instant Static Linter**: Added `DocumentLinkProvider`, `HoverProvider` (C4 macro docs & inline diagram thumbnails), `RenameProvider` (`F2` block-scoped rename), `DocumentColorProvider`, `CodeActionProvider` (`Quick Fix`), PlantUML Stdlib completions, C4 `SignatureHelpProvider`, and zero-subprocess static syntax diagnostics when the preview panel is closed.
- **Architecture, Performance & Security Hardening**: FIFO local PlantUML pipe queue eliminating multi-block Markdown self-cancellation, prefix/suffix minimal range `WorkspaceEdit` on Draw.io saves, `flushPendingEdits()` synchronization, shared protocol discriminated unions, unified host-injected Settings Drawer i18n dictionary, untrusted-workspace CSP/code-link boundary guards, and zero-`innerHTML` Settings Drawer DOM rendering.

## 0.2.0

- Slide-in Settings Drawer (`DrawGraph: Open DrawGraph Settings Drawer`, `⚙` toolbar button in Draw.io and Diagram Preview) with one-click `中 | EN` display language toggle (`drawGraph.language`: `Auto` / `Simplified Chinese` / `English`) that switches DrawGraph UI, CodeLens, preview toolbars, and the embedded Draw.io editor language live without restarting VS Code.
- Hide the bottom-right GitHub badge/icon inside the embedded Draw.io editor by default (`drawGraph.drawio.hideGithubIcon`).
- Diagram preview minimap (`m` or `Map` toolbar button) with viewport indicator and click/drag panning, plus in-diagram text search & highlight (`Cmd/Ctrl+F` or `/`).
- Code Links across Draw.io and Diagram Previews: jump from `#SymbolName` or `path/to/file.ts:line` diagram labels directly to workspace definitions (`DrawGraph: Navigate Draw.io Code Links…`, status bar `Code Links` button, or `Cmd/Ctrl+Click` in preview), and insert workspace symbols onto the Draw.io canvas (`DrawGraph: Insert Workspace Code Symbol into Draw.io…`).
- Context-aware IntelliSense (`CompletionItemProvider` for keywords, `!theme` names, `skinparam` properties, directives, and declared node/participant IDs) and document formatting (`Shift+Alt+F`) for Mermaid and PlantUML.
- Interactive hover zoom/pan toolbar (`−` / `100%` / `+` and `Ctrl/Cmd/Alt+Wheel`) on rendered Mermaid and PlantUML diagrams inside VS Code's built-in Markdown preview.
- PlantUML ecosystem workflows: `Alt+D` preview shortcut, HTTP `POST` fallback for large server diagrams, `DrawGraph: Generate Shareable PlantUML URL…`, `DrawGraph: Export All Diagrams in Document…` (multi-block `.puml` and `.md`), and `DrawGraph: Extract Embedded Diagram Source` (recovers embedded `<mxfile>` XML or PlantUML `<!--SRC=[...]-->` source from `.svg`/`.png` files).
- Support `*.dio.svg`, `*.dio.png`, and `*.dio.xml` file extensions in the Draw.io custom editor.
- Extension logo (`icon.png`) and colorful top-right toolbar quick-menu icon (`DrawGraph: Diagram Menu`, `drawGraph.toolbar.showQuickMenu`), plus direct top-right toolbar icons for diagram export, PNG copy, and Mermaid-to-Draw.io conversion.
- Edit `*.drawio.svg` and `*.drawio.png` files directly in the draw.io editor: edits rewrite valid SVG/PNG images with the diagram embedded inside.
- Markdown support for PlantUML: syntax highlighting and built-in Markdown preview rendering for ```` ```plantuml ```` / ```` ```puml ```` blocks (`drawGraph.markdown.plantuml`).
- Copy diagrams as PNG images directly to the clipboard from both the Mermaid/PlantUML preview toolbar and the draw.io editor (`DrawGraph: Copy Draw.io Diagram as PNG` / `SVG`), with configurable scale (`drawGraph.preview.pngScale`) and transparent background (`drawGraph.preview.pngTransparent`).
- Convert Mermaid diagrams into editable draw.io diagrams (`DrawGraph: Open Mermaid Diagram in Draw.io…`), available from the editor title bar, Explorer context menu, and CodeLens.
- Language intelligence for Mermaid and PlantUML: inline editor error diagnostics (Problems panel), Outline / Breadcrumbs symbols, CodeLens actions (`drawGraph.editor.codeLens`), code snippets, and `DrawGraph: New Diagram from Template…`.
- Preview enhancements: dynamic active-editor following with Pin/Lock toggle (`drawGraph.preview.followActiveEditor`), background switcher (`Auto` / `Light` / `Dark` / `Grid`), double-click on preview elements to jump to the matching source line, and `◀` / `▶` (`[` / `]`) navigation across multi-diagram `.puml` files and `newpage` pages.
- Auto-export sidecar `.svg` or `.png` images on save (`drawGraph.exportOnSave`, `drawGraph.exportOnSaveOutDir`).
- Mount custom workspace `<mxlibrary>` shape libraries in draw.io (`drawGraph.drawio.customLibraries`).
- VS Code shortcuts (command palette, quick open, close editor, Ctrl+Tab, editor groups, …) work while the draw.io editor has focus; `drawGraph.drawio.vscodeShortcuts` turns this off.
- `drawGraph.drawio.svgColorScheme` setting: keep draw.io's adaptive SVG colors (`auto`) or pin them to `light` / `dark`.
- Local PlantUML rendering reuses a persistent background process and caches rendered SVGs for faster updates and instant block switching.
- Lazy-load Mermaid in the built-in Markdown preview only when a document contains a `mermaid` block, respecting `drawGraph.mermaid.theme` and live theme changes.
- Workspace Trust support: restrict executable paths and external rendering endpoints in untrusted workspaces.
- Fix: empty `.drawio` files no longer hang while loading.
- Fix: Mermaid blocks render reliably in the built-in Markdown preview.
- Fix: draw.io no longer gets stuck on "Loading draw.io…" when opened from the browser cache.
- Fix: PlantUML diagrams with nested `@startsub`/`@endsub`, block-commented markers, or nested `<svg>` sprites render without truncation.

## 0.1.0

- draw.io custom editor (embed mode) with autosave sync, Cmd/Ctrl+S save, external-change reload and editable SVG/PNG export.
- Live Mermaid preview (bundled Mermaid, works offline) with zoom/pan and SVG/PNG export.
- Live PlantUML preview via PlantUML server or local `plantuml.jar`; picks the diagram under the cursor.
- Mermaid rendering in the built-in Markdown preview.
- Syntax highlighting for Mermaid and PlantUML; Mermaid highlighting inside Markdown code blocks.
- English and Simplified Chinese UI.
