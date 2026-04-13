import { useState, useRef, useCallback } from 'react';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultSplit?: number; // percentage, default 50
  collapsedPane?: 'left' | 'right' | null;
  onExpandLeft?: () => void;
  onExpandRight?: () => void;
}

export function SplitPane({ left, right, defaultSplit = 50, collapsedPane = null, onExpandLeft, onExpandRight }: SplitPaneProps) {
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
      {isLeftCollapsed && onExpandLeft && (
        <button
          className="expand-bar expand-bar-left"
          onClick={onExpandLeft}
          title="Expand architect panel"
          aria-label="Expand architect panel"
        >
          <svg width="10" height="24" viewBox="0 0 10 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8l4 4-4 4" />
          </svg>
        </button>
      )}
      <div
        className="split-left"
        style={{
          width: isLeftCollapsed ? 0 : isRightCollapsed ? undefined : `${split}%`,
          flex: isRightCollapsed ? 1 : undefined,
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
          width: isRightCollapsed ? 0 : isLeftCollapsed ? undefined : `${100 - split}%`,
          flex: isLeftCollapsed ? 1 : undefined,
          display: isRightCollapsed ? 'none' : undefined,
        }}
      >
        {right}
      </div>
      {isRightCollapsed && onExpandRight && (
        <button
          className="expand-bar expand-bar-right"
          onClick={onExpandRight}
          title="Expand work panel"
          aria-label="Expand work panel"
        >
          <svg width="10" height="24" viewBox="0 0 10 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 8l-4 4 4 4" />
          </svg>
        </button>
      )}
    </div>
  );
}
