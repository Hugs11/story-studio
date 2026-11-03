import { Tooltip } from '../common/Tooltip.jsx';
import { presentCatalogueError } from '../../store/catalogue/catalogueApi.js';
export function CatalogueNotice({ error, compact = false }) {
  if (!error) return null;
  const message = presentCatalogueError(error);
  if (compact) return <Tooltip text={message.technicalDetail ?? message.message}><p className="opts-row-sub" role="alert" tabIndex={0}>{message.message}</p></Tooltip>;
  return <Tooltip text={message.technicalDetail ?? ''} disabled={!message.technicalDetail}><div className="catalogue-notice" tabIndex={message.technicalDetail ? 0 : undefined}><p>{message.message}</p></div></Tooltip>;
}
