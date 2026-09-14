import { describe, it, expect } from 'vitest'
import { closeOpenCodeFence } from './streamMarkdown'

describe('closeOpenCodeFence', () => {
  it('leaves fence-free text alone', () => {
    expect(closeOpenCodeFence('- Just prose.')).toBe('- Just prose.')
  })

  it('leaves a balanced fence alone', () => {
    const balanced = 'Before\n```ts\nconst a = 1\n```\nAfter'
    expect(closeOpenCodeFence(balanced)).toBe(balanced)
  })

  it('closes a fence that is still open', () => {
    expect(closeOpenCodeFence('Intro\n```ts\nconst a = 1')).toBe('Intro\n```ts\nconst a = 1\n```')
  })

  it('closes an open fence whose body has not arrived yet', () => {
    expect(closeOpenCodeFence('```python')).toBe('```python\n```')
  })

  it('does not double the newline when the text already ends with one', () => {
    expect(closeOpenCodeFence('```ts\nconst a = 1\n')).toBe('```ts\nconst a = 1\n```')
  })

  it('never counts inline code spans as fences', () => {
    expect(closeOpenCodeFence('Use `map` and `filter`.')).toBe('Use `map` and `filter`.')
  })

  it('handles a closed block followed by an open one', () => {
    expect(closeOpenCodeFence('```js\na\n```\ntext\n```py\nb')).toBe('```js\na\n```\ntext\n```py\nb\n```')
  })

  it('returns empty for empty input', () => {
    expect(closeOpenCodeFence('')).toBe('')
  })
})
