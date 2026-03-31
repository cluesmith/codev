import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { TipBanner } from '../src/components/TipBanner.js';
import { tips } from '../src/lib/tips.js';

// localStorage mock for jsdom
const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (index: number) => [...storageMap.keys()][index] ?? null,
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  storageMap.clear();
});

describe('TipBanner', () => {
  describe('daily rotation', () => {
    it('shows the correct tip for a given day', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 1)); // March 1, 2026 = day 60
      const expectedIndex = 60 % tips.length;
      const expectedText = tips[expectedIndex].replace(/`/g, '');

      render(<TipBanner />);

      const banner = screen.getByText('Tip:').closest('.tip-banner');
      // Strip all text and verify expected tip content appears
      expect(banner?.textContent).toContain(expectedText);

      vi.useRealTimers();
    });

    it('shows a different tip on a different day', () => {
      vi.useFakeTimers();

      // Day 1: Jan 2 (day 2)
      vi.setSystemTime(new Date(2026, 0, 2));
      const { unmount: unmount1 } = render(<TipBanner />);
      const text1 = screen.getByText('Tip:').parentElement?.textContent;
      unmount1();

      // Day 2: Jan 3 (day 3)
      vi.setSystemTime(new Date(2026, 0, 3));
      render(<TipBanner />);
      const text2 = screen.getByText('Tip:').parentElement?.textContent;

      expect(text1).not.toBe(text2);

      vi.useRealTimers();
    });
  });

  describe('code span rendering', () => {
    it('renders backtick-delimited text as code elements', () => {
      vi.useFakeTimers();
      // tips[0] contains backtick code spans — navigate to it
      // dayOfYear(date) % tips.length === 0 when dayOfYear = tips.length
      vi.setSystemTime(new Date(2026, 0, tips.length));

      render(<TipBanner />);
      const banner = screen.getByText('Tip:').closest('.tip-banner');
      const codeElements = banner?.querySelectorAll('code');

      // tips[0] has backtick code — verify code elements are rendered
      expect(codeElements!.length).toBeGreaterThan(0);
      // Verify the code content matches the backtick-delimited text
      const firstCodeText = codeElements![0].textContent;
      expect(firstCodeText).toBeTruthy();

      vi.useRealTimers();
    });

    it('renders the correct code text from backtick-delimited spans', () => {
      vi.useFakeTimers();
      // tips[0] is: Use `afx spawn --task "description"` for quick one-off tasks...
      // It has two code spans: "afx spawn --task \"description\""
      vi.setSystemTime(new Date(2026, 0, tips.length)); // day = tips.length → index 0

      render(<TipBanner />);
      const banner = screen.getByText('Tip:').closest('.tip-banner');
      const codeElements = banner?.querySelectorAll('code');

      expect(codeElements!.length).toBeGreaterThan(0);
      // Verify the code text matches what's between backticks in tips[0]
      const backtickContent = tips[0].match(/`([^`]+)`/);
      expect(backtickContent).toBeTruthy();
      expect(codeElements![0].textContent).toBe(backtickContent![1]);

      vi.useRealTimers();
    });
  });

  describe('arrow navigation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1)); // Jan 1
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('navigates to the next tip when clicking right arrow', () => {
      render(<TipBanner />);
      const initialText = screen.getByText('Tip:').parentElement?.textContent;

      fireEvent.click(screen.getByLabelText('Next tip'));
      const nextText = screen.getByText('Tip:').parentElement?.textContent;

      expect(nextText).not.toBe(initialText);
    });

    it('navigates to the previous tip when clicking left arrow', () => {
      render(<TipBanner />);
      const initialText = screen.getByText('Tip:').parentElement?.textContent;

      fireEvent.click(screen.getByLabelText('Previous tip'));
      const prevText = screen.getByText('Tip:').parentElement?.textContent;

      expect(prevText).not.toBe(initialText);
    });

    it('wraps around when navigating past the last tip', () => {
      render(<TipBanner />);

      // Click next tips.length times — should wrap back to the daily tip
      for (let i = 0; i < tips.length; i++) {
        fireEvent.click(screen.getByLabelText('Next tip'));
      }

      const wrappedText = screen.getByText('Tip:').parentElement?.textContent;
      // Re-render to get fresh daily tip for comparison
      cleanup();
      render(<TipBanner />);
      const dailyText = screen.getByText('Tip:').parentElement?.textContent;

      expect(wrappedText).toBe(dailyText);
    });

    it('wraps around when navigating before the first tip', () => {
      render(<TipBanner />);

      // Click prev tips.length times — should wrap back to the daily tip
      for (let i = 0; i < tips.length; i++) {
        fireEvent.click(screen.getByLabelText('Previous tip'));
      }

      const wrappedText = screen.getByText('Tip:').parentElement?.textContent;
      cleanup();
      render(<TipBanner />);
      const dailyText = screen.getByText('Tip:').parentElement?.textContent;

      expect(wrappedText).toBe(dailyText);
    });
  });

  describe('dismiss behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 15)); // June 15
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('hides the banner when dismiss is clicked', () => {
      render(<TipBanner />);
      expect(screen.getByText('Tip:')).toBeTruthy();

      fireEvent.click(screen.getByLabelText('Dismiss tip'));

      expect(screen.queryByText('Tip:')).toBeNull();
    });

    it('writes dismiss key to localStorage', () => {
      render(<TipBanner />);
      fireEvent.click(screen.getByLabelText('Dismiss tip'));

      expect(localStorage.getItem('tip-dismissed-2026-06-15')).toBe('1');
    });
  });

  describe('dismiss persistence', () => {
    it('does not render when today dismiss key exists in localStorage', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 15));
      localStorage.setItem('tip-dismissed-2026-06-15', '1');

      render(<TipBanner />);

      expect(screen.queryByText('Tip:')).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('next-day reappearance', () => {
    it('renders when only yesterday dismiss key exists', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 5, 16)); // June 16
      localStorage.setItem('tip-dismissed-2026-06-15', '1'); // Yesterday

      render(<TipBanner />);

      expect(screen.getByText('Tip:')).toBeTruthy();
      vi.useRealTimers();
    });
  });

  describe('ephemeral navigation reset', () => {
    it('resets to daily tip on re-mount', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1));

      // First render — get daily tip text
      const { unmount } = render(<TipBanner />);
      const dailyText = screen.getByText('Tip:').parentElement?.textContent;

      // Navigate away from daily tip
      fireEvent.click(screen.getByLabelText('Next tip'));
      const navigatedText = screen.getByText('Tip:').parentElement?.textContent;
      expect(navigatedText).not.toBe(dailyText);

      // Unmount and re-mount — simulates page reload
      unmount();
      render(<TipBanner />);
      const resetText = screen.getByText('Tip:').parentElement?.textContent;

      expect(resetText).toBe(dailyText);
      vi.useRealTimers();
    });
  });

  describe('tip content', () => {
    it('has at least 48 tips', () => {
      expect(tips.length).toBeGreaterThanOrEqual(48);
    });
  });
});
