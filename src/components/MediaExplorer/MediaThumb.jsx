import { useLocalFile } from '../../hooks/useLocalFile';
import { AudioWave } from './AudioWave';
import { KindIcon } from './KindIcon';

export function MediaThumb({ item, compact }) {
  const imageUrl = useLocalFile(item.kind === 'image' && item.exists ? item.path : null);
  if (imageUrl) return <img className="media-thumb-img" src={imageUrl} alt="" draggable={false} />;
  if (item.kind === 'audio') {
    return (
      <div className="media-thumb-fallback is-audio">
        <AudioWave name={item.name} bars={compact ? 8 : 18} />
      </div>
    );
  }
  return (
    <div className={`media-thumb-fallback is-${item.kind}`}>
      <KindIcon kind={item.kind} />
    </div>
  );
}
