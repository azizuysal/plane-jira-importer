import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { HttpError, httpRequest, jsonRequest } from '../src/utils/http.js';
import { withRetry } from '../src/utils/retry.js';
import { PlaneClient } from '../src/clients/plane.js';

vi.mock('../src/utils/logger.js', () => ({ log: { warn: vi.fn() } }));

interface ReceivedRequest {
  path: string;
  method: string | undefined;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

describe('native HTTP transport', () => {
  const requests: ReceivedRequest[] = [];
  let apiUrl: string;
  let storageUrl: string;
  let credentials: unknown;
  let storageStatus: number;
  let retryAttempts: number;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = req.url ?? '';
    requests.push({ path, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (path === '/redirect') {
      res.writeHead(302, { Location: `${storageUrl}/download` });
      res.end();
    } else if (path === '/slow-body') {
      res.writeHead(200);
      res.write('partial');
    } else if (path === '/invalid-json') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('invalid JSON');
    } else if (path === '/retry' && retryAttempts++ === 0) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end('Rate limited');
    } else if (path === '/upload') {
      res.writeHead(storageStatus);
      res.end(storageStatus === 204 ? undefined : 'Storage failed');
    } else if (req.method === 'POST' && path.endsWith('/attachments/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(credentials));
    } else if (req.method === 'PATCH') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'asset-1' }));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }
  }

  const api = createServer((req, res) => {
    handle(req, res).catch((err: unknown) =>
      res.destroy(err instanceof Error ? err : new Error(String(err))),
    );
  });
  const storage = createServer((req, res) => {
    handle(req, res).catch((err: unknown) =>
      res.destroy(err instanceof Error ? err : new Error(String(err))),
    );
  });

  beforeAll(async () => {
    for (const server of [api, storage]) {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    }
    const apiAddress = api.address();
    const storageAddress = storage.address();
    if (
      !apiAddress ||
      typeof apiAddress === 'string' ||
      !storageAddress ||
      typeof storageAddress === 'string'
    ) {
      throw new Error('Expected TCP server addresses');
    }
    apiUrl = `http://127.0.0.1:${apiAddress.port}`;
    storageUrl = `http://127.0.0.1:${storageAddress.port}`;
  });

  afterAll(async () => {
    for (const server of [api, storage]) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });

  beforeEach(() => {
    requests.length = 0;
    retryAttempts = 0;
    storageStatus = 204;
    credentials = {
      asset_id: 'asset-1',
      upload_data: {
        url: `${storageUrl}/upload`,
        fields: { key: 'uploads/test', policy: 'signed-policy' },
      },
    };
  });

  function planeClient() {
    return new PlaneClient({
      host: apiUrl,
      workspaceSlug: 'test-ws',
      apiKey: 'test-api-key',
      maxRetries: 0,
      rateLimiter: { wait: async () => {} },
    });
  }

  it('encodes JSON bodies and query parameters', async () => {
    await jsonRequest(`${apiUrl}/json`, {
      method: 'POST',
      params: { cursor: 'a +/&?', limit: 100 },
      body: { name: 'Issue' },
    });
    const [request] = requests;
    expect(new URL(request.path, apiUrl).searchParams.get('cursor')).toBe('a +/&?');
    expect(new URL(request.path, apiUrl).searchParams.get('limit')).toBe('100');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body.toString())).toEqual({ name: 'Issue' });
  });

  it('retries an actual HTTP 429 response using Retry-After', async () => {
    const result = await withRetry(() => jsonRequest(`${apiUrl}/retry`), { maxRetries: 1 });
    expect(result).toEqual({ ok: true });
    expect(retryAttempts).toBe(2);
  });

  it('times out while reading a stalled response body', async () => {
    await expect(async () => {
      const response = await httpRequest(`${apiUrl}/slow-body`, {}, 100);
      await response.text();
    }).rejects.toThrow(/abort|timeout/i);
  });

  it('does not repeat a successful write when its response contains invalid JSON', async () => {
    await expect(
      withRetry(() =>
        jsonRequest(`${apiUrl}/invalid-json`, { method: 'POST', body: { name: 'Issue' } }),
      ),
    ).rejects.toThrow(/Invalid JSON response/);
    expect(requests).toHaveLength(1);
  });

  it('blocks API redirects before custom credentials reach another origin', async () => {
    await expect(
      jsonRequest(`${apiUrl}/redirect`, { headers: { 'X-API-Key': 'secret' } }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers['x-api-key']).toBe('secret');
  });

  it('strips Authorization when following an attachment redirect to another origin', async () => {
    const response = await httpRequest(`${apiUrl}/redirect`, {
      headers: { Authorization: 'Basic test-credentials' },
      redirect: 'follow',
    });
    await response.arrayBuffer();
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.authorization).toBe('Basic test-credentials');
    expect(requests[1].headers.authorization).toBeUndefined();
  });

  it('uploads exact binary content and form fields before confirming the attachment', async () => {
    const content = Buffer.from([0, 255, 13, 10, 42, 128]);
    const filename = 'report "final".png';
    const result = await planeClient().uploadAttachment(
      'project-1',
      'issue-1',
      content,
      filename,
      'image/png',
      content.length,
      {
        external_id: 'jira-attachment-1',
        external_source: 'jira-importer',
      },
    );
    expect(result).toEqual({ id: 'asset-1' });
    expect(requests.map((r) => r.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(JSON.parse(requests[0].body.toString())).toEqual({
      name: filename,
      type: 'image/png',
      size: content.length,
      external_id: 'jira-attachment-1',
      external_source: 'jira-importer',
    });
    expect(requests[0].headers['x-api-key']).toBe('test-api-key');
    const upload = requests[1];
    expect(upload.headers['x-api-key']).toBeUndefined();
    expect(upload.headers.authorization).toBeUndefined();
    const form = await new Request(`${storageUrl}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': String(upload.headers['content-type']) },
      body: Uint8Array.from(upload.body),
    }).formData();
    expect(form.get('key')).toBe('uploads/test');
    expect(form.get('policy')).toBe('signed-policy');
    const file = form.get('file') as File;
    expect(file.name).toBe(filename);
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(content);
    expect(requests[2].path).toMatch(/attachments\/asset-1\/$/);
    expect(requests[2].headers['x-api-key']).toBe('test-api-key');
  });

  it.each([
    {},
    { asset_id: 'asset-1' },
    { upload_data: { url: 'https://storage.test/upload', fields: {} } },
    { asset_id: 'asset-1', upload_data: { fields: {} } },
  ])(
    'does not confirm an attachment when upload credentials are incomplete: %j',
    async (invalid) => {
      credentials = invalid;
      await expect(
        planeClient().uploadAttachment('p', 'i', Buffer.from('file'), 'file.txt', 'text/plain', 4),
      ).rejects.toThrow(/incomplete upload credentials/);
      expect(requests.map((r) => r.method)).toEqual(['POST']);
    },
  );

  it('does not confirm an attachment when storage rejects the upload', async () => {
    storageStatus = 403;
    await expect(
      planeClient().uploadAttachment('p', 'i', Buffer.from('file'), 'file.txt', 'text/plain', 4),
    ).rejects.toThrow(/Plane API error 403.*uploading/);
    expect(requests.map((r) => r.method)).toEqual(['POST', 'POST']);
  });

  it('preserves status, headers, and error details for HTTP failures', async () => {
    const result = httpRequest(`${apiUrl}/retry`);
    await expect(result).rejects.toBeInstanceOf(HttpError);
    await expect(result).rejects.toMatchObject({ status: 429, message: 'Rate limited' });
  });
});
