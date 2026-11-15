import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOptionsSection } from '../src/tabs/OptionsTab/activeOptionsSection.js';
import { runner } from './reactHookDriver.mjs';
const { useOptionsSectionNav } = await import('../src/tabs/OptionsTab/useOptionsSectionNav.js');

const sections = [24, 260, 1300, 1350, 1400, 2200].map((top, index) => ({ id: `section-${index}`, top }));

for (const direction of [1, -1]) {
  test(`slow ${direction === 1 ? 'downward' : 'upward'} scroll visits every neighbour monotonically, including short sections`, () => {
    const positions = Array.from({ length: 2501 }, (_, index) => direction === 1 ? index : 2500 - index);
    const active = positions.map(top => activeOptionsSection(sections, top, 500, 3000));
    const visited = active.filter((id, index) => index === 0 || id !== active[index - 1]);
    assert.deepEqual(visited, (direction === 1 ? sections : sections.toReversed()).map(section => section.id));
    for (let index = 1; index < active.length; index++) {
      const delta = sections.findIndex(section => section.id === active[index]) - sections.findIndex(section => section.id === active[index - 1]);
      assert.ok(delta === 0 || delta === direction);
    }
  });
}

test('selection changes at the fixed line minus one pixel of tolerance, independent of viewport height', () => {
  for (const height of [300, 700]) {
    assert.equal(activeOptionsSection(sections, 242, height, 3000), 'section-0');
    assert.equal(activeOptionsSection(sections, 243, height, 3000), 'section-1');
  }
});

for (const direction of [1, -1]) {
  test(`three short final sections are visited monotonically ${direction === 1 ? 'downward' : 'upward'}`, () => {
    const finalSections = [24, 650, 750, 900].map((top, index) => ({ id: `end-${index}`, top }));
    const positions = Array.from({ length: 501 }, (_, index) => direction === 1 ? index : 500 - index);
    const active = positions.map(top => activeOptionsSection(finalSections, top, 500, 1000));
    const visited = active.filter((id, index) => index === 0 || id !== active[index - 1]);
    assert.deepEqual(visited, (direction === 1 ? finalSections : finalSections.toReversed()).map(section => section.id));
    assert.equal(activeOptionsSection(finalSections, 500, 500, 1000), 'end-3');
  });
}

test('activation tolerates one pixel of fractional positioning after a click', () => {
  assert.equal(activeOptionsSection(sections, 242.99, 500, 3000), 'section-0');
  for (const top of [243, 243.25, 243.75, 244]) {
    assert.equal(activeOptionsSection(sections, top, 500, 3000), 'section-1');
  }
});

test('content fitting the viewport keeps the first section unless explicitly navigated to', () => {
  const shortSections = [{ id: 'first', top: 24 }, { id: 'last', top: 200 }];
  for (const height of [300, 500]) {
    assert.equal(activeOptionsSection(shortSections, 0, height, 300), 'first');
    assert.equal(activeOptionsSection(shortSections, 0, height, 300, 'last'), 'last');
  }
});

test('navigation target stays selected throughout animation, including a bottom-clamped target', () => {
  for (const target of ['section-4', 'section-1']) {
    for (let top = 0; top <= 2500; top += 10) {
      assert.equal(activeOptionsSection(sections, top, 500, 3000, target), target);
    }
  }
});

test('hook batches scroll updates, pins a click, resumes on wheel and cleans up', () => {
  const previousWindow = globalThis.window;
  const frames = new Map(), handlers = new Map(), calls = [];
  let nextFrame = 0;
  globalThis.window = {
    requestAnimationFrame(fn) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout() { return 1; }, clearTimeout() {},
  };
  const frame = () => {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn());
  };
  const root = {
    scrollTop: 0, clientTop: 0, clientHeight: 500, scrollHeight: 3000,
    getBoundingClientRect: () => ({ top: 120 }),
    addEventListener: (name, fn) => handlers.set(name, fn),
    removeEventListener: name => handlers.delete(name),
  };
  const sectionIds = sections.map(section => section.id), screenRef = { current: root };
  const hook = runner(() => useOptionsSectionNav({ sectionIds, screenRef }));
  try {
    let view = hook.render();
    for (const section of sections) view.registerSection(section.id)({
      id: section.id,
      getBoundingClientRect: () => ({ top: 120 + section.top - root.scrollTop }),
      scrollIntoView: options => calls.push([section.id, options]),
    });
    hook.flush();
    view.scrollToSection('section-4');
    assert.equal(hook.render().activeSectionId, 'section-4');
    assert.deepEqual(calls, [['section-4', { behavior: 'smooth', block: 'start' }]]);
    frame();
    for (const top of [260, 1300, 1384]) {
      root.scrollTop = top; handlers.get('scroll')(); handlers.get('scroll')();
      assert.equal(frames.size, 1);
      frame();
      assert.equal(hook.render().activeSectionId, 'section-4');
    }
    handlers.get('wheel')(); root.scrollTop = 1320; handlers.get('scroll')(); frame();
    assert.equal(hook.render().activeSectionId, 'section-2');
    handlers.get('scroll')();
    hook.unmount();
    assert.equal(frames.size, 0);
    assert.equal(handlers.size, 0);
  } finally {
    globalThis.window = previousWindow;
  }
});
