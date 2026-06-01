import test from 'node:test';
import assert from 'node:assert/strict';

import { markersAfterAction } from '../src/components/AudioEditorModal/audioEditorMarkers.js';

test('markersAfterAction with invalid selection returns input untouched', () => {
  const markers = [{ time: 1 }, { time: 2 }];
  assert.deepEqual(markersAfterAction(markers, 'trim', 5, 5, 10), markers);
  assert.deepEqual(markersAfterAction(markers, 'trim', NaN, 5, 10), markers);
});

test('markersAfterAction trim keeps markers inside selection, rebased to zero', () => {
  const markers = [{ time: 1, fadeSec: 0.2 }, { time: 3 }, { time: 4 }];
  const result = markersAfterAction(markers, 'trim', 2, 3.5, 10);
  // Marker time:1 hors selection -> filtre. time:3 dans [2, 3.5] -> rebase a 1. time:4 hors.
  assert.deepEqual(result, [{ time: 1 }]);
});

test('markersAfterAction cut removes selection and shifts subsequent markers', () => {
  const markers = [{ time: 1 }, { time: 5 }, { time: 7 }];
  const result = markersAfterAction(markers, 'cut', 2, 4, 10, 0);
  // Selection [2,4] is removed (duration 2), markers > 4 shifted back by 2.
  // A new cut marker is added at the selection start since it is not at the edges.
  assert.deepEqual(result, [
    { time: 1 },
    { time: 2, fadeSec: 0 },
    { time: 3 },
    { time: 5 },
  ]);
});

test('markersAfterAction cut without inner cut marker when selection touches the edge', () => {
  const markers = [{ time: 1 }, { time: 5 }];
  // Selection until duration -> shouldn't append a new cut marker (selectionEnd >= dur-0.01).
  const result = markersAfterAction(markers, 'cut', 2, 9.999, 10, 0);
  assert.deepEqual(result, [{ time: 1 }]);
});

test('markersAfterAction cut includes the configured fade in the removed duration', () => {
  const markers = [{ time: 1 }, { time: 6 }];
  const result = markersAfterAction(markers, 'cut', 2, 4, 10, 1);
  // Removed duration = 4-2 + 1 = 3. Marker at 6 -> 3.
  assert.deepEqual(result, [
    { time: 1 },
    { time: 2, fadeSec: 1 },
    { time: 3 },
  ]);
});
