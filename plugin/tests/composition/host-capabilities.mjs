// AGENTS.md：rc.1 的 native executor 使用 provider-owned 声明；与 rc.1 专项门禁同口径。
import { hasDshModule } from '../../contracts/install-resolver.mjs'

export const providerOwnedTools = hasDshModule('@deepseek-ai/dsh-tool-executor-native')
export const legacyHost = !providerOwnedTools
