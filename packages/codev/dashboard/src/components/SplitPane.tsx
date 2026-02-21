import { useState, useRef, useCallback } from 'react';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultSplit?: number; // percentage, default 50
}

export function SplitPane({ left, right, defaultSplit = 50 }: SplitPaneProps) {
  const [split, setSplit] = useState(defaultSplit);
  const [collapsedPane, setCollapsedPane] = useState<'left' | 'right' | null>(null);
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
      {isLeftCollapsed && (
        <button
          className="split-expand-bar"
          onClick={() => setCollapsedPane(null)}
          title="Expand architect panel"
          aria-label="Expand architect panel"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <div
        className="split-left"
        style={{
          width: isLeftCollapsed ? 0 : isRightCollapsed ? '100%' : `${split}%`,
          display: isLeftCollapsed ? 'none' : undefined,
        }}
      >
        {left}
        {!collapsedPane && (
          <button
            className="split-collapse-btn split-collapse-btn--left"
            onClick={() => setCollapsedPane('left')}
            title="Collapse architect panel"
            aria-label="Collapse architect panel"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M7 1L3 5l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
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
        {!collapsedPane && (
          <button
            className="split-collapse-btn split-collapse-btn--right"
            onClick={() => setCollapsedPane('right')}
            title="Collapse work panel"
            aria-label="Collapse work panel"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      {isRightCollapsed && (
        <button
          className="split-expand-bar"
          onClick={() => setCollapsedPane(null)}
          title="Expand work panel"
          aria-label="Expand work panel"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M7 1L3 5l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
