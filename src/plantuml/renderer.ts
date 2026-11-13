import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { encodePlantUml } from './encoder';

export interface PlantUmlOptions {
  mode: 'auto' | 'local' | 'server';
  server: string;
  jar: string;
  java: string;
  dot: string;
  /** Directory used to resolve relative `!include` paths in local mode. */
  baseDir?: string;
}

const TIMEOUT_MS = 30000;

/**
 * Renders PlantUML source to SVG. Starting a new render cancels the previous one
 * (kills the Java process / aborts the HTTP request).
 */
export class PlantUmlRenderer {
  private current: { abort(): void } | undefined;

  cancel(): void {
    this.current?.abort();
    this.current = undefined;
  }

  render(source: string, options: PlantUmlOptions): Promise<string> {
    this.cancel();
    const useLocal = options.mode === 'local' || (options.mode === 'auto' && options.jar.trim() !== '');
    return useLocal ? this.renderLocal(source, options) : this.renderServer(source, options);
  }

  private async renderServer(source: string, options: PlantUmlOptions): Promise<string> {
    const base = (options.server || 'https://www.plantuml.com/plantuml').replace(/\/+$/, '');
    const controller = new AbortController();
    this.current = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const encoded = encodePlantUml(source);
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
      if (err instanceof ServerError) {
        throw err;
      }
      if (controller.signal.aborted && this.current !== controller) {
        throw new CancelledError();
      }
      if (controller.signal.aborted) {
        throw new Error(`PlantUML server did not respond within ${TIMEOUT_MS / 1000}s (${base})`);
      }
      throw new Error(`Could not reach PlantUML server ${base}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      if (this.current === controller) {
        this.current = undefined;
      }
    }
  }

  private renderLocal(source: string, options: PlantUmlOptions): Promise<string> {
    const jar = options.jar.trim();
    if (!jar) {
      return Promise.reject(new Error('Local PlantUML rendering needs the "drawGraph.plantuml.jar" setting (path to plantuml.jar).'));
    }
    const args = ['-Djava.awt.headless=true'];
    if (options.baseDir) {
      args.push(`-Dplantuml.include.path=${options.baseDir}`);
    }
    args.push('-jar', jar, '-tsvg', '-pipe', '-charset', 'UTF-8', '-nometadata');
    if (options.dot.trim()) {
      args.push('-graphvizdot', options.dot.trim());
    }

    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      let cancelled = false;
      try {
        child = spawn(options.java || 'java', args, { cwd: options.baseDir ?? path.dirname(jar), windowsHide: true });
      } catch (err) {
        reject(err);
        return;
      }
      const token = {
        abort: () => {
          cancelled = true;
          child.kill();
        },
      };
      this.current = token;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`PlantUML did not finish within ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on('data', (d: Buffer) => stdout.push(d));
      child.stderr?.on('data', (d: Buffer) => stderr.push(d));
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
        if (this.current === token) {
          this.current = undefined;
        }
        if (cancelled) {
          reject(new CancelledError());
          return;
        }
        const out = Buffer.concat(stdout).toString('utf8');
        // PlantUML exits non-zero on syntax errors but still prints an SVG explaining the error.
        if (out.includes('<svg')) {
          resolve(extractSvg(out));
        } else {
          const err = Buffer.concat(stderr).toString('utf8').trim();
          reject(new Error(err || `PlantUML exited with code ${code}`));
        }
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(source, 'utf8');
    });
  }
}

class ServerError extends Error {}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** Strips the XML prolog and anything after the first </svg>. */
function extractSvg(text: string): string {
  const start = text.indexOf('<svg');
  const end = text.indexOf('</svg>', start);
  return end >= 0 ? text.slice(start, end + 6) : text.slice(start);
}
