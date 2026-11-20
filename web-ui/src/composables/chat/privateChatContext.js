import { inject } from 'vue'

export const PRIVATE_CHAT_CONTEXT = Symbol('private-chat-page')

// 每个聊天页面提供自己的 refs；子区只消费显式列出的状态和动作。
export function usePrivateChatContext() {
  const context = inject(PRIVATE_CHAT_CONTEXT)
  if (!context) throw new Error('私聊子区必须位于 ChatView 内')
  return context
}
