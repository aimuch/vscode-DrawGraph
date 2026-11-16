import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { encodePlantUmlAsync } from './encoder';
import { StateMachine, type MachineSnapshot, type TransitionRecord, type TransitionTable } from '../stateMachine';

export interface PlantUmlOptions {
  mode: 'auto' | 'local' | 'server';
  server: string;
  jar: string;
  java: string;
  dot: string;
  /** Directory used to resolve relative `!include` paths in local mode. */
  baseDir?: string;
  /** Zero-based page index for multi-page (`newpage`) diagrams. */
  page?: number;
  /** Skip the in-memory SVG cache (used on explicit config/theme refreshes). */
  noCache?: boolean;
}

export type WorkerPhase = 'cold' | 'busy' | 'draining_cancelled' | 'warm_idle' | 'disposed';
export type WorkerEvent =
  | 'START_REQUEST'
  | 'CANCEL_INFLIGHT'
  | 'DRAINED_TO_IDLE'
  | 'DRAINED_TO_NEXT'
  | 'RESET_TO_COLD'
  | 'IDLE_EXPIRED'
  | 'DISPOSE';

const WORKER_TRANSITIONS: TransitionTable<WorkerPhase, WorkerEvent> = {
  cold: {
    START_REQUEST: 'busy',
    RESET_TO_COLD: 'cold',
    DISPOSE: 'disposed',
  },
  busy: {
    CANCEL_INFLIGHT: 'draining_cancelled',
    DRAINED_TO_IDLE: 'warm_idle',
    DRAINED_TO_NEXT: 'busy',
    RESET_TO_COLD: 'cold',
    DISPOSE: 'disposed',
  },
  draining_cancelled: {
    DRAINED_TO_IDLE: 'warm_idle',
    DRAINED_TO_NEXT: 'busy',
    RESET_TO_COLD: 'cold',
    DISPOSE: 'disposed',
  },
  warm_idle: {
    START_REQUEST: 'busy',
    IDLE_EXPIRED: 'cold',
    RESET_TO_COLD: 'cold',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const WORKER_SETTLED: readonly WorkerPhase[] = ['cold', 'warm_idle', 'disposed'];

export interface RendererSnapshot {
  worker: MachineSnapshot<WorkerPhase, WorkerEvent>;
  workerPid?: number;
  hasQueuedRequest: boolean;
  serverInFlight: boolean;
  cacheSize: number;
  isSettled: boolean;
}

const TIMEOUT_MS = 30000;
const CANCEL_GRACE_MS = 1500;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32;
const PIPE_DELIMITER = '___DRAWGRAPH_PLANTUML_END___';

interface PipeRequest {
  source: string;
  resolve: (svg: string) => void;
  reject: (err: Error) => void;
  cancelled: boolean;
}

function killProcess(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }, 2000);
  forceTimer.unref?.();
}

/**
 * Persistent `java -jar plantuml.jar -pipe -pipedelimitor` worker modeled as an explicit
 * lifecycle state machine (`cold` -> `busy` <-> `warm_idle` / `draining_cancelled` -> `disposed`).
 */
class LocalPipeWorker {
  readonly fsm: StateMachine<WorkerPhase, WorkerEvent>;
  private child: ChildProcess | undefined;
  private stdoutBuf = '';
  private stderrBuf = '';
  private stdoutBytes = 0;
  private inflight: PipeRequest | undefined;
  private queued: PipeRequest | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private cancelGraceTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(
    id: string,
    readonly key: string,
    private readonly java: string,
    private readonly jar: string,
    private readonly dot: string,
    private readonly baseDir: string | undefined,
    onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void,
  ) {
    this.fsm = new StateMachine<WorkerPhase, WorkerEvent>({
      id,
      initial: 'cold',
      transitions: WORKER_TRANSITIONS,
      settledStates: WORKER_SETTLED,
      onTransition,
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get hasQueued(): boolean {
    return this.queued !== undefined;
  }

  render(source: string): Promise<string> {
    if (this.fsm.state === 'disposed') {
      return Promise.reject(new CancelledError());
    }
    this.cancelPending();
    return new Promise<string>((resolve, reject) => {
      const req: PipeRequest = { source, resolve, reject, cancelled: false };
      if (this.inflight) {
        this.queued = req;
      } else {
        this.startRequest(req);
      }
    });
  }

  cancelPending(): void {
    if (this.queued) {
      const stale = this.queued;
      this.queued = undefined;
      stale.reject(new CancelledError());
    }
    if (this.inflight && !this.inflight.cancelled) {
      const active = this.inflight;
      active.cancelled = true;
      this.fsm.send('CANCEL_INFLIGHT');
      active.reject(new CancelledError());
      if (!this.cancelGraceTimer) {
        this.cancelGraceTimer = setTimeout(() => {
          this.cancelGraceTimer = undefined;
          if (this.inflight === active) {
            this.resetChild('cancel grace expired');
            this.pumpNext();
          }
        }, CANCEL_GRACE_MS);
        this.cancelGraceTimer.unref?.();
      }
    }
  }

  dispose(): void {
    if (this.fsm.state === 'disposed') {
      return;
    }
    this.clearTimers();
    if (this.queued) {
      this.queued.reject(new CancelledError());
      this.queued = undefined;
    }
    if (this.inflight && !this.inflight.cancelled) {
      this.inflight.cancelled = true;
      this.inflight.reject(new CancelledError());
    }
    this.inflight = undefined;
    const proc = this.child;
    this.child = undefined;
    if (proc) {
      proc.stdin?.end();
      killProcess(proc);
    }
    this.fsm.send('DISPOSE');
  }

  private startRequest(req: PipeRequest, fromDrain = false): void {
    if (this.fsm.state === 'disposed') {
      req.reject(new CancelledError());
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;

    if (!this.child && !this.spawnChild(req)) {
      return;
    }
    if (!fromDrain) {
      this.fsm.send('START_REQUEST');
    }
    this.inflight = req;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.stdoutBytes = 0;

    this.timeoutTimer = setTimeout(() => {
      if (this.inflight === req) {
        this.inflight = undefined;
        this.resetChild('render timeout');
        if (!req.cancelled) {
          req.reject(new Error(`PlantUML did not finish within ${TIMEOUT_MS / 1000}s`));
        }
        this.pumpNext();
      }
    }, TIMEOUT_MS);

    const payload = req.source.trim() + '\n';
    this.child!.stdin?.write(payload, 'utf8');
  }

  private spawnChild(initialReq: PipeRequest): boolean {
    const args = ['-Djava.awt.headless=true'];
    if (this.baseDir) {
      args.push(`-Dplantuml.include.path=${this.baseDir}`);
    }
    args.push('-jar', this.jar, '-tsvg', '-pipe', '-pipedelimitor', PIPE_DELIMITER, '-charset', 'UTF-8', '-nometadata');
    if (this.dot) {
      args.push('-graphvizdot', this.dot);
    }

    let proc: ChildProcess;
    try {
      proc = spawn(this.java || 'java', args, { cwd: this.baseDir ?? path.dirname(this.jar), windowsHide: true });
    } catch (err) {
      this.fsm.send('RESET_TO_COLD', 'spawn threw');
      initialReq.reject(err as Error);
      return false;
    }
    this.child = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== proc) {
        return;
      }
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > MAX_OUTPUT_BYTES) {
        const active = this.inflight;
        this.inflight = undefined;
        this.resetChild('output limit exceeded');
        if (active && !active.cancelled) {
          active.reject(new Error('PlantUML output exceeded the 32 MB safety limit.'));
        }
        this.pumpNext();
        return;
      }
      this.stdoutBuf += chunk.toString('utf8');
      this.drainCompleted();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      if (this.child === proc && this.stderrBuf.length < 65536) {
        this.stderrBuf += chunk.toString('utf8');
      }
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (this.child !== proc) {
        return;
      }
      this.child = undefined;
      this.clearInflightTimers();
      this.fsm.send('RESET_TO_COLD', err.code ?? 'process error');
      const formatted =
        err.code === 'ENOENT'
          ? new Error(`Java executable "${this.java}" not found. Install Java or set "drawGraph.plantuml.java".`)
          : err;
      const active = this.inflight;
      this.inflight = undefined;
      if (active && !active.cancelled) {
        active.reject(formatted);
      }
      if (this.queued) {
        const next = this.queued;
        this.queued = undefined;
        next.reject(formatted);
      }
    });

    proc.on('close', (code) => {
      if (this.child !== proc) {
        return;
      }
      this.child = undefined;
      this.clearInflightTimers();
      this.fsm.send('RESET_TO_COLD', `exit ${code}`);
      const active = this.inflight;
      this.inflight = undefined;
      if (active && !active.cancelled) {
        if (this.stdoutBuf.includes('<svg')) {
          active.resolve(extractSvg(this.stdoutBuf));
        } else {
          const errText = this.stderrBuf.trim();
          active.reject(new Error(errText || `PlantUML exited with code ${code}`));
        }
      }
      this.stdoutBuf = '';
      this.stderrBuf = '';
      this.pumpNext();
    });

    proc.stdin?.on('error', () => undefined);
    return true;
  }

  private drainCompleted(): void {
    const idx = this.stdoutBuf.indexOf(PIPE_DELIMITER);
    if (idx < 0) {
      return;
    }
    const raw = this.stdoutBuf.slice(0, idx);
    let rest = this.stdoutBuf.slice(idx + PIPE_DELIMITER.length);
    if (rest.startsWith('\r\n')) {
      rest = rest.slice(2);
    } else if (rest.startsWith('\n')) {
      rest = rest.slice(1);
    }
    this.stdoutBuf = rest;
    this.stdoutBytes = Buffer.byteLength(this.stdoutBuf, 'utf8');

    const active = this.inflight;
    this.inflight = undefined;
    this.clearInflightTimers();

    if (active && !active.cancelled) {
      if (raw.includes('<svg')) {
        active.resolve(extractSvg(raw));
      } else {
        const errText = this.stderrBuf.trim();
        active.reject(new Error(errText || 'PlantUML produced no SVG output.'));
      }
    }
    this.stderrBuf = '';
    this.pumpNext(true);
  }

  private pumpNext(fromDrain = false): void {
    if (this.fsm.state === 'disposed') {
      return;
    }
    if (this.queued) {
      const next = this.queued;
      this.queued = undefined;
      if (fromDrain && this.child) {
        this.fsm.send('DRAINED_TO_NEXT');
        this.startRequest(next, true);
      } else {
        this.startRequest(next, false);
      }
    } else if (this.child) {
      if (fromDrain) {
        this.fsm.send('DRAINED_TO_IDLE');
      }
      this.idleTimer = setTimeout(() => {
        this.idleTimer = undefined;
        this.fsm.send('IDLE_EXPIRED');
        this.terminateChild();
      }, IDLE_TIMEOUT_MS);
      this.idleTimer.unref?.();
    }
  }

  private resetChild(reason: string): void {
    this.clearInflightTimers();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.fsm.send('RESET_TO_COLD', reason);
    this.terminateChild();
  }

  private terminateChild(): void {
    const proc = this.child;
    this.child = undefined;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.stdoutBytes = 0;
    if (proc) {
      proc.stdin?.end();
      killProcess(proc);
    }
  }

  private clearInflightTimers(): void {
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    clearTimeout(this.cancelGraceTimer);
    this.cancelGraceTimer = undefined;
  }

  private clearTimers(): void {
    this.clearInflightTimers();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

let rendererSeq = 0;

/**
 * Renders PlantUML source to SVG. Starting a new render cancels the previous one;
 * local mode reuses a warm PlantUML pipe worker and both modes share a small LRU cache.
 */
export class PlantUmlRenderer {
  private readonly id: string;
  private readonly onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void;
  private serverAbort: AbortController | undefined;
  private worker: LocalPipeWorker | undefined;
  private readonly cache = new Map<string, string>();

  constructor(
    id = `plantuml-renderer-${++rendererSeq}`,
    onTransition?: (record: TransitionRecord<string, string>, machineId: string) => void,
  ) {
    this.id = id;
    this.onTransition = onTransition;
  }

  cancel(): void {
    this.serverAbort?.abort();
    this.serverAbort = undefined;
    this.worker?.cancelPending();
  }

  dispose(): void {
    this.cancel();
    this.worker?.dispose();
    this.worker = undefined;
    this.cache.clear();
  }

  snapshot(): RendererSnapshot {
    const workerSnap: MachineSnapshot<WorkerPhase, WorkerEvent> = this.worker
      ? this.worker.fsm.snapshot()
      : { id: `${this.id}:worker`, state: 'cold', allowedEvents: ['START_REQUEST', 'DISPOSE'], isSettled: true, transitions: [] };
    const serverInFlight = this.serverAbort !== undefined;
    return {
      worker: workerSnap,
      workerPid: this.worker?.pid,
      hasQueuedRequest: this.worker?.hasQueued ?? false,
      serverInFlight,
      cacheSize: this.cache.size,
      isSettled: workerSnap.isSettled && !serverInFlight && !(this.worker?.hasQueued ?? false),
    };
  }

  async render(source: string, options: PlantUmlOptions): Promise<string> {
    this.cancel();
    const page = Math.max(0, Math.floor(options.page ?? 0));
    const jar = options.jar.trim();
    const useLocal = options.mode === 'local' || (options.mode === 'auto' && jar !== '');
    const configKey = useLocal
      ? `local\0${options.java || 'java'}\0${jar}\0${options.dot.trim()}\0${options.baseDir ?? ''}`
      : `server\0${normalizeServerBase(options.server)}`;
    const cacheKey = `${configKey}\0${page}\0${source}`;

    if (!options.noCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return cached;
      }
    }

    const svg = useLocal
      ? await this.renderLocal(source, options, configKey, page)
      : await this.renderServer(source, options, page);
    this.storeCache(cacheKey, svg);
    return svg;
  }

  /** Renders a PlantUML block directly to PNG bytes (used for headless export / auto-export on save). */
  async renderPng(source: string, options: PlantUmlOptions): Promise<Uint8Array> {
    const page = Math.max(0, Math.floor(options.page ?? 0));
    const jar = options.jar.trim();
    const useLocal = options.mode === 'local' || (options.mode === 'auto' && jar !== '');
    if (useLocal) {
      if (!jar) {
        throw new Error('Local PlantUML rendering needs the "drawGraph.plantuml.jar" setting (path to plantuml.jar).');
      }
      return runOneShotLocal(source, options, 'png', page);
    }
    const base = normalizeServerBase(options.server);
    const encoded = await encodePlantUmlAsync(source);
    const pageSegment = page > 0 ? `${page}/` : '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${base}/png/${pageSegment}${encoded}`, { signal: controller.signal });
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return buf;
      }
      throw new ServerError(`PlantUML server ${base} responded ${response.status} ${response.statusText}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private storeCache(key: string, svg: string): void {
    this.cache.delete(key);
    this.cache.set(key, svg);
    if (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  private async renderServer(source: string, options: PlantUmlOptions, page: number): Promise<string> {
    const base = normalizeServerBase(options.server);
    const controller = new AbortController();
    this.serverAbort = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const encoded = await encodePlantUmlAsync(source);
      if (controller.signal.aborted) {
        throw new CancelledError();
      }
      const pageSegment = page > 0 ? `${page}/` : '';
      let response: Response | undefined;
      let body = '';

      // Large diagrams can exceed HTTP GET URL limits on proxies/servers; try HTTP POST first when large.
      if (encoded.length > 3500) {
        try {
          const postRes = await fetch(`${base}/svg/${pageSegment}`.replace(/\/$/, ''), {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: source,
            signal: controller.signal,
          });
          const postBody = await postRes.text();
          if (postBody.includes('<svg')) {
            return extractSvg(postBody);
          }
        } catch (postErr) {
          if (controller.signal.aborted) {
            throw postErr;
          }
          // Fall back to standard GET below if the server does not accept POST.
        }
      }

      response = await fetch(`${base}/svg/${pageSegment}${encoded}`, { signal: controller.signal });
      body = await response.text();
      if (body.includes('<svg')) {
        return extractSvg(body);
      }

      // If GET failed with URI-too-long/payload-too-large and we haven't tried POST yet, try POST as fallback.
      if (encoded.length <= 3500 && [413, 414].includes(response.status)) {
        const postRes = await fetch(`${base}/svg/${pageSegment}`.replace(/\/$/, ''), {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: source,
          signal: controller.signal,
        });
        const postBody = await postRes.text();
        if (postBody.includes('<svg')) {
          return extractSvg(postBody);
        }
      }

      const tooLong = encoded.length > 4000 && [400, 413, 414].includes(response.status);
      throw new ServerError(
        `PlantUML server ${base} responded ${response.status} ${response.statusText}` +
          (tooLong ? ' — the diagram is probably too large to encode in a URL. Use a local plantuml.jar ("drawGraph.plantuml.jar") instead.' : ''),
      );
    } catch (err) {
      if (err instanceof ServerError || err instanceof CancelledError) {
        throw err;
      }
      if (controller.signal.aborted && this.serverAbort !== controller) {
        throw new CancelledError();
      }
      if (controller.signal.aborted) {
        throw new Error(`PlantUML server did not respond within ${TIMEOUT_MS / 1000}s (${base})`);
      }
      throw new Error(`Could not reach PlantUML server ${base}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      if (this.serverAbort === controller) {
        this.serverAbort = undefined;
      }
    }
  }

  private async renderLocal(source: string, options: PlantUmlOptions, workerKey: string, page: number): Promise<string> {
    const jar = options.jar.trim();
    if (!jar) {
      throw new Error('Local PlantUML rendering needs the "drawGraph.plantuml.jar" setting (path to plantuml.jar).');
    }
    if (page > 0) {
      const out = (await runOneShotLocal(source, options, 'svg', page)).toString('utf8');
      if (out.includes('<svg')) {
        return extractSvg(out);
      }
      throw new Error('PlantUML produced no SVG for the requested page.');
    }
    if (this.worker && this.worker.key !== workerKey) {
      this.worker.dispose();
      this.worker = undefined;
    }
    if (!this.worker) {
      this.worker = new LocalPipeWorker(
        `${this.id}:worker`,
        workerKey,
        options.java || 'java',
        jar,
        options.dot.trim(),
        options.baseDir,
        this.onTransition,
      );
    }
    return this.worker.render(source);
  }
}

function runOneShotLocal(source: string, options: PlantUmlOptions, format: 'svg' | 'png', page: number): Promise<Buffer> {
  const jar = options.jar.trim();
  const args = ['-Djava.awt.headless=true'];
  if (options.baseDir) {
    args.push(`-Dplantuml.include.path=${options.baseDir}`);
  }
  args.push('-jar', jar, format === 'png' ? '-tpng' : '-tsvg', '-pipe', '-charset', 'UTF-8');
  if (format === 'svg') {
    args.push('-nometadata');
  }
  if (page > 0) {
    args.push('-pipeimageindex', String(page));
  }
  if (options.dot.trim()) {
    args.push('-graphvizdot', options.dot.trim());
  }

  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.java || 'java', args, { cwd: options.baseDir ?? path.dirname(jar), windowsHide: true });
    } catch (err) {
      reject(err as Error);
      return;
    }
    const timer = setTimeout(() => {
      killProcess(child);
      reject(new Error(`PlantUML did not finish within ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    child.stdout?.on('data', (d: Buffer) => {
      totalBytes += d.length;
      if (totalBytes <= MAX_OUTPUT_BYTES) {
        stdout.push(d);
      } else {
        killProcess(child);
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 64) {
        stderr.push(d);
      }
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new Error(`Java executable "${options.java}" not found. Install Java or set "drawGraph.plantuml.java".`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (totalBytes > MAX_OUTPUT_BYTES) {
        reject(new Error('PlantUML output exceeded the 32 MB safety limit.'));
        return;
      }
      const out = Buffer.concat(stdout);
      if (out.length > 0 && (format === 'png' || out.toString('utf8').includes('<svg'))) {
        resolve(out);
      } else {
        const err = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(err || `PlantUML exited with code ${code}`));
      }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(source.trim() + '\n', 'utf8');
  });
}

function normalizeServerBase(raw: string): string {
  const candidate = (raw || 'https://www.plantuml.com/plantuml').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return candidate;
    }
  } catch {
    // Fall back below.
  }
  return 'https://www.plantuml.com/plantuml';
}

class ServerError extends Error {}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/**
 * Strips the XML prolog and anything after the matching closing `</svg>` of the root
 * `<svg>` element, preserving nested `<svg>` elements (such as PlantUML sprites/icons).
 */
export function extractSvg(text: string): string {
  const start = text.indexOf('<svg');
  if (start < 0) {
    return text;
  }
  const tokenRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|(<\/?svg\b(?:[^>"']|"[^"]*"|'[^']*')*>)/gi;
  tokenRe.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const tag = match[1];
    if (!tag) {
      continue;
    }
    if (tag.startsWith('</')) {
      if (--depth === 0) {
        return text.slice(start, match.index + tag.length);
      }
    } else if (!tag.endsWith('/>')) {
      depth++;
    } else if (depth === 0) {
      return text.slice(start, match.index + tag.length);
    }
  }
  return text.slice(start);
}

/**
 * Inspects a rendered PlantUML SVG for a PlantUML syntax-error report, returning the
 * 1-based line number within the block and a readable diagnostic message when found.
 */
export function extractPlantUmlError(svg: string): { line: number; message: string } | undefined {
  if (!/Syntax Error/i.test(svg)) {
    return undefined;
  }
  const texts: string[] = [];
  const textRe = /<text\b[^>]*>([\s\S]*?)<\/text>/gi;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(svg)) !== null) {
    const plain = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();
    if (plain) {
      texts.push(plain);
    }
  }
  const joined = texts.join('\n');
  if (!/Syntax Error/i.test(joined)) {
    return undefined;
  }
  const lineMatch = /\(line\s+(\d+)\)/i.exec(joined);
  const line = lineMatch ? Math.max(1, parseInt(lineMatch[1], 10)) : 1;
  const syntaxIdx = texts.findIndex((t) => /Syntax Error/i.test(t));
  const summary = syntaxIdx >= 0 ? texts.slice(syntaxIdx, syntaxIdx + 2).join(' — ') : 'PlantUML syntax error';
  return { line, message: summary };
}
