import { bootstrap } from '../src/bootstrap';
import { Component } from '../src/component';

class BoomRoot extends Component<{ boom: boolean }, Record<string, never>> {
  public unmountCount = 0;

  constructor (props: Record<string, never>) {
    super(props);
    this.state = { boom: false };
  }

  public override compose (): null {
    if (this.state.boom) {
      throw new Error('compose boom after setState');
    }

    return null;
  }

  public override onUnmount (): void {
    this.unmountCount += 1;
  }
}

describe('bootstrap isRunning after GraphRuntime fail-stop', () => {
  it('BOOT-ZOMBIE: isRunning false and reconcile no-op after auto-reconcile fail-stop', async () => {
    const handle = await bootstrap(BoomRoot, {});
    const root = handle.rootInstance;

    expect(handle.isRunning()).toBe(true);

    root.setState({ boom: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Fail-stop already tore the tree down…
    expect(root.unmountCount).toBe(1);
    // …but the handle must not claim it is still running.
    expect(handle.isRunning()).toBe(false);

    // reconcile must not re-enter / rethrow the terminal GraphRuntime error
    await expect(handle.reconcile()).resolves.toBeUndefined();
    expect(handle.isRunning()).toBe(false);

    // shutdown still clears owned primitives (uses the internal latch, not isRunning)
    await handle.shutdown();
    expect(handle.isRunning()).toBe(false);
  });
});
