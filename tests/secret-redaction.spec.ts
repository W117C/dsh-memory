import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/storage/db.js';
import { HybridRetriever } from '../src/core/hybrid-retriever.js';
import { redactSecrets } from '../src/core/secret-redactor.js';
import { DEFAULT_CONFIG } from '../src/config.js';

describe('Zero-Leak Secret & Credential Redactor', () => {
  let store: MemoryStore;
  let retriever: HybridRetriever;

  beforeEach(() => {
    store = new MemoryStore(DEFAULT_CONFIG, ':memory:');
    retriever = new HybridRetriever(store, DEFAULT_CONFIG.retrieval);
  });

  afterEach(() => {
    store.close();
  });

  it('should redact various high-risk credentials and tokens accurately', () => {
    // 1. API Keys
    const rawApiKey = 'curl https://api.deepseek.com/v1 -H "Authorization: Bearer sk-live-99a8b7c6d5e4f3a2b1c0"';
    const redactedApiKey = redactSecrets(rawApiKey);
    expect(redactedApiKey).not.toContain('sk-live-99a8b7c6d5e4f3a2b1c0');
    expect(redactedApiKey).toContain('[REDACTED_API_KEY]');

    // 2. Database Passwords in Connection String
    const rawDbUrl = 'DATABASE_URL="postgres://postgres:SuperSecretPassword123!@db.internal:5432/prod_db"';
    const redactedDbUrl = redactSecrets(rawDbUrl);
    expect(redactedDbUrl).not.toContain('SuperSecretPassword123!');
    expect(redactedDbUrl).toContain('postgres://postgres:[REDACTED_PASSWORD]@db.internal:5432/prod_db');

    // 3. JWT Tokens
    const rawJwt = 'Set header Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgN_dummy_signature_xxx';
    const redactedJwt = redactSecrets(rawJwt);
    expect(redactedJwt).not.toContain('dozjgN_dummy_signature_xxx');
    expect(redactedJwt).toContain('[REDACTED_JWT]');

    // 4. GitHub Personal Access Tokens
    const rawGhToken = 'git clone https://ghp_1234567890abcdefghijklmnopqrstuvwx@github.com/repo.git';
    const redactedGhToken = redactSecrets(rawGhToken);
    expect(redactedGhToken).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwx');
    expect(redactedGhToken).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  it('should automatically sanitize secrets when memories are created and retrieved', async () => {
    const rawContent = 'Failed to connect: postgres://app_user:MyP@ssw0rd!@db.prod:5432/main. Use connection pooling with pgBouncer.';

    // Create memory directly or via distillation
    const mem = await store.createMemory({
      tier: 'episodic',
      category: 'post_mortem',
      content: rawContent,
      error_signature: 'FATAL: password authentication failed for user "app_user" (key: sk-proj-1234567890abcdef123456)',
      solution_code: 'export DATABASE_URL="postgres://app_user:MyP@ssw0rd!@db.prod:5432/main"',
      status: 'verified'
    });

    expect(mem.content).not.toContain('MyP@ssw0rd!');
    expect(mem.content).toContain('[REDACTED_PASSWORD]');
    expect(mem.error_signature).toContain('[REDACTED_API_KEY]');
    expect(mem.solution_code).toContain('[REDACTED_PASSWORD]');

    // Verify retrieval output contains no plaintext passwords
    const recalls = await retriever.retrieve('database connection pgBouncer');
    expect(recalls.length).toBeGreaterThan(0);
    expect(recalls[0].memory.content).not.toContain('MyP@ssw0rd!');
    expect(recalls[0].memory.content).toContain('[REDACTED_PASSWORD]');
  });
});
