// Helpers for draw.io files stored as SVG (`*.drawio.svg`). draw.io keeps the
// editable diagram in the `content` attribute of the root <svg> element.

/** Whether a draw.io editor for this path stores the diagram as SVG. */
export function isSvgDiagramPath(path: string): boolean {
  return /\.svg$/i.test(path);
}

const ROOT_SVG_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|(<svg\b(?:[^>"']|"[^"]*"|'[^']*')*>)/gi;

function findRootSvgTag(svg: string): { index: number; tag: string } | undefined {
  ROOT_SVG_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROOT_SVG_TOKEN.exec(svg)) !== null) {
    if (match[1]) {
      return { index: match.index, tag: match[1] };
    }
  }
  return undefined;
}

/**
 * Returns the diagram XML (`<mxfile>…</mxfile>`, possibly compressed) embedded in a
 * draw.io SVG, or `undefined` when the SVG carries no diagram.
 */
export function extractDiagramFromSvg(svg: string): string | undefined {
  const root = findRootSvgTag(svg);
  if (!root) {
    return undefined;
  }
  const attr = /\scontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(root.tag);
  if (!attr) {
    return undefined;
  }
  const value = unescapeXml(attr[2] ?? attr[3] ?? '').trim();
  return /^<mxfile\b|^<mxGraphModel\b/.test(value) ? value : undefined;
}

export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (_, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'amp':
        return '&';
    }
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
}

/**
 * Replaces (or adds) the diagram embedded in a draw.io SVG. draw.io's export always
 * stores it compressed; storing the plain XML instead keeps `git diff` readable.
 */
export function replaceEmbeddedDiagram(svg: string, xml: string): string {
  const root = findRootSvgTag(svg);
  if (!root) {
    return svg;
  }
  const value = `content="${escapeXmlAttribute(xml)}"`;
  const contentAttr = /\scontent\s*=\s*("[^"]*"|'[^']*')/i;
  const newRoot = contentAttr.test(root.tag)
    ? root.tag.replace(contentAttr, () => ` ${value}`)
    : root.tag.replace(/^<svg\b/i, () => `<svg ${value}`);
  return svg.slice(0, root.index) + newRoot + svg.slice(root.index + root.tag.length);
}

export function escapeXmlAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xa;')
    .replace(/\r/g, '&#xd;')
    .replace(/\t/g, '&#x9;');
}
