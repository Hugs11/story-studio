import { createPortal } from 'react-dom';
import './AppModalPortal.css';

export function AppModalPortal({ className = 'modal-overlay', children }) {
  return createPortal(
    <div className={`app-modal-overlay ${className}`.trim()}>
      {children}
    </div>,
    document.body,
  );
}
