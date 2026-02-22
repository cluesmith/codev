import { useState, useRef, useCallback } from 'react';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultSplit?: number; // percentage, default 50
  collapsedPane?: 'left' | 'right' | null;
}

export function SplitPane({ left, right, defaultSplit = 50, collapsedPane = null }: SplitPaneProps) {
  const [split, setSplit] = useState(defaultSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplit(Math.max(20, Math.min(80, pct)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  const isLeftCollapsed = collapsedPane === 'left';
  const isRightCollapsed = collapsedPane === 'right';

  return (
    <div ref={containerRef} className="split-pane">
      <div
        className="split-left"
        style={{
          width: isLeftCollapsed ? 0 : isRightCollapsed ? '100%' : `${split}%`,
          display: isLeftCollapsed ? 'none' : undefined,
        }}
      >
        {left}
      </div>
      {!collapsedPane && (
        <div className="split-handle" onMouseDown={onMouseDown} role="separator" aria-label="Resize panels" />
      )}
      <div
        className="split-right"
        style={{
          width: isRightCollapsed ? 0 : isLeftCollapsed ? '100%' : `${100 - split}%`,
          display: isRightCollapsed ? 'none' : undefined,
        }}
      >
        {right}
      </div>
    </div>
  );
}
