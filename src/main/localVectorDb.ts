// localVectorDb.ts - Fast On-Device Vector Store for Interview Content & Notes

import electron from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export interface VectorChunk {
  id: string
  text: string
  source: string
  embedding: number[]
}

interface VectorStoreData {
  chunks: VectorChunk[]
}

class LocalVectorDb {
  private filePath: string
  private data: VectorStoreData = { chunks: [] }

  constructor() {
    const app = electron?.app
    const userDataPath = app?.getPath ? app.getPath('userData') : process.cwd()
    this.filePath = path.join(userDataPath, 'zyro_local_vectors.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        this.data = JSON.parse(raw)
        // Migration: if embeddings were generated with old 128-dim, clear them
        // (new embeddings are 256-dim for better Hindi/multilingual support)
        const firstChunk = this.data.chunks?.[0]
        if (firstChunk && firstChunk.embedding.length !== 256) {
          console.log('[LocalVectorDb] Detected old 128-dim embeddings. Clearing for 256-dim upgrade...')
          this.data = { chunks: [] }
          this.save()
        }
      }
    } catch (err) {
      console.error('[LocalVectorDb] Error loading vector file:', err)
      this.data = { chunks: [] }
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[LocalVectorDb] Error saving vector file:', err)
    }
  }

  // Local embedding generator - supports Hindi, Devanagari, and English
  private generateLocalEmbedding(text: string): number[] {
    // Normalize: lowercase, keep alphanumeric + Devanagari (Hindi) characters
    // Unicode range for Devanagari: \u0900-\u097F
    const normalized = text.toLowerCase().replace(/[^\w\s\u0900-\u097F]/g, ' ')
    const words = normalized.split(/\s+/).filter(Boolean)
    const dim = 256  // Increased from 128 to 256 for better representation
    const vec = new Array(dim).fill(0)

    for (const word of words) {
      let hash = 5381  // djb2 hash seed — more uniform distribution
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) + hash) + word.charCodeAt(i)
        hash |= 0  // Convert to 32bit int
      }
      const idx = Math.abs(hash) % dim
      vec[idx] += 1

      // Also add character bigrams for better Hindi word similarity
      for (let i = 0; i < word.length - 1; i++) {
        const bigram = word.charCodeAt(i) * 31 + word.charCodeAt(i + 1)
        const bigramIdx = Math.abs(bigram) % dim
        vec[bigramIdx] += 0.5
      }
    }

    // L2 Normalize vector
    const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1
    return vec.map((val) => val / norm)
  }

  // Index text by splitting into semantic chunks (~300 chars)
  public indexContent(source: string, content: string): number {
    if (!content || !content.trim()) return 0

    // Filter out old chunks from same source
    this.data.chunks = this.data.chunks.filter((c) => c.source !== source)

    // Semantic & Sliding-Window chunking for large documents (handles 150+ pages easily)
    const rawParagraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 15)

    const chunks: string[] = []
    for (const p of rawParagraphs) {
      if (p.length <= 800) {
        chunks.push(p)
      } else {
        // Sub-chunk large paragraphs into ~600 char overlapping windows
        let start = 0
        while (start < p.length) {
          const slice = p.substring(start, start + 650).trim()
          if (slice.length > 20) chunks.push(slice)
          start += 450
        }
      }
    }

    let count = 0
    for (const textChunk of chunks) {
      const embedding = this.generateLocalEmbedding(textChunk)
      this.data.chunks.push({
        id: `${source}_${Date.now()}_${count}`,
        text: textChunk,
        source,
        embedding
      })
      count++
    }

    this.save()
    console.log(`[LocalVectorDb] Indexed ${count} chunks for source "${source}". Total store size: ${this.data.chunks.length}`)
    return count
  }

  // Hybrid Search: Cosine Similarity + Keyword/Term Overlap Boost
  public search(query: string, topK: number = 3): string[] {
    if (!query || !query.trim() || this.data.chunks.length === 0) return []

    const queryVec = this.generateLocalEmbedding(query)

    // Extract query keywords (ignore very short stop tokens)
    const queryTokens = query
      .toLowerCase()
      .replace(/[^\w\s\u0900-\u097F]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !['the', 'and', 'for', 'with', 'what', 'how', 'kya', 'hai', 'aap', 'kaise', 'hota', 'hoti', 'mein', 'karo', 'tell', 'about'].includes(t))

    const scored = this.data.chunks.map((chunk) => {
      let dot = 0
      for (let i = 0; i < queryVec.length; i++) {
        dot += queryVec[i] * (chunk.embedding[i] || 0)
      }

      // Keyword boost for cross-lingual / tech terms matching
      let keywordBoost = 0
      const chunkLower = chunk.text.toLowerCase()
      for (const token of queryTokens) {
        if (chunkLower.includes(token)) {
          keywordBoost += 0.3
        }
      }

      const totalScore = dot + keywordBoost
      return { text: chunk.text, score: totalScore }
    })

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, topK).filter((item) => item.score > 0.04)
    return top.map((item) => item.text)
  }

  public clearSource(source: string): void {
    this.data.chunks = this.data.chunks.filter((c) => c.source !== source)
    this.save()
  }
}

export const localVectorDb = new LocalVectorDb()
