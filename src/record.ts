/**
 * 素のオブジェクトを添字で引く。
 *
 * 添字には題名のようなユーザー由来の文字列が入るので、`constructor` や `toString` のときに
 * Object.prototype から継承した値を拾わないよう、自前の添字だけを見る。
 */
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.hasOwn(record, key) ? record[key] : undefined;
}
