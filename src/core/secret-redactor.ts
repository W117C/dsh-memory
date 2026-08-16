/**
 * Zero-Leak Secret & Credential Redactor:
 * Sanitizes high-risk secrets, API tokens, connection string passwords,
 * JWTs, and private keys before text is indexed, vectorized, or stored.
 */

export function redactSecrets(text: string): string {
  if (!text) return '';

  return text
    // 1. Private Key blocks (RSA, EC, OPENSSH, etc.)
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')

    // 2. OpenAI / DeepSeek / Anthropic / Common LLM API Keys (e.g. sk-live-..., sk-ant-...)
    .replace(/sk-[a-zA-Z0-9_\-]{20,}/g, '[REDACTED_API_KEY]')

    // 3. GitHub Personal Access Tokens & Fine-Grained Tokens
    .replace(/gh[pousr]_[a-zA-Z0-9]{20,}/g, '[REDACTED_GITHUB_TOKEN]')

    // 4. AWS Access Key IDs
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')

    // 5. Slack Tokens
    .replace(/xox[baprs]-[0-9a-zA-Z\-]{10,}/g, '[REDACTED_SLACK_TOKEN]')

    // 6. Database Connection URLs with Passwords (postgres://, mysql://, mongodb://, redis://)
    .replace(/(:\/\/[^:\s'"]+:)([^@\s'"]+)(@)/g, '$1[REDACTED_PASSWORD]$3')

    // 7. JWT Tokens (Three base64 segments starting with eyJ)
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, '[REDACTED_JWT]')

    // 8. Authorization Bearer Tokens
    .replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]{20,}/gi, '$1[REDACTED_TOKEN]')

    // 9. Generic Key-Value secret assignments (e.g. password = "...", secret: '...')
    .replace(/(password|passwd|secret|api_key|access_token|client_secret)\s*[:=]\s*['"][^'"]{6,}['"]/gi, '$1: "[REDACTED_SECRET]"');
}
