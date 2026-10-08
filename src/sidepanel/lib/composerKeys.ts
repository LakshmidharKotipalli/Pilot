export interface KeyLike {
  key: string;
  shiftKey: boolean;
  keyCode?: number;
  isComposing?: boolean;
}

/** Enter submits; Shift+Enter is a newline; Enter while an IME is composing never submits. */
export function shouldSubmit(e: KeyLike, canRun: boolean): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return canRun;
}
