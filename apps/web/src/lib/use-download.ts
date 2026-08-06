'use client';

import { useCallback } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { useToast } from '@/components/ui/toast';
import type { Dictionary } from '@/i18n/get-dictionary';
import { fetchDocumentBlob, type DocumentSummary } from './documents';
import { errorMessage } from './error-message';

/**
 * Downloads a document to disk.
 *
 * Extracted because three views need it — the documents list, the dashboard's
 * recent panel, and search — and each had grown, or was about to grow, its own
 * copy of the same anchor-click dance and the same revoke-on-next-tick detail
 * that is easy to leave out.
 *
 * Bytes are fetched with the access token rather than linked to directly: the
 * API has no presigned URLs, so every download goes through the same permission
 * check as any other read.
 */
export function useDocumentDownload(errors: Dictionary['errors'], common: Dictionary['common']) {
  const { withToken } = useSession();
  const toast = useToast();

  return useCallback(
    async (item: Pick<DocumentSummary, 'id' | 'originalName'>) => {
      try {
        const url = await withToken((token) => fetchDocumentBlob(token, item.id));
        const anchor = document.createElement('a');

        anchor.href = url;
        // The stored original name, not the display name — the file should
        // arrive called what the user uploaded.
        anchor.download = item.originalName;
        anchor.click();

        // Revoked on the next tick. Immediately would race the click; never
        // would pin the blob in memory for the life of the page.
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (error) {
        toast.error(errorMessage(error, errors, common.genericError));
      }
    },
    [withToken, toast, errors, common.genericError],
  );
}
