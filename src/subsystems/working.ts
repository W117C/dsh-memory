export interface ScratchpadEntry {
  key: string;
  value: string;
  updatedAt: number;
}

export class WorkingMemoryManager {
  private scratchpad = new Map<string, ScratchpadEntry>();
  private activeGoal = '';

  public setActiveGoal(goal: string): void {
    this.activeGoal = goal;
  }

  public getActiveGoal(): string {
    return this.activeGoal;
  }

  public setScratchpadItem(key: string, value: string): void {
    this.scratchpad.set(key, {
      key,
      value,
      updatedAt: Date.now()
    });
  }

  public getScratchpadItem(key: string): string | undefined {
    return this.scratchpad.get(key)?.value;
  }

  public getAllScratchpad(): ScratchpadEntry[] {
    return Array.from(this.scratchpad.values());
  }

  public clear(): void {
    this.scratchpad.clear();
    this.activeGoal = '';
  }
}
