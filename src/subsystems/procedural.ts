import { MemoryStore, mapRowToRecord } from '../storage/db.js';
import { MemoryRecord } from '../types/memory.js';

export interface WorkflowRecipeInput {
  taskName: string;
  triggerCondition: string;
  commandsOrScript: string;
  caveats?: string;
  topic_keywords?: string[];
  importance?: number;
}

export class ProceduralMemoryManager {
  constructor(private store: MemoryStore) {}

  public async registerRecipe(input: WorkflowRecipeInput): Promise<MemoryRecord> {
    const summary = `Recipe: ${input.taskName} -> ${input.triggerCondition}`.slice(0, 120);
    const content = `### Task: ${input.taskName}\n**Trigger**: ${input.triggerCondition}\n\n### Commands\n\`\`\`bash\n${input.commandsOrScript}\n\`\`\`\n${input.caveats ? `\n**Caveats**: ${input.caveats}` : ''}`;

    return this.store.createMemory({
      tier: 'procedural',
      category: 'workflow',
      entity_key: `recipe.${input.taskName.toLowerCase().replace(/\s+/g, '_')}`,
      content,
      summary,
      solution_code: input.commandsOrScript,
      topic_keywords: input.topic_keywords,
      importance: input.importance ?? 4.0,
      status: 'verified'
    });
  }

  public getRecipes(limit = 10): MemoryRecord[] {
    const now = Date.now();
    const stmt = this.store.getDb().prepare(`
      SELECT * FROM memories
      WHERE tier = 'procedural' AND category = 'workflow' AND (invalid_at IS NULL OR invalid_at > ?)
      ORDER BY importance DESC, last_accessed_at DESC
      LIMIT ?
    `);
    return (stmt.all(now, limit) as MemoryRecord[]).map((r) => mapRowToRecord(r));
  }
}
