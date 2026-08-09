/**
 * LifecycleEngine tests — GraphRuntime node lifecycle state machine.
 *
 * Contract: stages registered -> resolved -> created -> mounted -> ready,
 * public hooks onMount/onUpdate/onUnmount.
 *
 * @module Effectable/component/LifecycleEngine.entity.test
 */

import { Component, LifecycleEngine } from 'Effectable';

class StubComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public calls: string[] = [];

  constructor () {
    super({});
  }

  public override async onMount (): Promise<void> {
    this.calls.push('onMount');
  }

  public override async onUnmount (): Promise<void> {
    this.calls.push('onUnmount');
  }
}

class FailingMountComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public calls: string[] = [];

  constructor () {
    super({});
  }

  public override async onMount (): Promise<void> {
    this.calls.push('onMount');
    throw new Error('onMount failed');
  }

  public override async onUnmount (): Promise<void> {
    this.calls.push('onUnmount');
  }
}

class DeferredRejectMountComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public calls: string[] = [];

  constructor () {
    super({});
  }

  public override async onMount (): Promise<void> {
    this.calls.push('onMount');
    await Promise.resolve();
    throw new Error('async onMount failed');
  }

  public override async onUnmount (): Promise<void> {
    this.calls.push('onUnmount');
  }
}

class FailingUnmountComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public calls: string[] = [];

  constructor () {
    super({});
  }

  public override async onMount (): Promise<void> {
    this.calls.push('onMount');
  }

  public override async onUnmount (): Promise<void> {
    this.calls.push('onUnmount');
    throw new Error('onUnmount failed');
  }
}

class SyncMountComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public calls: string[] = [];

  constructor () {
    super({});
  }

  public override onMount (): void {
    this.calls.push('onMount');
  }
}

class SyncUnmountComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public calls: string[] = [];

  constructor () {
    super({});
  }

  public override onMount (): void {
    this.calls.push('onMount');
  }

  public override onUnmount (): void {
    this.calls.push('onUnmount');
  }
}

describe('LifecycleEngine', () => {
  describe('canUpdate — before and after startup', () => {
    it('before runStartup canUpdate() returns false', () => {
      const engine = new LifecycleEngine();

      expect(engine.canUpdate()).toBe(false);
    });

    it('after failed runStartup canUpdate() returns false', async () => {
      const engine = new LifecycleEngine();
      const instance = new FailingMountComponent();

      await engine.runStartup(instance);

      expect(engine.canUpdate()).toBe(false);
    });
  });

  describe('startup — success path', () => {
    it('calls onMount and transitions to ready', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      expect(engine.getStatus()).toBe('registered');

      const result = await engine.runStartup(instance);

      expect(result.ok).toBe(true);
      expect(engine.getStatus()).toBe('ready');
      expect(instance.calls).toEqual(['onMount']);
    });

    it('after runStartup canUpdate() returns true', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);

      expect(engine.canUpdate()).toBe(true);
    });

    it('isTerminated() returns false after successful startup', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);

      expect(engine.isTerminated()).toBe(false);
    });
  });

  describe('startup — failure path', () => {
    it('on onMount error transitions to destroyed and calls onUnmount (runFailedCleanup)', async () => {
      const engine = new LifecycleEngine();
      const instance = new FailingMountComponent();

      const result = await engine.runStartup(instance);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as Error).message).toBe('onMount failed');
      }
      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toContain('onMount');
      expect(instance.calls).toContain('onUnmount');
    });

    it('H16: async onMount with reject after await → destroyed + onUnmount (runFailedCleanup)', async () => {
      const engine = new LifecycleEngine();
      const instance = new DeferredRejectMountComponent();

      const result = await engine.runStartup(instance);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as Error).message).toBe('async onMount failed');
      }
      expect(engine.getStatus()).toBe('destroyed');
      expect(engine.isTerminated()).toBe(true);
      expect(instance.calls).toEqual(['onMount', 'onUnmount']);
    });
  });

  describe('shutdown — success path', () => {
    it('calls onUnmount and transitions to destroyed', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);
      instance.calls = [];

      const result = await engine.runShutdown(instance);

      expect(result.ok).toBe(true);
      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toEqual(['onUnmount']);
    });

    it('repeated runShutdown is idempotent (does not call hooks twice)', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);
      await engine.runShutdown(instance);
      instance.calls = [];

      const result = await engine.runShutdown(instance);

      expect(result.ok).toBe(true);
      expect(instance.calls).toEqual([]);
    });

    it('isTerminated() returns true after runShutdown', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);
      await engine.runShutdown(instance);

      expect(engine.isTerminated()).toBe(true);
    });

    it('runShutdown without prior runStartup does not call onUnmount and transitions to destroyed', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      const result = await engine.runShutdown(instance);

      expect(result.ok).toBe(true);
      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toEqual([]);
    });
  });

  describe('shutdown — failure path', () => {
    it('on onUnmount error returns ok: false with the error and still transitions to destroyed', async () => {
      const engine = new LifecycleEngine();
      const instance = new FailingUnmountComponent();

      await engine.runStartup(instance);
      instance.calls = [];

      const result = await engine.runShutdown(instance);

      expect(result.ok).toBe(false);
      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toContain('onUnmount');
    });
  });

  describe('runFailedCleanup', () => {
    it('calls onUnmount on error after the mounted stage', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);
      instance.calls = [];

      await engine.runFailedCleanup(instance, true);

      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toContain('onUnmount');
    });

    it('does not call onUnmount on error before the mounted stage', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runFailedCleanup(instance, false);

      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).not.toContain('onUnmount');
    });

    it('with wasMounted=true and onUnmount error still transitions to destroyed', async () => {
      const engine = new LifecycleEngine();
      const instance = new FailingUnmountComponent();

      await engine.runStartup(instance);
      instance.calls = [];

      await engine.runFailedCleanup(instance, true);

      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toContain('onUnmount');
    });
  });

  describe('runStartup — repeated call', () => {
    it('repeated runStartup on the same engine after a successful cycle calls onMount again', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);
      instance.calls = [];

      const second = await engine.runStartup(instance);

      expect(second.ok).toBe(true);
      expect(instance.calls).toEqual(['onMount']);
    });
  });

  describe('canTransitionTo', () => {
    it('returns true for a valid forward transition', () => {
      const engine = new LifecycleEngine();

      expect(engine.canTransitionTo('resolved')).toBe(true);
      expect(engine.canTransitionTo('mounted')).toBe(true);
      expect(engine.canTransitionTo('destroyed')).toBe(true);
    });

    it('returns false for a backward transition', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);

      // 'resolved' has a lower order than 'ready', so canTransitionTo returns false
      expect(engine.canTransitionTo('resolved')).toBe(false);
      expect(engine.canTransitionTo('created')).toBe(false);
    });

    it('from failed only a transition to destroyed is allowed', () => {
      const engine = new LifecycleEngine();

      engine.markFailed();

      expect(engine.canTransitionTo('destroyed')).toBe(true);
      expect(engine.canTransitionTo('mounted')).toBe(false);
    });
  });

  describe('markFailed', () => {
    it('transitions to failed without calling hooks', () => {
      const engine = new LifecycleEngine();

      engine.markFailed();

      expect(engine.getStatus()).toBe('failed');
      expect(engine.isTerminated()).toBe(true);
    });

    it('repeated markFailed does not change status (idempotent)', async () => {
      const engine = new LifecycleEngine();
      const instance = new StubComponent();

      await engine.runStartup(instance);
      await engine.runShutdown(instance);

      engine.markFailed();

      expect(engine.getStatus()).toBe('destroyed');
    });
  });

  describe('LIFE-04 / LIFE-05 sync fast-path and pure', () => {
    it('LIFE-04: sync onMount (non-thenable) — runStartup returns the result synchronously', () => {
      const engine = new LifecycleEngine();
      const instance = new SyncMountComponent();
      engine.initHookFlags(instance);

      const result = engine.runStartup(instance);

      expect(typeof (result as { then?: unknown }).then).toBe('undefined');
      expect(result).toEqual({ ok: true });
      expect(engine.getStatus()).toBe('ready');
      expect(instance.calls).toEqual(['onMount']);
    });

    it('LIFE-05: initHookFlags + pure instance without hooks — sync ready without calling onMount', () => {
      const engine = new LifecycleEngine();
      const pure = {
        state: {},
        props: {},
      } as unknown as Component<Record<string, unknown>, Record<string, unknown>>;

      engine.initHookFlags(pure);
      const result = engine.runStartup(pure);

      expect(typeof (result as { then?: unknown }).then).toBe('undefined');
      expect(result).toEqual({ ok: true });
      expect(engine.getStatus()).toBe('ready');
      expect(engine.canUpdate()).toBe(true);
    });

    it('LIFE-06: initHookFlags accounts for Mount/Update/Unmount (typeof on the instance)', () => {
      const HookBit = {
        Mount: 1 << 0,
        Update: 1 << 1,
        Unmount: 1 << 2,
      } as const;

      const computeFlags = (instance: Component<unknown, unknown>): number => {
        return (
          (typeof instance.onMount === 'function' ? HookBit.Mount : 0) |
          (typeof instance.onUpdate === 'function' ? HookBit.Update : 0) |
          (typeof instance.onUnmount === 'function' ? HookBit.Unmount : 0)
        );
      };

      const pure = {
        state: {},
        props: {},
      } as unknown as Component<Record<string, unknown>, Record<string, unknown>>;
      expect(computeFlags(pure)).toBe(0);

      const mountOnly = {
        state: {},
        props: {},
        onMount: (): void => {},
      } as unknown as Component<Record<string, unknown>, Record<string, unknown>>;
      expect(computeFlags(mountOnly)).toBe(HookBit.Mount);

      const mountCalls: string[] = [];
      const mountOnlyRunnable = {
        state: {},
        props: {},
        onMount: (): void => {
          mountCalls.push('onMount');
        },
      } as unknown as Component<Record<string, unknown>, Record<string, unknown>>;

      const engineMount = new LifecycleEngine();
      engineMount.initHookFlags(mountOnlyRunnable);
      const mountResult = engineMount.runStartup(mountOnlyRunnable);
      expect(typeof (mountResult as { then?: unknown }).then).toBe('undefined');
      expect(mountCalls).toEqual(['onMount']);

      const full = new SyncUnmountComponent();
      const fullMask = HookBit.Mount | HookBit.Update | HookBit.Unmount;
      expect(computeFlags(full)).toBe(fullMask);

      const enginePure = new LifecycleEngine();
      enginePure.initHookFlags(pure);
      const pureStartup = enginePure.runStartup(pure);
      expect(typeof (pureStartup as { then?: unknown }).then).toBe('undefined');
      expect(enginePure.getStatus()).toBe('ready');
    });

    it('LIFE-13: sync onUnmount (non-Promise) — runShutdown returns the result synchronously', () => {
      const engine = new LifecycleEngine();
      const instance = new SyncUnmountComponent();

      engine.initHookFlags(instance);
      void engine.runStartup(instance);
      instance.calls = [];

      const result = engine.runShutdown(instance);

      expect(typeof (result as { then?: unknown }).then).toBe('undefined');
      expect(result).toEqual({ ok: true });
      expect(engine.getStatus()).toBe('destroyed');
      expect(instance.calls).toEqual(['onUnmount']);
    });
  });
});
