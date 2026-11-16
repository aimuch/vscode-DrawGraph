import { inflateRawSync } from 'node:zlib';
import { escapeXmlAttribute, unescapeXml } from './drawioSvg';

export interface DiagramCodeLink {
  label: string;
  target: string;
  kind: 'symbol' | 'file';
}

function stripHtmlTags(raw: string): string {
  return unescapeXml(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

function expandCompressedDiagrams(xml: string): string {
  return xml.replace(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/gi, (full, attrs: string, inner: string) => {
    const trimmed = inner.trim();
    if (!trimmed || trimmed.includes('<mxGraphModel')) {
      return full;
    }
    try {
      const inflated = inflateRawSync(Buffer.from(trimmed, 'base64')).toString('utf8');
      const decoded = inflated.includes('%3C') || inflated.includes('%3c') ? decodeURIComponent(inflated) : inflated;
      return `<diagram${attrs}>${decoded}</diagram>`;
    } catch {
      return full;
    }
  });
}

/**
 * Extracts code references (`#SymbolName`, `#Class.method`, `path/to/file.ts:42`, or
 * `link="..."` attributes) from a draw.io `<mxfile>` XML document.
 */
export function extractCodeLinksFromDrawioXml(rawXml: string): DiagramCodeLink[] {
  const xml = expandCompressedDiagrams(rawXml);
  const seen = new Set<string>();
  const links: DiagramCodeLink[] = [];

  const pushLink = (label: string, target: string, kind: 'symbol' | 'file') => {
    const key = `${kind}:${target}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({ label, target, kind });
    }
  };

  // Explicit `link="..."` attributes on UserObject / object / mxCell nodes.
  const linkAttrRe = /\blink\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = linkAttrRe.exec(xml)) !== null) {
    const href = unescapeXml(m[1] ?? m[2] ?? '').trim();
    if (!href || /^(?:https?:|mailto:|data:|javascript:)/i.test(href)) {
      continue;
    }
    if (href.startsWith('#')) {
      pushLink(href, href.slice(1), 'symbol');
    } else {
      pushLink(href, href, 'file');
    }
  }

  // Node labels (`value="..."` or `label="..."`) containing `#Symbol` or `file.ext:line`.
  const valAttrRe = /\b(?:value|label)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = valAttrRe.exec(xml)) !== null) {
    const text = stripHtmlTags(m[1] ?? m[2] ?? '');
    if (!text) {
      continue;
    }
    const symRe = /(?:^|[\s(])#([A-Za-z_$][A-Za-z0-9_$.#]*)/g;
    let sm: RegExpExecArray | null;
    while ((sm = symRe.exec(text)) !== null) {
      pushLink(`#${sm[1]}`, sm[1], 'symbol');
    }
    const fileRe = /\b([A-Za-z0-9_./-]+\.[A-Za-z]{1,8}(?::\d+|#L\d+)?)\b/g;
    let fm: RegExpExecArray | null;
    while ((fm = fileRe.exec(text)) !== null) {
      const candidate = fm[1];
      if (!/^(?:embed\.diagrams\.net|www\.plantuml\.com)/i.test(candidate)) {
        pushLink(candidate, candidate, 'file');
      }
    }
  }

  return links;
}

/**
 * Builds a draw.io `<mxfile>` merge payload inserting a code-linked node (`#SymbolName`
 * or `path/to/file.ts:line`) onto the current page.
 */
export function buildCodeSymbolMergeXml(label: string, linkTarget: string, seq = Date.now()): string {
  const cellId = `code_sym_${seq}`;
  const safeLabel = escapeXmlAttribute(label);
  const safeLink = escapeXmlAttribute(linkTarget);
  const width = Math.max(150, Math.min(320, label.length * 9 + 36));
  return (
    '<mxfile><diagram id="merge" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
    `<UserObject label="${safeLabel}" link="${safeLink}" id="${cellId}">` +
    '<mxCell style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontFamily=Courier New;fontStyle=1;" vertex="1" parent="1">' +
    `<mxGeometry x="80" y="80" width="${width}" height="48" as="geometry"/>` +
    '</mxCell></UserObject>' +
    '</root></mxGraphModel></diagram></mxfile>'
  );
}
