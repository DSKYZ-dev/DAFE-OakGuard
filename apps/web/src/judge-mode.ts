/**
 * The hosted judge build opens with ?backend=none. It is deliberately
 * backend-free: the OakGuard replay runs in the browser, while live AI
 * (Trade Advisor, OakScript Coder, web search, voice) needs the local
 * backend and a saved provider key.
 */
export function isJudgeMode(): boolean {
  return (window as any).__DAFE_JUDGE_MODE === true;
}

export const JUDGE_AI_MESSAGE =
  'Live AI is off in the hosted judge demo. Run DAFE Charts locally with `npm run backend` to use the Trade Advisor and OakScript Coder.';
