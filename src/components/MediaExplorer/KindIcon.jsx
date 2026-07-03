import { Package, Play, SwatchBook } from '../icons/LucideLocal';
import { IconArchive } from '../TreePanel/TreeIcons';

export function KindIcon({ kind }) {
  if (kind === 'archive') {
    return (
      <span className="media-kind-icon media-kind-icon--archive">
        <IconArchive />
      </span>
    );
  }
  const Icon = kind === 'image' ? SwatchBook : kind === 'audio' ? Play : Package;
  return <Icon className="media-kind-icon" strokeWidth={2} absoluteStrokeWidth />;
}
