export interface TrajectoryStep {
  step_index: number;
  type: 'USER_INPUT' | 'MODEL' | 'REASONING' | 'TOOL_CALL' | 'TOOL_RESULT' | 'SYSTEM';
  status?: 'DONE' | 'ERROR';
  content: string;
  metadata?: {
    toolName?: string;
    exitCode?: number;
    filePath?: string;
    [key: string]: any;
  };
}

export interface PrunedTrajectory {
  errorRecoveryPairs: Array<{
    failedTool: string;
    errorMessage: string;
    recoveryAction: string;
    verifiedResult: string;
  }>;
  userDirectives: string[];
  reusableCommands: string[];
}

/**
 * Deterministically strips internal DeepSeek-R1/V3 thinking tags (<think>...</think>)
 * and internal monologues so only verified, objective facts and actions remain.
 */
export function stripReasoningContent(content: string): string {
  if (!content) return '';
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim();
}

export class TrajectoryFilter {
  public prune(rawSteps: TrajectoryStep[]): PrunedTrajectory {
    // 1. Sanitize & Filter: Strip CoT thought streams and drop internal REASONING steps
    const steps: TrajectoryStep[] = [];
    for (const raw of rawSteps) {
      if (raw.type === 'REASONING') {
        continue; // Drop pure internal thought steps entirely
      }
      const sanitizedContent = stripReasoningContent(raw.content);
      // If MODEL step had only <think> and nothing else, drop it
      if (raw.type === 'MODEL' && !sanitizedContent) {
        continue;
      }
      steps.push({
        ...raw,
        content: sanitizedContent
      });
    }

    const errorRecoveryPairs: PrunedTrajectory['errorRecoveryPairs'] = [];
    const userDirectives: string[] = [];
    const reusableCommands: string[] = [];

    let i = 0;
    while (i < steps.length) {
      const step = steps[i];

      // 1. Detect Explicit User Directives
      if (step.type === 'USER_INPUT') {
        const text = step.content.trim();
        if (
          text.includes('不要') || text.includes('严禁') || text.includes('必须') ||
          text.includes('don\'t') || text.includes('never') || text.includes('must') ||
          text.includes('prefer') || text.includes('always')
        ) {
          userDirectives.push(text);
        }
      }

      // 2. Three-Way Confirmed Action-Result-Pass Proof:
      // Anchor on physical TOOL_RESULT error -> intermediate action -> physical TOOL_RESULT pass (exitCode == 0)
      if (
        step.type === 'TOOL_RESULT' &&
        (step.status === 'ERROR' || (step.metadata && step.metadata.exitCode !== undefined && step.metadata.exitCode !== 0) || this.isExplicitError(step.content))
      ) {
        const failedTool = step.metadata?.toolName || 'tool';
        const errorMessage = step.content.slice(0, 300);
        let foundRecovery = false;

        // Look forward for successful execution proof in subsequent turns
        for (let j = i + 1; j < Math.min(steps.length, i + 6); j++) {
          const nextStep = steps[j];
          if (
            nextStep.type === 'TOOL_RESULT' &&
            nextStep.status === 'DONE' &&
            (!nextStep.metadata || nextStep.metadata.exitCode === 0) &&
            !this.isExplicitError(nextStep.content)
          ) {
            // Aggregate all sanitized model fixes and physical tool executions
            const recoverySteps = steps.slice(i + 1, j);
            const recoveryAction = recoverySteps
              .map(s => s.content)
              .filter(c => c && c.length > 0)
              .join(' | ') || 'Applied verified fix';

            errorRecoveryPairs.push({
              failedTool,
              errorMessage,
              recoveryAction: recoveryAction.slice(0, 500),
              verifiedResult: nextStep.content.slice(0, 200)
            });
            i = j;
            foundRecovery = true;
            break;
          }
        }

        if (foundRecovery) {
          i++;
          continue;
        }
      }

      // 3. Detect Successful Reusable Command Chains (exitCode === 0)
      if (step.type === 'TOOL_CALL' && (step.metadata?.toolName === 'run_command' || step.content.includes('CommandLine'))) {
        const nextStep = steps[i + 1];
        if (nextStep && nextStep.type === 'TOOL_RESULT' && nextStep.metadata?.exitCode === 0) {
          if (step.content.includes('build') || step.content.includes('test') || step.content.includes('deploy') || step.content.includes('migrate')) {
            reusableCommands.push(step.content);
          }
        }
      }

      i++;
    }

    return {
      errorRecoveryPairs,
      userDirectives,
      reusableCommands
    };
  }

  private isExplicitError(content: string): boolean {
    const lower = content.toLowerCase();
    return (
      lower.startsWith('error:') ||
      lower.includes('typeerror:') ||
      lower.includes('syntaxerror:') ||
      lower.includes('cannot find module') ||
      lower.includes('command failed with exit code') ||
      lower.includes('econnrefused')
    );
  }
}
