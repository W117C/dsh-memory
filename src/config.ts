import Schema from '@deepseek-ai/schemastery';

/**
 * Default distillation route: the dsh base composition's own default model
 * (`agent-default-model` row in `dsh-base/cordis.patch.yml`), so the plugin's
 * auxiliary calls ride the same DeepSeek-V4 provider the harness already
 * configured.
 */
export const DEFAULT_LLM_PROVIDER = 'deepseek-official';
export const DEFAULT_LLM_MODEL = 'deepseek-v4-flash';

export interface MemoryConfig {
  embedding: {
    provider: 'local' | 'remote';
    model: string;
    dimension: number;
    apiKey?: string;
    baseUrl?: string;
  };
  storage: {
    workspaceDbPath?: string;
    globalDbPath?: string;
    forceJsVector?: boolean;
  };
  retrieval: {
    maxWorkingSetTokens: number;
    defaultTopK: number;
    minScore: number;
    decayHalfLifeDays: number;
    vectorWeight: number;
    bm25Weight: number;
    recencyWeight: number;
    importanceWeight: number;
  };
  distillation: {
    autoDistillOnFinish: boolean;
    minTurnsForDistill: number;
    requireTestVerification: boolean;
    llmProvider: string;
    distillModel: string;
  };
  consolidation: {
    llmAssisted: boolean;
    similarityTopK: number;
    extractEntities: boolean;
  };
  prompt: {
    enabled: boolean;
  };
  web: {
    enabled: boolean;
    routePrefix: string;
  };
}

export const MemoryConfig: Schema<MemoryConfig> = Schema.object({
  embedding: Schema.object({
    provider: Schema.union(['local', 'remote']).default('local').description('向量计算后端: local (本地 ONNX) 或 remote (API)'),
    model: Schema.string().default('Xenova/bge-small-zh-v1.5').description('嵌入模型名称'),
    dimension: Schema.number().default(512).description('向量维度 (bge-small-zh 为 512, all-MiniLM-L6 为 384)'),
    apiKey: Schema.string().role('secret').description('远程嵌入 API Key (可选, 建议经环境变量注入)'),
    baseUrl: Schema.string().description('远程嵌入 API Base URL (可选)')
  }).description('向量嵌入配置'),

  storage: Schema.object({
    workspaceDbPath: Schema.string().description('工作区级数据库路径 (默认 .dsh/memory.db)'),
    globalDbPath: Schema.string().description('全局开发者级数据库路径 (默认 ~/.dsh/global_memory.db)'),
    forceJsVector: Schema.boolean().default(false).description('强制使用纯 JS 向量计算引擎 (跳过 sqlite-vec 原生扩展)')
  }).description('存储底座配置'),

  retrieval: Schema.object({
    maxWorkingSetTokens: Schema.number().default(1000).description('Session 静态工作集最大 Token 预算'),
    defaultTopK: Schema.number().default(6).description('单次检索召回数量上限'),
    minScore: Schema.number().default(0.35).description('混合检索最小置信度阈值'),
    decayHalfLifeDays: Schema.number().default(7).description('艾宾浩斯时间遗忘半衰期 (天)'),
    vectorWeight: Schema.number().default(0.45).description('密集向量相似度权重'),
    bm25Weight: Schema.number().default(0.25).description('稀疏 BM25 关键词权重'),
    recencyWeight: Schema.number().default(0.15).description('时间新鲜度衰减权重'),
    importanceWeight: Schema.number().default(0.15).description('记忆重要度权重')
  }).description('混合检索打分配置'),

  distillation: Schema.object({
    autoDistillOnFinish: Schema.boolean().default(true).description('会话结束 (session/disposed) 时是否自动异步提炼 Trajectory'),
    minTurnsForDistill: Schema.number().default(3).description('触发提炼的最小会话轮数'),
    requireTestVerification: Schema.boolean().default(true).description('是否强制要求通过 Exit Code == 0 验证门禁'),
    llmProvider: Schema.string().default(DEFAULT_LLM_PROVIDER).description('蒸馏调用的 LLM provider 路由 (dsh llm adapter 注册名)'),
    distillModel: Schema.string().default(DEFAULT_LLM_MODEL).description('蒸馏模型 (默认与 dsh 基座一致的 DeepSeek-V4 flash)')
  }).description('轨迹反思提炼配置'),

  consolidation: Schema.object({
    llmAssisted: Schema.boolean().default(true).description('写入时是否启用 LLM 合并决策 (ADD/UPDATE/DELETE/NOOP, 经 ctx.llm; 失败自动回退确定性路径)'),
    similarityTopK: Schema.number().default(5).description('合并决策时检索的相似记忆候选数'),
    extractEntities: Schema.boolean().default(true).description('写入时是否抽取实体并构建 mentions 图谱边')
  }).description('记忆合并与图谱增强配置'),

  prompt: Schema.object({
    enabled: Schema.boolean().default(true).description('是否注册 systemPrompt 分区与 context 快照 (KV-cache 友好双层注入)')
  }).description('提示词注入配置'),

  web: Schema.object({
    enabled: Schema.boolean().default(true).description('是否在 dsh webserver 上挂载 /api/memory JSON 面板后端'),
    routePrefix: Schema.string().default('/api/memory').description('HTTP 路由前缀')
  }).description('Web 面板后端配置')
});

export const DEFAULT_CONFIG: MemoryConfig = {
  embedding: {
    provider: 'local',
    model: 'Xenova/bge-small-zh-v1.5',
    dimension: 512
  },
  storage: {
    forceJsVector: false
  },
  retrieval: {
    maxWorkingSetTokens: 1000,
    defaultTopK: 6,
    minScore: 0.35,
    decayHalfLifeDays: 7,
    vectorWeight: 0.45,
    bm25Weight: 0.25,
    recencyWeight: 0.15,
    importanceWeight: 0.15
  },
  distillation: {
    autoDistillOnFinish: true,
    minTurnsForDistill: 3,
    requireTestVerification: true,
    llmProvider: DEFAULT_LLM_PROVIDER,
    distillModel: DEFAULT_LLM_MODEL
  },
  consolidation: {
    llmAssisted: true,
    similarityTopK: 5,
    extractEntities: true
  },
  prompt: {
    enabled: true
  },
  web: {
    enabled: true,
    routePrefix: '/api/memory'
  }
};
