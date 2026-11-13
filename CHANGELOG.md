# Changelog

## Unreleased

- Edit `*.drawio.svg` files: they open in the draw.io editor and every edit rewrites a valid SVG with the diagram embedded uncompressed (readable `git diff`).
- VS Code shortcuts (command palette, quick open, close editor, Ctrl+Tab, editor groups, …) now work while the draw.io editor has focus; `drawGraph.drawio.vscodeShortcuts` turns this off.
- `drawGraph.drawio.svgColorScheme` setting: keep draw.io's adaptive SVG colors (`auto`) or pin them to `light` / `dark`.
- Fix: empty `.drawio` files no longer hang while loading.
- Fix: Mermaid blocks now render in the built-in Markdown preview (the script no longer runs before Mermaid has loaded).
- Fix: draw.io could get stuck on "Loading draw.io…" when opened from the browser cache.

## 0.1.0

- draw.io custom editor (embed mode) with autosave sync, Cmd/Ctrl+S save, external-change reload and editable SVG/PNG export.
- Live Mermaid preview (bundled Mermaid, works offline) with zoom/pan and SVG/PNG export.
- Live PlantUML preview via PlantUML server or local `plantuml.jar`; picks the diagram under the cursor.
- Mermaid rendering in the built-in Markdown preview.
- Syntax highlighting for Mermaid and PlantUML; Mermaid highlighting inside Markdown code blocks.
- English and Simplified Chinese UI.
