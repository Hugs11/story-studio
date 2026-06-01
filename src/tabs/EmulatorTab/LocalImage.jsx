import { useLocalFile } from '../../hooks/useLocalFile';

export function LocalImage({ file }) {
  const url = useLocalFile(file);
  return url
    ? <img src={url} alt="" className="lunii-story-img" />
    : <div className="lunii-story-img lunii-story-img--empty" />;
}
