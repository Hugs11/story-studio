import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { generateTextImage } from './generateTextImage';
import { drawTextImage, TEXT_IMG_W, TEXT_IMG_H } from './drawTextImage';
import { Button } from '../common/Button';
import './TextImagePromptModal.css';

const OVERLAY_STYLE = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 10000,
  backdropFilter: 'blur(2px)',
};

export function TextImagePromptModal({ defaultText, onConfirm, onCancel }) {
  const [text, setText] = useState(defaultText || '');
  const [generating, setGenerating] = useState(false);
  const canvasRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawTextImage(canvas.getContext('2d'), text || 'Sans titre');
  }, [text]);

  async function handleGenerate() {
    if (generating) return;
    setGenerating(true);
    try {
      const path = await generateTextImage(text || 'Sans titre');
      onConfirm(path);
    } finally {
      setGenerating(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleGenerate();
    if (e.key === 'Escape') onCancel();
  }

  return createPortal(
    <div style={OVERLAY_STYLE} onClick={onCancel}>
      <div className="text-img-box" onClick={e => e.stopPropagation()}>
        <div className="text-img-header">Générer une image-titre</div>
        <div className="text-img-body">
          <input
            ref={inputRef}
            className="field-input text-img-input"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Texte à afficher"
            maxLength={200}
          />
          <canvas
            ref={canvasRef}
            width={TEXT_IMG_W}
            height={TEXT_IMG_H}
            className="text-img-preview"
          />
        </div>
        <div className="text-img-footer">
          <Button variant="ghost" onClick={onCancel}>Annuler</Button>
          <Button variant="primary-violet" onClick={handleGenerate} disabled={generating}>
            {generating ? 'Génération…' : 'Générer'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
