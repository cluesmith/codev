import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SplitPane } from '../src/components/SplitPane.js';

afterEach(cleanup);

describe('SplitPane', () => {
  it('renders both panes in split mode', () => {
    render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />,
    );
    expect(screen.getByTestId('left')).toBeTruthy();
    expect(screen.getByTestId('right')).toBeTruthy();
  });

  it('renders resize handle in split mode', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('hides left pane and shows expand bar when left collapsed', () => {
    const onExpandLeft = vi.fn();
    const { container } = render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
        collapsedPane="left"
        onExpandLeft={onExpandLeft}
      />,
    );

    // Left pane hidden
    const leftPane = container.querySelector('.split-left') as HTMLElement;
    expect(leftPane.style.display).toBe('none');

    // Right pane fills remaining space (flex: 1 alongside 24px expand bar)
    const rightPane = container.querySelector('.split-right') as HTMLElement;
    expect(rightPane.style.flex).toContain('1');

    // Full-height expand bar on left edge
    const expandBar = screen.getByTitle('Expand architect panel');
    expect(expandBar).toBeTruthy();
    expect(expandBar.classList.contains('expand-bar-left')).toBe(true);

    // No resize handle
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('hides right pane and shows expand bar when right collapsed', () => {
    const onExpandRight = vi.fn();
    const { container } = render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
        collapsedPane="right"
        onExpandRight={onExpandRight}
      />,
    );

    // Right pane hidden
    const rightPane = container.querySelector('.split-right') as HTMLElement;
    expect(rightPane.style.display).toBe('none');

    // Left pane fills remaining space (flex: 1 alongside 24px expand bar)
    const leftPane = container.querySelector('.split-left') as HTMLElement;
    expect(leftPane.style.flex).toContain('1');

    // Full-height expand bar on right edge
    const expandBar = screen.getByTitle('Expand work panel');
    expect(expandBar).toBeTruthy();
    expect(expandBar.classList.contains('expand-bar-right')).toBe(true);

    // No resize handle
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('calls onExpandLeft when left expand bar clicked', () => {
    const onExpandLeft = vi.fn();
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        collapsedPane="left"
        onExpandLeft={onExpandLeft}
      />,
    );

    fireEvent.click(screen.getByTitle('Expand architect panel'));
    expect(onExpandLeft).toHaveBeenCalledOnce();
  });

  it('calls onExpandRight when right expand bar clicked', () => {
    const onExpandRight = vi.fn();
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        collapsedPane="right"
        onExpandRight={onExpandRight}
      />,
    );

    fireEvent.click(screen.getByTitle('Expand work panel'));
    expect(onExpandRight).toHaveBeenCalledOnce();
  });

  it('does not show expand bars when no pane is collapsed', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        onExpandLeft={() => {}}
        onExpandRight={() => {}}
      />,
    );

    expect(screen.queryByTitle('Expand architect panel')).toBeNull();
    expect(screen.queryByTitle('Expand work panel')).toBeNull();
  });

  it('preserves split percentage after collapse/expand cycle', () => {
    const { container } = render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        defaultSplit={60}
      />,
    );

    const leftPane = container.querySelector('.split-left') as HTMLElement;
    expect(leftPane.style.width).toBe('60%');
  });

  it('has proper aria labels on expand bars', () => {
    const { rerender } = render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        collapsedPane="left"
        onExpandLeft={() => {}}
      />,
    );
    expect(screen.getByLabelText('Expand architect panel')).toBeTruthy();

    rerender(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        collapsedPane="right"
        onExpandRight={() => {}}
      />,
    );
    expect(screen.getByLabelText('Expand work panel')).toBeTruthy();
  });
});
