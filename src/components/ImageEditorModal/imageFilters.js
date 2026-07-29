// Filtres d'image portables, appliqués directement aux pixels du canvas.
//
// CanvasRenderingContext2D.filter n'est pas disponible de façon homogène dans
// les WebView embarquées (notamment WebKit). Garder ce pipeline indépendant du
// moteur garantit le même aperçu et le même export sur les trois plateformes.

const BYTE_MAX = 255;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value) {
  return clamp(Math.round(value), 0, BYTE_MAX);
}

function numberInRange(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp(numeric, min, max) : fallback;
}

function blurPass(source, target, width, height, radius, horizontal) {
  const windowSize = radius * 2 + 1;
  const primarySize = horizontal ? width : height;
  const secondarySize = horizontal ? height : width;

  for (let secondary = 0; secondary < secondarySize; secondary += 1) {
    const sums = [0, 0, 0, 0];
    const indexFor = (primary) => {
      const x = horizontal ? primary : secondary;
      const y = horizontal ? secondary : primary;
      return (y * width + x) * 4;
    };

    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = indexFor(clamp(offset, 0, primarySize - 1));
      for (let channel = 0; channel < 4; channel += 1) {
        sums[channel] += source[index + channel];
      }
    }

    for (let primary = 0; primary < primarySize; primary += 1) {
      const outputIndex = indexFor(primary);
      for (let channel = 0; channel < 4; channel += 1) {
        target[outputIndex + channel] = sums[channel] / windowSize;
      }

      const removeIndex = indexFor(clamp(primary - radius, 0, primarySize - 1));
      const addIndex = indexFor(clamp(primary + radius + 1, 0, primarySize - 1));
      for (let channel = 0; channel < 4; channel += 1) {
        sums[channel] += source[addIndex + channel] - source[removeIndex + channel];
      }
    }
  }
}

function applyBoxBlur(data, width, height, requestedRadius) {
  const radius = Math.max(1, Math.round(requestedRadius));
  if (width <= 0 || height <= 0 || radius <= 0) return data;

  // Le calcul prémultiplié évite les franges sombres lorsque l'image contenue
  // laisse des bandes transparentes autour d'elle.
  const premultiplied = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    const alphaFactor = alpha / BYTE_MAX;
    premultiplied[index] = data[index] * alphaFactor;
    premultiplied[index + 1] = data[index + 1] * alphaFactor;
    premultiplied[index + 2] = data[index + 2] * alphaFactor;
    premultiplied[index + 3] = alpha;
  }

  const horizontal = new Float32Array(data.length);
  const vertical = new Float32Array(data.length);
  blurPass(premultiplied, horizontal, width, height, radius, true);
  blurPass(horizontal, vertical, width, height, radius, false);

  const output = new Uint8ClampedArray(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = vertical[index + 3];
    output[index + 3] = clampByte(alpha);
    if (alpha <= 0) continue;
    const unpremultiply = BYTE_MAX / alpha;
    output[index] = clampByte(vertical[index] * unpremultiply);
    output[index + 1] = clampByte(vertical[index + 1] * unpremultiply);
    output[index + 2] = clampByte(vertical[index + 2] * unpremultiply);
  }
  return output;
}

function applyColorFilters(data, filters) {
  const thickness = numberInRange(filters.thickness, 0, 0, 5);
  const thicknessContrast = thickness > 0 ? 2 + thickness * 1.8 : 1;
  const brightness = 1 + numberInRange(filters.brightness, 0, -50, 50) / 100;
  const contrast = 1 + numberInRange(filters.contrast, 0, -50, 50) / 100;
  const saturation = 1 + numberInRange(filters.saturation, 0, -100, 100) / 100;
  const grayscale = Boolean(filters.grayscale);
  const hue = numberInRange(filters.hue, 0, 0, 360);
  const sepia = numberInRange(filters.sepia, 0, 0, 100) / 100;
  const invert = Boolean(filters.invert);
  const hueRadians = hue * Math.PI / 180;
  const hueCos = Math.cos(hueRadians);
  const hueSin = Math.sin(hueRadians);

  for (let index = 0; index < data.length; index += 4) {
    let red = data[index];
    let green = data[index + 1];
    let blue = data[index + 2];

    if (thicknessContrast !== 1) {
      red = (red - 127.5) * thicknessContrast + 127.5;
      green = (green - 127.5) * thicknessContrast + 127.5;
      blue = (blue - 127.5) * thicknessContrast + 127.5;
    }

    if (brightness !== 1) {
      red *= brightness;
      green *= brightness;
      blue *= brightness;
    }

    if (contrast !== 1) {
      red = (red - 127.5) * contrast + 127.5;
      green = (green - 127.5) * contrast + 127.5;
      blue = (blue - 127.5) * contrast + 127.5;
    }

    if (saturation !== 1) {
      const nextRed = (0.213 + 0.787 * saturation) * red
        + (0.715 - 0.715 * saturation) * green
        + (0.072 - 0.072 * saturation) * blue;
      const nextGreen = (0.213 - 0.213 * saturation) * red
        + (0.715 + 0.285 * saturation) * green
        + (0.072 - 0.072 * saturation) * blue;
      const nextBlue = (0.213 - 0.213 * saturation) * red
        + (0.715 - 0.715 * saturation) * green
        + (0.072 + 0.928 * saturation) * blue;
      red = nextRed;
      green = nextGreen;
      blue = nextBlue;
    }

    if (grayscale) {
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      red = luminance;
      green = luminance;
      blue = luminance;
    }

    if (hue !== 0) {
      const nextRed = (0.213 + hueCos * 0.787 - hueSin * 0.213) * red
        + (0.715 - hueCos * 0.715 - hueSin * 0.715) * green
        + (0.072 - hueCos * 0.072 + hueSin * 0.928) * blue;
      const nextGreen = (0.213 - hueCos * 0.213 + hueSin * 0.143) * red
        + (0.715 + hueCos * 0.285 + hueSin * 0.140) * green
        + (0.072 - hueCos * 0.072 - hueSin * 0.283) * blue;
      const nextBlue = (0.213 - hueCos * 0.213 - hueSin * 0.787) * red
        + (0.715 - hueCos * 0.715 + hueSin * 0.715) * green
        + (0.072 + hueCos * 0.928 + hueSin * 0.072) * blue;
      red = nextRed;
      green = nextGreen;
      blue = nextBlue;
    }

    if (sepia > 0) {
      const nextRed = (1 - 0.607 * sepia) * red + 0.769 * sepia * green + 0.189 * sepia * blue;
      const nextGreen = 0.349 * sepia * red + (1 - 0.314 * sepia) * green + 0.168 * sepia * blue;
      const nextBlue = 0.272 * sepia * red + 0.534 * sepia * green + (1 - 0.869 * sepia) * blue;
      red = nextRed;
      green = nextGreen;
      blue = nextBlue;
    }

    if (invert) {
      red = BYTE_MAX - red;
      green = BYTE_MAX - green;
      blue = BYTE_MAX - blue;
    }

    data[index] = clampByte(red);
    data[index + 1] = clampByte(green);
    data[index + 2] = clampByte(blue);
  }
}

export function hasPortableImageFilters(filters = {}) {
  return numberInRange(filters.brightness, 0, -50, 50) !== 0
    || numberInRange(filters.contrast, 0, -50, 50) !== 0
    || numberInRange(filters.saturation, 0, -100, 100) !== 0
    || Boolean(filters.grayscale)
    || numberInRange(filters.hue, 0, 0, 360) !== 0
    || numberInRange(filters.sepia, 0, 0, 100) !== 0
    || numberInRange(filters.blur, 0, 0, 8) !== 0
    || Boolean(filters.invert)
    || numberInRange(filters.thickness, 0, 0, 5) !== 0;
}

export function applyPortableImageFilters(imageData, filters = {}, width, height) {
  if (!imageData?.data || !hasPortableImageFilters(filters)) return imageData;

  const resolvedWidth = Number.isInteger(width) ? width : imageData.width;
  const resolvedHeight = Number.isInteger(height) ? height : imageData.height;
  if (!Number.isInteger(resolvedWidth) || !Number.isInteger(resolvedHeight)
    || resolvedWidth <= 0 || resolvedHeight <= 0
    || imageData.data.length !== resolvedWidth * resolvedHeight * 4) {
    throw new Error('Dimensions de filtre image invalides.');
  }

  const thickness = numberInRange(filters.thickness, 0, 0, 5);
  const blur = numberInRange(filters.blur, 0, 0, 8);
  let pixels = new Uint8ClampedArray(imageData.data);
  if (thickness > 0) pixels = applyBoxBlur(pixels, resolvedWidth, resolvedHeight, thickness * 0.6);
  if (blur > 0) pixels = applyBoxBlur(pixels, resolvedWidth, resolvedHeight, blur);
  applyColorFilters(pixels, filters);
  imageData.data.set(pixels);
  return imageData;
}
