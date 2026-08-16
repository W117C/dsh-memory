import { MemoryConfig } from '../config.js';

export interface EmbeddingProvider {
  embed(text: string, isQuery?: boolean): Promise<Float32Array>;
  embedBatch(texts: string[], isQuery?: boolean): Promise<Float32Array[]>;
  getDimension(): number;
}

export class EmbeddingAdapter implements EmbeddingProvider {
  private localPipeline: any = null;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private dimension: number;

  constructor(private config: MemoryConfig['embedding']) {
    this.dimension = config.dimension || 512;
  }

  public getDimension(): number {
    return this.dimension;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.localPipeline) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (this.config.provider === 'local') {
        try {
          const { pipeline } = await import('@huggingface/transformers');
          const loadPromise = pipeline('feature-extraction', this.config.model, {
            dtype: 'fp32'
          });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Embedding model load timeout')), 3000)
          );
          this.localPipeline = await Promise.race([loadPromise, timeoutPromise]);
        } catch {
          this.localPipeline = null;
        }
      }
    })();

    return this.initPromise;
  }

  public async embed(text: string, isQuery = false): Promise<Float32Array> {
    const [result] = await this.embedBatch([text], isQuery);
    return result;
  }

  public async embedBatch(texts: string[], isQuery = false): Promise<Float32Array[]> {
    await this.ensureInitialized();

    if (this.config.provider === 'remote' && this.config.apiKey && this.config.baseUrl) {
      return this.embedRemote(texts);
    }

    if (this.localPipeline) {
      try {
        const results: Float32Array[] = [];
        for (const rawText of texts) {
          const text = isQuery && this.config.model.includes('bge') ? `query: ${rawText}` : rawText;
          const output = await this.localPipeline(text, {
            pooling: 'mean',
            normalize: true
          });
          const array = new Float32Array(output.data);
          results.push(this.normalize(array));
        }
        return results;
      } catch {
        // Fallback
      }
    }

    return texts.map(t => this.generateDeterministicEmbedding(t));
  }

  private async embedRemote(texts: string[]): Promise<Float32Array[]> {
    const url = `${this.config.baseUrl!.replace(/\/+$/, '')}/embeddings`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: texts
      })
    });

    if (!response.ok) {
      throw new Error(`Remote embedding request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as any;
    return data.data.map((item: any) => this.normalize(new Float32Array(item.embedding)));
  }

  private normalize(vec: Float32Array): Float32Array {
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) {
      sumSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(sumSq) || 1e-12;
    const result = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
      result[i] = vec[i] / norm;
    }
    return result;
  }

  private generateDeterministicEmbedding(text: string): Float32Array {
    const dim = this.dimension;
    const vec = new Float32Array(dim);
    const normalized = text.toLowerCase().trim();

    for (let i = 0; i < normalized.length; i++) {
      const charCode = normalized.charCodeAt(i);
      const idx1 = (charCode * 31 + i) % dim;
      const idx2 = (charCode * 59 + i * 7) % dim;
      vec[idx1] += 1.0;
      vec[idx2] += 0.5;

      if (i < normalized.length - 1) {
        const bigram = charCode * 31 + normalized.charCodeAt(i + 1);
        const bIdx = (bigram * 97) % dim;
        vec[bIdx] += 1.5;
      }
    }

    return this.normalize(vec);
  }
}
