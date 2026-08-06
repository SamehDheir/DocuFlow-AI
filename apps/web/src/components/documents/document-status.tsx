'use client';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import type { Dictionary } from '@/i18n/get-dictionary';
import type { DocumentStatus, ProcessingStage } from '@/lib/documents';

/**
 * The processing state of one document, as a chip.
 *
 * Shared by the list, the preview and the search results so a document reads
 * the same wherever it appears — three separate renderings of the same enum is
 * how a status ends up meaning different things on different screens.
 *
 * READY is shown as nothing at all. It is the resting state of almost every row,
 * and a badge on all of them would be noise that makes the handful of rows
 * genuinely in flight harder to spot, not easier.
 */
const TONES: Partial<Record<DocumentStatus, BadgeTone>> = {
  UPLOADING: 'accent',
  PROCESSING: 'accent',
  OCR: 'accent',
  AI_ANALYSIS: 'accent',
  ARCHIVED: 'neutral',
  DELETED: 'neutral',
  CREATED: 'neutral',
  UPLOADED: 'neutral',
};

/** Statuses whose dot breathes, because the state is still changing. */
const ACTIVE: ReadonlySet<DocumentStatus> = new Set<DocumentStatus>([
  'UPLOADING',
  'PROCESSING',
  'OCR',
  'AI_ANALYSIS',
]);

export function DocumentStatusBadge({
  status,
  ocrStatus,
  aiStatus,
  ocrError,
  aiError,
  t,
  className,
}: {
  status: DocumentStatus;
  ocrStatus?: ProcessingStage | null;
  aiStatus?: ProcessingStage | null;
  ocrError?: string | null;
  aiError?: string | null;
  t: Dictionary['documents'];
  className?: string;
}) {
  /**
   * A finished document whose analysis failed still reads READY — the file is
   * intact and downloadable, which is the point of not failing the whole
   * document over a summariser timeout. But the failure has to be visible
   * somewhere, so it takes over the badge that READY would have suppressed.
   */
  if (status === 'READY') {
    const failed = ocrStatus === 'FAILED' || aiStatus === 'FAILED';

    if (!failed) {
      return null;
    }

    return (
      <Badge tone="danger" dot className={className} title={ocrError ?? aiError ?? undefined}>
        {ocrStatus === 'FAILED' ? t.processing.failedText : t.processing.failedSummary}
      </Badge>
    );
  }

  const tone = TONES[status] ?? 'neutral';

  return (
    <Badge tone={tone} pulse={ACTIVE.has(status)} className={className}>
      {t.status[status as keyof typeof t.status] ?? status}
    </Badge>
  );
}
