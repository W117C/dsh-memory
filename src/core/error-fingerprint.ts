export type ErrorType =
  | 'MISSING_LOCAL_FILE'
  | 'MISSING_PACKAGE'
  | 'TYPE_MISMATCH'
  | 'SYNTAX'
  | 'NETWORK_OR_TIMEOUT'
  | 'RUNTIME_EXCEPTION';

export interface ErrorFingerprint {
  errorType: ErrorType;
  targetSymbol?: string;
  frameworkContext?: string;
  normalizedSignature: string;
}

export function extractErrorFingerprint(rawError: string): ErrorFingerprint {
  const text = (rawError || '').trim();
  const lower = text.toLowerCase();

  // 1. Missing module / package detection
  const moduleMatch = text.match(/cannot find module ['"]([^'"]+)['"]/i) ||
                      text.match(/module not found: can't resolve ['"]([^'"]+)['"]/i) ||
                      text.match(/failed to resolve import ['"]([^'"]+)['"]/i) ||
                      text.match(/no module named ['"]([^'"]+)['"]/i);

  if (moduleMatch) {
    const symbol = moduleMatch[1].trim();
    const isLocalFile = symbol.startsWith('./') || symbol.startsWith('../') || symbol.startsWith('/');
    const errorType: ErrorType = isLocalFile ? 'MISSING_LOCAL_FILE' : 'MISSING_PACKAGE';
    return {
      errorType,
      targetSymbol: symbol,
      frameworkContext: detectFramework(text),
      normalizedSignature: `[${errorType}:${symbol}] ${text.slice(0, 120)}`
    };
  }

  // 2. TypeScript type mismatch (e.g. TS2322, TS2345, TS2769)
  const tsCodeMatch = text.match(/error (TS\d+):/i);
  if (tsCodeMatch || lower.includes('typeerror:') || lower.includes('is not assignable to type')) {
    const code = tsCodeMatch ? tsCodeMatch[1] : 'TYPE_MISMATCH';
    return {
      errorType: 'TYPE_MISMATCH',
      targetSymbol: code,
      frameworkContext: detectFramework(text),
      normalizedSignature: `[TYPE_MISMATCH:${code}] ${text.slice(0, 120)}`
    };
  }

  // 3. Syntax / Parsing Errors
  if (lower.includes('syntaxerror:') || lower.includes('unexpected token') || lower.includes('parsing error')) {
    return {
      errorType: 'SYNTAX',
      frameworkContext: detectFramework(text),
      normalizedSignature: `[SYNTAX] ${text.slice(0, 120)}`
    };
  }

  // 4. Network / Connection Refused
  if (lower.includes('econnrefused') || lower.includes('timeout') || lower.includes('etimedout') || lower.includes('fetch failed')) {
    return {
      errorType: 'NETWORK_OR_TIMEOUT',
      frameworkContext: detectFramework(text),
      normalizedSignature: `[NETWORK_OR_TIMEOUT] ${text.slice(0, 120)}`
    };
  }

  // 5. Default Runtime Exception
  return {
    errorType: 'RUNTIME_EXCEPTION',
    frameworkContext: detectFramework(text),
    normalizedSignature: `[RUNTIME_EXCEPTION] ${text.slice(0, 120)}`
  };
}

function detectFramework(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes('next.js') || lower.includes('nextjs') || lower.includes('next/')) return 'nextjs';
  if (lower.includes('prisma')) return 'prisma';
  if (lower.includes('vite') || lower.includes('@vitejs/')) return 'vite';
  if (lower.includes('vitest')) return 'vitest';
  if (lower.includes('cordis') || lower.includes('@cordisjs/')) return 'cordis';
  if (lower.includes('react')) return 'react';
  return undefined;
}
