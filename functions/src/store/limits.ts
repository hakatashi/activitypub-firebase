// Firestore のクエリ制約に関する定数。

// Firestore の `in` フィルタは1クエリにつき最大30件までしか指定できない。
export const FIRESTORE_IN_QUERY_LIMIT = 30;

// getNotes は attributedTo を `in` と `array-contains-any` の OR で引くため、選言数が actor 数の2倍になる。
// Firestore の選言数の上限 (30) に収まるよう、1回に渡す actor はこの件数までにする (→ ADR-0072)。
export const NOTE_AUTHORS_QUERY_LIMIT = 15;
