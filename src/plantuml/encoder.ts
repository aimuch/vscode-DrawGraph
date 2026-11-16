import { promisify } from 'node:util';
import {
  brotliDecompressSync,
  constants as zlibConstants,
  deflateRaw,
  deflateRawSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib';

const deflateRawAsync = promisify(deflateRaw);
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

function encodeBytes(data: Uint8Array): string {
  const chunks: string[] = new Array(Math.ceil(data.length / 3));
  let idx = 0;
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    chunks[idx++] =
      ALPHABET[b1 >> 2] +
      ALPHABET[((b1 & 0x3) << 4) | (b2 >> 4)] +
      ALPHABET[((b2 & 0xf) << 2) | (b3 >> 6)] +
      ALPHABET[b3 & 0x3f];
  }
  return chunks.join('');
}

/** Encodes PlantUML source the way the PlantUML server expects in its URLs (deflate + custom base64). */
export function encodePlantUml(source: string): string {
  return encodeBytes(deflateRawSync(Buffer.from(source, 'utf8'), { level: 6 }));
}

/** Asynchronous variant of `encodePlantUml` so large diagrams do not block the extension host. */
export async function encodePlantUmlAsync(source: string): Promise<string> {
  const compressed = await deflateRawAsync(Buffer.from(source, 'utf8'), { level: 6 });
  return encodeBytes(compressed);
}

/**
 * Decodes a PlantUML URL-encoded payload (`~1` header or raw deflate + PlantUML's 64-char alphabet)
 * back into UTF-8 PlantUML source text.
 */
export function decodePlantUml(encoded: string): string | undefined {
  let clean = encoded.trim();
  if (clean.startsWith('~1')) {
    clean = clean.slice(2);
  }
  if (!clean || !/^[0-9A-Za-z\-_]+$/.test(clean)) {
    return undefined;
  }
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = ALPHABET.indexOf(clean[i] ?? '0');
    const c2 = ALPHABET.indexOf(clean[i + 1] ?? '0');
    const c3 = i + 2 < clean.length ? ALPHABET.indexOf(clean[i + 2]) : -1;
    const c4 = i + 3 < clean.length ? ALPHABET.indexOf(clean[i + 3]) : -1;
    bytes.push((c1 << 2) | (c2 >> 4));
    if (c3 >= 0) {
      bytes.push(((c2 & 0xf) << 4) | (c3 >> 2));
    }
    if (c4 >= 0) {
      bytes.push(((c3 & 0x3) << 6) | c4);
    }
  }
  const buf = Buffer.from(bytes);
  try {
    return inflateRawSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8');
  } catch {
    // Not raw deflate; try zlib or Brotli (used by PlantUML's `<!--SRC=[...]-->` metadata).
  }
  try {
    return inflateSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString('utf8');
  } catch {
    // Not standard zlib; try Brotli below.
  }
  for (let pad = 0; pad <= 2 && buf.length > pad; pad++) {
    try {
      return brotliDecompressSync(pad === 0 ? buf : buf.subarray(0, buf.length - pad)).toString('utf8');
    } catch {
      // Try next padding length (PlantUML's 6-bit encoder pads 3-byte groups with up to 2 zero bytes).
    }
  }
  return undefined;
}

function ensureStartEndWrapper(decoded: string): string {
  const trimmed = decoded.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (/^@start\w+/i.test(trimmed)) {
    return decoded;
  }
  return `@startuml\n${trimmed}\n@enduml\n`;
}

/**
 * Extracts original PlantUML source code embedded in a PlantUML-generated SVG
 * (`<!--SRC=[...]-->` comment or PlantUML server URL metadata).
 */
export function extractPlantUmlSourceFromSvg(svg: string): string | undefined {
  const commentMatch = /<!--\s*SRC=\[([~0-9A-Za-z\-_]+)\]\s*-->/.exec(svg);
  if (commentMatch) {
    const decoded = decodePlantUml(commentMatch[1]);
    return decoded ? ensureStartEndWrapper(decoded) : undefined;
  }
  const urlMatch = /plantuml[^"']*?\/(?:svg|png|uml)\/([~0-9A-Za-z\-_]{8,})/i.exec(svg);
  if (urlMatch) {
    const decoded = decodePlantUml(urlMatch[1]);
    return decoded ? ensureStartEndWrapper(decoded) : undefined;
  }
  return undefined;
}

export interface DiagramBlock {
  /** Source of the block including its @start/@end lines. */
  source: string;
  startLine: number;
  endLine: number;
  /** Optional label parsed from `@startuml <name>` or `title <text>`. */
  title?: string;
}

export function stripBlockComments(line: string, inComment: boolean): { code: string; inComment: boolean } {
  if (!inComment && !line.includes("/'")) {
    return { code: line, inComment: false };
  }
  let code = '';
  let pos = 0;
  while (pos < line.length) {
    if (inComment) {
      const end = line.indexOf("'/", pos);
      if (end < 0) {
        return { code, inComment: true };
      }
      inComment = false;
      pos = end + 2;
    } else {
      const start = line.indexOf("/'", pos);
      if (start < 0) {
        code += line.slice(pos);
        break;
      }
      code += line.slice(pos, start);
      inComment = true;
      pos = start + 2;
    }
  }
  return { code, inComment };
}

/**
 * Splits a file into its `@startXXX ... @endXXX` blocks. Nested `@startsub ... @endsub`
 * sections and markers inside `/' ... '/` block comments are ignored. A file without any
 * markers is treated as a single `@startuml` diagram.
 */
export function splitDiagrams(text: string): DiagramBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: DiagramBlock[] = [];
  let start = -1;
  let endTagRe: RegExp | undefined;
  let startSuffix = 'uml';
  let blockTitle: string | undefined;
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = stripBlockComments(lines[i], inComment);
    inComment = stripped.inComment;
    const line = stripped.code.trim();
    if (!line || line.startsWith("'")) {
      continue;
    }
    if (start < 0) {
      const m = /^@start(\w*)(?:\s+(.+))?$/i.exec(line);
      if (m && m[1].toLowerCase() !== 'sub') {
        start = i;
        startSuffix = m[1] || 'uml';
        blockTitle = m[2]?.trim() || undefined;
        endTagRe = new RegExp(`^@end${m[1]}(?:\\b|\\s|$)`, 'i');
      }
    } else if (endTagRe?.test(line)) {
      blocks.push({ source: lines.slice(start, i + 1).join('\n'), startLine: start, endLine: i, title: blockTitle });
      start = -1;
      endTagRe = undefined;
      blockTitle = undefined;
    } else if (!blockTitle) {
      const titleMatch = /^title\s+(.+)$/i.exec(line);
      if (titleMatch) {
        blockTitle = titleMatch[1].replace(/^["']|["']$/g, '').trim() || undefined;
      }
    }
  }
  if (start >= 0) {
    // Unterminated block: render it anyway so the user sees progress while typing.
    const rest = lines.slice(start);
    const end = '@end' + startSuffix;
    blocks.push({ source: [...rest, end].join('\n'), startLine: start, endLine: lines.length - 1, title: blockTitle });
  }
  if (blocks.length === 0 && text.trim().length > 0) {
    blocks.push({ source: `@startuml\n${text}\n@enduml`, startLine: 0, endLine: lines.length - 1 });
  }
  return blocks;
}

/** Counts how many pages a single PlantUML diagram block produces via `newpage` directives. */
export function countPages(blockSource: string): number {
  const lines = blockSource.split(/\r?\n/);
  let pages = 1;
  let inComment = false;
  let seenBody = false;
  for (const raw of lines) {
    const stripped = stripBlockComments(raw, inComment);
    inComment = stripped.inComment;
    const line = stripped.code.trim();
    if (!line || line.startsWith("'") || /^@(?:start|end)\w*/i.test(line)) {
      continue;
    }
    if (/^newpage(?:\b|\s|$)/i.test(line)) {
      if (seenBody) {
        pages++;
        seenBody = false;
      }
    } else {
      seenBody = true;
    }
  }
  return pages;
}

/** Picks the block that contains `line`, falling back to the nearest preceding one, then the first. */
export function pickBlock(blocks: DiagramBlock[], line: number | undefined): DiagramBlock | undefined {
  if (blocks.length === 0) {
    return undefined;
  }
  if (line === undefined) {
    return blocks[0];
  }
  let best = blocks[0];
  for (const block of blocks) {
    if (block.startLine <= line) {
      best = block;
    }
  }
  return best;
}
