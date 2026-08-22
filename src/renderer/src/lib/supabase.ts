import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  }
})

/**
 * Raw PostgREST client that bypasses supabase-js auth entirely.
 * supabase-js v2 overwrites the Authorization header even when set via global.headers,
 * so for KB operations in Electron we use raw fetch with the real user token.
 */
export async function getAuthenticatedClient() {
  const session = await window.api.getSupabaseSessionData()
  const token = (session?.accessToken && session.accessToken.length > 20)
    ? session.accessToken
    : supabaseAnonKey

  console.log('[Auth] Token source:', token === supabaseAnonKey ? '⚠️ ANON KEY (session missing!)' : '✅ User JWT')

  const baseUrl = supabaseUrl
  const headers = {
    'Content-Type': 'application/json',
    'apikey': supabaseAnonKey,
    'Authorization': `Bearer ${token}`,
    'Prefer': 'return=representation',
  }

  return {
    from(table: string) {
      return new PostgRESTBuilder(baseUrl, table, headers)
    },
    rpc(fn: string, params: Record<string, unknown>) {
      return {
        async then(resolve: (val: any) => any, reject: (err: any) => any) {
          try {
            const res = await fetch(`${baseUrl}/rest/v1/rpc/${fn}`, {
              method: 'POST',
              headers,
              body: JSON.stringify(params)
            })
            const data = await res.json()
            if (!res.ok) {
              resolve({ data: null, error: data })
            } else {
              resolve({ data, error: null })
            }
          } catch (err) {
            reject(err)
          }
        }
      }
    }
  }
}

class PostgRESTBuilder {
  private url: string
  private headers: Record<string, string>
  private filters: string[] = []
  private _selectFields = '*'
  private _isSingle = false
  private _order: string | null = null

  constructor(baseUrl: string, table: string, headers: Record<string, string>) {
    this.url = `${baseUrl}/rest/v1/${table}`
    this.headers = { ...headers }
  }

  select(fields = '*') {
    this._selectFields = fields
    return this
  }

  eq(col: string, val: string) {
    this.filters.push(`${col}=eq.${val}`)
    return this
  }

  order(col: string, opts: { ascending: boolean } = { ascending: true }) {
    this._order = `${col}.${opts.ascending ? 'asc' : 'desc'}`
    return this
  }

  single() {
    this._isSingle = true
    this.headers['Prefer'] = 'return=representation'
    return this
  }

  private buildUrl(extra = '') {
    const params = [...this.filters]
    if (this._order) params.push(`order=${this._order}`)
    const qs = params.length ? '?' + params.join('&') : ''
    return `${this.url}${extra}${qs}`
  }

  async insert(data: object | object[]) {
    const res = await fetch(this.buildUrl(), {
      method: 'POST',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body: JSON.stringify(data)
    })
    const body = await res.json()
    if (!res.ok) return { data: null, error: body }
    const result = Array.isArray(body) ? (this._isSingle ? body[0] : body) : body
    return { data: result || null, error: null }
  }

  async delete() {
    const res = await fetch(this.buildUrl(), {
      method: 'DELETE',
      headers: this.headers
    })
    if (!res.ok) {
      const body = await res.json()
      return { data: null, error: body }
    }
    return { data: null, error: null }
  }

  async get() {
    const url = this.buildUrl(`?select=${this._selectFields}&${this.filters.join('&')}`)
    const res = await fetch(url, { headers: this.headers })
    const body = await res.json()
    if (!res.ok) return { data: null, error: body }
    return { data: this._isSingle ? (body[0] ?? null) : body, error: null }
  }

  // Allow awaiting directly for select queries
  then(resolve: (val: any) => any, reject: (err: any) => any) {
    const params = [`select=${this._selectFields}`, ...this.filters]
    if (this._order) params.push(`order=${this._order}`)
    const url = `${this.url}?${params.join('&')}`
    fetch(url, { headers: this.headers })
      .then(res => res.json().then(body => ({ res, body })))
      .then(({ res, body }) => {
        if (!res.ok) {
          resolve({ data: null, error: body })
        } else {
          resolve({ data: this._isSingle ? (body[0] ?? null) : body, error: null })
        }
      })
      .catch(reject)
  }
}
