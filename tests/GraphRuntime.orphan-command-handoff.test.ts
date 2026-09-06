/**
 * Regression: #158 deferred orphan destroy until after UPDATE (correct for EventBus
 * handoff) but stacked with eager exclusive Command/Query pre-release for *all*
 * orphans before PLACE. When UPDATE+DELETE ran with no PLACE claiming the type,
 * onUpdate `execute`/`query` to the still-mounted orphan already saw an unregistered
 * handler — silent handoff loss (promise reject) despite #158 lifecycle order.
 *
 * Contract: release orphan exclusive slots only for types an incoming PLACE/REPLACE
 * will register; otherwise keep them until deferred destroy after UPDATE.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseCommandBus, OnCommand, UseQueryBus, OnQuery } from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: { n: number } };
type Q = { type: 'GET'; payload: { n: number } };

function makeBuses () {
  return {
    eventBus: new EventBus(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime UPDATE→orphan exclusive handoff (no PLACE claim)', () => {
  it('UPDATE onUpdate execute reaches orphan @OnCommand before destroy', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ n: number }, { n: number }> {
      @UseCommandBus() declare commands: CommandBus<Cmd>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          void this.commands.execute({ type: 'DO', payload: { n: this.props.n } }).then(
            () => {
              seen.push('exec-ok');
            },
            (err: unknown) => {
              seen.push(`exec-fail:${err instanceof Error ? err.message : String(err)}`);
            },
          );
        }
      }
    }

    class Worker extends Component {
      @OnCommand('DO')
      public handle (c: Cmd): void {
        seen.push(`do:${c.payload.n}`);
      }
      public override onUnmount (): void {
        seen.push('worker-unmount');
      }
    }

    class Parent extends Component<{ n: number; keep: boolean }, { n: number; keep: boolean }> {
      public override compose () {
        if (this.props.keep) {
          return [
            h(Publisher, { n: this.props.n }, 'p'),
            h(Worker, {}, 'w'),
          ];
        }
        return [h(Publisher, { n: this.props.n }, 'p')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, keep: true }),
      undefined,
      buses as any,
    );
    seen.length = 0;

    await rt.reconcile(h(Parent, { n: 2, keep: false }));
    await Promise.resolve();
    await Promise.resolve();

    expect(rt.isActive()).toBe(true);
    expect(seen).toContain('do:2');
    expect(seen).toContain('exec-ok');
    expect(seen.some((s) => s.startsWith('exec-fail:'))).toBe(false);
    expect(seen.indexOf('do:2')).toBeLessThan(seen.indexOf('worker-unmount'));
    await rt.unmount();
  });

  it('UPDATE onUpdate query reaches orphan @OnQuery before destroy', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ n: number }, { n: number }> {
      @UseQueryBus() declare queries: QueryBus<Q>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          void this.queries.execute({ type: 'GET', payload: { n: this.props.n } }).then(
            (v) => {
              seen.push(`query-ok:${String(v)}`);
            },
            (err: unknown) => {
              seen.push(`query-fail:${err instanceof Error ? err.message : String(err)}`);
            },
          );
        }
      }
    }

    class Worker extends Component {
      @OnQuery('GET')
      public handle (q: Q): number {
        seen.push(`get:${q.payload.n}`);
        return q.payload.n * 10;
      }
      public override onUnmount (): void {
        seen.push('worker-unmount');
      }
    }

    class Parent extends Component<{ n: number; keep: boolean }, { n: number; keep: boolean }> {
      public override compose () {
        if (this.props.keep) {
          return [
            h(Publisher, { n: this.props.n }, 'p'),
            h(Worker, {}, 'w'),
          ];
        }
        return [h(Publisher, { n: this.props.n }, 'p')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, keep: true }),
      undefined,
      buses as any,
    );
    seen.length = 0;

    await rt.reconcile(h(Parent, { n: 2, keep: false }));
    await Promise.resolve();
    await Promise.resolve();

    expect(rt.isActive()).toBe(true);
    expect(seen).toContain('get:2');
    expect(seen).toContain('query-ok:20');
    expect(seen.some((s) => s.startsWith('query-fail:'))).toBe(false);
    expect(seen.indexOf('get:2')).toBeLessThan(seen.indexOf('worker-unmount'));
    await rt.unmount();
  });
});
