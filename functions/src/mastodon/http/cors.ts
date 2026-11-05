// ブラウザにプリフライトの結果を保持させる秒数 (→ ADR-0170)。Chrome の上限が 7200 秒。
// 指定しないとブラウザは 5 秒しか保持せず、クライアントのポーリングのたびに OPTIONS が飛ぶ。
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;
