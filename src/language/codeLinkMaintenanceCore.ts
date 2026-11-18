// Pure helpers for auditing broken local Code Links (`path/to/file.ts:line` & `!include`)
// and automatically rewriting diagram file references when workspace files are renamed/moved.

import * as path from 'node:path';
import { extractCodeLinksFromDrawioXml } from '../drawio/codeLinksXml';
import { extractDiagramDocumentLinks } from './advancedFeatures';

export interface AuditedFileLink {
  rawTarget: string;
  cleanRelativePath: string;
  resolvedFsPath: string;
  line: number;
  startCol: number;
  endCol: number;
}

function stripLineAndAnchor(target: string): { filePart: string; suffix: string } {
  const hashIdx = target.indexOf('#');
  if (hashIdx >= 0) {
    return { filePart: target.slice(0, hashIdx), suffix: target.slice(hashIdx) };
  }
  const colonMatch = /^(.*?)(:\d+(?::\d+)?)$/.exec(target);
  if (colonMatch) {
    return { filePart: colonMatch[1], suffix: colonMatch[2] };
  }
  return { filePart: target, suffix: '' };
}

export function collectLocalFileLinksInTextDiagram(
  source: string,
  kind: 'mermaid' | 'plantuml',
  docFsPath: string,
  workspaceRootFsPath?: string,
): AuditedFileLink[] {
  const links = extractDiagramDocumentLinks(source, kind);
  const docDir = path.dirname(docFsPath);
  const out: AuditedFileLink[] = [];

  for (const lk of links) {
    if (lk.kind === 'url') {
      continue;
    }
    const { filePart } = stripLineAndAnchor(lk.target.trim());
    if (!filePart || filePart.startsWith('#') || /^[a-z]+:\/\//i.test(filePart)) {
      continue;
    }
    const relDocCandidate = path.resolve(docDir, filePart);
    const wsCandidate = workspaceRootFsPath ? path.resolve(workspaceRootFsPath, filePart) : relDocCandidate;
    out.push({
      rawTarget: lk.target,
      cleanRelativePath: filePart,
      resolvedFsPath: filePart.startsWith('.') ? relDocCandidate : wsCandidate,
      line: lk.line,
      startCol: lk.startCol,
      endCol: lk.endCol,
    });
  }
  return out;
}

export function collectLocalFileLinksInDrawioXml(
  xml: string,
  docFsPath: string,
  workspaceRootFsPath?: string,
): Array<{ rawTarget: string; cleanRelativePath: string; resolvedFsPath: string; label: string }> {
  const items = extractCodeLinksFromDrawioXml(xml);
  const docDir = path.dirname(docFsPath);
  const out: Array<{ rawTarget: string; cleanRelativePath: string; resolvedFsPath: string; label: string }> = [];
  for (const item of items) {
    if (item.target.startsWith('#') || /^[a-z]+:\/\//i.test(item.target)) {
      continue;
    }
    const { filePart } = stripLineAndAnchor(item.target);
    if (!filePart) continue;
    const relDocCandidate = path.resolve(docDir, filePart);
    const wsCandidate = workspaceRootFsPath ? path.resolve(workspaceRootFsPath, filePart) : relDocCandidate;
    out.push({
      rawTarget: item.target,
      cleanRelativePath: filePart,
      resolvedFsPath: filePart.startsWith('.') ? relDocCandidate : wsCandidate,
      label: item.label,
    });
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Rewrites workspace-relative and document-relative file path references inside plain-text
 * diagrams (`.drawio`, `.drawio.svg`, `.mmd`, `.puml`, `.md`) when files or directories move.
 */
export function rewriteRenamedPathsInText(
  content: string,
  docFsPath: string,
  workspaceRootFsPath: string,
  renames: ReadonlyArray<{ oldFsPath: string; newFsPath: string }>,
): { updated: string; replacements: number } {
  let updated = content;
  let replacements = 0;
  const docDir = path.dirname(docFsPath);

  for (const { oldFsPath, newFsPath } of renames) {
    const oldWsRel = toPosix(path.relative(workspaceRootFsPath, oldFsPath));
    const newWsRel = toPosix(path.relative(workspaceRootFsPath, newFsPath));

    let oldDocRel = toPosix(path.relative(docDir, oldFsPath));
    let newDocRel = toPosix(path.relative(docDir, newFsPath));
    const oldDocDotRel = oldDocRel.startsWith('.') ? oldDocRel : `./${oldDocRel}`;
    const newDocDotRel = newDocRel.startsWith('.') ? newDocRel : `./${newDocRel}`;

    const pairs: Array<[string, string]> = [];
    if (oldDocDotRel !== newDocDotRel) {
      pairs.push([oldDocDotRel, newDocDotRel]);
    }
    if (oldWsRel && !oldWsRel.startsWith('..') && oldWsRel !== newWsRel) {
      pairs.push([oldWsRel, newWsRel]);
    }
    if (oldDocRel && oldDocRel !== oldWsRel && oldDocRel !== oldDocDotRel && oldDocRel !== newDocRel) {
      pairs.push([oldDocRel, newDocRel]);
    }

    // Sort longest first so `./dir/foo.ts` is matched before `dir/foo.ts`
    pairs.sort((a, b) => b[0].length - a[0].length);

    for (const [fromPath, toPath] of pairs) {
      const escaped = fromPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Only match bounded path occurrences (preceded by quote, paren, bracket, `=`, whitespace, or line start;
      // followed by `:line`, `#Lline`, quote, paren, bracket, `;`, `&`, whitespace, or line end).
      const re = new RegExp(
        `(^|["'(\\[\\s=;>]|&#x[0-9a-fA-F]+;)(${escaped})((?::\\d+(?::\\d+)?|#L?\\d+)?)(?=$|["')\\]\\s<;,|&])`,
        'gm',
      );
      updated = updated.replace(re, (_full, pre: string, _matched: string, suffix: string) => {
        replacements++;
        return `${pre}${toPath}${suffix}`;
      });
    }
  }

  return { updated, replacements };
}
