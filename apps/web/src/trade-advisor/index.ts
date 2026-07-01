export { TradeAdvisorAgent } from './agent';
export type { AgentConfig, AgentRole, ChatMessage, AgentResponse } from './agent';
export { VisualAdapter } from './visual-adapter';
export type { ChartSnapshot, ViewStatus, UserAction } from './visual-adapter';
export { LocalMemory, RemoteMemory } from './memory';
export type { MemoryEntry } from './memory';
export { WebSearch } from './web-search';
export type { SearchResult, SearchOptions } from './web-search';
export {
  initBridge,
  applyAgentCode,
  acceptEdit,
  rejectEdit,
  extractCodeBlocks,
  createAutoAcceptToggle,
  getPermissionMode,
  setPermissionMode,
  agentGenerateIndicator,
  agentGenerateIndicatorPhased,
  validateCurrentCode,
  agentAutoFixIterative,
  agentEditIndicator,
  agentBrainstormIndicator,
  agentDiagnoseErrors,
  agentAnalyzeMetrics,
} from './oakscript-bridge';
export type { AgentEditRequest, PermissionMode, OakScriptBridgeConfig } from './oakscript-bridge';
