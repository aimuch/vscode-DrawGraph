import * as path from 'node:path';
import * as vscode from 'vscode';
import { convertDrawioToMermaid } from '../converters/drawioToText';
import type { VisualDiffManager } from '../diff/visualDiffPanel';
import { computeMinimalTextChange } from '../drawio/minimalEdit';
import { type DrawioEditorProvider, readDrawioXmlFromUri } from '../drawio/drawioEditorProvider';
import { renderMxfileToPreviewSvg } from '../drawio/mxfileToSvg';
import { getLanguage, t } from '../l10n';
import { mermaidTheme, type PreviewManager } from '../preview/previewManager';
import { renderDotToSvgOffline } from '../renderers/dotRenderer';
import { renderWaveDromToSvg } from '../renderers/wavedromRenderer';
import {
  applySettingUpdate,
  getSettingsSnapshot,
  handleSettingsDrawerAction,
  openExtensionSettingsInVscode,
} from '../settingsSnapshot';
import { getNonce } from '../util';
import {
  fetchProviderModels,
  getAiConfigSync,
  onDidChangeAiApiKey,
  runAiPrompt,
  setApiKey,
  clearApiKey,
} from './aiProviders';
import {
  buildAiDiagramPrompt,
  extractAndNormalizeAiDiagram,
  parseArchitectureFindings,
  stripThinkingBlocks,
  type AiDiagramFormat,
  type AiTaskMode,
  type ArchitectureFinding,
  type OptimizePreset,
} from './diagramAiCore';

export interface OpenStudioOptions {
  mode?: AiTaskMode;
  format?: AiDiagramFormat;
  targetUri?: vscode.Uri;
  initialPrompt?: string;
  optimizePreset?: OptimizePreset;
  autoRun?: boolean;
  skipConsent?: boolean;
}

export interface HeadlessAiTaskArgs {
  mode: AiTaskMode;
  format?: AiDiagramFormat;
  prompt?: string;
  targetUri?: vscode.Uri;
  optimizePreset?: OptimizePreset;
  diagnosticHint?: string;
  applyImmediately?: boolean;
  openNewIfNoTarget?: boolean;
  skipConsent?: boolean;
}

export interface HeadlessAiTaskResult {
  code: string;
  explanation: string;
  findings: ArchitectureFinding[];
  format: AiDiagramFormat;
  provider: string;
  modelName: string;
  appliedUri?: vscode.Uri;
}

interface TargetDiagramInfo {
  uri: vscode.Uri;
  label: string;
  format: AiDiagramFormat;
  source: string;
}

function detectFormatFromUriOrLang(uri: vscode.Uri, languageId?: string): AiDiagramFormat | undefined {
  if (languageId === 'mermaid') return 'mermaid';
  if (languageId === 'plantuml') return 'plantuml';
  if (languageId === 'dot') return 'dot';
  if (languageId === 'wavedrom') return 'wavedrom';
  const p = uri.path.toLowerCase();
  if (/\.(?:drawio|dio|drawio\.svg|drawio\.png|dio\.svg|dio\.png)$/i.test(p)) return 'drawio';
  if (/\.(?:mmd|mermaid)$/i.test(p)) return 'mermaid';
  if (/\.(?:puml|plantuml|pu|iuml|wsd)$/i.test(p)) return 'plantuml';
  if (/\.(?:dot|gv)$/i.test(p)) return 'dot';
  if (/\.(?:wavedrom|wave\.json)$/i.test(p)) return 'wavedrom';
  return undefined;
}

export class AiDiagramStudioManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private webviewReady = false;
  private activeCts: vscode.CancellationTokenSource | undefined;
  private boundTargetUri: vscode.Uri | undefined;
  private currentMode: AiTaskMode = 'generate';
  private currentFormat: AiDiagramFormat = 'mermaid';
  private currentPreset: OptimizePreset = 'layout';
  private lastGeneratedCode = '';
  private lastGeneratedFormat: AiDiagramFormat = 'mermaid';
  private history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  private pendingOpenOptions: OpenStudioOptions | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly drawio: DrawioEditorProvider,
    private readonly previews: PreviewManager,
    private readonly visualDiff: VisualDiffManager,
  ) {
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (this.panel && this.webviewReady) {
          void this.pushContextState();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('drawGraph') && this.panel && this.webviewReady) {
          this.panel.title = `✨ ${t('AI Diagram Studio')}`;
          void this.pushContextState();
          void this.panel.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
        }
      }),
      onDidChangeAiApiKey(() => {
        if (this.panel && this.webviewReady) {
          void this.pushContextState();
          void this.panel.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
        }
      }),
    );
  }

  snapshot() {
    return {
      isOpen: Boolean(this.panel),
      ready: this.webviewReady,
      streaming: Boolean(this.activeCts),
      mode: this.currentMode,
      format: this.currentFormat,
      boundUri: this.boundTargetUri?.toString(),
      hasResult: Boolean(this.lastGeneratedCode),
    };
  }

  private async resolveTargetDiagram(explicitUri?: vscode.Uri): Promise<TargetDiagramInfo | undefined> {
    if (explicitUri) {
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === explicitUri.toString());
      const fmt = detectFormatFromUriOrLang(explicitUri, openDoc?.languageId);
      if (fmt === 'drawio') {
        const xml = await readDrawioXmlFromUri(explicitUri);
        return {
          uri: explicitUri,
          label: path.basename(explicitUri.path),
          format: 'drawio',
          source: xml ?? '',
        };
      }
      if (fmt) {
        const doc = openDoc ?? (await vscode.workspace.openTextDocument(explicitUri));
        return {
          uri: explicitUri,
          label: path.basename(explicitUri.path) || 'Untitled',
          format: fmt,
          source: doc.getText(),
        };
      }
    }

    // 1. Active Draw.io custom editor
    const activeDrawio = await this.drawio.getActiveDiagramXml();
    if (activeDrawio) {
      return {
        uri: activeDrawio.uri,
        label: path.basename(activeDrawio.uri.path),
        format: 'drawio',
        source: activeDrawio.xml,
      };
    }

    // 2. Active text diagram editor
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      const fmt = detectFormatFromUriOrLang(ed.document.uri, ed.document.languageId);
      if (fmt && fmt !== 'drawio') {
        return {
          uri: ed.document.uri,
          label: path.basename(ed.document.uri.path) || ed.document.languageId,
          format: fmt,
          source: ed.document.getText(),
        };
      }
      if (fmt === 'drawio') {
        const xml = await readDrawioXmlFromUri(ed.document.uri);
        return {
          uri: ed.document.uri,
          label: path.basename(ed.document.uri.path),
          format: 'drawio',
          source: xml ?? '',
        };
      }
    }

    // 3. Previously bound target URI if still valid
    if (this.boundTargetUri) {
      const prevFmt = detectFormatFromUriOrLang(this.boundTargetUri);
      if (prevFmt) {
        try {
          if (prevFmt === 'drawio') {
            const xml = await readDrawioXmlFromUri(this.boundTargetUri);
            if (xml !== undefined) {
              return {
                uri: this.boundTargetUri,
                label: path.basename(this.boundTargetUri.path),
                format: 'drawio',
                source: xml,
              };
            }
          } else {
            const doc = await vscode.workspace.openTextDocument(this.boundTargetUri);
            return {
              uri: this.boundTargetUri,
              label: path.basename(this.boundTargetUri.path),
              format: prevFmt,
              source: doc.getText(),
            };
          }
        } catch {
          // Bound document no longer accessible
        }
      }
    }

    // 4. Open Diagram Preview fallback
    const snap = this.previews.snapshot()[0];
    if (snap?.uri) {
      try {
        const pUri = vscode.Uri.parse(snap.uri);
        const fmt = detectFormatFromUriOrLang(pUri);
        if (fmt && fmt !== 'drawio') {
          const doc = await vscode.workspace.openTextDocument(pUri);
          return {
            uri: pUri,
            label: path.basename(pUri.path),
            format: fmt,
            source: doc.getText(),
          };
        }
      } catch {
        // Ignore
      }
    }

    return undefined;
  }

  private collectActiveCodeContext(): { fileName: string; content: string; isSelection: boolean } | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return undefined;
    }
    const fmt = detectFormatFromUriOrLang(ed.document.uri, ed.document.languageId);
    if (fmt) {
      return undefined;
    }
    const hasSelection = !ed.selection.isEmpty;
    const content = hasSelection ? ed.document.getText(ed.selection) : ed.document.getText();
    if (!content.trim()) {
      return undefined;
    }
    return {
      fileName: vscode.workspace.asRelativePath(ed.document.uri, false) || path.basename(ed.document.uri.path),
      content: content.slice(0, 14000),
      isSelection: hasSelection,
    };
  }

  private collectDiagnosticSummary(uri: vscode.Uri): string {
    const diags = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning);
    if (diags.length === 0) {
      return '';
    }
    return diags
      .slice(0, 8)
      .map((d) => `Line ${d.range.start.line + 1}: ${d.message}`)
      .join('\n');
  }

  async openStudio(options: OpenStudioOptions = {}): Promise<void> {
    if (options.targetUri) {
      this.boundTargetUri = options.targetUri;
    }
    if (options.mode) {
      this.currentMode = options.mode;
    }
    if (options.format) {
      this.currentFormat = options.format;
    }
    if (options.optimizePreset) {
      this.currentPreset = options.optimizePreset;
    }

    if (!options.mode && !options.format) {
      const detected = await this.resolveTargetDiagram(options.targetUri);
      if (detected) {
        this.boundTargetUri = detected.uri;
        this.currentFormat = detected.format;
      }
    }

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, false);
      if (this.webviewReady) {
        await this.pushContextState(options);
        if (options.autoRun) {
          await this.startStudioRun({
            mode: this.currentMode,
            format: this.currentFormat,
            prompt: options.initialPrompt ?? '',
            optimizePreset: this.currentPreset,
            includeCodeContext: true,
            skipConsent: options.skipConsent,
          });
        }
      } else {
        this.pendingOpenOptions = options;
      }
      return;
    }

    this.pendingOpenOptions = options;
    this.webviewReady = false;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'drawGraph.aiStudio',
      `✨ ${t('AI Diagram Studio')}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icons', 'drawgraph.svg');
    this.panel = panel;
    panel.webview.html = this.buildHtml(panel.webview);

    const sub = panel.webview.onDidReceiveMessage((msg) => {
      void this.onMessage(msg);
    });

    panel.onDidDispose(() => {
      sub.dispose();
      this.activeCts?.cancel();
      this.activeCts?.dispose();
      this.activeCts = undefined;
      this.webviewReady = false;
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
  }

  private buildStudioStrings(): Record<string, string> {
    return {
      studioTitle: t('AI Diagram Studio'),
      modeGenerate: t('Generate'),
      modeModify: t('Modify'),
      modeOptimize: t('Optimize'),
      modeFix: t('Fix Syntax'),
      modeExplain: t('Explain & Review'),
      lblFormat: t('Format'),
      lblTarget: t('Target'),
      noActiveDiagram: t('New Diagram (no active diagram bound)'),
      chkIncludeCode: t('Include code context ({0})'),
      presetLayout: t('Layout & Subgraphs'),
      presetStyle: t('Visual Styling'),
      presetSimplify: t('Simplify'),
      presetResilience: t('Resilience & Retries'),
      presetTranslate: t('Translate Labels'),
      phGenerate: t('Describe the architecture, sequence flow, ER schema, state machine, or timing waveform to generate…'),
      phModify: t('Describe what to add, remove, reconnect, or restyle in the current diagram…'),
      phOptimize: t('Optional extra optimization instructions (or click Run directly)…'),
      phFix: t('Optional hint about intended syntax (or click Fix Syntax directly)…'),
      phExplain: t('Optional question or review focus (e.g. bottlenecks, security, SPOFs)…'),
      btnRun: t('Run AI'),
      btnStop: t('Stop'),
      btnClearChat: t('Reset Session'),
      btnSettings: t('AI Settings'),
      btnApply: t('Apply to Active Diagram'),
      btnVisualDiff: t('Visual Diff (Before ↔ After)'),
      btnOpenNew: t('Open as New Diagram'),
      btnCopyCode: t('Copy Code'),
      tabPreview: t('Live Preview'),
      tabSource: t('Source Code'),
      streamingStatus: t('Generating with {0}…'),
      emptyWelcomeTitle: t('Design, Refine & Review Diagrams with AI'),
      emptyWelcomeSub: t('Supports Mermaid, Draw.io, PlantUML, Graphviz DOT, and WaveDrom with visual Before ↔ After diffing.'),
      chipMicroservices: t('E-commerce microservices with API Gateway, Auth, Order, Kafka & PostgreSQL'),
      chipSequence: t('OAuth 2.0 Authorization Code + PKCE login sequence diagram'),
      chipEr: t('Multi-tenant SaaS ER schema (Organizations, Users, Subscriptions, Invoices)'),
      chipState: t('Distributed payment order state machine with retries, refund & compensation'),
      chipWave: t('SPI / AXI4-Lite read transaction digital timing waveform'),
      copiedToast: t('Copied!'),
      appliedToast: t('Applied!'),
      findingsTitle: t('Architecture Findings'),
    };
  }

  private async pushContextState(openOpts?: OpenStudioOptions): Promise<void> {
    if (!this.panel) {
      return;
    }
    const target = await this.resolveTargetDiagram(openOpts?.targetUri ?? this.boundTargetUri);
    if (target) {
      this.boundTargetUri = target.uri;
      if (!openOpts?.format && this.currentMode !== 'generate') {
        this.currentFormat = target.format;
      }
    }
    const codeCtx = this.collectActiveCodeContext();
    const aiCfg = getAiConfigSync();
    const diagSummary = target ? this.collectDiagnosticSummary(target.uri) : '';

    void this.panel.webview.postMessage({
      type: 'studioState',
      mode: openOpts?.mode ?? this.currentMode,
      format: openOpts?.format ?? this.currentFormat,
      optimizePreset: openOpts?.optimizePreset ?? this.currentPreset,
      initialPrompt: openOpts?.initialPrompt,
      provider: aiCfg.provider,
      model: aiCfg.effectiveModel || aiCfg.provider,
      hasApiKey: aiCfg.hasApiKey,
      requiresApiKey: aiCfg.requiresApiKey,
      target: target
        ? {
            uri: target.uri.toString(),
            label: target.label,
            format: target.format,
            hasDiagnostics: Boolean(diagSummary),
            diagnostics: diagSummary,
          }
        : null,
      codeContextLabel: codeCtx ? `${codeCtx.fileName}${codeCtx.isSelection ? ' (selection)' : ''}` : null,
      mermaidTheme: mermaidTheme(),
      strings: this.buildStudioStrings(),
      settings: getSettingsSnapshot(),
    });
  }

  private async renderPreviewPayload(
    code: string,
    format: AiDiagramFormat,
  ): Promise<{ renderKind: 'mermaid' | 'svg'; payload: string; mermaidTheme?: string }> {
    if (!code.trim()) {
      return { renderKind: 'svg', payload: '' };
    }
    if (format === 'mermaid') {
      return { renderKind: 'mermaid', payload: code, mermaidTheme: mermaidTheme() };
    }
    if (format === 'drawio') {
      return { renderKind: 'svg', payload: renderMxfileToPreviewSvg(code) };
    }
    if (format === 'dot') {
      return { renderKind: 'svg', payload: renderDotToSvgOffline(code) };
    }
    if (format === 'wavedrom') {
      return { renderKind: 'svg', payload: renderWaveDromToSvg(code) };
    }
    const bytes = await this.previews.renderPlantUmlBytes(code, 'svg');
    return { renderKind: 'svg', payload: Buffer.from(bytes).toString('utf8') };
  }

  private async startStudioRun(args: {
    mode: AiTaskMode;
    format: AiDiagramFormat;
    prompt: string;
    optimizePreset?: OptimizePreset;
    includeCodeContext?: boolean;
    skipConsent?: boolean;
  }): Promise<void> {
    if (!this.panel) {
      return;
    }
    this.activeCts?.cancel();
    this.activeCts?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.activeCts = cts;

    this.currentMode = args.mode;
    this.currentFormat = args.format;
    if (args.optimizePreset) {
      this.currentPreset = args.optimizePreset;
    }

    const target = await this.resolveTargetDiagram(this.boundTargetUri);
    const effectiveFormat =
      args.mode === 'generate' ? args.format : (target?.format ?? args.format);
    const codeCtx = args.includeCodeContext ? this.collectActiveCodeContext() : undefined;
    const diagErrors = target && args.mode === 'fix' ? this.collectDiagnosticSummary(target.uri) : undefined;
    const drawioSummary =
      target && target.format === 'drawio' && target.source.includes('<mx')
        ? convertDrawioToMermaid(target.source)
        : undefined;

    const fullPrompt = buildAiDiagramPrompt({
      mode: args.mode,
      format: effectiveFormat,
      userPrompt: args.prompt,
      currentDiagram: args.mode === 'generate' ? undefined : target?.source,
      drawioSummaryMermaid: drawioSummary,
      codeContext: codeCtx ? { fileName: codeCtx.fileName, content: codeCtx.content } : undefined,
      diagnosticErrors: diagErrors,
      optimizePreset: args.optimizePreset ?? this.currentPreset,
      history: this.history,
      lang: getLanguage(),
    });

    const aiCfg = getAiConfigSync();
    void this.panel.webview.postMessage({
      type: 'streamStart',
      mode: args.mode,
      format: effectiveFormat,
      providerLabel: `${aiCfg.provider}${aiCfg.effectiveModel ? ` · ${aiCfg.effectiveModel}` : ''}`,
    });

    try {
      const result = await runAiPrompt(this.context, fullPrompt, {
        token: cts.token,
        skipConsent: args.skipConsent,
        onChunk: (acc) => {
          if (!this.panel || this.activeCts !== cts) {
            return;
          }
          if (args.mode === 'explain') {
            void this.panel.webview.postMessage({
              type: 'streamChunk',
              mode: 'explain',
              explanation: stripThinkingBlocks(acc),
              code: '',
            });
          } else {
            const extracted = extractAndNormalizeAiDiagram(acc, effectiveFormat);
            void this.panel.webview.postMessage({
              type: 'streamChunk',
              mode: args.mode,
              code: extracted.code,
              explanation: extracted.explanation,
              isCompleteFence: extracted.isCompleteFence,
            });
          }
        },
      });

      if (this.activeCts !== cts) {
        return;
      }

      if (args.mode === 'explain') {
        const cleanMd = stripThinkingBlocks(result.text);
        const findings = parseArchitectureFindings(cleanMd);
        this.history.push(
          { role: 'user', text: args.prompt || `Explain ${target?.label ?? 'diagram'}` },
          { role: 'assistant', text: cleanMd.slice(0, 1200) },
        );
        void this.panel?.webview.postMessage({
          type: 'streamComplete',
          mode: 'explain',
          format: effectiveFormat,
          code: '',
          explanation: cleanMd,
          findings,
          modelLabel: `${result.provider} · ${result.modelName}`,
        });
      } else {
        const extracted = extractAndNormalizeAiDiagram(result.text, effectiveFormat);
        this.lastGeneratedCode = extracted.code;
        this.lastGeneratedFormat = effectiveFormat;
        this.history.push(
          { role: 'user', text: args.prompt || `${args.mode} (${effectiveFormat})` },
          { role: 'assistant', text: `${extracted.explanation}\n${extracted.code.slice(0, 600)}`.trim() },
        );
        let preview: { renderKind: 'mermaid' | 'svg'; payload: string; mermaidTheme?: string } = {
          renderKind: 'svg',
          payload: '',
        };
        if (extracted.code) {
          try {
            preview = await this.renderPreviewPayload(extracted.code, effectiveFormat);
          } catch (renderErr) {
            const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
            preview = {
              renderKind: 'svg',
              payload: `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="80"><rect width="100%" height="100%" fill="#fff5f5"/><text x="16" y="44" fill="#c53030" font-family="sans-serif" font-size="12">${escapeHtml(msg)}</text></svg>`,
            };
          }
        }
        void this.panel?.webview.postMessage({
          type: 'streamComplete',
          mode: args.mode,
          format: effectiveFormat,
          code: extracted.code,
          explanation: extracted.explanation,
          findings: [],
          preview,
          canApplyToTarget: Boolean(target && target.format === effectiveFormat),
          targetLabel: target?.label ?? '',
          modelLabel: `${result.provider} · ${result.modelName}`,
        });
      }
    } catch (err) {
      if (this.activeCts !== cts) {
        return;
      }
      if (err instanceof vscode.CancellationError) {
        void this.panel?.webview.postMessage({ type: 'streamCancelled' });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        void this.panel?.webview.postMessage({ type: 'streamError', message });
      }
    } finally {
      if (this.activeCts === cts) {
        this.activeCts = undefined;
        cts.dispose();
      }
    }
  }

  /**
   * Applies `code` (`format`) to an existing target diagram URI (preserving native Undo),
   * or opens a new untitled/workspace diagram when `openNewIfNoTarget` is set.
   */
  async applyDiagramCode(
    code: string,
    format: AiDiagramFormat,
    explicitTargetUri?: vscode.Uri,
    openNewIfNoTarget = true,
  ): Promise<vscode.Uri | undefined> {
    if (!code.trim()) {
      return undefined;
    }
    const target = await this.resolveTargetDiagram(explicitTargetUri ?? this.boundTargetUri);
    if (target && target.format === format) {
      if (format === 'drawio') {
        const ok = await this.drawio.applyAiDiagramXml(target.uri, code);
        if (ok) {
          void vscode.window.setStatusBarMessage(t('Applied AI changes to {0}', target.label), 3000);
          return target.uri;
        }
      } else {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const change = computeMinimalTextChange(doc.getText(), code);
        if (change) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            target.uri,
            new vscode.Range(doc.positionAt(change.startOffset), doc.positionAt(change.endOffset)),
            change.replacement,
          );
          await vscode.workspace.applyEdit(edit);
        }
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: true });
        await this.previews.open(target.uri, true);
        void vscode.window.setStatusBarMessage(t('Applied AI changes to {0}', target.label), 3000);
        return target.uri;
      }
    }

    if (!openNewIfNoTarget) {
      return undefined;
    }
    return this.openCodeAsNewDiagram(code, format);
  }

  async openCodeAsNewDiagram(code: string, format: AiDiagramFormat): Promise<vscode.Uri | undefined> {
    if (!code.trim()) {
      return undefined;
    }
    if (format === 'drawio') {
      const wsDir = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (wsDir) {
        let candidate = vscode.Uri.joinPath(wsDir, 'ai-diagram.drawio');
        let idx = 1;
        while (idx < 50) {
          try {
            await vscode.workspace.fs.stat(candidate);
            idx++;
            candidate = vscode.Uri.joinPath(wsDir, `ai-diagram-${idx}.drawio`);
          } catch {
            break;
          }
        }
        await vscode.workspace.fs.writeFile(candidate, Buffer.from(code, 'utf8'));
        await vscode.commands.executeCommand('vscode.openWith', candidate, DrawioViewTypeConst);
        this.boundTargetUri = candidate;
        return candidate;
      }
      const saved = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('ai-diagram.drawio'),
        filters: { 'Draw.io Diagram': ['drawio'] },
      });
      if (!saved) {
        return undefined;
      }
      await vscode.workspace.fs.writeFile(saved, Buffer.from(code, 'utf8'));
      await vscode.commands.executeCommand('vscode.openWith', saved, DrawioViewTypeConst);
      this.boundTargetUri = saved;
      return saved;
    }

    const langId = format === 'mermaid' ? 'mermaid' : format === 'plantuml' ? 'plantuml' : format;
    const doc = await vscode.workspace.openTextDocument({ language: langId, content: code });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    await this.previews.open(doc.uri, true);
    this.boundTargetUri = doc.uri;
    return doc.uri;
  }

  /**
   * Executes a single AI diagramming task headlessly with a cancellable VS Code progress
   * notification — used by direct commands (`fixSyntax`, programmatic `generateDiagram`/`modifyDiagram`)
   * and integration tests.
   */
  async executeHeadlessTask(args: HeadlessAiTaskArgs): Promise<HeadlessAiTaskResult | undefined> {
    const target = await this.resolveTargetDiagram(args.targetUri);
    const format: AiDiagramFormat =
      args.format ?? (args.mode === 'generate' ? 'mermaid' : (target?.format ?? 'mermaid'));
    const codeCtx = this.collectActiveCodeContext();
    const diagErrors =
      args.diagnosticHint ?? (target && args.mode === 'fix' ? this.collectDiagnosticSummary(target.uri) : undefined);
    const drawioSummary =
      target && target.format === 'drawio' && target.source.includes('<mx')
        ? convertDrawioToMermaid(target.source)
        : undefined;

    const fullPrompt = buildAiDiagramPrompt({
      mode: args.mode,
      format,
      userPrompt: args.prompt ?? '',
      currentDiagram: args.mode === 'generate' ? undefined : target?.source,
      drawioSummaryMermaid: drawioSummary,
      codeContext: codeCtx ? { fileName: codeCtx.fileName, content: codeCtx.content } : undefined,
      diagnosticErrors: diagErrors,
      optimizePreset: args.optimizePreset,
      lang: getLanguage(),
    });

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('DrawGraph AI: Processing diagram…'),
        cancellable: true,
      },
      async (_progress, token) => {
        try {
          const res = await runAiPrompt(this.context, fullPrompt, {
            token,
            skipConsent: args.skipConsent,
          });
          if (args.mode === 'explain') {
            const cleanMd = stripThinkingBlocks(res.text);
            return {
              code: '',
              explanation: cleanMd,
              findings: parseArchitectureFindings(cleanMd),
              format,
              provider: res.provider,
              modelName: res.modelName,
            };
          }
          const extracted = extractAndNormalizeAiDiagram(res.text, format);
          this.lastGeneratedCode = extracted.code;
          this.lastGeneratedFormat = format;
          let appliedUri: vscode.Uri | undefined;
          if (extracted.code && args.applyImmediately) {
            appliedUri = await this.applyDiagramCode(
              extracted.code,
              format,
              args.targetUri ?? target?.uri,
              args.openNewIfNoTarget ?? (args.mode === 'generate'),
            );
          } else if (extracted.code && args.openNewIfNoTarget && !target) {
            appliedUri = await this.openCodeAsNewDiagram(extracted.code, format);
          }
          return {
            code: extracted.code,
            explanation: extracted.explanation,
            findings: [],
            format,
            provider: res.provider,
            modelName: res.modelName,
            appliedUri,
          };
        } catch (err) {
          if (err instanceof vscode.CancellationError) {
            return undefined;
          }
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(t('DrawGraph AI failed: {0}', msg));
          throw err;
        }
      },
    );
  }

  async openVisualDiffForLastResult(codeOverride?: string, formatOverride?: AiDiagramFormat): Promise<boolean> {
    const code = codeOverride || this.lastGeneratedCode;
    const format = formatOverride || this.lastGeneratedFormat;
    if (!code.trim()) {
      return false;
    }
    const target = await this.resolveTargetDiagram(this.boundTargetUri);
    const beforeSource = target && target.format === format ? target.source : '';
    const beforeLabel = target && target.format === format ? `${target.label} (${t('Before')})` : t('Empty');
    const afterLabel = `✨ ${t('AI Proposed')}`;
    return this.visualDiff.openInMemoryComparison(
      `✨ ${target?.label ?? format.toUpperCase()} (${t('Visual Diff')})`,
      format,
      beforeSource,
      code,
      beforeLabel,
      afterLabel,
    );
  }

  private async onMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.webviewReady = true;
        const pending = this.pendingOpenOptions;
        this.pendingOpenOptions = undefined;
        await this.pushContextState(pending);
        if (pending?.autoRun) {
          await this.startStudioRun({
            mode: pending.mode ?? this.currentMode,
            format: pending.format ?? this.currentFormat,
            prompt: pending.initialPrompt ?? '',
            optimizePreset: pending.optimizePreset ?? this.currentPreset,
            includeCodeContext: true,
            skipConsent: pending.skipConsent,
          });
        }
        break;
      }
      case 'run': {
        const mode = (msg.mode as AiTaskMode) || 'generate';
        const format = (msg.format as AiDiagramFormat) || 'mermaid';
        const prompt = typeof msg.prompt === 'string' ? msg.prompt : '';
        const optimizePreset = msg.optimizePreset as OptimizePreset | undefined;
        const includeCodeContext = msg.includeCodeContext !== false;
        await this.startStudioRun({ mode, format, prompt, optimizePreset, includeCodeContext });
        break;
      }
      case 'stop':
        this.activeCts?.cancel();
        break;
      case 'clearHistory':
        this.history = [];
        this.lastGeneratedCode = '';
        await this.pushContextState();
        break;
      case 'applyResult': {
        const code = typeof msg.code === 'string' ? msg.code : this.lastGeneratedCode;
        const format = (msg.format as AiDiagramFormat) || this.lastGeneratedFormat;
        await this.applyDiagramCode(code, format, this.boundTargetUri, true);
        await this.pushContextState();
        break;
      }
      case 'openAsNew': {
        const code = typeof msg.code === 'string' ? msg.code : this.lastGeneratedCode;
        const format = (msg.format as AiDiagramFormat) || this.lastGeneratedFormat;
        await this.openCodeAsNewDiagram(code, format);
        await this.pushContextState();
        break;
      }
      case 'previewDiff': {
        const code = typeof msg.code === 'string' ? msg.code : this.lastGeneratedCode;
        const format = (msg.format as AiDiagramFormat) || this.lastGeneratedFormat;
        await this.openVisualDiffForLastResult(code, format);
        break;
      }
      case 'copyCode': {
        const code = typeof msg.code === 'string' ? msg.code : this.lastGeneratedCode;
        if (code) {
          await vscode.env.clipboard.writeText(code);
        }
        break;
      }
      case 'requestSettings':
        void this.panel?.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
        break;
      case 'updateSetting':
        if (typeof msg.key === 'string') {
          await applySettingUpdate(msg.key, msg.value);
          void this.panel?.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
          await this.pushContextState();
        }
        break;
      case 'drawerAction':
        await this.handleDrawerActionWithFeedback(msg.action);
        break;
      case 'openExtensionSettings':
        await openExtensionSettingsInVscode();
        break;
    }
  }

  private async handleDrawerActionWithFeedback(action: unknown): Promise<void> {
    if (action === 'setAiApiKey') {
      await setApiKey();
    } else if (action === 'clearAiApiKey') {
      await clearApiKey();
    } else if (action === 'discoverAiModels') {
      try {
        const models = await fetchProviderModels();
        if (models.length === 0) {
          void vscode.window.showInformationMessage(t('No models returned by the current AI provider.'));
        } else {
          const picked = await vscode.window.showQuickPick(
            models.map((m) => ({ label: m })),
            { placeHolder: t('Select AI model ({0} discovered)', models.length) },
          );
          if (picked) {
            await applySettingUpdate('ai.model', picked.label);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(t('Failed to discover models: {0}', msg));
      }
    } else {
      await handleSettingsDrawerAction(action);
    }
    void this.panel?.webview.postMessage({ type: 'settingsState', settings: getSettingsSnapshot() });
    await this.pushContextState();
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, ...p));
    const imgSrc = vscode.workspace.isTrusted
      ? `${webview.cspSource} https: data: blob:`
      : `${webview.cspSource} data: blob:`;
    const csp = [
      `default-src 'none'`,
      `img-src ${imgSrc}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${media('shared', 'settingsDrawer.css')}" rel="stylesheet">
  <link href="${media('ai', 'studio.css')}" rel="stylesheet">
</head>
<body>
  <header id="studioHeader">
    <div class="brandTitle">
      <span class="sparkleIcon">✨</span>
      <span id="headerTitleText">AI Diagram Studio</span>
      <span id="providerBadge" class="providerBadge" title="Configure AI Provider">VS Code</span>
    </div>
    <div class="headerActions">
      <button id="clearSessionBtn" type="button" class="ghostBtn" title="Reset Session">↺</button>
      <button id="settingsBtn" type="button" class="ghostBtn" title="AI Settings">⚙</button>
    </div>
  </header>

  <nav id="modeBar" role="tablist">
    <button type="button" role="tab" data-mode="generate" class="modeTab active">Generate</button>
    <button type="button" role="tab" data-mode="modify" class="modeTab">Modify</button>
    <button type="button" role="tab" data-mode="optimize" class="modeTab">Optimize</button>
    <button type="button" role="tab" data-mode="fix" class="modeTab">Fix Syntax</button>
    <button type="button" role="tab" data-mode="explain" class="modeTab">Explain & Review</button>
  </nav>

  <section id="contextBar">
    <div id="formatPickerWrap" class="ctxItem">
      <label for="formatSelect" id="lblFormat">Format</label>
      <select id="formatSelect">
        <option value="mermaid">Mermaid</option>
        <option value="drawio">Draw.io (.drawio)</option>
        <option value="plantuml">PlantUML</option>
        <option value="dot">Graphviz DOT</option>
        <option value="wavedrom">WaveDrom</option>
      </select>
    </div>
    <div id="targetInfoWrap" class="ctxItem">
      <span id="lblTarget" class="ctxLabel">Target:</span>
      <span id="targetBadge" class="targetBadge">New Diagram</span>
    </div>
    <label id="codeContextWrap" class="ctxCheckbox" hidden>
      <input id="includeCodeChk" type="checkbox" checked>
      <span id="codeContextText">Include code context</span>
    </label>
  </section>

  <section id="optimizePresetsBar" hidden>
    <button type="button" class="presetPill active" data-preset="layout">Layout & Subgraphs</button>
    <button type="button" class="presetPill" data-preset="style">Visual Styling</button>
    <button type="button" class="presetPill" data-preset="simplify">Simplify</button>
    <button type="button" class="presetPill" data-preset="resilience">Resilience & Retries</button>
    <button type="button" class="presetPill" data-preset="translate">Translate Labels</button>
  </section>

  <main id="studioMain">
    <div id="welcomeView">
      <div class="welcomeHero">
        <div class="welcomeSparkle">✨</div>
        <h2 id="welcomeTitle">Design, Refine & Review Diagrams with AI</h2>
        <p id="welcomeSub">Supports Mermaid, Draw.io, PlantUML, Graphviz DOT, and WaveDrom with visual Before ↔ After diffing.</p>
      </div>
      <div id="starterChips" class="starterChips"></div>
    </div>

    <div id="errorBanner" class="errorBanner" hidden></div>
    <div id="statusBanner" class="statusBanner" hidden></div>

    <div id="resultContainer" hidden>
      <div id="diagramOutputSection" hidden>
        <div class="outputHeader">
          <div class="outputTabs">
            <button type="button" id="tabPreviewBtn" class="outTab active">Live Preview</button>
            <button type="button" id="tabSourceBtn" class="outTab">Source Code</button>
          </div>
          <div class="outputActions">
            <button type="button" id="applyBtn" class="primaryActionBtn">Apply to Active Diagram</button>
            <button type="button" id="diffBtn" class="secondaryActionBtn">Visual Diff (Before ↔ After)</button>
            <button type="button" id="openNewBtn" class="secondaryActionBtn">Open as New Diagram</button>
            <button type="button" id="copyCodeBtn" class="secondaryActionBtn">Copy Code</button>
          </div>
        </div>
        <div id="previewCanvas" class="previewCanvas"></div>
        <pre id="sourceCodeView" class="sourceCodeView" hidden></pre>
      </div>

      <div id="findingsSection" class="findingsSection" hidden>
        <h3 id="findingsTitle">Architecture Findings</h3>
        <div id="findingsList" class="findingsList"></div>
      </div>

      <div id="explanationBox" class="explanationBox" hidden></div>
    </div>
  </main>

  <footer id="composerFooter">
    <textarea id="promptInput" rows="3" placeholder="Describe the diagram to generate or how to modify the active diagram…"></textarea>
    <div class="composerActions">
      <span class="shortcutHint">⌘/Ctrl + Enter</span>
      <button type="button" id="stopBtn" class="dangerBtn" hidden>Stop</button>
      <button type="button" id="runBtn" class="runBtn">✨ Run AI</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${media('vendor', 'mermaid.min.js')}"></script>
  <script nonce="${nonce}" src="${media('shared', 'settingsDrawer.js')}"></script>
  <script nonce="${nonce}" src="${media('ai', 'studio.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.activeCts?.cancel();
    this.activeCts?.dispose();
    this.panel?.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}

const DrawioViewTypeConst = 'drawGraph.drawio';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
