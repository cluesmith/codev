import { useState, type ReactNode } from 'react';
import { tips } from '../lib/tips.js';

function getDayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / 86400000);
}

function getLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `tip-dismissed-${y}-${m}-${d}`;
}

function isDismissedToday(): boolean {
  try {
    return localStorage.getItem(getLocalDateKey(new Date())) === '1';
  } catch {
    return false;
  }
}

function dismissToday(): void {
  try {
    localStorage.setItem(getLocalDateKey(new Date()), '1');
  } catch {
    // Private browsing or storage full — ignore
  }
}

/** Parse backtick-delimited code spans into React nodes. */
function renderTipText(text: string): ReactNode[] {
  const parts = text.split('`');
  return parts.map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
  );
}

export function TipBanner() {
  const dailyIndex = getDayOfYear(new Date()) % tips.length;
  const [tipIndex, setTipIndex] = useState(dailyIndex);
  const [dismissed, setDismissed] = useState(isDismissedToday);

  if (dismissed || tips.length === 0) {
    return null;
  }

  const handlePrev = () => {
    setTipIndex((tipIndex - 1 + tips.length) % tips.length);
  };

  const handleNext = () => {
    setTipIndex((tipIndex + 1) % tips.length);
  };

  const handleDismiss = () => {
    dismissToday();
    setDismissed(true);
  };

  return (
    <div className="tip-banner">
      <button className="tip-banner-nav" onClick={handlePrev} aria-label="Previous tip">‹</button>
      <span className="tip-banner-label">Tip:</span>
      <span className="tip-banner-text">{renderTipText(tips[tipIndex])}</span>
      <button className="tip-banner-nav" onClick={handleNext} aria-label="Next tip">›</button>
      <button className="tip-banner-dismiss" onClick={handleDismiss} aria-label="Dismiss tip">×</button>
    </div>
  );
}
