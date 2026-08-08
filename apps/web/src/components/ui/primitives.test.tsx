import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Avatar, initialsOf } from './avatar';
import { Checkbox } from './checkbox';
import { TableHeaderCell, Table, TableHead, TableRow } from './table';
import { TagInput, type TagOption } from './tag-input';
import { Tooltip } from './tooltip';

/**
 * The primitives, tested where they carry behaviour rather than looks.
 *
 * Nothing here asserts a class name. Which utilities a component emits is not a
 * contract — the token layer is free to move — but "the mixed checkbox reports
 * mixed" and "the tag list can be driven from the keyboard" are, and both are
 * the kind of thing that breaks silently.
 */

describe('initialsOf', () => {
  it('takes the first character of each name', () => {
    expect(initialsOf('Ada', 'Lovelace')).toBe('AL');
  });

  /**
   * The bug this helper exists to fix. Two of the three call sites it replaced
   * used `slice(0, 1)` / `charAt(0)`, which cuts a surrogate pair in half and
   * renders the tombstone glyph.
   */
  it('keeps an astral character intact rather than splitting the pair', () => {
    const initials = initialsOf('𝒜da', 'Lovelace');

    expect([...initials]).toHaveLength(2);
    expect(initials.startsWith('𝒜')).toBe(true);
  });

  it('handles Arabic, which has no case to upper', () => {
    expect(initialsOf('سامح', 'ضهير')).toBe('سض');
  });

  it('falls back when there is no name at all', () => {
    expect(initialsOf(null, undefined, 'System')).toBe('S');
    expect(initialsOf('', '')).toBe('?');
  });
});

describe('Avatar', () => {
  it('is hidden from assistive tech unless it stands alone', () => {
    const { rerender } = render(<Avatar firstName="Ada" lastName="Lovelace" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    rerender(<Avatar firstName="Ada" lastName="Lovelace" label="Account" />);
    expect(screen.getByRole('img', { name: 'Account' })).toBeInTheDocument();
  });
});

describe('Checkbox', () => {
  /**
   * `indeterminate` is a DOM property with no HTML attribute, so React will not
   * render it — it has to be assigned to the node. A "select all" box showing a
   * tick when three of fifty rows are selected is a lie the user acts on.
   */
  it('reports the mixed state to assistive tech', () => {
    const { rerender } = render(
      <Checkbox label="Select all" indeterminate checked={false} onChange={() => {}} />,
    );

    const box = screen.getByRole('checkbox', { name: 'Select all' });
    expect(box).toBePartiallyChecked();

    rerender(<Checkbox label="Select all" indeterminate={false} checked onChange={() => {}} />);
    expect(box).not.toBePartiallyChecked();
    expect(box).toBeChecked();
  });

  it('toggles from the keyboard, because it is a real input', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<Checkbox label="Archive" checked={false} onChange={onChange} />);

    await user.tab();
    await user.keyboard(' ');

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps an accessible name when the label is hidden', () => {
    render(<Checkbox label="Select contract.pdf" hideLabel checked={false} onChange={() => {}} />);

    expect(screen.getByRole('checkbox', { name: 'Select contract.pdf' })).toBeInTheDocument();
  });
});

describe('TableHeaderCell', () => {
  it('announces sort direction on the cell and puts the control in a button', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();

    render(
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell sortable direction="asc" onSort={onSort}>
              Name
            </TableHeaderCell>
            <TableHeaderCell sortable onSort={() => {}}>
              Size
            </TableHeaderCell>
            <TableHeaderCell>Owner</TableHeaderCell>
          </TableRow>
        </TableHead>
      </Table>,
    );

    const [name, size, owner] = screen.getAllByRole('columnheader');
    expect(name).toHaveAttribute('aria-sort', 'ascending');
    expect(size).toHaveAttribute('aria-sort', 'none');
    // A column that cannot be sorted says nothing, rather than claiming "none".
    expect(owner).not.toHaveAttribute('aria-sort');

    await user.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSort).toHaveBeenCalledTimes(1);
  });
});

describe('Tooltip', () => {
  it('describes the trigger only while it is open, and dismisses on Escape', async () => {
    const user = userEvent.setup();

    render(
      <Tooltip content="Text extraction failed">
        <button type="button">Failed</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Failed' });
    expect(trigger).not.toHaveAttribute('aria-describedby');

    // Focus opens it immediately; hover waits, so a sweep across a toolbar does
    // not strobe every tooltip in it.
    await user.tab();
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(/extraction failed/));
    expect(trigger).toHaveAccessibleDescription('Text extraction failed');

    // WCAG 1.4.13 — dismissible without moving the pointer or the focus.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('keeps the trigger its own element, handlers included', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <Tooltip content="Hint">
        <button type="button" onClick={onClick}>
          Act
        </button>
      </Tooltip>,
    );

    await user.click(screen.getByRole('button', { name: 'Act' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

const TAGS: TagOption[] = [
  { id: 'a', name: 'Contracts', color: 'accent' },
  { id: 'b', name: 'Invoices', color: null },
  { id: 'c', name: 'Urgent', color: 'danger' },
];

const LABELS = {
  remove: 'Remove {name}',
  create: 'Create "{name}"',
  empty: 'No matching tags',
  full: 'Tag limit reached',
};

function Harness({
  initial = [],
  ...rest
}: { initial?: string[] } & Partial<React.ComponentProps<typeof TagInput>>) {
  const [value, setValue] = useState<string[]>(initial);

  return (
    <TagInput
      options={TAGS}
      value={value}
      onChange={setValue}
      label="Tags"
      labels={LABELS}
      {...rest}
    />
  );
}

describe('TagInput', () => {
  it('selects with the arrow keys and Enter, without focus leaving the input', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.click(input);

    expect(input).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowDown}{Enter}');

    // Focus staying put is what lets someone keep typing to narrow the list;
    // moving it into the listbox is the usual reason these cannot be keyboarded.
    expect(input).toHaveFocus();
    expect(screen.getByText('Invoices')).toBeInTheDocument();
  });

  it('points at the active option rather than moving focus to it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.click(input);

    const first = screen.getAllByRole('option')[0];
    expect(input).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('filters as you type and hides what is already chosen', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['a']} />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.click(input);

    // Contracts is selected, so it is not offered again.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Invoices',
      'Urgent',
    ]);

    await user.type(input, 'urg');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Urgent']);
  });

  it('removes the last chip on Backspace only when the query is empty', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['a', 'b']} />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.click(input);

    await user.type(input, 'x');
    await user.keyboard('{Backspace}');
    // That Backspace deleted the character, not a tag.
    expect(screen.getByRole('button', { name: 'Remove Invoices' })).toBeInTheDocument();

    await user.keyboard('{Backspace}');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove Invoices' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Remove Contracts' })).toBeInTheDocument();
  });

  it('offers to create only a name the vocabulary does not already hold', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ id: 'new', name: 'Legal' });

    render(<Harness allowCreate onCreate={onCreate} />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    await user.click(input);

    // An exact match must not offer a duplicate.
    await user.type(input, 'Urgent');
    expect(screen.queryByText('Create "Urgent"')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'Legal');
    await user.click(screen.getByText('Create "Legal"'));

    expect(onCreate).toHaveBeenCalledWith('Legal');
  });

  it('stops accepting tags at the cap', async () => {
    const user = userEvent.setup();
    render(<Harness initial={['a', 'b']} max={2} />);

    const input = screen.getByRole('combobox', { name: 'Tags' });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', LABELS.full);

    // Removing one puts the field back in service.
    await user.click(screen.getByRole('button', { name: 'Remove Invoices' }));
    await waitFor(() => expect(input).toBeEnabled());
  });
});
