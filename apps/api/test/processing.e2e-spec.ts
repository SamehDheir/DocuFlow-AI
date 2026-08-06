import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { DocumentProcessingService } from '../src/documents/processing/document-processing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * The v2 pipeline, end to end: extraction → analysis → search → notification,
 * plus the approval workflow.
 *
 * Needs the local stack running (`npm run infra:up`) — Postgres, MinIO and
 * Redis.
 *
 * THE WORKER IS NOT RUNNING (see e2e-env.ts). Jobs are enqueued for real, but
 * nothing consumes them; instead each test drives DocumentProcessingService
 * directly. That is deliberate: a test that uploads and then polls for READY is
 * timing-dependent and flaky, whereas awaiting the pipeline makes the
 * assertions exact. The queue's own wiring is covered by the unit specs.
 *
 * Fixtures are text/plain on purpose. That path reads the bytes directly, so
 * these tests exercise the real extractor without needing pdfjs — which cannot
 * be dynamically imported under Jest's CommonJS runtime without
 * --experimental-vm-modules.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface DocumentBody {
  id: string;
  name: string;
  status: string;
}

interface ApprovalBody {
  id: string;
  status: string;
}

const BODY = [
  'Invoice number 4471 issued to Acme Corporation.',
  'فاتورة رقم 4471 صادرة لشركة أكمي المحدودة.',
  'Total due 12500 USD payable within 30 days.',
].join('\n');

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `V2 ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Processing, search and approvals (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let processing: DocumentProcessingService;
  let server: App;

  const createdCompanies: string[] = [];

  async function tenant(label: string) {
    const response = await request(server)
      .post('/api/auth/register')
      .send(accountFor(label))
      .expect(201);

    const session = response.body as Session;
    createdCompanies.push(session.user.companyId);

    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${session.accessToken}`);

    return { session, auth };
  }

  function upload(
    auth: (req: request.Test) => request.Test,
    body = BODY,
    filename = 'invoice.txt',
  ) {
    return auth(request(server).post('/api/documents')).attach('file', Buffer.from(body, 'utf8'), {
      filename,
      contentType: 'text/plain',
    });
  }

  /** Uploads, then runs the pipeline synchronously in place of the worker. */
  async function uploadAndProcess(
    auth: (req: request.Test) => request.Test,
    session: Session,
    body = BODY,
    filename = 'invoice.txt',
  ): Promise<DocumentBody> {
    const document = (await upload(auth, body, filename).expect(201)).body as DocumentBody;

    await processing.process({
      documentId: document.id,
      companyId: session.user.companyId,
      userId: session.user.id,
    });

    return document;
  }

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    processing = app.get(DocumentProcessingService);
  });

  afterAll(async () => {
    const scope = { companyId: { in: createdCompanies } };

    // Same dependency order the documents suite documents: Restrict on
    // Document.owner blocks deleting a company that still owns documents.
    await prisma.approvalRequest.deleteMany({ where: scope });
    await prisma.notification.deleteMany({ where: scope });
    await prisma.document.deleteMany({ where: scope });
    await prisma.folder.deleteMany({ where: scope });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });

    await app.close();
  });

  describe('the processing pipeline', () => {
    it('returns PROCESSING immediately rather than holding the request open', async () => {
      const { auth } = await tenant('async');

      const document = (await upload(auth).expect(201)).body as DocumentBody;

      expect(document.status).toBe('PROCESSING');
    });

    it('extracts text, summarises, and lands on READY', async () => {
      const { auth, session } = await tenant('pipeline');

      const document = await uploadAndProcess(auth, session);

      const detail = (await auth(request(server).get(`/api/documents/${document.id}`)).expect(200))
        .body as {
        status: string;
        metadata: {
          extractedText: string;
          summary: string;
          ocrStatus: string;
          aiStatus: string;
          keywords: string[];
        };
      };

      expect(detail.status).toBe('READY');
      expect(detail.metadata.ocrStatus).toBe('DONE');
      expect(detail.metadata.aiStatus).toBe('DONE');
      expect(detail.metadata.extractedText).toContain('Acme Corporation');
      // Arabic must survive the round trip through MinIO and the extractor.
      expect(detail.metadata.extractedText).toContain('فاتورة');
      expect(detail.metadata.summary).toBeTruthy();
      expect(detail.metadata.keywords.length).toBeGreaterThan(0);
    });

    it('notifies the owner that the document is ready', async () => {
      const { auth, session } = await tenant('notify');

      await uploadAndProcess(auth, session);

      const inbox = (await auth(request(server).get('/api/notifications')).expect(200)).body as {
        items: { type: string; payload: { name: string } }[];
        unread: number;
      };

      expect(inbox.unread).toBeGreaterThan(0);
      expect(inbox.items[0].type).toBe('DOCUMENT_READY');
      // The wording is not stored — only the values the client interpolates.
      expect(inbox.items[0].payload.name).toBe('invoice.txt');
    });

    it('still reaches READY when a file has no text to extract', async () => {
      const { auth, session } = await tenant('empty');

      const document = await uploadAndProcess(auth, session, '   ', 'blank.txt');

      const detail = (await auth(request(server).get(`/api/documents/${document.id}`)).expect(200))
        .body as { status: string; metadata: { ocrStatus: string; aiStatus: string } };

      // A file with nothing in it is not a failure — the bytes uploaded fine.
      expect(detail.status).toBe('READY');
      expect(detail.metadata.aiStatus).toBe('SKIPPED');
    });

    it('refuses to reprocess a document already in flight', async () => {
      const { auth } = await tenant('inflight');

      const document = (await upload(auth).expect(201)).body as DocumentBody;

      // Still at PROCESSING, because nothing consumed the job.
      const response = await auth(
        request(server).post(`/api/documents/${document.id}/reprocess`),
      ).expect(409);

      expect((response.body as { code: string }).code).toBe('DOCUMENT_ALREADY_PROCESSING');
    });
  });

  describe('search', () => {
    it('finds a document by text that appears only in its contents', async () => {
      const { auth, session } = await tenant('search');

      await uploadAndProcess(auth, session);

      const results = (
        await auth(request(server).get('/api/search').query({ q: 'Acme Corporation' })).expect(200)
      ).body as { items: { name: string; snippet: { text: string; match: boolean }[] }[] };

      expect(results.items).toHaveLength(1);
      expect(results.items[0].name).toBe('invoice.txt');
      // The snippet arrives pre-split, never as markup.
      expect(results.items[0].snippet.some((part) => part.match)).toBe(true);
    });

    it('finds Arabic content typed without its diacritics', async () => {
      const { auth, session } = await tenant('arabic');

      await uploadAndProcess(auth, session);

      // The stored text has أكمي; this searches اكمي — a different alef, and
      // the spelling most people actually type.
      const results = (
        await auth(request(server).get('/api/search').query({ q: 'اكمي' })).expect(200)
      ).body as { items: unknown[] };

      expect(results.items).toHaveLength(1);
    });

    it('tolerates a typo in the file name', async () => {
      const { auth, session } = await tenant('typo');

      await uploadAndProcess(auth, session);

      const results = (
        await auth(request(server).get('/api/search').query({ q: 'invoce' })).expect(200)
      ).body as { items: unknown[] };

      expect(results.items).toHaveLength(1);
    });

    it('returns nothing rather than erroring on tsquery metacharacters', async () => {
      const { auth, session } = await tenant('hostile');

      await uploadAndProcess(auth, session);

      const results = (
        await auth(
          request(server).get('/api/search').query({ q: "&|!():*<-> ' or 1=1 --" }),
        ).expect(200)
      ).body as { items: unknown[] };

      expect(results.items).toHaveLength(0);
    });

    it('rejects an empty query with a translatable code', async () => {
      const { auth } = await tenant('emptyq');

      const response = await auth(request(server).get('/api/search').query({ q: '  ' })).expect(
        400,
      );

      expect((response.body as { code: string }).code).toBe('SEARCH_QUERY_REQUIRED');
    });

    it('never returns another company’s documents', async () => {
      const alpha = await tenant('alpha');
      const beta = await tenant('beta');

      await uploadAndProcess(alpha.auth, alpha.session);

      /**
       * The load-bearing test for this module. Search is raw SQL, so the tenant
       * guard does not cover it and the company predicate is written by hand —
       * this is what proves the hand-written one is actually there.
       */
      const results = (
        await beta
          .auth(request(server).get('/api/search').query({ q: 'Acme Corporation' }))
          .expect(200)
      ).body as { items: unknown[] };

      expect(results.items).toHaveLength(0);
    });
  });

  describe('approvals', () => {
    it('walks request → decision, and refuses a second open request', async () => {
      const { auth, session } = await tenant('approve');

      const document = await uploadAndProcess(auth, session);

      const created = (
        await auth(request(server).post(`/api/documents/${document.id}/approval`))
          .send({ note: 'Please check the total' })
          .expect(201)
      ).body as ApprovalBody;

      expect(created.status).toBe('PENDING');

      // The partial unique index, not an application check — two concurrent
      // requests would both pass a SELECT-then-INSERT.
      const duplicate = await auth(
        request(server).post(`/api/documents/${document.id}/approval`),
      ).expect(409);

      expect((duplicate.body as { code: string }).code).toBe('APPROVAL_ALREADY_PENDING');

      // An Owner holds documents.approve, but nobody decides their own request.
      const self = await auth(request(server).post(`/api/approvals/${created.id}/decision`))
        .send({ decision: 'APPROVED' })
        .expect(403);

      expect((self.body as { code: string }).code).toBe('APPROVAL_SELF_DECISION');

      const cancelled = (
        await auth(request(server).post(`/api/approvals/${created.id}/cancel`)).expect(201)
      ).body as ApprovalBody;

      expect(cancelled.status).toBe('CANCELLED');

      // Cancelling frees the document: the unique index only covers PENDING.
      await auth(request(server).post(`/api/documents/${document.id}/approval`)).expect(201);
    });

    it('rejects a decision value outside the allowed set', async () => {
      const { auth, session } = await tenant('badenum');

      const document = await uploadAndProcess(auth, session);
      const created = (
        await auth(request(server).post(`/api/documents/${document.id}/approval`)).expect(201)
      ).body as ApprovalBody;

      // CANCELLED is on the enum but is not a decision — accepting it here
      // would let an approver silently withdraw someone else's request.
      await auth(request(server).post(`/api/approvals/${created.id}/decision`))
        .send({ decision: 'CANCELLED' })
        .expect(400);
    });

    it('never shows one company the other’s approval queue', async () => {
      const alpha = await tenant('alphaq');
      const beta = await tenant('betaq');

      const document = await uploadAndProcess(alpha.auth, alpha.session);
      await alpha.auth(request(server).post(`/api/documents/${document.id}/approval`)).expect(201);

      const seen = (await beta.auth(request(server).get('/api/approvals')).expect(200)).body as {
        items: unknown[];
      };

      expect(seen.items).toHaveLength(0);
    });
  });

  describe('notifications', () => {
    it('marks one read and reports the remaining count', async () => {
      const { auth, session } = await tenant('read');

      await uploadAndProcess(auth, session);

      const inbox = (await auth(request(server).get('/api/notifications')).expect(200)).body as {
        items: { id: string }[];
        unread: number;
      };

      const after = (
        await auth(request(server).post(`/api/notifications/${inbox.items[0].id}/read`)).expect(201)
      ).body as { unread: number };

      expect(after.unread).toBe(inbox.unread - 1);
    });

    it('never returns a colleague’s notifications to another company', async () => {
      const alpha = await tenant('alphan');
      const beta = await tenant('betan');

      await uploadAndProcess(alpha.auth, alpha.session);

      const seen = (await beta.auth(request(server).get('/api/notifications')).expect(200))
        .body as {
        items: unknown[];
      };

      expect(seen.items).toHaveLength(0);
    });
  });
});
