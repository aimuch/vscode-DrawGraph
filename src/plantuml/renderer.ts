import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { encodePlantUmlAsync } from './encoder';

export interface PlantUmlOptions {
  mode: 'auto' | 'local' | 'server';
  server: string;
  jar: string;
  java: string;
  dot: string;
  /** Directory used to resolve relative `!include` paths in local mode. */
  baseDir?: string;
  /** Skip the in-memory SVG cache (used on explicit config/theme refreshes). */
  noCache?: boolean;
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
 * Persistent `java -jar plantuml.jar -pipe -pipedelimitor` worker that keeps a warm JVM
 * alive across edits so local renders avoid JVM startup overhead.
 */
class LocalPipeWorker {
  private child: ChildProcess | undefined;
  private stdoutBuf = '';
  private stderrBuf = '';
  private stdoutBytes = 0;
  private inflight: PipeRequest | undefined;
  private queued: PipeRequest | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private cancelGraceTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    readonly key: string,
    private readonly java: string,
    private readonly jar: string,
    private readonly dot: string,
    private readonly baseDir: string | undefined,
  ) {}

  render(source: string): Promise<string> {
    if (this.disposed) {
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
      active.reject(new CancelledError());
      // Let a fast in-flight render finish draining so the JVM stays warm; kill if stuck.
      if (!this.cancelGraceTimer) {
        this.cancelGraceTimer = setTimeout(() => {
          this.cancelGraceTimer = undefined;
          if (this.inflight === active) {
            this.resetChild();
            this.pumpNext();
          }
        }, CANCEL_GRACE_MS);
        this.cancelGraceTimer.unref?.();
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
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
    this.resetChild();
  }

  private startRequest(req: PipeRequest): void {
    if (this.disposed) {
      req.reject(new CancelledError());
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;

    if (!this.child && !this.spawnChild(req)) {
      return;
    }
    this.inflight = req;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.stdoutBytes = 0;

    this.timeoutTimer = setTimeout(() => {
      if (this.inflight === req) {
        this.inflight = undefined;
        this.resetChild();
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
        this.resetChild();
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
    this.pumpNext();
  }

  private pumpNext(): void {
    if (this.disposed) {
      return;
    }
    if (this.queued) {
      const next = this.queued;
      this.queued = undefined;
      this.startRequest(next);
    } else if (this.child) {
      this.idleTimer = setTimeout(() => this.resetChild(), IDLE_TIMEOUT_MS);
      this.idleTimer.unref?.();
    }
  }

  private resetChild(): void {
    this.clearInflightTimers();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
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

/**
 * Renders PlantUML source to SVG. Starting a new render cancels the previous one;
 * local mode reuses a warm PlantUML pipe worker and both modes share a small LRU cache.
 */
export class PlantUmlRenderer {
  private serverAbort: AbortController | undefined;
  private worker: LocalPipeWorker | undefined;
  private readonly cache = new Map<string, string>();

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

  async render(source: string, options: PlantUmlOptions): Promise<string> {
    this.cancel();
    const jar = options.jar.trim();
    const useLocal = options.mode === 'local' || (options.mode === 'auto' && jar !== '');
    const configKey = useLocal
      ? `local\0${options.java || 'java'}\0${jar}\0${options.dot.trim()}\0${options.baseDir ?? ''}`
      : `server\0${normalizeServerBase(options.server)}`;
    const cacheKey = `${configKey}\0${source}`;

    if (!options.noCache) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        // Refresh LRU order.
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return cached;
      }
    }

    const svg = useLocal ? await this.renderLocal(source, options, configKey) : await this.renderServer(source, options);
    this.storeCache(cacheKey, svg);
    return svg;
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

  private async renderServer(source: string, options: PlantUmlOptions): Promise<string> {
    const base = normalizeServerBase(options.server);
    const controller = new AbortController();
    this.serverAbort = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const encoded = await encodePlantUmlAsync(source);
      if (controller.signal.aborted) {
        throw new CancelledError();
      }
      const response = await fetch(`${base}/svg/${encoded}`, { signal: controller.signal });
      const body = await response.text();
      // The server answers syntax errors with HTTP 400 *and* an SVG describing the error.
      if (body.includes('<svg')) {
        return extractSvg(body);
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

  private renderLocal(source: string, options: PlantUmlOptions, workerKey: string): Promise<string> {
    const jar = options.jar.trim();
    if (!jar) {
      return Promise.reject(new Error('Local PlantUML rendering needs the "drawGraph.plantuml.jar" setting (path to plantuml.jar).'));
    }
    if (this.worker && this.worker.key !== workerKey) {
      this.worker.dispose();
      this.worker = undefined;
    }
    if (!this.worker) {
      this.worker = new LocalPipeWorker(workerKey, options.java || 'java', jar, options.dot.trim(), options.baseDir);
    }
    return this.worker.render(source);
  }
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
