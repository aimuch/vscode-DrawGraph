// Optional VS Code Chat Participant (`@drawgraph`) registration using safe runtime
// feature detection so DrawGraph stays 100% compatible with `@types/vscode ~1.85.0`.

import * as vscode from 'vscode';
import type { AiDiagramStudioManager } from './aiDiagramStudio';
import type { AiDiagramFormat } from './diagramAiCore';
import { t } from '../l10n';

function inferFormatFromPrompt(prompt: string): AiDiagramFormat {
  const lower = prompt.toLowerCase();
  if (/\bd2\b/.test(lower)) return 'd2';
  if (/\bdraw\.?io\b|\bmxfile\b/.test(lower)) return 'drawio';
  if (/\bplantuml\b|\bpuml\b/.test(lower)) return 'plantuml';
  if (/\bgraphviz\b|\bdot\b/.test(lower)) return 'dot';
  if (/\bwavedrom\b|\bbitfield\b|波形|寄存器/.test(lower)) return 'wavedrom';
  return 'mermaid';
}

interface ChatRequestLike {
  prompt: string;
  command?: string;
}

interface ChatResponseStreamLike {
  markdown(value: string): void;
  button(command: { title: string; command: string; arguments?: unknown[] }): void;
}

interface ChatNamespaceLike {
  createChatParticipant(
    id: string,
    handler: (
      request: ChatRequestLike,
      context: unknown,
      stream: ChatResponseStreamLike,
      token: vscode.CancellationToken,
    ) => Promise<void> | void,
  ): vscode.Disposable & { iconPath?: vscode.Uri };
}

export function registerDrawGraphChatParticipant(
  context: vscode.ExtensionContext,
  aiStudio: AiDiagramStudioManager,
): void {
  const chatNs = (vscode as unknown as { chat?: ChatNamespaceLike }).chat;
  if (!chatNs || typeof chatNs.createChatParticipant !== 'function') {
    return;
  }

  try {
    const participant = chatNs.createChatParticipant(
      'drawgraph.assistant',
      async (request, _chatCtx, stream, token) => {
        const cmd = request.command || 'gen';
        const prompt = request.prompt.trim();

        if (cmd === 'impact') {
          stream.markdown(`${t('Generating PR / Git Diff architecture impact diagram…')}\n\n`);
          try {
            const fmt = inferFormatFromPrompt(prompt);
            const targetFmt = fmt === 'd2' || fmt === 'drawio' ? fmt : 'mermaid';
            const doc = await vscode.commands.executeCommand<vscode.TextDocument | vscode.Uri | undefined>(
              'drawGraph.generatePrImpactDiagram',
              'HEAD',
              targetFmt,
            );
            if (doc && 'getText' in doc) {
              stream.markdown(`\`\`\`${targetFmt}\n${doc.getText()}\n\`\`\`\n\n`);
            } else if (!doc) {
              stream.markdown(`${t('No changed files found compared to {0}.', 'HEAD')}\n\n`);
            }
          } catch (err) {
            stream.markdown(`${t('DrawGraph AI failed: {0}', (err as Error).message)}\n\n`);
          }
          stream.button({
            title: `✨ ${t('Open AI Diagram Studio')}`,
            command: 'drawGraph.ai.openStudio',
          });
          return;
        }

        if (cmd === 'fix') {
          const res = await aiStudio.executeHeadlessTask({
            mode: 'fix',
            prompt,
            applyImmediately: true,
            externalToken: token,
          });
          if (res?.code) {
            stream.markdown(`\`\`\`${res.format}\n${res.code}\`\`\`\n\n${res.explanation || ''}`);
          } else {
            stream.markdown(t('No syntax errors fixed or operation cancelled.'));
          }
          return;
        }

        if (cmd === 'review') {
          const res = await aiStudio.executeHeadlessTask({
            mode: 'explain',
            prompt,
            externalToken: token,
          });
          if (res?.explanation) {
            stream.markdown(res.explanation);
            stream.button({
              title: `✨ ${t('Open AI Diagram Studio')}`,
              command: 'drawGraph.ai.openStudio',
              arguments: [{ mode: 'explain' }],
            });
          }
          return;
        }

        // Default `/gen`
        const inferredFormat = inferFormatFromPrompt(prompt);
        const res = await aiStudio.executeHeadlessTask({
          mode: 'generate',
          format: inferredFormat,
          prompt: prompt || 'Create a clean system architecture diagram.',
          openNewIfNoTarget: true,
          externalToken: token,
        });
        if (res?.code) {
          stream.markdown(`\`\`\`${res.format}\n${res.code}\`\`\`\n\n${res.explanation || ''}`);
          stream.button({
            title: `✨ ${t('Open AI Diagram Studio')}`,
            command: 'drawGraph.ai.openStudio',
          });
        }
      },
    );
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icons', 'drawgraph.svg');
    context.subscriptions.push(participant);
  } catch {
    // Ignore on VS Code versions without Chat Participant support
  }
}
