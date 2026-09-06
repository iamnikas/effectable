/**
 * Parent @OnEvent must see child publishes during child onMount.
 *
 * GraphRuntime used to wire parent buses only after all children finished
 * materialize+onMount. A child that published in onMount therefore hit a parent
 * that was not yet subscribed — silent event loss. Mirror of #80 (teardown:
 * parent bus after children): mount must register parent bus before children.
 */
import 'reflect-metadata';

import { Component } from '../src/component/Component';
import { EMPTY_CONTEXT_SCOPE } from '../src/component/context';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import {
  OnEvent,
  UseEventBus,
  createRuntimeBuses,
} from '../src/runtime/BusDecorators';
import type { EventBus } from '../src/runtime/EventBus';
import type { RuntimeEvent } from '../src/runtime/types';

describe('GraphRuntime parent bus wiring before child onMount', () => {
  type Ev = RuntimeEvent<'CHILD_READY', { id: string }>;

  it('parent @OnEvent receives publish from child onMount', async () => {
    const buses = createRuntimeBuses<never, never, Ev>();
    const seen: string[] = [];

    class Child extends Component<Record<string, never>, Record<string, never>> {
      @UseEventBus()
      public declare eventBus: EventBus<Ev>;

      public constructor () {
        super({});
      }

      public override onMount (): void {
        seen.push('child-mount');
        this.eventBus.publish({ type: 'CHILD_READY', payload: { id: 'c1' } });
        seen.push('child-published');
      }
    }

    class Parent extends Component<Record<string, never>, Record<string, never>> {
      @UseEventBus()
      public declare eventBus: EventBus<Ev>;

      public constructor () {
        super({});
      }

      @OnEvent('CHILD_READY')
      public onChildReady (event: Ev): void {
        seen.push(`parent-got:${event.payload.id}`);
      }

      public override onMount (): void {
        seen.push('parent-mount');
      }

      public override compose () {
        return [h(Child)];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent),
      EMPTY_CONTEXT_SCOPE,
      buses as never,
    );

    expect(seen).toEqual([
      'child-mount',
      'parent-got:c1',
      'child-published',
      'parent-mount',
    ]);

    await rt.unmount();
  });
});
