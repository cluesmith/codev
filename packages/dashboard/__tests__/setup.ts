import '@testing-library/jest-dom/vitest';

// Bugfix #472: Stub EventSource for hooks that use SSE (useSSE.ts)
// jsdom does not provide EventSource, so we supply a minimal no-op stub.
class EventSourceStub {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  readyState = 0;
  close(): void { /* no-op */ }
}
Object.defineProperty(window, 'EventSource', { writable: true, configurable: true, value: EventSourceStub });

// Mock window.matchMedia for components that use useMediaQuery (e.g., Terminal)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
