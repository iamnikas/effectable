/**
 * Regression: constructionJournal.mountedChildren must not retain destroyed
 * child fibers after UPDATE shrinks a keyed list.
 *
 * Mount aliases fiber.children to journal.mountedChildren. UPDATE used to
 * reassign fiber.children to a new array while leaving the journal pointing at
 * the pre-reconcile array, leaking destroyed siblings until the parent unmounted.
 */

import { Component, GraphRuntime, h } from 'Effectable';

describe('GraphRuntime constructionJournal.mountedChildren leak', () => {
  class Child extends Component<{ id: string }, { id: string }> {
    public constructor (props: { id: string }) {
      super(props);
      this.state = { id: props.id };
    }
  }

  class Parent extends Component<{ ids: string[] }, { ids: string[] }> {
    public constructor (props: { ids: string[] }) {
      super(props);
      this.state = { ids: props.ids };
    }

    public override compose () {
      return this.props.ids.map((id) => h(Child, { id }, id));
    }
  }

  it('drops destroyed siblings from journal after keyed list shrink', async () => {
    const runtime = await GraphRuntime.mount(h(Parent, { ids: ['a', 'b', 'c'] }));
    await runtime.reconcile(h(Parent, { ids: ['a'] }));

    const root = (runtime as unknown as {
      currentRoot: {
        children: Array<{ instance: { props: { id: string } } | null }>;
        constructionJournal?: {
          mountedChildren: Array<{ instance: { props: { id: string } } | null }>;
        };
      };
    }).currentRoot;

    expect(root.children.map((f) => f.instance?.props.id)).toEqual(['a']);
    expect(
      root.constructionJournal?.mountedChildren.map((f) => f.instance?.props.id),
    ).toEqual(['a']);

    await runtime.unmount();
  });
});
