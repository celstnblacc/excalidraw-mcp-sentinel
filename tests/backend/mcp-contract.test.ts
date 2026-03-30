import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { server, tools } from '../../src/index.js';

let client: Client;

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'mcp-contract-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe('MCP contract', () => {
  it('tools/list returns all declared tools', async () => {
    const listed = await client.listTools();
    expect(Array.isArray(listed.tools)).toBe(true);
    expect(listed.tools.length).toBe(32);
    expect(listed.tools.length).toBe(tools.length);
  });

  it('tools/call unknown tool returns MethodNotFound (-32601)', async () => {
    await expect(
      client.callTool({
        name: '__unknown_tool__',
        arguments: {},
      })
    ).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
  });
});
