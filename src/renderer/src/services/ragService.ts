import { getAuthenticatedClient } from '../lib/supabase'

export interface RAGChunk {
  id: string
  content: string
  chunk_index: number
  similarity: number
}

// Configurable threshold and top-k limits
const RAG_TOP_K = 5
const RAG_SIMILARITY_THRESHOLD = 0.65

/**
 * Split text into semantic chunks of approx 500-800 tokens with 80-150 tokens overlap.
 * Uses paragraph and sentence boundary heuristics for clean chunking.
 */
export function chunkText(text: string, maxChunkTokens = 600, overlapTokens = 100): string[] {
  // Rough proxy: 1 token ≈ 0.75 words.
  const wordLimit = Math.max(100, Math.floor(maxChunkTokens * 0.75))
  const overlapWordsCount = Math.max(10, Math.floor(overlapTokens * 0.75))

  const paragraphs = text.split(/\n\s*\n/)
  const chunks: string[] = []
  let currentWords: string[] = []

  for (const paragraph of paragraphs) {
    const paraWords = paragraph.trim().split(/\s+/).filter(Boolean)
    if (paraWords.length === 0) continue

    if (currentWords.length + paraWords.length <= wordLimit) {
      currentWords = currentWords.concat(paraWords)
    } else {
      if (currentWords.length > 0) {
        chunks.push(currentWords.join(' '))
      }

      if (paraWords.length > wordLimit) {
        // Paragraph is too large, split by sentences
        const sentences = paragraph.split(/(?<=[.?!])\s+/)
        let tempWords: string[] = []
        for (const sentence of sentences) {
          const sentenceWords = sentence.trim().split(/\s+/).filter(Boolean)
          if (tempWords.length + sentenceWords.length <= wordLimit) {
            tempWords = tempWords.concat(sentenceWords)
          } else {
            if (tempWords.length > 0) {
              chunks.push(tempWords.join(' '))
            }
            tempWords = sentenceWords
          }
        }
        if (tempWords.length > 0) {
          currentWords = tempWords
        } else {
          currentWords = []
        }
      } else {
        // Start new chunk with overlap from previous chunk
        const overlapWords = currentWords.slice(-overlapWordsCount)
        currentWords = overlapWords.concat(paraWords)
      }
    }
  }

  if (currentWords.length > 0) {
    chunks.push(currentWords.join(' '))
  }

  return chunks
}

/**
 * Modular Embedding Provider calling Cloudflare Workers AI embeddings endpoint
 */
export class EmbeddingProvider {
  private static getGatewayUrl(): string {
    return 'https://ai-gateway.harshjeswani30.workers.dev'
  }

  static async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const gatewayUrl = this.getGatewayUrl()
    const res = await fetch(`${gatewayUrl}/gateway/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: texts })
    })

    if (!res.ok) {
      throw new Error(`Embedding API returned status ${res.status}`)
    }

    const data = await res.json() as { data?: number[][] }
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response structure from embeddings API')
    }

    return data.data
  }

  static async generateEmbedding(text: string): Promise<number[]> {
    const embeddings = await this.generateEmbeddings([text])
    if (embeddings.length === 0) {
      throw new Error('No embedding returned')
    }
    return embeddings[0]
  }
}

/**
 * Retrieve relevant chunks from Supabase vector search for a question and a knowledge base ID.
 * Returns the formatted context or "NO_RELEVANT_CONTEXT" if nothing matches above threshold.
 */
export async function retrieveContext(
  question: string,
  kbId: string,
  topK = RAG_TOP_K,
  threshold = RAG_SIMILARITY_THRESHOLD
): Promise<string> {
  const trimmed = question.trim()
  if (!trimmed || !kbId) return 'NO_RELEVANT_CONTEXT'

  const startTime = Date.now()
  try {
    // 1. Generate query embedding
    const queryEmbedding = await EmbeddingProvider.generateEmbedding(trimmed)
    const embeddingTime = Date.now() - startTime

    // Format as pgvector string required by PostgREST
    const queryVec = `[${(queryEmbedding as number[]).join(',')}]`

    // 2. Perform similarity search via Supabase RPC (use authenticated client)
    const dbStartTime = Date.now()
    const db = await getAuthenticatedClient()
    const { data: chunks, error } = await db.rpc('match_knowledge_chunks', {
      query_embedding: queryVec,
      match_threshold: threshold,
      match_count: topK,
      kb_id: kbId
    })
    const dbTime = Date.now() - dbStartTime


    if (error) {
      console.error('[RAG] Database vector search error:', error)
      return 'NO_RELEVANT_CONTEXT'
    }

    if (!chunks || chunks.length === 0) {
      console.log(`[RAG] Cosine search: no chunks matched threshold ${threshold}`)
      return 'NO_RELEVANT_CONTEXT'
    }

    // 3. Log RAG Pipeline Performance
    const totalTime = Date.now() - startTime
    console.log(
      `[RAG] Query: "${trimmed.substring(0, 40)}..." | Embedding: ${embeddingTime}ms | DB Search: ${dbTime}ms | Total: ${totalTime}ms | Chunks found: ${chunks.length}`
    )

    // 4. Format context from retrieved chunks
    const formattedContext = chunks
      .sort((a: any, b: any) => a.chunk_index - b.chunk_index) // order chronologically
      .map((c: any) => c.content)
      .join('\n\n')

    return formattedContext
  } catch (err) {
    console.error('[RAG] Retrieval failed:', err)
    return 'NO_RELEVANT_CONTEXT'
  }
}
