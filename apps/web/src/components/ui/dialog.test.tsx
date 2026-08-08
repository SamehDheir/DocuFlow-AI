import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './dialog';

/**
 * The focus trap, and the regression that made it eat keystrokes.
 *
 * `useModalBehavior` is shared by Dialog and Drawer, so a fault in it is a fault
 * in every overlay in the app at once — which is exactly what happened: the
 * setup effect depended on `onClose`, callers pass an inline arrow, and so every
 * render of the owning component tore the trap down and built it again,
 * re-focusing the panel's first control on the way through.
 */

/** A dialog with two fields, owned by a parent that re-renders as you type. */
function TwoFieldDialog({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');

  return (
    <Dialog
      open
      // Inline, on purpose. This is what every call site in the app does, and
      // recreating it per render is the condition the bug needed.
      onClose={() => onClose()}
      title="Add a version"
    >
      <input aria-label="File" value={first} onChange={(event) => setFirst(event.target.value)} />
      <input aria-label="Note" value={second} onChange={(event) => setSecond(event.target.value)} />
    </Dialog>
  );
}

describe('Dialog focus', () => {
  it('lands on the first control when it opens', () => {
    render(<TwoFieldDialog />);

    expect(screen.getByLabelText('File')).toHaveFocus();
  });

  /**
   * THE REGRESSION. Typing one character into the second field threw focus back
   * to the first, so the rest of the word went into the wrong input — reported
   * on the "upload new version" dialog, where the note field sits under a file
   * picker.
   */
  it('stays in the field being typed into, across re-renders', async () => {
    const user = userEvent.setup();
    render(<TwoFieldDialog />);

    const note = screen.getByLabelText('Note');
    await user.click(note);
    await user.type(note, 'fixed a typo');

    expect(note).toHaveFocus();
    expect(note).toHaveValue('fixed a typo');
    expect(screen.getByLabelText('File')).toHaveValue('');
  });

  it('still closes on Escape, with the latest handler', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<TwoFieldDialog onClose={onClose} />);

    // After a re-render, so the ref has been through at least one update — a
    // stale captured handler would show up here as a call count of zero.
    await user.type(screen.getByLabelText('Note'), 'x');
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab at the end of the panel rather than letting focus escape', async () => {
    const user = userEvent.setup();
    render(<TwoFieldDialog />);

    // File → Note → wraps back, rather than reaching the document behind.
    await user.tab();
    expect(screen.getByLabelText('Note')).toHaveFocus();

    await user.tab();
    expect(screen.getByLabelText('File')).toHaveFocus();
  });
});
