/** Английские формы: plural(n, one, many) → n === 1 ? one : many. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}