export interface TransitionRecord<TState extends string = string, TEvent extends string = string> {
  seq: number;
  from: TState;
  to: TState;
  event: TEvent;
  at: number;
  note?: string;
}

export interface MachineSnapshot<TState extends string = string, TEvent extends string = string> {
  id: string;
  state: TState;
  allowedEvents: TEvent[];
  isSettled: boolean;
  transitions: TransitionRecord<TState, TEvent>[];
}

export type TransitionTable<TState extends string, TEvent extends string> = Readonly<
  Record<TState, Partial<Record<TEvent, TState>>>
>;

export interface StateMachineOptions<TState extends string, TEvent extends string> {
  id: string;
  initial: TState;
  transitions: TransitionTable<TState, TEvent>;
  settledStates?: ReadonlySet<TState> | readonly TState[];
  maxHistory?: number;
  onTransition?: (record: TransitionRecord<TState, TEvent>, id: string) => void;
}

/**
 * Lightweight, zero-dependency finite state machine with compile-time typed states/events,
 * runtime transition validation, bounded ring-buffer history, and JSON snapshots for
 * diagnostics and test-harness introspection.
 */
export class StateMachine<TState extends string, TEvent extends string> {
  readonly id: string;
  private current: TState;
  private readonly table: TransitionTable<TState, TEvent>;
  private readonly settled: ReadonlySet<TState>;
  private readonly maxHistory: number;
  private readonly onTransition?: (record: TransitionRecord<TState, TEvent>, id: string) => void;
  private readonly history: TransitionRecord<TState, TEvent>[] = [];
  private seq = 0;

  constructor(options: StateMachineOptions<TState, TEvent>) {
    this.id = options.id;
    this.current = options.initial;
    this.table = options.transitions;
    this.settled =
      options.settledStates instanceof Set
        ? options.settledStates
        : new Set(options.settledStates ?? ([options.initial] as readonly TState[]));
    this.maxHistory = Math.max(4, options.maxHistory ?? 24);
    this.onTransition = options.onTransition;
  }

  get state(): TState {
    return this.current;
  }

  get isSettled(): boolean {
    return this.settled.has(this.current);
  }

  allowedEvents(): TEvent[] {
    return Object.keys(this.table[this.current] ?? {}) as TEvent[];
  }

  can(event: TEvent): boolean {
    return this.table[this.current]?.[event] !== undefined;
  }

  send(event: TEvent, note?: string): boolean {
    const next = this.table[this.current]?.[event];
    if (next === undefined) {
      return false;
    }
    const prev = this.current;
    this.current = next;
    const record: TransitionRecord<TState, TEvent> = {
      seq: ++this.seq,
      from: prev,
      to: next,
      event,
      at: Date.now(),
      ...(note ? { note } : {}),
    };
    if (this.history.length >= this.maxHistory) {
      this.history.shift();
    }
    this.history.push(record);
    this.onTransition?.(record, this.id);
    return true;
  }

  snapshot(): MachineSnapshot<TState, TEvent> {
    return {
      id: this.id,
      state: this.current,
      allowedEvents: this.allowedEvents(),
      isSettled: this.isSettled,
      transitions: [...this.history],
    };
  }
}

export type SyncPhase = 'idle' | 'debouncing' | 'running' | 'running_dirty' | 'disposed';
export type SyncEvent = 'SCHEDULE' | 'TIMER_FIRED' | 'FLUSH' | 'PASS_CLEAN' | 'PASS_DIRTY' | 'PASS_FAIL' | 'CANCEL' | 'DISPOSE';

const SYNC_TRANSITIONS: TransitionTable<SyncPhase, SyncEvent> = {
  idle: {
    SCHEDULE: 'debouncing',
    FLUSH: 'running',
    CANCEL: 'idle',
    DISPOSE: 'disposed',
  },
  debouncing: {
    SCHEDULE: 'debouncing',
    TIMER_FIRED: 'running',
    FLUSH: 'running',
    CANCEL: 'idle',
    DISPOSE: 'disposed',
  },
  running: {
    SCHEDULE: 'running_dirty',
    FLUSH: 'running_dirty',
    PASS_CLEAN: 'idle',
    PASS_FAIL: 'idle',
    CANCEL: 'idle',
    DISPOSE: 'disposed',
  },
  running_dirty: {
    SCHEDULE: 'running_dirty',
    FLUSH: 'running_dirty',
    PASS_DIRTY: 'running',
    PASS_FAIL: 'idle',
    CANCEL: 'idle',
    DISPOSE: 'disposed',
  },
  disposed: {},
};

const SYNC_SETTLED: readonly SyncPhase[] = ['idle', 'disposed'];

export interface CoalescedTaskOptions<TData> {
  id: string;
  debounceMs: number;
  /** Produces a snapshot/export of the current state. */
  produce: () => Promise<TData | undefined>;
  /** Commits the freshest produced snapshot once no newer changes arrived during `produce`. */
  commit: (data: TData) => Promise<boolean> | boolean;
  onTransition?: (record: TransitionRecord<SyncPhase, SyncEvent>, id: string) => void;
}

/**
 * Explicit state machine for debounced, single-flight coalescing async synchronization
 * (used by `.drawio.svg` and `.drawio.png` document sync).
 *
 * Guarantees:
 * - At most one `produce()` call runs at a time.
 * - Edits arriving during `produce()` transition `running -> running_dirty`, discarding the
 *   superseded intermediate result and running one fresh `produce()` before calling `commit()`.
 * - `flush()` bypasses any pending debounce timer immediately (for Save / WillSave).
 * - `cancel()` aborts pending debounce and invalidates any in-flight pass (for Revert / external edit).
 */
export class CoalescedTaskMachine<TData> {
  readonly fsm: StateMachine<SyncPhase, SyncEvent>;
  private readonly debounceMs: number;
  private readonly produce: () => Promise<TData | undefined>;
  private readonly commit: (data: TData) => Promise<boolean> | boolean;
  private timer: NodeJS.Timeout | undefined;
  private waiters: Array<(ok: boolean) => void> = [];
  private activeEpoch = 0;

  constructor(options: CoalescedTaskOptions<TData>) {
    this.debounceMs = options.debounceMs;
    this.produce = options.produce;
    this.commit = options.commit;
    this.fsm = new StateMachine<SyncPhase, SyncEvent>({
      id: options.id,
      initial: 'idle',
      transitions: SYNC_TRANSITIONS,
      settledStates: SYNC_SETTLED,
      onTransition: options.onTransition,
    });
  }

  get state(): SyncPhase {
    return this.fsm.state;
  }

  get isSettled(): boolean {
    return this.fsm.isSettled;
  }

  get hasPendingDebounce(): boolean {
    return this.fsm.state === 'debouncing';
  }

  snapshot(): MachineSnapshot<SyncPhase, SyncEvent> {
    return this.fsm.snapshot();
  }

  /** Schedules a debounced sync (or coalesces into an already-running sync). */
  schedule(): Promise<boolean> {
    if (this.fsm.state === 'disposed') {
      return Promise.resolve(false);
    }
    const promise = new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
    const wasRunning = this.fsm.state === 'running' || this.fsm.state === 'running_dirty';
    this.fsm.send('SCHEDULE');
    if (!wasRunning) {
      this.clearTimer();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.fsm.send('TIMER_FIRED')) {
          void this.runLoop();
        }
      }, this.debounceMs);
    }
    return promise;
  }

  /** Immediately executes any pending or requested sync without waiting for debounce. */
  flush(): Promise<boolean> {
    if (this.fsm.state === 'disposed') {
      return Promise.resolve(false);
    }
    const promise = new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
    this.clearTimer();
    const wasRunning = this.fsm.state === 'running' || this.fsm.state === 'running_dirty';
    this.fsm.send('FLUSH');
    if (!wasRunning) {
      void this.runLoop();
    }
    return promise;
  }

  /** Cancels any pending debounce and invalidates any in-flight pass. */
  cancel(reason?: string): void {
    if (this.fsm.state === 'disposed') {
      return;
    }
    this.activeEpoch++;
    this.clearTimer();
    this.fsm.send('CANCEL', reason);
    this.resolveAll(false);
  }

  dispose(): void {
    if (this.fsm.state === 'disposed') {
      return;
    }
    this.activeEpoch++;
    this.clearTimer();
    this.fsm.send('DISPOSE');
    this.resolveAll(false);
  }

  private currentPhase(): SyncPhase {
    return this.fsm.state;
  }

  private async runLoop(): Promise<void> {
    const epoch = ++this.activeEpoch;
    while (this.currentPhase() === 'running' && epoch === this.activeEpoch) {
      let data: TData | undefined;
      try {
        data = await this.produce();
      } catch {
        data = undefined;
      }
      if (epoch !== this.activeEpoch || this.currentPhase() === 'disposed') {
        return;
      }
      if (data === undefined) {
        this.fsm.send('PASS_FAIL');
        this.resolveAll(false);
        return;
      }
      if (this.currentPhase() === 'running_dirty') {
        // Newer changes arrived while `produce()` was running: loop once more with latest state.
        this.fsm.send('PASS_DIRTY', 'superseded intermediate pass');
        continue;
      }
      let ok = false;
      try {
        ok = await this.commit(data);
      } catch {
        ok = false;
      }
      if (epoch !== this.activeEpoch || this.currentPhase() === 'disposed') {
        return;
      }
      // Check if an edit arrived while `commit()` was awaiting `applyEdit`.
      if (this.currentPhase() === 'running_dirty') {
        this.fsm.send('PASS_DIRTY', 'edit arrived during commit');
        continue;
      }
      this.fsm.send(ok ? 'PASS_CLEAN' : 'PASS_FAIL');
      this.resolveAll(ok);
      return;
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private resolveAll(ok: boolean): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) {
      resolve(ok);
    }
  }
}
