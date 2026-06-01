import { waveHeights } from './helpers';

export function AudioWave({ name, bars = 18 }) {
  const heights = waveHeights(name, bars);
  return (
    <div className="media-audio-wave">
      {heights.map((h, i) => (
        <span key={i} className="media-audio-wave-bar" style={{ height: h }} />
      ))}
    </div>
  );
}
