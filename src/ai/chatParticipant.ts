// Optional VS Code Chat Participant (`@drawgraph`) registration using safe runtime
// feature detection so DrawGraph stays 100% compatible with `@types/vscode ~1.85.0`.

import * as vscode from 'vscode';
import type { AiDiagramStudioManager } from './aiDiagramStudio';
import { t } from '../l10n';

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
      async (request, _chatCtx, stream) => {
        const cmd = request.command || 'gen';
        const prompt = request.prompt.trim();

        if (cmd === 'impact') {
          stream.markdown(`${t('Generating PR / Git Diff architecture impact diagram…')}\n\n`);
          await vscode.commands.executeCommand('drawGraph.generatePrImpactDiagram', 'HEAD', 'mermaid');
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
        const res = await aiStudio.executeHeadlessTask({
          mode: 'generate',
          format: 'mermaid',
          prompt: prompt || 'Create a clean system architecture diagram.',
          openNewIfNoTarget: true,
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
