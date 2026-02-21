import { describe, it, expect, afterEach } from 'vitest';
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

  it('renders collapse buttons for both panes', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    expect(screen.getByTitle('Collapse architect panel')).toBeTruthy();
    expect(screen.getByTitle('Collapse work panel')).toBeTruthy();
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

  it('collapses left pane when collapse architect button clicked', () => {
    const { container } = render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />,
    );
    fireEvent.click(screen.getByTitle('Collapse architect panel'));

    // Left pane should be hidden (display: none)
    const leftPane = container.querySelector('.split-left') as HTMLElement;
    expect(leftPane.style.display).toBe('none');

    // Right pane should be full width
    const rightPane = container.querySelector('.split-right') as HTMLElement;
    expect(rightPane.style.width).toBe('100%');

    // Expand bar should appear
    expect(screen.getByTitle('Expand architect panel')).toBeTruthy();

    // Resize handle should be hidden
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('collapses right pane when collapse work button clicked', () => {
    const { container } = render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />,
    );
    fireEvent.click(screen.getByTitle('Collapse work panel'));

    // Right pane should be hidden
    const rightPane = container.querySelector('.split-right') as HTMLElement;
    expect(rightPane.style.display).toBe('none');

    // Left pane should be full width
    const leftPane = container.querySelector('.split-left') as HTMLElement;
    expect(leftPane.style.width).toBe('100%');

    // Expand bar should appear
    expect(screen.getByTitle('Expand work panel')).toBeTruthy();

    // Resize handle should be hidden
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('restores split layout when expand bar clicked after left collapse', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    // Collapse left
    fireEvent.click(screen.getByTitle('Collapse architect panel'));
    expect(screen.getByTitle('Expand architect panel')).toBeTruthy();

    // Expand
    fireEvent.click(screen.getByTitle('Expand architect panel'));

    // Both collapse buttons should be back
    expect(screen.getByTitle('Collapse architect panel')).toBeTruthy();
    expect(screen.getByTitle('Collapse work panel')).toBeTruthy();

    // Resize handle should be back
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('restores split layout when expand bar clicked after right collapse', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    // Collapse right
    fireEvent.click(screen.getByTitle('Collapse work panel'));
    expect(screen.getByTitle('Expand work panel')).toBeTruthy();

    // Expand
    fireEvent.click(screen.getByTitle('Expand work panel'));

    // Both collapse buttons should be back
    expect(screen.getByTitle('Collapse architect panel')).toBeTruthy();
    expect(screen.getByTitle('Collapse work panel')).toBeTruthy();
  });

  it('preserves split percentage after collapse/expand cycle', () => {
    const { container } = render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
        defaultSplit={60}
      />,
    );

    // Verify initial split
    const leftPane = container.querySelector('.split-left') as HTMLElement;
    expect(leftPane.style.width).toBe('60%');

    // Collapse and expand
    fireEvent.click(screen.getByTitle('Collapse architect panel'));
    fireEvent.click(screen.getByTitle('Expand architect panel'));

    // Split percentage should be preserved
    const leftPaneAfter = container.querySelector('.split-left') as HTMLElement;
    expect(leftPaneAfter.style.width).toBe('60%');
  });

  it('has proper aria labels on collapse/expand buttons', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    expect(screen.getByLabelText('Collapse architect panel')).toBeTruthy();
    expect(screen.getByLabelText('Collapse work panel')).toBeTruthy();
  });

  it('has proper aria label on expand bar', () => {
    render(
      <SplitPane
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    fireEvent.click(screen.getByTitle('Collapse architect panel'));
    expect(screen.getByLabelText('Expand architect panel')).toBeTruthy();
  });
});
