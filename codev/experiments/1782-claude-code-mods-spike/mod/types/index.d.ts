export type IssueRef = { number: string; isPR: boolean }

export type IssueCard = {
  number: string
  title: string
  state: string
  url: string
  labels: string[]
  body: string
  comments: { author: string; createdAt: string; body: string }[]
}

export type ContextFill = { percent?: number; tokens?: number; window: number }

export type Peek = { number: string; card?: IssueCard; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'codev-spike': {
      context: ContextFill | null
      refs: IssueRef[]
      titles: Record<string, string>
      peek: Peek | null
    }
  }
}
