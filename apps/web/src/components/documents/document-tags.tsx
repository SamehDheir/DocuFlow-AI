'use client';

import { useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TagInput } from '@/components/ui/tag-input';
import { useToast } from '@/components/ui/toast';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { cn } from '@/lib/cn';
import type { DocumentTag } from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { createTag, listTags, setDocumentTags, type TagListItem } from '@/lib/tags';

/** The API's cap on tags per document, mirrored so the picker stops before the 400. */
const MAX_TAGS = 20;

/**
 * `Tag.color` holds a design-token name, never a hex.
 *
 * Anything unrecognised — including null, which is what an uncoloured tag
 * stores — falls back to neutral rather than throwing. A colour the palette has
 * since dropped should make a chip plain, not break the page.
 */
export function toneOf(color: string | null | undefined): BadgeTone {
  return color === 'accent' || color === 'success' || color === 'warning' || color === 'danger'
    ? color
    : 'neutral';
}

/**
 * A document's labels, rendered.
 *
 * Shared by the list row and the detail aside so the same tag is the same
 * colour in both. `max` truncates with a count rather than wrapping: a row is
 * one line tall, and five chips on a document called "Q3 budget" would push the
 * name out of the layout that makes the list scannable.
 */
export function TagChips({
  tags,
  max,
  onSelect,
  className,
}: {
  tags: DocumentTag[];
  max?: number;
  /** Makes each chip a filter control. Omitted, they are plain labels. */
  onSelect?: (tag: DocumentTag) => void;
  className?: string;
}) {
  if (tags.length === 0) {
    return null;
  }

  const shown = max === undefined ? tags : tags.slice(0, max);
  const hidden = tags.length - shown.length;

  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {shown.map((tag) =>
        onSelect ? (
          <button
            key={tag.id}
            type="button"
            onClick={() => onSelect(tag)}
            className="focus-visible:outline-focus rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Badge tone={toneOf(tag.color)}>{tag.name}</Badge>
          </button>
        ) : (
          <Badge key={tag.id} tone={toneOf(tag.color)}>
            {tag.name}
          </Badge>
        ),
      )}

      {hidden > 0 ? (
        // Titled with the names it stands for, so the count is not a dead end
        // for anyone who cannot open the document to find out.
        <span
          className="text-text-subtle text-2xs tabular-nums"
          title={tags
            .slice(shown.length)
            .map((tag) => tag.name)
            .join(', ')}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The tag editor on the detail page.
 *
 * Read first, then edit — deliberately not a live picker that saves on every
 * keystroke. `PUT /documents/:id/tags` replaces the whole set, and whole-set
 * semantics are only safe when the form has shown what is already there; a
 * picker firing a request per chip would also let two rapid changes land out of
 * order and settle on the earlier one.
 *
 * The vocabulary is fetched when editing starts rather than on mount. Most
 * visits to a document never touch its tags, and `GET /tags` is a request whose
 * only purpose is to fill a list nobody has opened.
 */
export function DocumentTagsPanel({
  documentId,
  tags,
  canEdit,
  canCreate,
  archived,
  onChange,
  t,
  errors,
  common,
}: {
  documentId: string;
  tags: DocumentTag[];
  /** `documents.update`. Labelling a document is ordinary document work. */
  canEdit: boolean;
  /** `tags.manage`. Inventing a label the whole company then sees is the privileged half. */
  canCreate: boolean;
  archived: boolean;
  onChange: (tags: DocumentTag[]) => void;
  t: Dictionary['tags'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { withToken } = useSession();
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [vocabulary, setVocabulary] = useState<TagListItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    setLoading(true);

    try {
      const all = await withToken(listTags);

      setVocabulary(all);
      setSelected(tags.map((tag) => tag.id));
      setEditing(true);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);

    try {
      const saved = await withToken((token) => setDocumentTags(token, documentId, selected));

      onChange(saved);
      setEditing(false);
      toast.success(t.saved);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Creates a tag and hands it straight back to the picker, so inventing a label
   * and applying it is one gesture rather than a trip to a settings screen.
   *
   * The new tag is folded into the local vocabulary too — otherwise the chip
   * would render as an id the picker cannot resolve to a name.
   */
  const create = async (name: string) => {
    try {
      const created = await withToken((token) => createTag(token, { name }));

      setVocabulary((current) =>
        [...current, { ...created, createdAt: new Date().toISOString(), documentCount: 0 }].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );

      return created;
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
      return null;
    }
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-3">
        <TagInput
          options={vocabulary}
          value={selected}
          onChange={setSelected}
          label={t.label}
          placeholder={t.placeholder}
          hint={canCreate ? t.createHint : undefined}
          allowCreate={canCreate}
          onCreate={create}
          max={MAX_TAGS}
          labels={{
            remove: t.remove,
            create: t.create,
            empty: t.noMatches,
            full: interpolate(t.full, { count: MAX_TAGS }),
          }}
        />

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            {t.cancel}
          </Button>
          <Button size="sm" loading={saving} onClick={() => void save()}>
            {t.save}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {tags.length > 0 ? (
        <TagChips tags={tags} />
      ) : (
        <p className="text-text-subtle text-xs">{t.none}</p>
      )}

      {canEdit ? (
        archived ? (
          // Said rather than hidden. A button that silently disappears when a
          // document is archived reads as a permission problem; the archive
          // notice at the top of the page explains the rest.
          <p className="text-text-subtle text-xs">{t.frozen}</p>
        ) : (
          <div>
            <Button variant="ghost" size="sm" loading={loading} onClick={() => void open()}>
              {tags.length > 0 ? t.edit : t.add}
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}
