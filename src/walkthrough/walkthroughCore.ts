// Pure, zero-vscode parser for Step-by-Step Architecture Walkthrough annotations:
// Recognizes explicit step markers in comments across Mermaid (`%% step 1: ...`),
// PlantUML (`' step 1: ...`), DOT (`// step 1: ...`), and D2 (`# step 1: ...`),
// associating the nodes/participants on subsequent lines until the next step marker.

export interface WalkthroughStep {
  readonly step: number;
  readonly title: string;
  readonly targets: string[];
  readonly line: number;
}

const STEP_MARKER_RE = /^\s*(?:%%|'|\/\/|#)\s*step\s+(\d+)\s*(?:[:—–-]\s*(.+))?$/i;

function extractTargetsFromLine(rawLine: string): string[] {
  const line = rawLine.trim();
  if (!line || /^(?:%%|'|\/\/|#)/.test(line)) {
    return [];
  }
  const targets = new Set<string>();

  // Quoted labels (`"API Gateway"`, `["Order Service"]`)
  const quoteRe = /"([^"\n]{2,60})"/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(line)) !== null) {
    targets.add(m[1].trim());
  }

  // Mermaid bracket labels (`A[Client]`, `B(Service)`, `C[(Database)]`)
  const bracketRe = /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:\[\(?|\(\[?|\{\{?)([^\]\)\}]{2,50})[\]\)\}]/g;
  while ((m = bracketRe.exec(line)) !== null) {
    targets.add(m[1].trim());
    targets.add(m[2].replace(/^"|"$/g, '').trim());
  }

  // Edge endpoints (`A -> B`, `A --> B`, `A ->> B`, `A <-> B`)
  const edgeRe = /\b([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:<->|-->|->>|->|<-|--)\s*([A-Za-z_][A-Za-z0-9_.-]*)\b/g;
  while ((m = edgeRe.exec(line)) !== null) {
    targets.add(m[1].trim());
    targets.add(m[2].trim());
  }

  // D2 single-line declarations (`gateway: API Gateway` or `backend: Core {`)
  const d2Decl = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*([^{}\n]{2,60})(?:\s*\{)?$/.exec(line);
  if (d2Decl && !/^(?:direction|shape|style|fill|stroke|constraint|icon|near|link)$/i.test(d2Decl[1])) {
    targets.add(d2Decl[1].trim());
    const lbl = d2Decl[2].trim().replace(/^["']|["']$/g, '');
    if (lbl.length >= 2) {
      targets.add(lbl);
    }
  }

  return [...targets].filter((t) => t.length >= 2);
}

/**
 * Extracts ordered walkthrough steps from diagram source.
 * Returns an empty array if no explicit `step N` annotations are present.
 */
export function extractWalkthroughSteps(source: string): WalkthroughStep[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const steps: Array<{ step: number; title: string; targets: Set<string>; line: number }> = [];
  let current: { step: number; title: string; targets: Set<string>; line: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const marker = STEP_MARKER_RE.exec(raw);
    if (marker) {
      const stepNum = parseInt(marker[1], 10);
      const title = (marker[2] || `Step ${stepNum}`).trim();
      current = { step: stepNum, title, targets: new Set<string>(), line: i };
      steps.push(current);
      continue;
    }
    if (!current) continue;
    const trimmed = raw.trim();
    if (!trimmed) {
      // Blank line ends the current step's capture block if we already captured targets
      if (current.targets.size > 0) {
        current = undefined;
      }
      continue;
    }
    for (const tgt of extractTargetsFromLine(raw)) {
      current.targets.add(tgt);
    }
  }

  return steps
    .sort((a, b) => a.step - b.step)
    .map((s) => ({
      step: s.step,
      title: s.title,
      targets: [...s.targets],
      line: s.line,
    }));
}
