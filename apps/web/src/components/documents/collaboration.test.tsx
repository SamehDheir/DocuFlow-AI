import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import en from '@/i18n/dictionaries/en.json';
import { BulkBar } from './bulk-bar';
import { TagChips } from './document-tags';

/**
 * The two collaboration pieces that carry decisions rather than layout.
 *
 * Both render from real dictionary entries rather than fixtures, so a key
 * renamed out from under them fails here as well as in `dictionaries.test.ts` —
 * and an interpolation placeholder that never gets substituted shows up as the
 * literal `{count}` in an assertion instead of passing quietly.
 */

const bulk = en.bulk as never as Parameters<typeof BulkBar>[0]['t'];
const errors = en.errors as never as Parameters<typeof BulkBar>[0]['errors'];
const common = en.common as never as Parameters<typeof BulkBar>[0]['common'];

const TAGS = [
  { id: '1', name: 'Urgent', color: 'danger' },
  { id: '2', name: 'Finance', color: 'accent' },
  { id: '3', name: 'Q3', color: null },
  { id: '4', name: 'Reviewed', color: 'success' },
];

describe('TagChips', () => {
  it('renders every tag when there is no cap', () => {
    render(<TagChips tags={TAGS} />);

    for (const tag of TAGS) {
      expect(screen.getByText(tag.name)).toBeInTheDocument();
    }
  });

  /**
   * A list row is one line tall. Five chips on a document called "Q3 budget"
   * push the name out of the layout that makes the list scannable, which is why
   * the row passes `max={3}`.
   */
  it('truncates to the cap and counts the rest', () => {
    render(<TagChips tags={TAGS} max={2} />);

    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.queryByText('Q3')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  /** The count is not a dead end: what it stands for is on the element. */
  it('names the hidden tags in the overflow title', () => {
    render(<TagChips tags={TAGS} max={2} />);

    expect(screen.getByText('+2')).toHaveAttribute('title', 'Q3, Reviewed');
  });

  it('is plain text until a select handler makes the chips filters', async () => {
    const { rerender } = render(<TagChips tags={TAGS} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    const onSelect = vi.fn();
    rerender(<TagChips tags={TAGS} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole('button', { name: 'Urgent' }));
    expect(onSelect).toHaveBeenCalledWith(TAGS[0]);
  });

  it('renders nothing at all rather than an empty box', () => {
    const { container } = render(<TagChips tags={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('BulkBar', () => {
  const props = {
    actions: [{ key: 'archive', label: 'Archive', onSelect: vi.fn() }],
    onDismiss: vi.fn(),
    onClear: vi.fn(),
    t: bulk,
    errors,
    common,
  };

  it('stays out of the way until something is selected', () => {
    const { container } = render(<BulkBar {...props} count={0} outcome={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('announces the count, using the singular for one', () => {
    const { rerender } = render(<BulkBar {...props} count={1} outcome={null} />);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    rerender(<BulkBar {...props} count={7} outcome={null} />);
    expect(screen.getByText('7 selected')).toBeInTheDocument();
  });

  /**
   * Two batches over one selection would report two outcomes into the same
   * panel and race over the rows, so the other buttons go inert while one runs —
   * but the running one keeps its own loading state rather than being disabled
   * out from under the spinner.
   */
  it('locks the other actions while one is running', () => {
    render(
      <BulkBar
        {...props}
        count={3}
        busy="archive"
        outcome={null}
        actions={[
          { key: 'archive', label: 'Archive', onSelect: vi.fn() },
          { key: 'delete', label: 'Delete', onSelect: vi.fn() },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  /**
   * THE POINT OF THE PANEL. The API returns 200 with a per-id report either way,
   * and dropping the detail to fit one line is how a user ends up believing all
   * fifty went through.
   */
  it('groups skips by reason rather than listing ids', () => {
    render(
      <BulkBar
        {...props}
        count={0}
        outcome={{
          action: 'archive',
          result: {
            requested: 5,
            succeeded: ['a', 'b', 'c'],
            skipped: [
              { id: 'd', code: 'DOCUMENT_ALREADY_ARCHIVED' },
              { id: 'e', code: 'DOCUMENT_ALREADY_ARCHIVED' },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText('3 done, 2 skipped')).toBeInTheDocument();

    const reason = screen.getByRole('listitem');
    expect(reason).toHaveTextContent('2');
    expect(reason).toHaveTextContent(en.errors.DOCUMENT_ALREADY_ARCHIVED);
    // Grouped, so one line stands for both ids rather than one line each.
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  /**
   * A batch clears what it acted on, so gating the whole bar on `count > 0`
   * would take the report away in the same frame it arrived.
   */
  it('keeps the report after the selection it describes is gone', () => {
    render(
      <BulkBar
        {...props}
        count={0}
        outcome={{
          action: 'delete',
          result: { requested: 2, succeeded: ['a', 'b'], skipped: [] },
        }}
      />,
    );

    expect(screen.getByText('2 of 2 done')).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
  });

  it('reports a partial result politely rather than as an alert', () => {
    render(
      <BulkBar
        {...props}
        count={0}
        outcome={{
          action: 'archive',
          result: { requested: 1, succeeded: [], skipped: [{ id: 'a', code: 'NOPE' }] },
        }}
      />,
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
