// Pure TypeScript offline renderer for WaveDrom timing waveforms (`signal`) and
// BitField hardware register diagrams (`reg`). Supports relaxed WaveJSON syntax
// (comments, single-quoted strings, unquoted keys, and trailing commas).

export interface WaveSignalEntry {
  name?: string;
  wave?: string;
  data?: string | string[];
  period?: number;
  phase?: number;
  node?: string;
}

export type WaveSignalItem = WaveSignalEntry | [string, ...WaveSignalItem[]] | Record<string, never>;

export interface RegField {
  bits: number;
  name?: string | number;
  attr?: string | string[];
  type?: number;
  rotate?: number;
}

export interface WaveDromDoc {
  signal?: WaveSignalItem[];
  reg?: RegField[];
  edge?: string[];
  head?: { text?: string; tick?: number; tock?: number };
  foot?: { text?: string; tick?: number; tock?: number };
  config?: {
    hscale?: number;
    bits?: number;
    lanes?: number;
    hspace?: number;
    vspace?: number;
    fontsize?: number;
  };
}

/**
 * Converts relaxed WaveJSON (JS object-literal subset with `//` or `/*` comments,
 * single-quoted strings, unquoted identifier keys, and trailing commas) into strict JSON.
 */
export function parseWaveJson(source: string): WaveDromDoc {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error('Empty WaveDrom source.');
  }
  try {
    return JSON.parse(trimmed) as WaveDromDoc;
  } catch {
    // Fall through to relaxed tokenizer
  }

  let out = '';
  let i = 0;
  const n = trimmed.length;

  while (i < n) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];

    // Line comment
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && trimmed[i] !== '\n') {
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(trimmed[i] === '*' && trimmed[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }
    // Double-quoted string
    if (ch === '"') {
      out += '"';
      i++;
      while (i < n) {
        const c = trimmed[i++];
        if (c === '\\' && i < n) {
          const esc = trimmed[i++];
          out += esc === "'" ? "'" : `\\${esc}`;
        } else if (c === '"') {
          out += '"';
          break;
        } else if (c === '\n' || c === '\r') {
          out += '\\n';
        } else {
          out += c;
        }
      }
      continue;
    }
    // Single-quoted string -> JSON double-quoted string
    if (ch === "'") {
      out += '"';
      i++;
      while (i < n) {
        const c = trimmed[i++];
        if (c === '\\' && i < n) {
          const esc = trimmed[i++];
          if (esc === "'") {
            out += "'";
          } else if (esc === '"') {
            out += '\\"';
          } else {
            out += `\\${esc}`;
          }
        } else if (c === "'") {
          out += '"';
          break;
        } else if (c === '"') {
          out += '\\"';
        } else if (c === '\n' || c === '\r') {
          out += '\\n';
        } else {
          out += c;
        }
      }
      continue;
    }
    // Identifier: quote if followed by `:` (unquoted object key)
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < n && /[A-Za-z0-9_$]/.test(trimmed[end])) {
        end++;
      }
      const ident = trimmed.slice(i, end);
      let look = end;
      while (look < n && /\s/.test(trimmed[look])) {
        look++;
      }
      if (trimmed[look] === ':') {
        out += `"${ident}"`;
      } else {
        out += ident;
      }
      i = end;
      continue;
    }

    out += ch;
    i++;
  }

  // Strip trailing commas before `}` or `]`
  const cleaned = out.replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(cleaned) as WaveDromDoc;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('WaveDrom root must be an object containing "signal" or "reg".');
  }
  return parsed;
}

const BUS_FILLS: Record<string, string> = {
  '=': '#f8fafc',
  '2': '#fef9c3',
  '3': '#ffedd5',
  '4': '#dcfce7',
  '5': '#dbeafe',
  '6': '#f3e8ff',
  '7': '#fce7f3',
  '8': '#ccfbf1',
  '9': '#e0e7ff',
};

const REG_TYPE_FILLS: Record<number, string> = {
  0: '#e2e8f0',
  1: '#cbd5e1',
  2: '#fecaca',
  3: '#fde68a',
  4: '#bbf7d0',
  5: '#bfdbfe',
  6: '#e9d5ff',
  7: '#fbcfe8',
};

interface FlattenedSignal {
  group?: string;
  entry: WaveSignalEntry;
  spacer?: boolean;
}

function flattenSignals(items: WaveSignalItem[], groupPrefix = ''): FlattenedSignal[] {
  const out: FlattenedSignal[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      const [grpName, ...rest] = item;
      const nextGroup = groupPrefix ? `${groupPrefix} / ${grpName}` : String(grpName ?? '');
      out.push(...flattenSignals(rest, nextGroup));
    } else if (item && typeof item === 'object') {
      const hasContent = Boolean(item.name || item.wave || item.node);
      out.push({ group: groupPrefix || undefined, entry: item, spacer: !hasContent });
    }
  }
  return out;
}

function parseDataItems(data?: string | string[]): string[] {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data.map(String);
  }
  return String(data).trim().split(/\s+/).filter(Boolean);
}

function isBusChar(ch: string): boolean {
  return ch === '=' || (ch >= '2' && ch <= '9');
}

function renderSignalWaveformSvg(doc: WaveDromDoc): string {
  const rows = flattenSignals(doc.signal ?? []);
  const hscale = Math.max(0.5, Math.min(4, Number(doc.config?.hscale) || 1));
  const stepW = Math.round(40 * hscale);
  const rowH = 34;
  const waveH = 20;

  let maxCycles = 1;
  for (const r of rows) {
    if (r.entry.wave) {
      const period = Math.max(0.5, Number(r.entry.period) || 1);
      maxCycles = Math.max(maxCycles, Math.ceil(r.entry.wave.length * period));
    }
  }

  let maxLabelChars = 6;
  for (const r of rows) {
    const fullName = r.group ? `[${r.group}] ${r.entry.name ?? ''}` : (r.entry.name ?? '');
    maxLabelChars = Math.max(maxLabelChars, fullName.length);
  }

  const leftPad = Math.min(240, Math.max(84, maxLabelChars * 8 + 28));
  const hasHead = Boolean(doc.head && (doc.head.text !== undefined || doc.head.tick !== undefined || doc.head.tock !== undefined));
  const hasFoot = Boolean(doc.foot && (doc.foot.text !== undefined || doc.foot.tick !== undefined || doc.foot.tock !== undefined));
  const topPad = hasHead ? 46 : 20;
  const bottomPad = hasFoot ? 42 : 20;
  const plotW = maxCycles * stepW;
  const totalW = leftPad + plotW + 28;
  const totalH = topPad + Math.max(1, rows.length) * rowH + bottomPad;

  const parts: string[] = [];
  const nodeCoords = new Map<string, { x: number; y: number }>();

  // Vertical cycle guidelines
  for (let c = 0; c <= maxCycles; c++) {
    const gx = leftPad + c * stepW;
    parts.push(`<line x1="${gx}" y1="${topPad - 6}" x2="${gx}" y2="${topPad + rows.length * rowH}" stroke="#cbd5e1" stroke-width="0.8" stroke-dasharray="2,3"/>`);
  }

  if (hasHead && doc.head) {
    if (doc.head.text) {
      parts.push(`<text x="${leftPad + plotW / 2}" y="18" text-anchor="middle" font-size="13" font-weight="600" fill="#0f172a">${escXml(String(doc.head.text))}</text>`);
    }
    if (doc.head.tick !== undefined || doc.head.tock !== undefined) {
      const startNum = Number(doc.head.tick ?? doc.head.tock ?? 0);
      const offset = doc.head.tock !== undefined && doc.head.tick === undefined ? stepW / 2 : 0;
      for (let c = 0; c < maxCycles; c++) {
        parts.push(`<text x="${leftPad + c * stepW + offset}" y="${topPad - 10}" text-anchor="middle" font-size="10" fill="#64748b">${startNum + c}</text>`);
      }
    }
  }

  rows.forEach((row, rowIdx) => {
    const yMid = topPad + rowIdx * rowH + rowH / 2;
    const yHigh = yMid - waveH / 2;
    const yLow = yMid + waveH / 2;

    if (row.spacer) {
      return;
    }

    const label = row.group ? `${row.group}: ${row.entry.name ?? ''}` : (row.entry.name ?? '');
    if (label) {
      parts.push(
        `<g class="node"><text x="${leftPad - 12}" y="${yMid + 4}" text-anchor="end" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#1e293b">${escXml(label)}</text></g>`,
      );
    }

    const wave = row.entry.wave ?? '';
    const period = Math.max(0.5, Number(row.entry.period) || 1);
    const phase = Number(row.entry.phase) || 0;
    const cw = stepW * period;
    const startX = leftPad - phase * stepW;
    const dataQueue = parseDataItems(row.entry.data);
    let dataIdx = 0;

    // Record named timing nodes for edge arrows
    if (row.entry.node) {
      for (let ni = 0; ni < row.entry.node.length; ni++) {
        const nch = row.entry.node[ni];
        if (nch && nch !== '.') {
          nodeCoords.set(nch, { x: startX + (ni + 0.5) * cw, y: yMid });
        }
      }
    }

    // Expand effective tokens while tracking bus spans
    interface CycleToken {
      raw: string;
      eff: string;
      transition: boolean;
    }
    const tokens: CycleToken[] = [];
    let prevEff = 'x';
    for (let i = 0; i < wave.length; i++) {
      const raw = wave[i];
      if (raw === '.') {
        tokens.push({ raw, eff: prevEff, transition: false });
      } else if (raw === '|') {
        tokens.push({ raw: '|', eff: prevEff, transition: false });
      } else {
        tokens.push({ raw, eff: raw, transition: i > 0 && (raw !== prevEff || isBusChar(raw)) });
        prevEff = raw;
      }
    }

    // Render bus / `x` spans first as continuous polygons
    let idx = 0;
    while (idx < tokens.length) {
      const tk = tokens[idx];
      if (isBusChar(tk.eff) || tk.eff === 'x') {
        let endIdx = idx + 1;
        while (endIdx < tokens.length && tokens[endIdx].raw === '.') {
          endIdx++;
        }
        const x0 = Math.max(leftPad, startX + idx * cw);
        const x1 = startX + endIdx * cw;
        const slant = Math.min(5, cw * 0.16);
        const leftSlant = idx > 0 ? slant : 0;
        const rightSlant = endIdx < tokens.length ? slant : 0;
        const poly = [
          `${x0},${yMid}`,
          `${x0 + leftSlant},${yHigh}`,
          `${x1 - rightSlant},${yHigh}`,
          `${x1},${yMid}`,
          `${x1 - rightSlant},${yLow}`,
          `${x0 + leftSlant},${yLow}`,
        ].join(' ');
        const fill = tk.eff === 'x' ? 'url(#wd-hatch)' : (BUS_FILLS[tk.eff] ?? '#f8fafc');
        parts.push(`<polygon points="${poly}" fill="${fill}" stroke="#0f172a" stroke-width="1.3" stroke-linejoin="round"/>`);
        if (isBusChar(tk.eff)) {
          const dLabel = dataQueue[dataIdx++] ?? '';
          if (dLabel) {
            parts.push(
              `<text x="${(x0 + x1) / 2}" y="${yMid + 4}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" fill="#0f172a">${escXml(dLabel)}</text>`,
            );
          }
        }
        idx = endIdx;
        continue;
      }
      idx++;
    }

    // Render logic lines, clocks, high-Z, and gaps
    let prevLevelY: number | null = null;
    for (let i = 0; i < tokens.length; i++) {
      const tk = tokens[i];
      const x0 = startX + i * cw;
      const x1 = x0 + cw;
      const xm = x0 + cw / 2;

      if (tk.raw === '|') {
        parts.push(
          `<path d="M ${xm - 3} ${yHigh - 3} Q ${xm + 1} ${yMid} ${xm - 3} ${yLow + 3} M ${xm + 3} ${yHigh - 3} Q ${xm + 7} ${yMid} ${xm + 3} ${yLow + 3}" fill="none" stroke="#64748b" stroke-width="1.4"/>`,
        );
        prevLevelY = null;
        continue;
      }

      if (isBusChar(tk.eff) || tk.eff === 'x') {
        prevLevelY = yMid;
        continue;
      }

      if (tk.eff === 'z') {
        parts.push(`<line x1="${x0}" y1="${yMid}" x2="${x1}" y2="${yMid}" stroke="#d97706" stroke-width="1.5" stroke-dasharray="4,2"/>`);
        prevLevelY = yMid;
        continue;
      }

      if (tk.eff === 'p' || tk.eff === 'P' || tk.eff === 'n' || tk.eff === 'N') {
        const pos = tk.eff === 'p' || tk.eff === 'P';
        const yStart = pos ? yLow : yHigh;
        const yPeak = pos ? yHigh : yLow;
        const d = `M ${x0} ${yStart} L ${x0} ${yPeak} L ${xm} ${yPeak} L ${xm} ${yStart} L ${x1} ${yStart}`;
        parts.push(`<path d="${d}" fill="none" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>`);
        if (tk.eff === 'P') {
          parts.push(`<polygon points="${x0 - 3},${yMid + 2} ${x0},${yMid - 4} ${x0 + 3},${yMid + 2}" fill="#0f172a"/>`);
        } else if (tk.eff === 'N') {
          parts.push(`<polygon points="${x0 - 3},${yMid - 2} ${x0},${yMid + 4} ${x0 + 3},${yMid - 2}" fill="#0f172a"/>`);
        }
        prevLevelY = yStart;
        continue;
      }

      const targetY =
        tk.eff === '1' || tk.eff === 'h' || tk.eff === 'H' || tk.eff === 'u'
          ? yHigh
          : yLow;
      const strokeDash = tk.eff === 'u' || tk.eff === 'd' ? ' stroke-dasharray="3,2"' : '';
      if (prevLevelY !== null && prevLevelY !== targetY) {
        parts.push(`<line x1="${x0}" y1="${prevLevelY}" x2="${x0}" y2="${targetY}" stroke="#0f172a" stroke-width="1.5"/>`);
      }
      parts.push(`<line x1="${x0}" y1="${targetY}" x2="${x1}" y2="${targetY}" stroke="#0f172a" stroke-width="1.5"${strokeDash}/>`);
      prevLevelY = targetY;
    }
  });

  // Render timing edges (`edge: ['a~>b t_su', 'b<->c 10ns']`)
  for (const spec of doc.edge ?? []) {
    const m = /^([A-Za-z0-9])\s*(<->|<-|->|~>|~|-~|\|-|-\|)\s*([A-Za-z0-9])(?:\s+(.*))?$/.exec(spec.trim());
    if (!m) {
      continue;
    }
    const p1 = nodeCoords.get(m[1]);
    const p2 = nodeCoords.get(m[3]);
    if (!p1 || !p2) {
      continue;
    }
    const op = m[2];
    const label = (m[4] ?? '').trim();
    const curved = op.includes('~');
    const markerEnd = op.endsWith('>') ? ' marker-end="url(#wd-arrow)"' : '';
    const markerStart = op.startsWith('<') ? ' marker-start="url(#wd-arrow-start)"' : '';
    if (curved) {
      const cx = (p1.x + p2.x) / 2;
      const cy = Math.min(p1.y, p2.y) - 14;
      parts.push(`<path d="M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}" fill="none" stroke="#2563eb" stroke-width="1.3"${markerStart}${markerEnd}/>`);
    } else {
      parts.push(`<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#2563eb" stroke-width="1.3"${markerStart}${markerEnd}/>`);
    }
    if (label) {
      const lx = (p1.x + p2.x) / 2;
      const ly = (p1.y + p2.y) / 2 - 4;
      parts.push(`<rect x="${lx - label.length * 3.6 - 4}" y="${ly - 10}" width="${label.length * 7.2 + 8}" height="14" rx="3" fill="#ffffff" opacity="0.9"/>`);
      parts.push(`<text x="${lx}" y="${ly}" text-anchor="middle" font-size="10" fill="#1d4ed8">${escXml(label)}</text>`);
    }
  }

  if (hasFoot && doc.foot) {
    const footY = topPad + rows.length * rowH + 18;
    if (doc.foot.tick !== undefined || doc.foot.tock !== undefined) {
      const startNum = Number(doc.foot.tick ?? doc.foot.tock ?? 0);
      const offset = doc.foot.tock !== undefined && doc.foot.tick === undefined ? stepW / 2 : 0;
      for (let c = 0; c < maxCycles; c++) {
        parts.push(`<text x="${leftPad + c * stepW + offset}" y="${footY}" text-anchor="middle" font-size="10" fill="#64748b">${startNum + c}</text>`);
      }
    }
    if (doc.foot.text) {
      parts.push(`<text x="${leftPad + plotW / 2}" y="${totalH - 6}" text-anchor="middle" font-size="12" fill="#334155">${escXml(String(doc.foot.text))}</text>`);
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">`,
    `<defs>`,
    `<pattern id="wd-hatch" width="6" height="6" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="6" stroke="#94a3b8" stroke-width="1.6"/></pattern>`,
    `<marker id="wd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 1 L 8 4 L 0 7 z" fill="#2563eb"/></marker>`,
    `<marker id="wd-arrow-start" viewBox="0 0 8 8" refX="1" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 8 1 L 0 4 L 8 7 z" fill="#2563eb"/></marker>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...parts,
    `</svg>`,
  ].join('');
}

function renderBitFieldRegisterSvg(doc: WaveDromDoc): string {
  const fields = doc.reg ?? [];
  const totalBitsFromFields = fields.reduce((acc, f) => acc + Math.max(1, Math.round(Number(f.bits) || 1)), 0);
  const totalBits = Math.max(totalBitsFromFields, Math.round(Number(doc.config?.bits) || 0) || totalBitsFromFields || 8);
  const lanes = Math.max(1, Math.round(Number(doc.config?.lanes) || 1));
  const bitsPerLane = Math.max(1, Math.ceil(totalBits / lanes));
  const hspace = Math.max(320, Math.round(Number(doc.config?.hspace) || 680));
  const laneH = Math.max(64, Math.round(Number(doc.config?.vspace) || 82));
  const fontSize = Math.max(9, Math.round(Number(doc.config?.fontsize) || 12));

  const padX = 24;
  const padTop = 22;
  const bitW = (hspace - padX * 2) / bitsPerLane;
  const boxH = 32;
  const totalH = padTop + lanes * laneH + 14;

  // Split fields across lanes if a field crosses a lane boundary (LSB = 0 at right)
  interface BitSlice {
    lsb: number;
    msb: number;
    field: RegField;
  }
  const slices: BitSlice[] = [];
  let cursor = 0;
  for (const f of fields) {
    const span = Math.max(1, Math.round(Number(f.bits) || 1));
    slices.push({ lsb: cursor, msb: cursor + span - 1, field: f });
    cursor += span;
  }
  if (cursor < totalBits) {
    slices.push({ lsb: cursor, msb: totalBits - 1, field: { bits: totalBits - cursor, type: 1 } });
  }

  const parts: string[] = [];

  for (let laneIdx = 0; laneIdx < lanes; laneIdx++) {
    // Top lane shows highest bits (standard hardware datasheet convention)
    const laneHighOrder = lanes - 1 - laneIdx;
    const laneLsb = laneHighOrder * bitsPerLane;
    const laneMsb = Math.min(totalBits - 1, laneLsb + bitsPerLane - 1);
    const yTop = padTop + laneIdx * laneH + 16;

    // Bit ticks along top edge
    for (let b = laneLsb; b <= laneMsb; b++) {
      const colFromRight = b - laneLsb;
      const xLeft = hspace - padX - (colFromRight + 1) * bitW;
      parts.push(`<line x1="${xLeft}" y1="${yTop}" x2="${xLeft}" y2="${yTop + 4}" stroke="#94a3b8" stroke-width="0.9"/>`);
    }

    for (const sl of slices) {
      const segLsb = Math.max(laneLsb, sl.lsb);
      const segMsb = Math.min(laneMsb, sl.msb);
      if (segLsb > segMsb) {
        continue;
      }
      const segBits = segMsb - segLsb + 1;
      const xRight = hspace - padX - (segLsb - laneLsb) * bitW;
      const xLeft = xRight - segBits * bitW;
      const width = xRight - xLeft;
      const hasName = sl.field.name !== undefined && String(sl.field.name).trim() !== '';
      const fill =
        sl.field.type !== undefined
          ? (REG_TYPE_FILLS[sl.field.type] ?? '#f8fafc')
          : hasName
            ? '#f8fafc'
            : '#e2e8f0';

      parts.push(
        `<g class="node"><rect x="${xLeft}" y="${yTop}" width="${width}" height="${boxH}" fill="${fill}" stroke="#0f172a" stroke-width="1.3"/>`,
      );

      // Bit index labels (MSB and LSB of segment)
      if (segMsb === segLsb) {
        parts.push(`<text x="${xLeft + width / 2}" y="${yTop - 5}" text-anchor="middle" font-size="10" fill="#475569">${segLsb}</text>`);
      } else {
        parts.push(`<text x="${xLeft + bitW / 2}" y="${yTop - 5}" text-anchor="middle" font-size="10" fill="#475569">${segMsb}</text>`);
        parts.push(`<text x="${xRight - bitW / 2}" y="${yTop - 5}" text-anchor="middle" font-size="10" fill="#475569">${segLsb}</text>`);
      }

      if (hasName) {
        parts.push(
          `<text x="${xLeft + width / 2}" y="${yTop + boxH / 2 + 4}" text-anchor="middle" font-size="${fontSize}" font-weight="500" fill="#0f172a">${escXml(String(sl.field.name))}</text>`,
        );
      }
      if (sl.field.attr) {
        const attrText = Array.isArray(sl.field.attr) ? sl.field.attr.join(' ') : String(sl.field.attr);
        parts.push(
          `<text x="${xLeft + width / 2}" y="${yTop + boxH + 14}" text-anchor="middle" font-size="10" fill="#64748b">${escXml(attrText)}</text>`,
        );
      }
      parts.push(`</g>`);
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${hspace}" height="${totalH}" viewBox="0 0 ${hspace} ${totalH}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...parts,
    `</svg>`,
  ].join('');
}

export function renderWaveDromToSvg(source: string): string {
  const doc = parseWaveJson(source);
  if (Array.isArray(doc.reg) && doc.reg.length > 0) {
    return renderBitFieldRegisterSvg(doc);
  }
  if (Array.isArray(doc.signal)) {
    return renderSignalWaveformSvg(doc);
  }
  throw new Error('WaveDrom JSON must contain a "signal" or "reg" array.');
}

export function validateWaveDromSyntaxStatic(source: string): Array<{ line: number; message: string; severity: 'error' | 'warning' }> {
  if (!source.trim()) {
    return [];
  }
  try {
    const doc = parseWaveJson(source);
    if (!Array.isArray(doc.signal) && !Array.isArray(doc.reg)) {
      return [{ line: 0, message: 'WaveDrom document must define a "signal" or "reg" array.', severity: 'error' }];
    }
    return [];
  } catch (err) {
    const msg = (err as Error).message || 'Invalid WaveDrom JSON.';
    return [{ line: 0, message: msg, severity: 'error' }];
  }
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
