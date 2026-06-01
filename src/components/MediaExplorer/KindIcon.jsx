import { Package, Play, SwatchBook } from '../icons/LucideLocal';

export function KindIcon({ kind }) {
  const Icon = kind === 'image' ? SwatchBook : kind === 'audio' ? Play : Package;
  return <Icon className="media-kind-icon" strokeWidth={2} absoluteStrokeWidth />;
}
