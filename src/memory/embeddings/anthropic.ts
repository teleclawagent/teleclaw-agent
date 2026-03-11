import type { EmbeddingProvider } from "./provider.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { VOYAGE_API_URL } from "../../constants/api-endpoints.js";
import { VOYAGE_BATCH_SIZE } from "../../constants/limits.js";

export class AnthropicEmbeddingProvider implements EmbeddingProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly dimensions: number;
  private apiKey: string;
  private baseUrl = VOYAGE_API_URL;

  constructor(config: { apiKey: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "voyage-3-lite";

    const dims: Record<string, number> = {
      "voyage-3": 1024,
      "voyage-3-lite": 512,
      "voyage-code-3": 1024,
      "voyage-finance-2": 1024,
      "voyage-multilingual-2": 1024,
      "voyage-law-2": 1024,
    };

    this.dimensions = dims[this.model] ?? 512;
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.embed([text], "query");
    return result[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const batchSize = VOYAGE_BATCH_SIZE;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await this.embed(batch);
      results.push(...embeddings);
    }

    return results;
  }

  private async embed(
    texts: string[],
    inputType: "query" | "document" = "document"
  ): Promise<number[][]> {
    const response = await fetchWithTimeout(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: inputType,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((item) => item.embedding);
  }
}
