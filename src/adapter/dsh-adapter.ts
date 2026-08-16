/**
 * Bridge between real dsh session events and the memory core.
 *
 * Event names and payloads follow the published `@deepseek-ai/dsh-session`
 * contract (`session/created` / `session/disposed` / `session/event`, emit
 * mode). The adapter also projects each appended event into the neutral
 * `TrajectoryStep` shape the distiller consumes, and tracks the per-session
 * working context (last touched file, active git branch) without ever
 * cloning the live `Session` object.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { DshSessionEvent, DshSessionSnapshot } from '../contracts/dsh.js';
import type { TrajectoryStep } from '../pipeline/trajectory-filter.js';

export type SessionCreateHandler = (session: DshSessionSnapshot) => void;
export type SessionDisposeHandler = (session: DshSessionSnapshot) => void;
export type SessionEventHandler = (session: DshSessionSnapshot, event: DshSessionEvent) => void;

export interface SessionWorkingContext {
  currentFilePath: string;
  gitBranch: string;
  trajectory: TrajectoryStep[];
}

export class DshEventAdapter {
  private contexts = new Map<string, SessionWorkingContext>();

  constructor(private ctx: Context) {}

  public onSessionCreated(handler: SessionCreateHandler): () => void {
    return this.ctx.on('session/created', handler);
  }

  public onSessionDisposed(handler: SessionDisposeHandler): () => void {
    return this.ctx.on('session/disposed', handler);
  }

  public onSessionEvent(handler: SessionEventHandler): () => void {
    return this.ctx.on('session/event', handler);
  }

  public getContext(sessionId: string): SessionWorkingContext | undefined {
    return this.contexts.get(sessionId);
  }

  public takeContext(sessionId: string): SessionWorkingContext | undefined {
    const ctx = this.contexts.get(sessionId);
    this.contexts.delete(sessionId);
    return ctx;
  }

  public clear(): void {
    this.contexts.clear();
  }

  /**
   * Fold one appended session event into the session's working context.
   * Called from the `session/event` listener; safe for unknown event types
   * (they simply contribute nothing).
   */
  public trackEvent(sessionId: string, event: DshSessionEvent): void {
    let context = this.contexts.get(sessionId);
    if (!context) {
      context = { currentFilePath: '', gitBranch: '', trajectory: [] };
      this.contexts.set(sessionId, context);
    }

    const step = projectEventToStep(event, context.trajectory.length);
    if (step) {
      context.trajectory.push(step);
      if (step.metadata?.filePath) {
        context.currentFilePath = step.metadata.filePath;
      }
    }
  }
}

/**
 * Project a dsh session event onto the distiller's neutral trajectory step.
 * The mapping is deliberately conservative: only roles and shapes the memory
 * pipeline understands produce steps, and message content is walked for the
 * few scalar fields the pipeline needs (never deep-cloned).
 */
export function projectEventToStep(event: DshSessionEvent, stepIndex: number): TrajectoryStep | null {
  if (!event.type || !event.message) return null;

  const role = event.message.role ?? '';
  const content = messageText(event.message.content);

  if (event.type === 'turn/end' && role === 'assistant') {
    return {
      step_index: stepIndex,
      type: 'MODEL',
      status: 'DONE',
      content,
      metadata: extractFileMeta(event.message.content)
    };
  }

  if (role === 'user') {
    return {
      step_index: stepIndex,
      type: 'USER_INPUT',
      status: 'DONE',
      content
    };
  }

  if (role === 'tool') {
    const toolName = typeof (event.message as { toolName?: unknown }).toolName === 'string'
      ? (event.message as { toolName: string }).toolName
      : 'tool';
    const isError = event.type.includes('error');
    return {
      step_index: stepIndex,
      type: 'TOOL_RESULT',
      status: isError ? 'ERROR' : 'DONE',
      content,
      metadata: {
        toolName,
        exitCode: isError ? 1 : 0,
        ...extractFileMeta(event.message.content)
      }
    };
  }

  return null;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as { text: unknown }).text === 'string') {
          return (block as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const FILE_PATH_KEYS = ['file_path', 'filePath', 'path', 'notebookPath'] as const;

function extractFileMeta(content: unknown): TrajectoryStep['metadata'] {
  const found = findFilePath(content, 0);
  return found ? { filePath: found } : undefined;
}

function findFilePath(value: unknown, depth: number): string | undefined {
  if (depth > 4 || value == null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findFilePath(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of FILE_PATH_KEYS) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  for (const nested of Object.values(record)) {
    const hit = findFilePath(nested, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}
