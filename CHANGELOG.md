# Changelog

## Unreleased

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
