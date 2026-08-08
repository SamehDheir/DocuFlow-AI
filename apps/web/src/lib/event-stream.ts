import { API_URL } from './api';
import type { DocumentStatus, ProcessingStage } from './documents';

/**
 * The live update stream.
 *
 * WHY NOT `EventSource`: it cannot set request headers. The only way to
 * authenticate one is a token in the query string, which then lands in every
 * nginx access log, every browser history entry and every `Referer`. This app
 * deliberately keeps the access token in memory and out of storage precisely so
 * it leaves no trace — putting it in a URL would undo that.
 *
 * So the stream is read with `fetch` + `ReadableStream` instead. That carries a
 * normal `Authorization` header, which means it also composes with
 * `SessionProvider.withToken`'s renew-and-replay behaviour on a 401, exactly
 * like every other request. The cost is parsing the SSE wire format by hand,
 * which is about twenty lines.
 */

export type LiveEvent =
  | {
      type: 'document.status';
      documentId: string;
      status: DocumentStatus;
      ocrStatus: ProcessingStage;
      aiStatus: ProcessingStage;
    }
  | { type: 'notification'; unread: number }
  | { type: 'approval.changed'; documentId: string; approvalId: string }
  /**
   * A comment was posted, edited or removed.
   *
   * Ids only — the body never rides the company-wide channel. A client with the
   * thread open refetches it through the endpoint that checks permissions, which
   * is also what makes the event safe to broadcast to everyone in the company.
   */
  | { type: 'comment.changed'; documentId: string; commentId: string }
  /** Server heartbeat, so proxies keep an idle connection open. Ignored. */
  | { type: 'ping' };

export interface StreamHandle {
  close: () => void;
}

/**
 * Opens the stream and calls `onEvent` for each message.
 *
 * Resolves when the connection ends — the caller decides whether to reconnect,
 * because only it knows whether the session is still valid.
 */
export async function readEventStream(
  token: string,
  onEvent: (event: LiveEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_URL}/api/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    // Thrown so a 401 reaches withToken, which renews the token and replays.
    const error = new Error(`Event stream failed: ${response.status}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }

  if (!response.body) {
    throw new Error('Event stream returned no body');
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  /**
   * Chunk boundaries fall wherever the network puts them, so a message can
   * arrive split down the middle. Everything after the last complete
   * `\n\n` stays here until its remainder shows up.
   */
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        return;
      }

      buffer += value;

      let boundary = buffer.indexOf('\n\n');

      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        const event = parseMessage(raw);

        if (event) {
          onEvent(event);
        }
      }
    }
  } finally {
    // Releases the socket; without it an aborted stream leaks the connection.
    reader.releaseLock();
    await response.body.cancel().catch(() => undefined);
  }
}

/**
 * Pulls the JSON out of one SSE message.
 *
 * Only `data:` matters here — `id:` is emitted by Nest but this stream carries
 * no resumable history, so replaying from an id would be meaningless. Comment
 * lines (`:`) and unknown fields are skipped.
 */
function parseMessage(raw: string): LiveEvent | null {
  const data = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as LiveEvent;
  } catch {
    // A malformed frame must not tear down a working stream.
    return null;
  }
}
