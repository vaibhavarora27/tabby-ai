/**
 * Barrel for the provider-agnostic AI layer.
 *
 * Re-exports the shared types, the streaming parsers, the persisted config /
 * metadata, and the four concrete adapters. The Angular service and the
 * settings UI import everything they need from here.
 *
 * NOTE: the four adapter classes are implemented in their own files against the
 * `adapterContract` published with this CORE deliverable. They are re-exported
 * here so the rest of the app has a single import surface
 * (`import { AnthropicAdapter, ... } from '../providers'`).
 */

export * from './types'
export * from './sse'
export * from './config'

export { AnthropicAdapter } from './anthropic.adapter'
export { OpenAIAdapter } from './openai.adapter'
export { GeminiAdapter } from './gemini.adapter'
export { OllamaAdapter } from './ollama.adapter'
