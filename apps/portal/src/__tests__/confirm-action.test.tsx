// @vitest-environment jsdom
/**
 * ConfirmAction asks on the page, where the button was, instead of with
 * window.confirm: a browser that blocks or auto-dismisses dialogs (a
 * scripted or agent-driven one) answers false, and the action did nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmAction } from '../lib/ConfirmAction.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDelete(props: { onConfirm?: () => void; error?: unknown } = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  render(
    <ConfirmAction prompt="Delete for good?" confirmLabel="Yes, delete" title="It can't be undone." onConfirm={onConfirm} error={props.error}>
      {(ask) => (
        <button type="button" onClick={ask}>
          Delete
        </button>
      )}
    </ConfirmAction>,
  );
  return onConfirm;
}

describe('ConfirmAction', () => {
  it('swaps the button for the question, and Yes runs the action once', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onConfirm = renderDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.getByText('Delete for good?').getAttribute('title')).toBe("It can't be undone.");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('focuses Cancel, not Yes, and Cancel puts the button back with focus', () => {
    const onConfirm = renderDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
  });

  it('cancels on Escape', () => {
    const onConfirm = renderDelete();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows a refusal next to the button', () => {
    renderDelete({ error: new Error('program_in_use: End it instead.') });
    expect(screen.getByRole('alert').textContent).toBe('program_in_use: End it instead.');
  });
});
