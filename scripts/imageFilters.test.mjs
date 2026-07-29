import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPortableImageFilters,
  hasPortableImageFilters,
} from '../src/components/ImageEditorModal/imageFilters.js';

function imageData(pixels, width = 1, height = 1) {
  return {
    data: new Uint8ClampedArray(pixels),
    width,
    height,
  };
}

function filteredPixel(pixel, filters) {
  const data = imageData(pixel);
  applyPortableImageFilters(data, filters);
  return [...data.data];
}

test('neutral image filters avoid a pixel pass', () => {
  const data = imageData([10, 20, 30, 255]);
  assert.equal(hasPortableImageFilters({}), false);
  assert.equal(applyPortableImageFilters(data, {}), data);
  assert.deepEqual([...data.data], [10, 20, 30, 255]);
});

test('brightness, contrast and saturation are applied without canvas filter support', () => {
  assert.deepEqual(filteredPixel([100, 100, 100, 255], { brightness: -50 }), [50, 50, 50, 255]);
  assert.deepEqual(filteredPixel([100, 100, 100, 255], { contrast: -50 }), [114, 114, 114, 255]);

  const desaturated = filteredPixel([255, 0, 0, 255], { saturation: -100 });
  assert.deepEqual(desaturated, [54, 54, 54, 255]);
});

test('grayscale and invert work through the portable pixel pipeline', () => {
  const grayscale = filteredPixel([20, 100, 220, 255], { grayscale: true });
  assert.equal(grayscale[0], grayscale[1]);
  assert.equal(grayscale[1], grayscale[2]);
  assert.deepEqual(filteredPixel([20, 100, 220, 128], { invert: true }), [235, 155, 35, 128]);
});

test('advanced hue and sepia filters alter colors while preserving alpha', () => {
  const source = [180, 80, 20, 77];
  const hue = filteredPixel(source, { hue: 180 });
  const sepia = filteredPixel(source, { sepia: 100 });
  assert.notDeepEqual(hue.slice(0, 3), source.slice(0, 3));
  assert.notDeepEqual(sepia.slice(0, 3), source.slice(0, 3));
  assert.equal(hue[3], 77);
  assert.equal(sepia[3], 77);
});

test('blur spreads an opaque center pixel and preserves transparent edges cleanly', () => {
  const data = imageData([
    0, 0, 0, 0,
    255, 0, 0, 255,
    0, 0, 0, 0,
  ], 3, 1);
  applyPortableImageFilters(data, { blur: 1 });

  assert.ok(data.data[3] > 0);
  assert.ok(data.data[7] > 0 && data.data[7] < 255);
  assert.ok(data.data[11] > 0);
  assert.equal(data.data[0], 255);
  assert.equal(data.data[4], 255);
  assert.equal(data.data[8], 255);
});

test('thickness performs its blur and contrast pass without relying on WebKit', () => {
  const data = imageData([
    0, 0, 0, 255,
    180, 180, 180, 255,
    255, 255, 255, 255,
  ], 3, 1);
  applyPortableImageFilters(data, { thickness: 2 });

  assert.notDeepEqual([...data.data], [
    0, 0, 0, 255,
    180, 180, 180, 255,
    255, 255, 255, 255,
  ]);
  assert.deepEqual(
    [data.data[3], data.data[7], data.data[11]],
    [255, 255, 255],
  );
});

test('portable filters reject mismatched dimensions', () => {
  const data = imageData([1, 2, 3, 255]);
  assert.throws(
    () => applyPortableImageFilters(data, { invert: true }, 2, 2),
    /Dimensions de filtre image invalides/,
  );
});
